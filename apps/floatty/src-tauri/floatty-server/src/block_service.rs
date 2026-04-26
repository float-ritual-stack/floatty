//! Block CRUD service — shared block semantics for all route families.
//!
//! BlockService owns the canonical CRUD operations. Handlers (legacy and outline)
//! are thin wrappers that resolve an OutlineContext, call BlockService, and
//! format the HTTP response.
//!
//! **No route-awareness.** BlockService doesn't know whether the caller is
//! a legacy route or an outline route. Route-specific behavior belongs in handlers.

use crate::api::{
    self, AncestorContext, ApiError, BlockDto, BlockRef, BlockSearchHit, BlockSearchQuery,
    BlockSearchResponse, BlocksResponse, EffectiveMarkerDto, InboundSampleDto, InheritedMarkerDto,
    MarkerSource, SiblingContext, TokenEstimate, TreeNode,
};
use crate::WsBroadcaster;
use floatty_core::events::BlockChange;
use floatty_core::hooks::{tantivy_index, InheritanceIndex, PageNameIndex};
use floatty_core::projections::{walk_ancestors, AncestorWalk, WalkTermination, YDocParentLookup};
use floatty_core::{HookSystem, IndexManager, Origin, SearchFilters, SearchService, YDocStore};
use std::collections::{BTreeSet, HashSet};
use std::sync::{Arc, RwLock};
use yrs::{Array, ArrayPrelim, Map, MapPrelim, ReadTxn, Transact, WriteTxn};

// =========================================================================
// Constants
// =========================================================================

/// Maximum ancestor chain length surfaced via `ancestorContext.ancestorBlockIds`.
///
/// Bumped from 10 → 20 on 2026-04-26 after a depth probe against the live
/// outline (31,120 blocks): real-world max depth is 16 with one cluster of
/// 9 blocks at depth 15. ~700 blocks today have depth > 10 and were having
/// their rootmost ancestors silently truncated. 20 leaves headroom for
/// daily-note nesting growth without immediately re-entering the truncation
/// regime.
///
/// The walker contract is "nearest-first; caller-controlled cap"; callers
/// reverse to rootmost-first when shaping the wire response. Breadcrumb
/// composition has its own visible cap of `take(5)` independent of this
/// value — bumping this only affects `ancestorBlockIds` length.
pub(crate) const ANCESTOR_CONTEXT_MAX_DEPTH: usize = 20;

// =========================================================================
// Helpers (pub(crate) — used by api.rs handlers during incremental migration)
// =========================================================================

/// Extract timestamp from Y.Doc value (handles f64 and i64).
pub(crate) fn extract_timestamp(value: Option<yrs::Out>) -> i64 {
    value
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::Number(n)) => Some(n as i64),
            yrs::Out::Any(yrs::Any::BigInt(n)) => Some(n),
            _ => None,
        })
        .unwrap_or(0)
}

/// Resolve a block ID or short-hash prefix to a full canonical block ID.
///
/// - Full UUID (36 chars with dashes): O(1) exact lookup, case-insensitive
/// - 6+ hex chars: O(n) prefix scan, dash-stripped matching
/// - Non-hex or <6 chars: treated as literal ID, exact lookup (backward compat)
pub(crate) fn resolve_block_id<T: ReadTxn>(
    id_or_prefix: &str,
    blocks_map: &yrs::MapRef,
    txn: &T,
) -> Result<String, ApiError> {
    let trimmed = id_or_prefix.trim();
    let lower = trimmed.to_lowercase();

    let is_full_uuid = trimmed.len() == 36 && {
        let b = trimmed.as_bytes();
        b[8] == b'-'
            && b[13] == b'-'
            && b[18] == b'-'
            && b[23] == b'-'
            && trimmed.chars().enumerate().all(|(i, c)| {
                if i == 8 || i == 13 || i == 18 || i == 23 {
                    c == '-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
    };

    if is_full_uuid {
        if blocks_map.get(txn, &lower).is_some() {
            return Ok(lower);
        }
        if blocks_map.get(txn, trimmed).is_some() {
            return Ok(trimmed.to_string());
        }
        return Err(ApiError::NotFound(trimmed.to_string()));
    }

    let is_hex_prefix = trimmed.len() >= 6 && trimmed.chars().all(|c| c.is_ascii_hexdigit());

    if !is_hex_prefix {
        if blocks_map.get(txn, trimmed).is_some() {
            return Ok(trimmed.to_string());
        }
        return Err(ApiError::NotFound(trimmed.to_string()));
    }

    let mut matches: Vec<String> = Vec::new();

    for (key, _value) in blocks_map.iter(txn) {
        let key_lower = key.to_lowercase();
        if key_lower.starts_with(&lower) {
            matches.push(key.to_string());
            continue;
        }
        let key_nodash: String = key_lower.chars().filter(|c| *c != '-').collect();
        if key_nodash.starts_with(&lower) {
            matches.push(key.to_string());
        }
    }

    match matches.len() {
        0 => Err(ApiError::NotFound(format!(
            "No block matches prefix '{}'",
            trimmed
        ))),
        1 => Ok(matches.into_iter().next().unwrap()),
        n => Err(ApiError::Ambiguous(n)),
    }
}

/// Resolve a block ID field from a request body, wrapping errors with field name context.
pub(crate) fn resolve_body_field<T: ReadTxn>(
    id_or_prefix: &str,
    field_name: &str,
    blocks_map: &yrs::MapRef,
    txn: &T,
) -> Result<String, ApiError> {
    resolve_block_id(id_or_prefix, blocks_map, txn).map_err(|e| match e {
        ApiError::Ambiguous(n) => {
            ApiError::InvalidRequest(format!("Ambiguous prefix in {}: {} matches", field_name, n))
        }
        ApiError::NotFound(msg) => ApiError::NotFound(format!("{} not found: {}", field_name, msg)),
        other => other,
    })
}

/// Map InheritanceIndex results to InheritedMarkerDto for API responses.
pub(crate) fn lookup_inherited(
    index: &InheritanceIndex,
    block_id: &str,
) -> Option<Vec<InheritedMarkerDto>> {
    let inherited = index.get(block_id);
    if inherited.is_empty() {
        None
    } else {
        Some(
            inherited
                .iter()
                .map(|m| InheritedMarkerDto {
                    marker_type: m.marker_type.clone(),
                    value: m.value.clone(),
                    source_block_id: m.source_block_id.clone(),
                })
                .collect(),
        )
    }
}

/// Read a BlockDto from a Y.Map block entry.
///
/// Callers provide pre-computed `inherited_markers` so bulk endpoints can
/// acquire the inheritance index lock once instead of per-block.
pub(crate) fn read_block_dto<T: ReadTxn>(
    block_map: &yrs::MapRef,
    txn: &T,
    id: &str,
    inherited_markers: Option<Vec<InheritedMarkerDto>>,
    include_output: bool,
) -> BlockDto {
    let content = block_map
        .get(txn, "content")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_default();

    let parent_id = block_map.get(txn, "parentId").and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        yrs::Out::Any(yrs::Any::Null) => None,
        _ => None,
    });

    let child_ids = block_map
        .get(txn, "childIds")
        .and_then(|v| match v {
            yrs::Out::YArray(arr) => Some(
                arr.iter(txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default();

    let collapsed = block_map
        .get(txn, "collapsed")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::Bool(b)) => Some(b),
            _ => None,
        })
        .unwrap_or(false);

    let metadata = block_map
        .get(txn, "metadata")
        .and_then(|v| api::extract_metadata_from_yrs(v, txn));

    let created_at = extract_timestamp(block_map.get(txn, "createdAt"));
    let updated_at = extract_timestamp(block_map.get(txn, "updatedAt"));

    let output_type = block_map.get(txn, "outputType").and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        _ => None,
    });

    let output = if include_output {
        block_map
            .get(txn, "output")
            .map(|v| api::yrs_out_to_json(v, txn))
    } else {
        None
    };

    let block_type = floatty_core::parse_block_type(&content);

    BlockDto {
        id: id.to_string(),
        content,
        parent_id,
        child_ids,
        collapsed,
        block_type: format!("{:?}", block_type).to_lowercase(),
        metadata,
        inherited_markers,
        created_at,
        updated_at,
        output_type,
        output,
        // Defaults to None — handler-side shaping helpers populate this
        // when the response surface calls for it. read_block_dto stays a
        // pure projection (no walks, no index reads).
        ancestor_context: None,
    }
}

// =========================================================================
// Block field readers (used by context helpers below)
// =========================================================================

/// Read a block's content from a Y.Map within a transaction.
pub(crate) fn read_block_content<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
) -> Option<String> {
    let block_map = match blocks_map.get(txn, block_id)? {
        yrs::Out::YMap(map) => map,
        _ => return None,
    };
    block_map.get(txn, "content").and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        _ => None,
    })
}

/// Read a block's parentId from Y.Doc.
pub(crate) fn read_block_parent_id<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
) -> Option<String> {
    let block_map = match blocks_map.get(txn, block_id)? {
        yrs::Out::YMap(map) => map,
        _ => return None,
    };
    block_map.get(txn, "parentId").and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        _ => None,
    })
}

/// Read a block's childIds from Y.Doc.
pub(crate) fn read_block_child_ids<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
) -> Vec<String> {
    let block_map = match blocks_map.get(txn, block_id) {
        Some(yrs::Out::YMap(map)) => map,
        _ => return Vec::new(),
    };
    block_map
        .get(txn, "childIds")
        .and_then(|v| match v {
            yrs::Out::YArray(arr) => Some(
                arr.iter(txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default()
}

/// Parse include directives from comma-separated string.
///
/// Made `pub` (not `pub(crate)`) so the symmetry harness in
/// `tests/symmetry_ancestor_context.rs` can build `AncestorContextOpts`
/// the same way handlers do.
pub fn parse_includes(include: &Option<String>) -> HashSet<String> {
    include
        .as_ref()
        .map(|s| s.split(',').map(|p| p.trim().to_lowercase()).collect())
        .unwrap_or_default()
}

// =========================================================================
// AncestorContext shaping helpers (the navigation-layer surface).
// These wrap the existing primitives (`walk_ancestors`,
// `InheritanceIndex`, `PageNameIndex`) — they don't reinvent any walks.
// =========================================================================

/// Bundle of opt-in toggles for `compute_ancestor_context`. Keeps the
/// signature manageable when handlers thread their `?include=` decisions
/// through to the shape layer.
#[derive(Debug, Clone, Copy, Default)]
pub struct AncestorContextOpts {
    /// Populate `effectiveMarkers` from InheritanceIndex. Always-on for
    /// `/blocks/:id` per the plan; opt-in via `?include=effective_markers`
    /// elsewhere.
    pub include_effective_markers: bool,
    /// Populate `inboundSamples` (top-N source blocks linking here).
    /// Opt-in via `?include=inbound_samples`. Top-5 default; cap honoured
    /// from `inbound_sample_count`.
    pub include_inbound_samples: bool,
    /// Override for the inbound-samples cap; min(value, 50) at use site.
    pub inbound_sample_count: usize,
}

impl AncestorContextOpts {
    /// Construct from a `BlockContextQuery` — the canonical includes parser
    /// for handlers that already have a query struct in hand.
    pub(crate) fn from_query(query: &api::BlockContextQuery) -> Self {
        let includes = parse_includes(&query.include);
        Self {
            include_effective_markers: includes.contains("effective_markers"),
            include_inbound_samples: includes.contains("inbound_samples"),
            inbound_sample_count: query.inbound_sample_count.min(50),
        }
    }

    /// Construct from raw `?include=` + opts (search query layer).
    ///
    /// `pub` (not `pub(crate)`) so the symmetry harness in
    /// `tests/symmetry_ancestor_context.rs` can use the canonical
    /// constructor handlers funnel through.
    pub fn from_raw(includes: &HashSet<String>, inbound_sample_count: usize) -> Self {
        Self {
            include_effective_markers: includes.contains("effective_markers"),
            include_inbound_samples: includes.contains("inbound_samples"),
            inbound_sample_count: inbound_sample_count.min(50),
        }
    }

    /// Variant for `/blocks/:id` and other singletons where effective_markers
    /// is always-on.
    pub fn always_effective(mut self) -> Self {
        self.include_effective_markers = true;
        self
    }
}

/// Pre-computed hints to skip walks/lookups inside `compute_ancestor_context`.
///
/// Search hits carry these denormalised from Tantivy STORED columns
/// (populated at index time by `TantivyIndexHook`) — the response path
/// reuses the indexer's work instead of walking Y.Doc and re-querying
/// `PageNameIndex` per hit (Fix 2 in the simplify pass).
///
/// Singleton paths (e.g., `/blocks/:id` not via search) pass `default()`
/// and `compute_ancestor_context` falls back to the original walks.
#[derive(Debug, Clone, Default)]
pub struct AncestorContextHints {
    /// Pre-computed `subtree_size`. When `Some`, skips the BFS over the
    /// block's child pointers.
    pub subtree_size: Option<u32>,
    /// Pre-computed `inbound_count`. When `Some`, skips the
    /// `PageNameIndex::referencing_blocks(...).len()` call for the count.
    pub inbound_count: Option<u32>,
    /// Pre-computed inbound block IDs (already deterministically id-sorted +
    /// capped by the indexer). When `Some` AND `?include=inbound_samples`
    /// is on, used directly instead of pulling from `PageNameIndex` at
    /// response time.
    pub inbound_block_ids: Option<Vec<String>>,
}

/// Shape an `AncestorContext` for a given block. Pure read-time projection
/// — no Y.Doc writes, no broadcast.
///
/// Inputs (the only primitives this helper touches):
/// - `walk_ancestors` for the ancestor chain + nearest_page derivation
/// - `InheritanceIndex` for `effective_markers` (when opted-in)
/// - `PageNameIndex` for `inbound_count` and `inbound_samples`
/// - `own_metadata` for the block's own outlinks (folded into
///   `ancestor_outlinks`) and own markers (folded into `effective_markers`
///   when opted-in). Pass the raw `BlockDto.metadata` — the same JSON shape
///   the metadata-extraction hook writes.
///
/// Returns `None` when no navigation signal fired — bare blocks (no chain,
/// no outlinks, no inbound, no markers) ship as `None` to keep the wire
/// surface terse. See [`AncestorContext::is_empty`].
///
/// Signature note: takes `own_metadata: Option<&serde_json::Value>` rather
/// than the full `BlockDto` so callers (notably `shape_search_hit`) don't
/// have to construct a skeletal-DTO scaffold just to satisfy this helper.
/// All the helper actually reads from the DTO is `metadata` — passing it
/// directly removes the indirection and the duplicate read in the
/// `want_metadata=false` search-hit path.
///
/// `pub` (not `pub(crate)`) so the symmetry harness in
/// `tests/symmetry_ancestor_context.rs` can call the same shaping function
/// every endpoint funnels through.
pub fn compute_ancestor_context<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    own_metadata: Option<&serde_json::Value>,
    inheritance_index: Option<&InheritanceIndex>,
    page_name_index: Option<&PageNameIndex>,
    opts: AncestorContextOpts,
) -> Option<AncestorContext> {
    compute_ancestor_context_with_hints(
        blocks_map,
        txn,
        block_id,
        own_metadata,
        inheritance_index,
        page_name_index,
        opts,
        AncestorContextHints::default(),
    )
}

/// Same as [`compute_ancestor_context`] but accepts pre-computed hints
/// (Fix 2 in the simplify pass). Search hits use this with hints derived
/// from Tantivy STORED columns; singleton paths just call the wrapper
/// above with empty hints.
#[allow(clippy::too_many_arguments)]
pub fn compute_ancestor_context_with_hints<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    own_metadata: Option<&serde_json::Value>,
    inheritance_index: Option<&InheritanceIndex>,
    page_name_index: Option<&PageNameIndex>,
    opts: AncestorContextOpts,
    hints: AncestorContextHints,
) -> Option<AncestorContext> {
    // One walk for ancestor IDs + nearest_page derivation. Walker's depth
    // cap (ANCESTOR_CONTEXT_MAX_DEPTH = 20) is the documented
    // AncestorContext.ancestorBlockIds cap. See const definition for the
    // depth-probe rationale (real-world max=16 + headroom for nesting growth).
    let lookup = YDocParentLookup::new(blocks_map, txn);
    let walk: AncestorWalk = walk_ancestors(
        &lookup,
        block_id,
        ANCESTOR_CONTEXT_MAX_DEPTH,
        page_name_index,
    );

    let nearest_page_block_id = walk.nearest_page.as_ref().map(|(id, _)| id.clone());
    let nearest_page_name = walk.nearest_page.as_ref().map(|(_, name)| name.clone());
    // Wire contract is ROOTMOST-FIRST per the plan §"Foundation status
    // (post-PR-281)" lesson banked from PR 1 review: "behavior-preservation
    // tests preserve INTENT, not necessarily CORRECTNESS." Walker returns
    // nearest-first; we reverse here so the public surface matches the
    // breadcrumb composer's `take(5).rev()` shape established by PR 1.
    let ancestor_block_ids: Vec<String> = walk.ids.iter().cloned().rev().collect();

    // ancestor_outlinks: deduped union over walked ancestors + own.
    // The plan calls for the union including the block's own outlinks too —
    // it's "all outlinks visible from the focused block via its lineage."
    // BTreeSet keeps the result deterministically sorted (good for diff /
    // golden-file tests + symmetric harness).
    let mut outlinks_set: BTreeSet<String> = BTreeSet::new();
    if let Some(meta) = own_metadata {
        if let Some(arr) = meta.get("outlinks").and_then(|v| v.as_array()) {
            for o in arr {
                if let Some(s) = o.as_str() {
                    outlinks_set.insert(s.to_string());
                }
            }
        }
    }
    for ancestor_id in &walk.ids {
        if let Some(yrs::Out::YMap(ancestor_map)) = blocks_map.get(txn, ancestor_id) {
            if let Some(meta_value) = ancestor_map.get(txn, "metadata") {
                if let Some(meta_json) = api::extract_metadata_from_yrs(meta_value, txn) {
                    if let Some(arr) = meta_json.get("outlinks").and_then(|v| v.as_array()) {
                        for o in arr {
                            if let Some(s) = o.as_str() {
                                outlinks_set.insert(s.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    let ancestor_outlinks: Vec<String> = outlinks_set.into_iter().collect();

    // subtree_size: prefer the Tantivy-STORED hint (denormalised at index
    // time). When absent, fall back to a fresh BFS over child pointers.
    // Cap matches the indexer's `SUBTREE_SIZE_CAP` — same shape on read
    // and write paths (Fix 7 in the simplify pass — single source of truth
    // for the cap).
    let subtree_size = hints.subtree_size.unwrap_or_else(|| {
        compute_subtree_size_via_txn(blocks_map, txn, block_id, tantivy_index::SUBTREE_SIZE_CAP)
    });

    // effective_markers — opt-in. Reads `InheritanceIndex` for the inherited
    // half; the own half comes from `own_metadata.markers`.
    let effective_markers = if opts.include_effective_markers {
        compute_effective_markers(own_metadata, inheritance_index, block_id)
    } else {
        Vec::new()
    };

    // inbound_count + samples: prefer Tantivy-STORED hints when present.
    // Falls back to PageNameIndex on the block's nearest page name (or the
    // block itself if it IS a page) when no hint is available.
    let (inbound_count, inbound_samples) = compute_inbound(
        blocks_map,
        txn,
        block_id,
        nearest_page_name.as_deref(),
        page_name_index,
        opts,
        &hints,
    );

    let ctx = AncestorContext {
        nearest_page_block_id,
        nearest_page_name,
        ancestor_block_ids,
        effective_markers,
        ancestor_outlinks,
        subtree_size,
        inbound_count,
        inbound_samples,
    };

    if ctx.is_empty() {
        None
    } else {
        Some(ctx)
    }
}

/// Convenience wrapper for handlers that own a `BlockDto` and want to
/// attach `ancestor_context` in place. Mutates `dto.ancestor_context`.
///
/// `pub` so the symmetry harness can verify `attach_*` and `compute_*`
/// produce matching shapes (which they must — `attach_*` is just a thin
/// wrapper around `compute_*`).
pub fn attach_ancestor_context<T: ReadTxn>(
    dto: &mut BlockDto,
    blocks_map: &yrs::MapRef,
    txn: &T,
    inheritance_index: Option<&InheritanceIndex>,
    page_name_index: Option<&PageNameIndex>,
    opts: AncestorContextOpts,
) {
    dto.ancestor_context = compute_ancestor_context(
        blocks_map,
        txn,
        &dto.id,
        dto.metadata.as_ref(),
        inheritance_index,
        page_name_index,
        opts,
    );
}

/// Compute `subtree_size` via the existing transaction — avoids the
/// `Store::get_block` call path and its per-call txn acquisition. Cap
/// matches the TantivyIndexHook constant.
fn compute_subtree_size_via_txn<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    root_id: &str,
    cap: u32,
) -> u32 {
    if cap == 0 {
        return 0;
    }
    let mut count: u32 = 0;
    let mut stack: Vec<String> = vec![root_id.to_string()];
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(root_id.to_string());

    while let Some(id) = stack.pop() {
        let Some(yrs::Out::YMap(_block_map)) = blocks_map.get(txn, &id) else {
            continue;
        };
        count = count.saturating_add(1);
        if count >= cap {
            return cap;
        }
        let child_ids = read_block_child_ids(blocks_map, txn, &id);
        for child_id in child_ids {
            if seen.insert(child_id.clone()) {
                stack.push(child_id);
            }
        }
    }
    count
}

/// Compose effective markers (own + inherited with provenance) for a block.
///
/// `own_metadata` is the block's `BlockDto.metadata` JSON (the same shape
/// emitted by the metadata-extraction hook). Pass `None` when the caller
/// only wants the inherited half.
fn compute_effective_markers(
    own_metadata: Option<&serde_json::Value>,
    inheritance_index: Option<&InheritanceIndex>,
    block_id: &str,
) -> Vec<EffectiveMarkerDto> {
    let mut out: Vec<EffectiveMarkerDto> = Vec::new();
    let mut seen_types: HashSet<String> = HashSet::new();

    if let Some(meta) = own_metadata {
        if let Some(arr) = meta.get("markers").and_then(|v| v.as_array()) {
            for m in arr {
                let marker_type = m
                    .get("markerType")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let value = m
                    .get("value")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if marker_type.is_empty() || value.is_empty() {
                    // Bare prefix marker — no value, no inheritance. Skip
                    // for the wire surface (the helper is "tag" markers only,
                    // matching InheritanceIndex semantics).
                    continue;
                }
                seen_types.insert(marker_type.clone());
                out.push(EffectiveMarkerDto {
                    marker_type,
                    value,
                    source: MarkerSource::Own,
                });
            }
        }
    }

    if let Some(idx) = inheritance_index {
        for inherited in idx.get(block_id) {
            if seen_types.contains(&inherited.marker_type) {
                continue;
            }
            seen_types.insert(inherited.marker_type.clone());
            out.push(EffectiveMarkerDto {
                marker_type: inherited.marker_type.clone(),
                value: inherited.value.clone(),
                source: MarkerSource::Inherited {
                    source_block_id: inherited.source_block_id.clone(),
                },
            });
        }
    }

    out
}

/// Compute inbound count + (optional) samples for a block.
///
/// Prefers Tantivy-STORED hints when present (search hits) — skips the
/// `PageNameIndex` lookups entirely for the count, and uses the indexer's
/// pre-sorted truncated `inbound_block_ids` for samples (Fix 2 in the
/// simplify pass). Singleton paths pass empty hints and the function falls
/// back to live `PageNameIndex` queries.
fn compute_inbound<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    nearest_page_name: Option<&str>,
    page_name_index: Option<&PageNameIndex>,
    opts: AncestorContextOpts,
    hints: &AncestorContextHints,
) -> (u32, Vec<InboundSampleDto>) {
    // Hot path: when the count hint is present we skip PageNameIndex
    // entirely for the count value. Samples use the hint when present;
    // otherwise we still need the live index to enumerate.
    let count_from_hint = hints.inbound_count;

    // Resolve the requested cap once — used by both the hint and live paths
    // so consumers see consistent honour-the-cap semantics regardless of
    // which branch fires.
    let requested_cap = if opts.inbound_sample_count == 0 {
        5
    } else {
        opts.inbound_sample_count.min(50)
    };

    // Count-only short-circuit (PR #282 review round 2 — CodeRabbit Minor).
    // When the consumer didn't request samples AND we have a count hint,
    // skip the entire `PageNameIndex` path — both for stored-ids-present
    // (already covered below) AND for stored-ids-absent on stale docs.
    // Without this guard, a stale doc with `Some(count) + None ids` falls
    // through to the live path; if `page_name_index` isn't wired (or the
    // block has no nearest page), the live path returns 0, silently
    // dropping the hinted count for callers that only asked for the count.
    if !opts.include_inbound_samples {
        if let Some(count) = count_from_hint {
            return (count, vec![]);
        }
    }

    // Sample ids candidate: from hint when present, else from live index.
    // Build a Vec<String> either way so the downstream content read is
    // identical.
    //
    // Hint capacity gate (PR #282 review — CodeRabbit Major / Greptile P2):
    // Tantivy stores at most `INBOUND_SAMPLES_CAP` (5) inbound_block_ids per
    // doc. Trusting the hint blindly silently caps search-endpoint samples
    // at 5 even when the consumer asked for `?inbound_sample_count=20`.
    // Trust the hint when EITHER:
    //   (a) the consumer didn't request inbound_samples (count-only path —
    //       the truncated id list is never read), OR
    //   (b) the requested cap fits inside the hint's stored capacity
    //       (≤ INBOUND_SAMPLES_CAP), OR
    //   (c) total inbound count is ≤ INBOUND_SAMPLES_CAP — the hint
    //       contains everything anyway, no fallback would surface more.
    // Otherwise fall back to the live PageNameIndex path so the consumer
    // gets up to `min(N, 50)` samples instead of a silently-truncated 5.
    let (count, sample_ids): (u32, Vec<String>) = match (count_from_hint, &hints.inbound_block_ids)
    {
        (Some(count), Some(ids))
            if !opts.include_inbound_samples
                || requested_cap <= tantivy_index::INBOUND_SAMPLES_CAP
                || (count as usize) <= tantivy_index::INBOUND_SAMPLES_CAP =>
        {
            // Hint sufficient — entirely skip PageNameIndex.
            let mut sample_ids = if opts.include_inbound_samples {
                ids.clone()
            } else {
                Vec::new()
            };
            sample_ids.truncate(requested_cap);
            (count, sample_ids)
        }
        _ => {
            // Fall back to the live PageNameIndex path. Used by:
            //   - Singleton callers (presence, /blocks/:id) that pass empty
            //     hints (Fix 2 — kept from prior pass).
            //   - Search hits where the requested cap exceeds the stored
            //     hint capacity (the gate above falls through to here).
            let Some(idx) = page_name_index else {
                return (0, vec![]);
            };
            // Decide which page name to look up — if THIS block IS a page,
            // use its own name; else fall back to the nearest ancestor
            // page. O(1) reverse lookup via PageNameIndex's block_id → name
            // index (Fix 3 in the simplify pass).
            let target_name = idx
                .page_name_for_block(block_id)
                .map(String::from)
                .or_else(|| nearest_page_name.map(String::from));
            let Some(name) = target_name else {
                return (0, vec![]);
            };

            let Some(refs) = idx.referencing_blocks(&name) else {
                return (0, vec![]);
            };
            let count = refs.len() as u32;
            if !opts.include_inbound_samples {
                return (count, vec![]);
            }

            // Deterministic id-sort, capped to the requested cap (already
            // bounded by `min(N, 50)` above).
            let mut sample_ids: Vec<String> = refs.iter().cloned().collect();
            sample_ids.sort();
            sample_ids.truncate(requested_cap);
            (count, sample_ids)
        }
    };

    // No samples requested → return count, skip content reads.
    if !opts.include_inbound_samples {
        return (count, vec![]);
    }

    let samples: Vec<InboundSampleDto> = sample_ids
        .into_iter()
        .map(|id| {
            let content = read_block_content(blocks_map, txn, &id)
                .map(|c| {
                    if c.chars().count() > 200 {
                        let truncated: String = c.chars().take(200).collect();
                        format!("{}...", truncated)
                    } else {
                        c
                    }
                })
                .unwrap_or_default();
            InboundSampleDto {
                block_id: id,
                content,
            }
        })
        .collect();

    (count, samples)
}

// =========================================================================
// Block context helpers (FLO-338)
// =========================================================================

/// Walk the parent chain up to root, returning ancestor BlockRefs (nearest first).
/// Max 10 ancestors to prevent runaway.
///
/// Migrated to `walk_ancestors` (FLO-679 PR 1, commit 2). The walker returns
/// IDs only; this caller folds each ID into a `BlockRef` by fetching content.
/// Cap matches `ANCESTOR_CONTEXT_MAX_DEPTH` so the breadcrumb composer's
/// `take(5)` and `ancestorContext.ancestorBlockIds` draw from the same
/// underlying walk. The visible breadcrumb stays at 5 regardless.
pub(crate) fn get_ancestors<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
) -> Vec<BlockRef> {
    let lookup = YDocParentLookup::new(blocks_map, txn);
    let walk = walk_ancestors(&lookup, block_id, ANCESTOR_CONTEXT_MAX_DEPTH, None);
    walk.ids
        .into_iter()
        .map(|id| {
            let content = read_block_content(blocks_map, txn, &id).unwrap_or_default();
            BlockRef { id, content }
        })
        .collect()
}

/// Get siblings before/after a block within its parent's childIds.
pub(crate) fn get_siblings<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    radius: usize,
) -> SiblingContext {
    let empty = SiblingContext {
        before: vec![],
        after: vec![],
    };

    let parent_id = match read_block_parent_id(blocks_map, txn, block_id) {
        Some(id) => id,
        None => return empty,
    };
    let sibling_ids = read_block_child_ids(blocks_map, txn, &parent_id);

    let pos = match sibling_ids.iter().position(|id| id == block_id) {
        Some(p) => p,
        None => return empty,
    };

    let before_start = pos.saturating_sub(radius);
    let before: Vec<BlockRef> = sibling_ids[before_start..pos]
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect();

    let after_end = pos
        .saturating_add(1)
        .saturating_add(radius)
        .min(sibling_ids.len());
    let after: Vec<BlockRef> = sibling_ids[(pos + 1)..after_end]
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect();

    SiblingContext { before, after }
}

/// Get direct children as BlockRefs.
pub(crate) fn get_children_refs<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
) -> Vec<BlockRef> {
    read_block_child_ids(blocks_map, txn, block_id)
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect()
}

/// DFS traversal of subtree, returning TreeNodes with depth.
/// Respects max_depth and caps total nodes at 1000.
pub(crate) fn get_subtree<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    root_id: &str,
    max_depth: usize,
) -> Vec<TreeNode> {
    let mut result = Vec::new();
    let mut stack: Vec<(String, usize)> = Vec::new();

    // Start with root's children at depth 1
    let root_children = read_block_child_ids(blocks_map, txn, root_id);
    for child_id in root_children.into_iter().rev() {
        stack.push((child_id, 1));
    }

    while let Some((id, depth)) = stack.pop() {
        if result.len() >= 1000 {
            break;
        }

        let content = read_block_content(blocks_map, txn, &id).unwrap_or_default();
        let child_ids = read_block_child_ids(blocks_map, txn, &id);

        // Push children for further traversal if within depth limit
        if depth < max_depth {
            for child_id in child_ids.iter().rev() {
                stack.push((child_id.clone(), depth + 1));
            }
        }

        result.push(TreeNode {
            id: id.clone(),
            content,
            depth,
            child_ids,
        });
    }

    result
}

/// Compute a rough token estimate for a subtree.
pub(crate) fn compute_token_estimate<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    root_id: &str,
    max_depth: usize,
) -> TokenEstimate {
    let mut total_chars = 0usize;
    let mut block_count = 0usize;
    let mut deepest = 0usize;
    let mut stack: Vec<(String, usize)> = Vec::new();

    // Include root content
    if let Some(content) = read_block_content(blocks_map, txn, root_id) {
        total_chars += content.chars().count();
    }
    block_count += 1;

    let root_children = read_block_child_ids(blocks_map, txn, root_id);
    for child_id in root_children.into_iter().rev() {
        stack.push((child_id, 1));
    }

    while let Some((id, depth)) = stack.pop() {
        if block_count >= 5000 {
            break;
        } // Safety cap

        if let Some(content) = read_block_content(blocks_map, txn, &id) {
            total_chars += content.chars().count();
        }
        block_count += 1;
        if depth > deepest {
            deepest = depth;
        }

        if depth < max_depth {
            let child_ids = read_block_child_ids(blocks_map, txn, &id);
            for child_id in child_ids.into_iter().rev() {
                stack.push((child_id, depth + 1));
            }
        }
    }

    TokenEstimate {
        total_chars,
        block_count,
        max_depth: deepest,
    }
}

// =========================================================================
// Block context orchestrator
// =========================================================================

/// Build a BlockWithContextResponse from a block DTO and query params.
/// Shared between get_block and get_daily_note.
pub(crate) fn build_block_context_response<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    block_dto: BlockDto,
    ctx_query: &api::BlockContextQuery,
) -> api::BlockWithContextResponse {
    let includes = parse_includes(&ctx_query.include);
    let sibling_radius = ctx_query.sibling_radius.min(50);
    let max_depth = ctx_query.max_depth.min(100);

    api::BlockWithContextResponse {
        block: block_dto,
        ancestors: includes
            .contains("ancestors")
            .then(|| get_ancestors(blocks_map, txn, block_id)),
        siblings: includes
            .contains("siblings")
            .then(|| get_siblings(blocks_map, txn, block_id, sibling_radius)),
        children: includes
            .contains("children")
            .then(|| get_children_refs(blocks_map, txn, block_id)),
        tree: includes
            .contains("tree")
            .then(|| get_subtree(blocks_map, txn, block_id, max_depth)),
        token_estimate: includes
            .contains("token_estimate")
            .then(|| compute_token_estimate(blocks_map, txn, block_id, max_depth)),
    }
}

// =========================================================================
// Descendant collection (used by delete_block in Step 5)
// =========================================================================

/// Collect a block and all its descendants via stack-based traversal.
/// Returns Vec of (id, content) pairs for hook event emission.
pub(crate) fn collect_descendants(
    blocks: &yrs::MapRef,
    txn: &yrs::TransactionMut<'_>,
    root_id: &str,
) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut stack = vec![root_id.to_string()];
    let mut seen = std::collections::HashSet::from([root_id.to_string()]);

    while let Some(current_id) = stack.pop() {
        if let Some(yrs::Out::YMap(block_map)) = blocks.get(txn, &current_id) {
            let content = block_map
                .get(txn, "content")
                .and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
                .unwrap_or_default();

            // Push children onto stack for traversal (skip already-seen to prevent cycles)
            if let Some(yrs::Out::YArray(child_ids)) = block_map.get(txn, "childIds") {
                for value in child_ids.iter(txn) {
                    if let yrs::Out::Any(yrs::Any::String(s)) = value {
                        let child = s.to_string();
                        if seen.insert(child.clone()) {
                            stack.push(child);
                        }
                    }
                }
            }

            result.push((current_id, content));
        }
    }

    result
}

// =========================================================================
// Read operations
// =========================================================================

/// Get all blocks with optional filters. Returns BlocksResponse with typed DTOs.
///
/// `page_name_index` is needed when `query.ancestor_context == Some(true)` to
/// populate `nearestPage*` and `inboundCount` per block. Pass `None` and the
/// new fields stay defaulted-empty.
pub(crate) fn get_blocks(
    store: &Arc<YDocStore>,
    inheritance_index: Option<&RwLock<InheritanceIndex>>,
    page_name_index: Option<&RwLock<PageNameIndex>>,
    query: &api::BlocksQuery,
) -> Result<BlocksResponse, ApiError> {
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let mut blocks = Vec::new();
    let mut root_ids = Vec::new();

    if let Some(root_ids_arr) = txn.get_array("rootIds") {
        for value in root_ids_arr.iter(&txn) {
            if let yrs::Out::Any(yrs::Any::String(id)) = value {
                root_ids.push(id.to_string());
            }
        }
    }

    // Acquire inheritance index once for all blocks (if available)
    let inheritance_guard = match inheritance_index {
        Some(idx) => Some(idx.read().map_err(|_| ApiError::LockPoisoned)?),
        None => None,
    };
    // Same for PageNameIndex when ancestor_context is opted in.
    let want_ancestor_context = query.ancestor_context.unwrap_or(false);
    let pni_guard = if want_ancestor_context {
        match page_name_index {
            Some(pni) => Some(pni.read().map_err(|_| ApiError::LockPoisoned)?),
            None => None,
        }
    } else {
        None
    };

    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                let block_id = key.to_string();
                let inherited_markers = inheritance_guard
                    .as_ref()
                    .and_then(|guard| lookup_inherited(guard, &block_id));
                let mut dto = read_block_dto(&block_map, &txn, &block_id, inherited_markers, false);

                // Opt-in per-block ancestor context.
                if want_ancestor_context {
                    let opts = AncestorContextOpts::default();
                    attach_ancestor_context(
                        &mut dto,
                        &blocks_map,
                        &txn,
                        inheritance_guard.as_deref(),
                        pni_guard.as_deref(),
                        opts,
                    );
                }

                // Apply query filters
                if let Some(since) = query.since {
                    if dto.created_at < since {
                        continue;
                    }
                }
                if let Some(until) = query.until {
                    if dto.created_at >= until {
                        continue;
                    }
                }
                if let Some(ref mt) = query.marker_type {
                    let has_marker = dto
                        .metadata
                        .as_ref()
                        .and_then(|m| m.get("markers"))
                        .and_then(|arr| arr.as_array())
                        .map(|markers| {
                            markers.iter().any(|marker| {
                                let type_match = marker.get("markerType").and_then(|v| v.as_str())
                                    == Some(mt.as_str());
                                if let Some(ref mv) = query.marker_value {
                                    type_match
                                        && marker.get("value").and_then(|v| v.as_str())
                                            == Some(mv.as_str())
                                } else {
                                    type_match
                                }
                            })
                        })
                        .unwrap_or(false);
                    if !has_marker {
                        continue;
                    }
                }

                blocks.push(dto);
            }
        }
    }

    Ok(BlocksResponse { blocks, root_ids })
}

/// Get a single block by ID with optional context (?include= params).
///
/// Optional `page_name_index` enables `ancestorContext.nearestPage*` and
/// `ancestorContext.inbound*`. Without it, those fields stay `None`/`0`
/// (per-outline endpoints that haven't ensured a hook system call us with
/// `None` and degrade gracefully).
pub(crate) fn get_block(
    store: &Arc<YDocStore>,
    inheritance_index: &RwLock<InheritanceIndex>,
    page_name_index: Option<&RwLock<PageNameIndex>>,
    id: &str,
    ctx_query: &api::BlockContextQuery,
) -> Result<api::BlockWithContextResponse, ApiError> {
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    // Resolve short-hash prefix to full block ID
    let id = resolve_block_id(id, &blocks_map, &txn)?;

    let value = blocks_map
        .get(&txn, &id)
        .ok_or_else(|| ApiError::NotFound(id.clone()))?;

    if let yrs::Out::YMap(block_map) = value {
        // Single inheritance_index read guard for both lookup_inherited
        // and attach_ancestor_context (Fix 6 in the simplify pass).
        let inh_guard = inheritance_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        let inherited_markers = lookup_inherited(&inh_guard, &id);
        let mut block_dto = read_block_dto(&block_map, &txn, &id, inherited_markers, true);

        // Always-on ancestor context for /blocks/:id (slow-context path
        // already, so effective_markers is always-on here too).
        let pni_guard = match page_name_index {
            Some(rw) => Some(rw.read().map_err(|_| ApiError::LockPoisoned)?),
            None => None,
        };
        let opts = AncestorContextOpts::from_query(ctx_query).always_effective();
        attach_ancestor_context(
            &mut block_dto,
            &blocks_map,
            &txn,
            Some(&inh_guard),
            pni_guard.as_deref(),
            opts,
        );

        Ok(build_block_context_response(
            &blocks_map,
            &txn,
            &id,
            block_dto,
            ctx_query,
        ))
    } else {
        Err(ApiError::NotFound(id))
    }
}

// =========================================================================
// Write operations
// =========================================================================

/// Create a new block. Handles validation, Y.Doc mutation, persistence,
/// broadcast, and hook emission.
pub(crate) fn create_block(
    store: &Arc<YDocStore>,
    broadcaster: &Arc<WsBroadcaster>,
    hook_system: &Arc<HookSystem>,
    req: api::CreateBlockRequest,
) -> Result<BlockDto, ApiError> {
    create_block_inner(store, broadcaster, hook_system, req, None, None, None)
}

/// Internal create used by both create_block and import_block.
/// `explicit_id` lets the caller supply the block UUID (import path).
/// `explicit_created_at` / `explicit_updated_at` preserve original timestamps on import.
/// When all three are None, behaviour is identical to the old create_block.
fn create_block_inner(
    store: &Arc<YDocStore>,
    broadcaster: &Arc<WsBroadcaster>,
    hook_system: &Arc<HookSystem>,
    mut req: api::CreateBlockRequest,
    explicit_id: Option<String>,
    explicit_created_at: Option<i64>,
    explicit_updated_at: Option<i64>,
) -> Result<BlockDto, ApiError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let created_at = explicit_created_at.unwrap_or(now);
    let updated_at = explicit_updated_at.unwrap_or(now);

    let doc = store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    // Resolve short-hash prefixes in body fields (if blocks map exists)
    {
        let txn = doc_guard.transact();
        if let Some(blocks_map) = txn.get_map("blocks") {
            if let Some(ref parent_id) = req.parent_id {
                let resolved = resolve_body_field(parent_id, "parentId", &blocks_map, &txn)?;
                req.parent_id = Some(resolved);
            }
            if let Some(ref after_id) = req.after_id {
                let resolved = resolve_body_field(after_id, "afterId", &blocks_map, &txn)?;
                req.after_id = Some(resolved);
            }
        }
    }

    let id = explicit_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Validate parent exists before creating block
        if let Some(ref parent_id) = req.parent_id {
            match blocks.get(&txn, parent_id) {
                Some(yrs::Out::YMap(_)) => {} // Parent exists, continue
                _ => {
                    return Err(ApiError::NotFound(format!(
                        "Parent block not found: {}",
                        parent_id
                    )));
                }
            }
        }

        // Validate positional insertion parameters
        // 1. Check mutual exclusivity
        if req.after_id.is_some() && req.at_index.is_some() {
            return Err(ApiError::InvalidRequest(
                "Cannot specify both afterId and atIndex".to_string(),
            ));
        }

        // 2. Validate afterId if present
        if let Some(ref after_id) = req.after_id {
            match blocks.get(&txn, after_id) {
                Some(yrs::Out::YMap(after_map)) => {
                    // Check afterId block shares same parent
                    let after_parent = after_map.get(&txn, "parentId").and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    });

                    let expected_parent = req.parent_id.as_deref();
                    let actual_parent = after_parent.as_deref();

                    if actual_parent != expected_parent {
                        return Err(ApiError::InvalidRequest(format!(
                            "Block {} is not a sibling (different parent)",
                            after_id
                        )));
                    }
                }
                _ => {
                    return Err(ApiError::NotFound(format!(
                        "afterId block not found: {}",
                        after_id
                    )));
                }
            }
        }

        // Create nested Y.Map for block with Y.Array for childIds
        let parent_id_value: yrs::Any = match &req.parent_id {
            Some(p) => yrs::Any::String(p.clone().into()),
            None => yrs::Any::Null,
        };
        let block_map = blocks.insert(
            &mut txn,
            id.as_str(),
            MapPrelim::from([
                ("id".to_owned(), yrs::any!(id.clone())),
                ("content".to_owned(), yrs::any!(req.content.clone())),
                ("parentId".to_owned(), parent_id_value),
                ("collapsed".to_owned(), yrs::any!(false)),
                ("createdAt".to_owned(), yrs::any!(created_at as f64)),
                ("updatedAt".to_owned(), yrs::any!(updated_at as f64)),
            ]),
        );
        // Insert childIds as nested Y.Array (empty)
        let empty: Vec<yrs::Any> = vec![];
        block_map.insert(&mut txn, "childIds", ArrayPrelim::from(empty));

        // Update parent's childIds or add to rootIds
        if let Some(ref parent_id) = req.parent_id {
            // Add to parent's childIds array (already validated parent exists above)
            if let Some(yrs::Out::YMap(parent_map)) = blocks.get(&txn, parent_id) {
                if let Some(yrs::Out::YArray(child_ids)) = parent_map.get(&txn, "childIds") {
                    // Determine insertion index
                    let insert_idx = if let Some(ref after_id) = req.after_id {
                        // Find position of afterId sibling, insert after it
                        let child_ids_vec: Vec<String> = child_ids
                            .iter(&txn)
                            .filter_map(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                _ => None,
                            })
                            .collect();

                        match child_ids_vec.iter().position(|x| x == after_id) {
                            Some(idx) => idx + 1,
                            None => {
                                return Err(ApiError::InvalidRequest(format!(
                                    "afterId '{}' not found in parent's childIds",
                                    after_id
                                )))
                            }
                        }
                    } else if let Some(at_index) = req.at_index {
                        // Clamp to valid range (0..=length)
                        at_index.min(child_ids.len(&txn) as usize)
                    } else {
                        // Default: append to end (backward compatible)
                        child_ids.len(&txn) as usize
                    };

                    // Use Y.Array insert() - surgical, 1 CRDT op (FLO-280 pattern)
                    child_ids.insert(&mut txn, insert_idx as u32, id.as_str());
                }
            }
        } else {
            // No parent - add to rootIds
            let root_ids = txn.get_or_insert_array("rootIds");

            let insert_idx = if let Some(ref after_id) = req.after_id {
                let root_vec: Vec<String> = root_ids
                    .iter(&txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect();

                match root_vec.iter().position(|x| x == after_id) {
                    Some(idx) => idx + 1,
                    None => {
                        return Err(ApiError::InvalidRequest(format!(
                            "afterId '{}' not found in rootIds",
                            after_id
                        )))
                    }
                }
            } else if let Some(at_index) = req.at_index {
                at_index.min(root_ids.len(&txn) as usize)
            } else {
                root_ids.len(&txn) as usize
            };

            root_ids.insert(&mut txn, insert_idx as u32, id.as_str());
        }

        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    let seq = store.persist_update(&update)?;
    broadcaster.broadcast(update, None, Some(seq));

    // Emit to hook system for metadata extraction
    let _ = hook_system.emit_change(BlockChange::Created {
        id: id.clone(),
        content: req.content.clone(),
        parent_id: req.parent_id.clone(),
        origin: Origin::User,
    });

    let block_type = floatty_core::parse_block_type(&req.content);

    Ok(BlockDto {
        id,
        content: req.content,
        parent_id: req.parent_id,
        child_ids: vec![],
        collapsed: false,
        block_type: format!("{:?}", block_type).to_lowercase(),
        metadata: None,          // Hooks will populate async
        inherited_markers: None, // Computed on read
        created_at,
        updated_at,
        output_type: None,
        output: None,
        // Create response is the brand-new block — no ancestors yet (or one
        // shallow parent). Callers wanting context should re-GET.
        ancestor_context: None,
    })
}

/// Identity-preserving block create for migration and curation workflows.
///
/// Unlike `create_block`, the caller supplies the ID. This is an explicit import
/// primitive — not ambient behavior. Separate endpoint, separate audit trail.
///
/// Audit log: emits `identity_source = "supplied"` so import operations are
/// distinguishable from ordinary creates in log queries.
pub(crate) fn import_block(
    store: &Arc<YDocStore>,
    broadcaster: &Arc<WsBroadcaster>,
    hook_system: &Arc<HookSystem>,
    mut req: api::ImportBlockRequest,
) -> Result<BlockDto, ApiError> {
    // Validate and canonicalise to lowercase — resolve_block_id() normalises lookups
    // to lowercase, so importing the same UUID with different casing would bypass
    // the collision check without this step.
    let parsed_id = uuid::Uuid::parse_str(&req.id)
        .map_err(|_| ApiError::InvalidRequest(format!("id '{}' is not a valid UUID", req.id)))?;
    req.id = parsed_id.hyphenated().to_string();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let created_at = req.created_at.unwrap_or(now);
    let updated_at = req.updated_at.unwrap_or(now);

    let doc = store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    {
        let txn = doc_guard.transact();
        if let Some(blocks_map) = txn.get_map("blocks") {
            // Collision check — reject before any mutation
            if blocks_map.contains_key(&txn, req.id.as_str()) {
                return Err(ApiError::Conflict(format!(
                    "Block '{}' already exists in this outline",
                    req.id
                )));
            }
            if let Some(ref parent_id) = req.parent_id {
                let resolved = resolve_body_field(parent_id, "parentId", &blocks_map, &txn)?;
                req.parent_id = Some(resolved);
            }
            if let Some(ref after_id) = req.after_id {
                let resolved = resolve_body_field(after_id, "afterId", &blocks_map, &txn)?;
                req.after_id = Some(resolved);
            }
        }
    }

    tracing::info!(
        target: "floatty_server::import",
        block_id = %req.id,
        identity_source = "supplied",
        created_at = created_at,
        updated_at = updated_at,
        "Importing block with preserved identity"
    );

    // Drop the read lock before calling create_block_inner (which takes write lock)
    drop(doc_guard);

    // Single write path: supply the caller's ID and timestamps directly.
    // No temp UUID, no rename — one Y.Doc transaction, one persist, one broadcast.
    let create_req = api::CreateBlockRequest {
        content: req.content.clone(),
        parent_id: req.parent_id.clone(),
        after_id: req.after_id.clone(),
        at_index: req.at_index,
    };

    create_block_inner(
        store,
        broadcaster,
        hook_system,
        create_req,
        Some(req.id.clone()),
        Some(created_at),
        Some(updated_at),
    )
}

/// Update an existing block. Handles content changes, metadata updates,
/// reparenting, and repositioning. Owns the full mutation pipeline.
pub(crate) fn update_block(
    store: &Arc<YDocStore>,
    broadcaster: &Arc<WsBroadcaster>,
    hook_system: &Arc<HookSystem>,
    id: &str,
    mut req: api::UpdateBlockRequest,
) -> Result<BlockDto, ApiError> {
    let doc = store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Resolve short-hash prefixes in path and body fields
    let (id, req) = {
        let txn = doc_guard.transact();
        let blocks_map = txn
            .get_map("blocks")
            .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

        let id = resolve_block_id(id, &blocks_map, &txn)?;

        // Resolve body field prefixes
        if let Some(Some(ref parent_id)) = req.parent_id {
            let resolved = resolve_body_field(parent_id, "parentId", &blocks_map, &txn)?;
            req.parent_id = Some(Some(resolved));
        }
        if let Some(ref after_id) = req.after_id {
            let resolved = resolve_body_field(after_id, "afterId", &blocks_map, &txn)?;
            req.after_id = Some(resolved);
        }

        (id, req)
    };

    // Read existing block data
    let (old_parent_id, child_ids, collapsed, existing_content, existing_metadata, created_at) = {
        let txn = doc_guard.transact();
        let blocks_map = txn
            .get_map("blocks")
            .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

        let value = blocks_map
            .get(&txn, &id)
            .ok_or_else(|| ApiError::NotFound(id.clone()))?;

        if let yrs::Out::YMap(block_map) = value {
            let parent_id = block_map.get(&txn, "parentId").and_then(|v| match v {
                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                yrs::Out::Any(yrs::Any::Null) => None,
                _ => None,
            });

            let child_ids = block_map
                .get(&txn, "childIds")
                .and_then(|v| match v {
                    yrs::Out::YArray(arr) => Some(
                        arr.iter(&txn)
                            .filter_map(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                _ => None,
                            })
                            .collect(),
                    ),
                    _ => None,
                })
                .unwrap_or_default();

            let collapsed = block_map
                .get(&txn, "collapsed")
                .and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::Bool(b)) => Some(b),
                    _ => None,
                })
                .unwrap_or(false);

            let existing_content = block_map
                .get(&txn, "content")
                .and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
                .unwrap_or_default();

            let existing_metadata = block_map
                .get(&txn, "metadata")
                .and_then(|v| api::extract_metadata_from_yrs(v, &txn));

            // Extract created_at (doesn't change on update)
            let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));

            (
                parent_id,
                child_ids,
                collapsed,
                existing_content,
                existing_metadata,
                created_at,
            )
        } else {
            return Err(ApiError::NotFound(id));
        }
    };

    // Determine final values
    let old_content = existing_content.clone();
    let final_content = req.content.clone().unwrap_or(existing_content);
    let content_changed = req.content.is_some() && old_content != final_content;
    let final_metadata = if req.metadata.is_some() {
        req.metadata.clone()
    } else {
        existing_metadata
    };

    // Validate positional insertion parameters
    if req.after_id.is_some() && req.at_index.is_some() {
        return Err(ApiError::InvalidRequest(
            "Cannot specify both afterId and atIndex".to_string(),
        ));
    }

    // Reject self-referential afterId (block removed first → afterId not found → silent append)
    if req.after_id.as_deref() == Some(id.as_str()) {
        return Err(ApiError::InvalidRequest(
            "afterId cannot reference the block being moved".to_string(),
        ));
    }

    // Determine if reparenting is requested
    // req.parent_id: None = don't change, Some(None) = move to root, Some(Some(id)) = move under parent
    let (final_parent_id, parent_changed) = match &req.parent_id {
        None => (old_parent_id.clone(), false),
        Some(new_parent) => {
            let changed = *new_parent != old_parent_id;
            (new_parent.clone(), changed)
        }
    };

    // Determine if repositioning is requested (positional params present)
    let repositioning = req.after_id.is_some() || req.at_index.is_some();

    // Update fields granularly (only what changed)
    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Validate new parent exists and won't create cycle (if reparenting to a non-root parent)
        if parent_changed {
            if let Some(ref new_parent_id) = final_parent_id {
                // Prevent self-parenting
                if new_parent_id == &id {
                    return Err(ApiError::InvalidParent(
                        "Cannot reparent block under itself".to_string(),
                    ));
                }

                // Walk ancestor chain to prevent cycles (can't parent under a descendant).
                // Migrated to `walk_ancestors` (FLO-679 PR 1, commit 4) with explicit
                // Cycle-termination rejection added per PR #281 reviewer findings (Greptile P1
                // + CodeRabbit Major: walker's silent break on cycle weakened the corruption
                // guard, since visited-set short-circuits before the depth cap can fire).
                //
                // Three guards, in order:
                //   1. termination == Cycle → pre-existing cycle in new_parent_id's ancestry
                //      (does NOT need to involve `id`). Refuse to attach under corrupt data.
                //   2. depth saturates `MAX + 1` → genuinely deep-but-acyclic chain →
                //      same "data corruption" reject as pre-migration loop's iteration count.
                //   3. `walk.ids.contains(&id)` → reparenting under its own descendant.
                //
                // Self-parenting (`new_parent_id == id`) is caught by the explicit guard
                // above; the walker starts from `new_parent_id`'s parent.
                const MAX_ANCESTOR_DEPTH: usize = 1000;
                let lookup = YDocParentLookup::new(&blocks, &txn);
                let walk = walk_ancestors(&lookup, new_parent_id, MAX_ANCESTOR_DEPTH + 1, None);
                if matches!(walk.termination, WalkTermination::Cycle) {
                    return Err(ApiError::InvalidParent(
                        "Ancestor chain contains a cycle — possible data corruption".to_string(),
                    ));
                }
                if walk.depth as usize > MAX_ANCESTOR_DEPTH {
                    return Err(ApiError::InvalidParent(
                        "Ancestor chain exceeds depth limit — possible data corruption".to_string(),
                    ));
                }
                if walk.ids.iter().any(|aid| aid == &id) {
                    return Err(ApiError::InvalidParent(format!(
                        "Cannot reparent block {} under its own descendant",
                        id
                    )));
                }

                // Validate new parent exists
                match blocks.get(&txn, new_parent_id) {
                    Some(yrs::Out::YMap(_)) => {} // New parent exists
                    _ => {
                        return Err(ApiError::NotFound(format!(
                            "New parent block not found: {}",
                            new_parent_id
                        )));
                    }
                }
            }
        }

        if let Some(yrs::Out::YMap(block_map)) = blocks.get(&txn, &id) {
            // Update content if provided
            if req.content.is_some() {
                block_map.insert(&mut txn, "content", final_content.clone());
            }
            // Update metadata if provided
            if let Some(ref meta) = req.metadata {
                let meta_str = serde_json::to_string(meta).unwrap_or_default();
                block_map.insert(&mut txn, "metadata", meta_str);
            }

            // Handle reparenting or repositioning
            if parent_changed || repositioning {
                // Update block's parentId field (only if parent changed)
                if parent_changed {
                    let parent_id_value: yrs::Any = match &final_parent_id {
                        Some(p) => yrs::Any::String(p.clone().into()),
                        None => yrs::Any::Null,
                    };
                    block_map.insert(&mut txn, "parentId", parent_id_value);
                }

                // Validate afterId if present
                if let Some(ref after_id) = req.after_id {
                    match blocks.get(&txn, after_id) {
                        Some(yrs::Out::YMap(after_map)) => {
                            // Check afterId block shares same parent (or will share after reparenting)
                            let after_parent =
                                after_map.get(&txn, "parentId").and_then(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    yrs::Out::Any(yrs::Any::Null) => None,
                                    _ => None,
                                });

                            let expected_parent = final_parent_id.as_deref();
                            let actual_parent = after_parent.as_deref();

                            if actual_parent != expected_parent {
                                return Err(ApiError::InvalidRequest(format!(
                                    "Block {} is not a sibling (different parent)",
                                    after_id
                                )));
                            }
                        }
                        _ => {
                            return Err(ApiError::NotFound(format!(
                                "afterId block not found: {}",
                                after_id
                            )));
                        }
                    }
                }

                // Remove from old parent's childIds (or rootIds if was root)
                if let Some(ref old_pid) = old_parent_id {
                    if let Some(yrs::Out::YMap(old_parent_map)) = blocks.get(&txn, old_pid) {
                        if let Some(yrs::Out::YArray(child_ids_arr)) =
                            old_parent_map.get(&txn, "childIds")
                        {
                            let mut remove_idx: Option<u32> = None;
                            for (i, value) in child_ids_arr.iter(&txn).enumerate() {
                                if let yrs::Out::Any(yrs::Any::String(s)) = value {
                                    if s.as_ref() == id {
                                        remove_idx = Some(i as u32);
                                        break;
                                    }
                                }
                            }
                            if let Some(idx) = remove_idx {
                                child_ids_arr.remove(&mut txn, idx);
                            }
                        }
                    }
                } else {
                    // Was root - remove from rootIds
                    let root_ids = txn.get_or_insert_array("rootIds");
                    let mut remove_idx: Option<u32> = None;
                    for (i, value) in root_ids.iter(&txn).enumerate() {
                        if let yrs::Out::Any(yrs::Any::String(s)) = value {
                            if s.as_ref() == id {
                                remove_idx = Some(i as u32);
                                break;
                            }
                        }
                    }
                    if let Some(idx) = remove_idx {
                        root_ids.remove(&mut txn, idx);
                    }
                }

                // Add to new parent's childIds (or rootIds if moving to root)
                if let Some(ref new_pid) = final_parent_id {
                    if let Some(yrs::Out::YMap(new_parent_map)) = blocks.get(&txn, new_pid) {
                        if let Some(yrs::Out::YArray(child_ids_arr)) =
                            new_parent_map.get(&txn, "childIds")
                        {
                            // Determine insertion index
                            let insert_idx = if let Some(ref after_id) = req.after_id {
                                let child_ids_vec: Vec<String> = child_ids_arr
                                    .iter(&txn)
                                    .filter_map(|v| match v {
                                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                        _ => None,
                                    })
                                    .collect();

                                child_ids_vec
                                    .iter()
                                    .position(|x| x == after_id)
                                    .map(|idx| idx + 1)
                                    .unwrap_or(child_ids_arr.len(&txn) as usize)
                            } else if let Some(at_index) = req.at_index {
                                at_index.min(child_ids_arr.len(&txn) as usize)
                            } else {
                                child_ids_arr.len(&txn) as usize
                            };

                            child_ids_arr.insert(&mut txn, insert_idx as u32, id.as_str());
                        }
                    }
                } else {
                    // Moving to root
                    let root_ids = txn.get_or_insert_array("rootIds");

                    let insert_idx = if let Some(ref after_id) = req.after_id {
                        let root_vec: Vec<String> = root_ids
                            .iter(&txn)
                            .filter_map(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                _ => None,
                            })
                            .collect();

                        root_vec
                            .iter()
                            .position(|x| x == after_id)
                            .map(|idx| idx + 1)
                            .unwrap_or(root_ids.len(&txn) as usize)
                    } else if let Some(at_index) = req.at_index {
                        at_index.min(root_ids.len(&txn) as usize)
                    } else {
                        root_ids.len(&txn) as usize
                    };

                    root_ids.insert(&mut txn, insert_idx as u32, id.as_str());
                }
            }

            block_map.insert(&mut txn, "updatedAt", now as f64);
        }
        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    let seq = store.persist_update(&update)?;
    broadcaster.broadcast(update, None, Some(seq));

    // Emit to hook system for metadata extraction (only if content changed)
    if content_changed {
        let _ = hook_system.emit_change(BlockChange::ContentChanged {
            id: id.clone(),
            old_content,
            new_content: final_content.clone(),
            origin: Origin::User,
        });
    }

    // Emit MetadataChanged if metadata was explicitly updated via PATCH
    if req.metadata.is_some() {
        let _ = hook_system.emit_change(BlockChange::MetadataChanged {
            id: id.clone(),
            old_metadata: None, // Previous metadata not tracked in this path
            new_metadata: req.metadata.clone(),
            origin: Origin::User,
        });
    }

    // Emit Moved event if reparenting occurred
    if parent_changed {
        let _ = hook_system.emit_change(BlockChange::Moved {
            id: id.clone(),
            old_parent_id,
            new_parent_id: final_parent_id.clone(),
            origin: Origin::User,
        });
    }

    let block_type = floatty_core::parse_block_type(&final_content);

    Ok(BlockDto {
        id: id.clone(),
        content: final_content,
        parent_id: final_parent_id,
        child_ids,
        collapsed,
        block_type: format!("{:?}", block_type).to_lowercase(),
        metadata: final_metadata,
        inherited_markers: None, // Computed on read
        created_at,
        updated_at: now,
        output_type: None,
        output: None,
        // Update response — caller should re-GET if they need recomputed
        // ancestor context (Tantivy index is async).
        ancestor_context: None,
    })
}

/// Delete a block and its entire subtree. Handles persistence, broadcast,
/// and hook emission for each deleted block.
pub(crate) fn delete_block(
    store: &Arc<YDocStore>,
    broadcaster: &Arc<WsBroadcaster>,
    hook_system: &Arc<HookSystem>,
    id: &str,
) -> Result<(), ApiError> {
    let doc = store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    let (update, deleted_blocks) = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Resolve short-hash prefix to full block ID
        let id = resolve_block_id(id, &blocks, &txn)?;

        // Get block's parentId before deleting
        let parent_id: Option<String> = match blocks.get(&txn, &id) {
            Some(yrs::Out::YMap(block_map)) => {
                block_map.get(&txn, "parentId").and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
            }
            Some(_) => return Err(ApiError::NotFound(id)),
            None => return Err(ApiError::NotFound(id)),
        };

        // Collect all descendants (block + children + grandchildren...)
        let to_delete = collect_descendants(&blocks, &txn, &id);

        // Remove from parent's childIds if this block has a parent
        if let Some(ref pid) = parent_id {
            if let Some(yrs::Out::YMap(parent_map)) = blocks.get(&txn, pid) {
                if let Some(yrs::Out::YArray(child_ids)) = parent_map.get(&txn, "childIds") {
                    let mut remove_idx: Option<u32> = None;
                    for (i, value) in child_ids.iter(&txn).enumerate() {
                        if let yrs::Out::Any(yrs::Any::String(s)) = value {
                            if s.as_ref() == id {
                                remove_idx = Some(i as u32);
                                break;
                            }
                        }
                    }
                    if let Some(idx) = remove_idx {
                        child_ids.remove(&mut txn, idx);
                    }
                }
            }
        }

        // Delete all collected blocks from the map
        for (del_id, _) in &to_delete {
            blocks.remove(&mut txn, del_id);
        }

        // Remove from rootIds if present (only if no parent)
        if parent_id.is_none() {
            let root_ids = txn.get_or_insert_array("rootIds");
            let mut remove_index: Option<u32> = None;
            for (i, value) in root_ids.iter(&txn).enumerate() {
                if let yrs::Out::Any(yrs::Any::String(s)) = value {
                    if s.as_ref() == id {
                        remove_index = Some(i as u32);
                        break;
                    }
                }
            }
            if let Some(idx) = remove_index {
                root_ids.remove(&mut txn, idx);
            }
        }

        (txn.encode_update_v1(), to_delete)
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    let seq = store.persist_update(&update)?;
    broadcaster.broadcast(update, None, Some(seq));

    // Emit BlockChange::Deleted for EACH deleted block (hooks depend on complete coverage)
    for (del_id, del_content) in &deleted_blocks {
        let _ = hook_system.emit_change(BlockChange::Deleted {
            id: del_id.clone(),
            content: del_content.clone(),
            origin: Origin::User,
        });
    }

    Ok(())
}

// =========================================================================
// Search
// =========================================================================

/// Full-text + filtered search over a Tantivy index, hydrated from Y.Doc.
/// Used by both legacy and per-outline search handlers.
///
/// `inheritance_index` and `page_name_index` are optional — the per-outline
/// path passes `None` (per-outline endpoints don't share the legacy default
/// outline's indices). When absent, `ancestorContext.effectiveMarkers` and
/// `ancestorContext.inbound*` stay empty.
pub(crate) fn search_blocks(
    store: &Arc<YDocStore>,
    index_manager: &Arc<IndexManager>,
    inheritance_index: Option<&RwLock<InheritanceIndex>>,
    page_name_index: Option<&RwLock<PageNameIndex>>,
    query: &BlockSearchQuery,
) -> Result<BlockSearchResponse, ApiError> {
    let service = SearchService::new(Arc::clone(index_manager));

    // Build filters from query params
    let has_explicit_types = query.types.is_some();
    let filters = SearchFilters {
        block_types: query.types.as_ref().map(|t| {
            t.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        }),
        has_markers: query.has_markers,
        parent_id: query.parent_id.clone(),
        outlink: query.outlink.clone(),
        marker_type: query.marker_type.clone(),
        marker_value: match (&query.marker_type, &query.marker_val) {
            (Some(mt), Some(mv)) => Some(format!("{mt}::{mv}")),
            (None, Some(mv)) => Some(mv.clone()),
            _ => None,
        },
        created_after: query.created_after,
        created_before: query.created_before,
        ctx_after: query.ctx_after,
        ctx_before: query.ctx_before,
        include_inherited: query.inherited,
        exclude_types: Some(match &query.exclude_types {
            Some(t) => t
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
            None if !has_explicit_types => vec!["picker".into(), "output".into(), "ran".into()],
            None => vec![],
        }),
    };

    let (total, hits) = service
        .search_with_filters(&query.q, filters, query.limit)
        .map_err(|e| ApiError::Search(e.to_string()))?;

    let want_breadcrumb = query.include_breadcrumb.unwrap_or(false);
    let want_metadata = query.include_metadata.unwrap_or(false);
    let includes = parse_includes(&query.include);
    let inbound_sample_count = query.inbound_sample_count.unwrap_or(5);
    let ac_opts = AncestorContextOpts::from_raw(&includes, inbound_sample_count);

    // Hydrate content from Y.Doc for each hit. Single read txn for the
    // whole batch — cheap, no lock thrash.
    let hits: Vec<BlockSearchHit> = {
        let doc = store.doc();
        let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
        let txn = doc_guard.transact();
        let blocks_map = txn.get_map("blocks");
        // Acquire optional indices ONCE for the whole batch.
        let inh_guard = match inheritance_index {
            Some(rw) => Some(rw.read().map_err(|_| ApiError::LockPoisoned)?),
            None => None,
        };
        let pni_guard = match page_name_index {
            Some(rw) => Some(rw.read().map_err(|_| ApiError::LockPoisoned)?),
            None => None,
        };

        hits.into_iter()
            .map(|h| {
                shape_search_hit(
                    h,
                    blocks_map.as_ref(),
                    &txn,
                    inh_guard.as_deref(),
                    pni_guard.as_deref(),
                    want_breadcrumb,
                    want_metadata,
                    ac_opts,
                )
            })
            .collect()
    };

    Ok(BlockSearchResponse { hits, total })
}

/// Convert a `SearchHit` (Tantivy result) into a `BlockSearchHit` (wire DTO).
///
/// Extracted from `search_blocks` so the per-outline search handler can call
/// it with the same shape — closes the `/outlines/` drift surfaced by the
/// planning-time inventory.
///
/// Always emits `block_type` (via parse_block_type on content); emits
/// `breadcrumb` / `metadata` only when the caller opted in via the
/// corresponding `include_*` flags. AncestorContext is attached when any
/// cheap fields fire (always-on tier) — see `compute_ancestor_context`.
///
/// `pub` (not `pub(crate)`) so the symmetry harness can prove search-hit
/// shaping produces matching `ancestorContext` to `compute_ancestor_context`
/// directly.
#[allow(clippy::too_many_arguments)]
pub fn shape_search_hit<T: ReadTxn>(
    hit: floatty_core::search::SearchHit,
    blocks_map: Option<&yrs::MapRef>,
    txn: &T,
    inheritance_index: Option<&InheritanceIndex>,
    page_name_index: Option<&PageNameIndex>,
    want_breadcrumb: bool,
    want_metadata: bool,
    ac_opts: AncestorContextOpts,
) -> BlockSearchHit {
    let Some(bmap) = blocks_map else {
        return BlockSearchHit {
            block_id: hit.block_id,
            score: hit.score,
            content: None,
            breadcrumb: None,
            metadata: None,
            snippet: hit.snippet,
            block_type: None,
            ancestor_context: None,
        };
    };

    // Read content (truncated for wire — same 200-char ceiling as before).
    let content = bmap
        .get(txn, &hit.block_id)
        .and_then(|v| match v {
            yrs::Out::YMap(block_map) => Some(block_map),
            _ => None,
        })
        .and_then(|block_map| {
            block_map.get(txn, "content").and_then(|v| match v {
                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
        })
        .map(|c| {
            if c.chars().count() > 200 {
                let truncated: String = c.chars().take(200).collect();
                format!("{}...", truncated)
            } else {
                c
            }
        });

    let breadcrumb = if want_breadcrumb {
        // Take the nearest 5 ancestors, then reverse for ROOTMOST-FIRST
        // display order — matches the contract documented in
        // .claude/rules/api-reference.md ("breadcrumb is parent chain
        // ... ancestor block content (nearest parent last)") and the
        // floatty-backend SKILL.md helper which joins with " → " as
        // root → leaf. Per CodeRabbit Major review on PR #281: the
        // walker keeps its nearest-first programmatic contract; only
        // the breadcrumb projection (a presentation surface) is
        // reversed at the composer.
        let ancestors = get_ancestors(bmap, txn, &hit.block_id);
        let crumbs: Vec<String> = ancestors
            .into_iter()
            .take(5)
            .rev()
            .map(|a| a.content)
            .collect();
        if crumbs.is_empty() {
            None
        } else {
            Some(crumbs)
        }
    } else {
        None
    };

    let metadata = if want_metadata {
        bmap.get(txn, &hit.block_id).and_then(|v| match v {
            yrs::Out::YMap(block_map) => block_map
                .get(txn, "metadata")
                .and_then(|m| api::extract_metadata_from_yrs(m, txn)),
            _ => None,
        })
    } else {
        None
    };

    let block_type = content
        .as_ref()
        .map(|c| floatty_core::parse_block_type(c).as_str().to_string());

    // ancestor_context needs the block's own metadata for outlinks +
    // markers. Reuse the already-read `metadata` when `want_metadata=true`;
    // otherwise pull it once here. The helper takes
    // `Option<&serde_json::Value>` directly so no skeletal DTO scaffold is
    // needed (Fix 5 in the simplify pass — eliminates the prior duplicate
    // metadata read in the `want_metadata=false` path).
    let metadata_for_ac: Option<serde_json::Value> = if metadata.is_some() {
        None
    } else {
        bmap.get(txn, &hit.block_id).and_then(|v| match v {
            yrs::Out::YMap(block_map) => block_map
                .get(txn, "metadata")
                .and_then(|m| api::extract_metadata_from_yrs(m, txn)),
            _ => None,
        })
    };
    // Hints from the Tantivy STORED columns — let compute_ancestor_context
    // skip the per-hit BFS over child pointers AND the per-hit
    // PageNameIndex enumeration (Fix 2 in the simplify pass).
    let hints = AncestorContextHints {
        subtree_size: hit.subtree_size_hint,
        inbound_count: hit.inbound_count_hint,
        inbound_block_ids: hit.inbound_block_ids_hint.clone(),
    };
    let ancestor_context = compute_ancestor_context_with_hints(
        bmap,
        txn,
        &hit.block_id,
        metadata.as_ref().or(metadata_for_ac.as_ref()),
        inheritance_index,
        page_name_index,
        ac_opts,
        hints,
    );

    BlockSearchHit {
        block_id: hit.block_id,
        score: hit.score,
        content,
        breadcrumb,
        metadata,
        snippet: hit.snippet,
        block_type,
        ancestor_context,
    }
}

// =========================================================================
// Behaviour-preservation tests for FLO-679 PR 1 ancestor-walk migrations.
//
// Each migrated call site (get_ancestors / cycle detection / search
// breadcrumb) gets a focused integration test that builds a small Y.Doc
// and asserts the post-migration output matches what the pre-migration
// implementation produced. The walker itself is exhaustively unit-tested
// in `floatty-core::projections::ancestor_walk::tests`; tests here prove
// the *adapter wiring* and *result projection* haven't drifted.
// =========================================================================

#[cfg(test)]
mod ancestor_migration_tests {
    use super::*;
    use yrs::{ArrayPrelim, Doc};

    /// Build a Y.Doc with a blocks map and seed it with `(id, parent_id?, content)` tuples.
    fn build_doc(seeds: &[(&str, Option<&str>, &str)]) -> Doc {
        let doc = Doc::new();
        {
            let mut txn = doc.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");
            for (id, parent, content) in seeds {
                let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, *id);
                block_map.insert(&mut txn, "content", yrs::Any::String((*content).into()));
                if let Some(pid) = parent {
                    block_map.insert(&mut txn, "parentId", yrs::Any::String((*pid).into()));
                }
                let empty: Vec<yrs::Any> = vec![];
                block_map.insert(&mut txn, "childIds", ArrayPrelim::from(empty));
            }
        }
        doc
    }

    #[test]
    fn get_ancestors_returns_nearest_first() {
        // root → mid → leaf
        let doc = build_doc(&[
            ("root", None, "root content"),
            ("mid", Some("root"), "mid content"),
            ("leaf", Some("mid"), "leaf content"),
        ]);
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks").expect("blocks map");

        let ancestors = get_ancestors(&blocks_map, &txn, "leaf");
        assert_eq!(ancestors.len(), 2, "leaf has 2 ancestors");
        assert_eq!(ancestors[0].id, "mid", "nearest first");
        assert_eq!(ancestors[0].content, "mid content");
        assert_eq!(ancestors[1].id, "root");
        assert_eq!(ancestors[1].content, "root content");
    }

    #[test]
    fn get_ancestors_root_returns_empty() {
        let doc = build_doc(&[("root", None, "root")]);
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks").expect("blocks map");
        assert!(get_ancestors(&blocks_map, &txn, "root").is_empty());
    }

    #[test]
    fn get_ancestors_caps_at_walker_max() {
        // Build a 25-deep chain. Cap is ANCESTOR_CONTEXT_MAX_DEPTH = 20;
        // expect exactly 20 ancestors. Cap was 10 before 2026-04-26; bumped
        // after live-outline depth probe found real-world max=16. See the
        // const definition for full rationale.
        let mut seeds: Vec<(String, Option<String>, String)> = Vec::new();
        for i in 0..25 {
            let parent = if i == 0 {
                None
            } else {
                Some(format!("b{}", i - 1))
            };
            seeds.push((format!("b{}", i), parent, format!("content {}", i)));
        }
        // Convert to the borrowed-tuple shape build_doc wants.
        let seed_refs: Vec<(&str, Option<&str>, &str)> = seeds
            .iter()
            .map(|(id, p, c)| (id.as_str(), p.as_deref(), c.as_str()))
            .collect();
        let doc = build_doc(&seed_refs);
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks").expect("blocks map");

        let ancestors = get_ancestors(&blocks_map, &txn, "b24");
        assert_eq!(ancestors.len(), 20, "depth cap held");
        // Walker contract: nearest-first. b24's parent b23 is index 0;
        // 20 hops up is b4 (last entry).
        assert_eq!(ancestors[0].id, "b23");
        assert_eq!(ancestors.last().unwrap().id, "b4");
    }

    #[test]
    fn get_ancestors_terminates_on_cycle() {
        // A → B → A — the walker should not loop.
        let doc = build_doc(&[("a", Some("b"), "A"), ("b", Some("a"), "B")]);
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks").expect("blocks map");

        let ancestors = get_ancestors(&blocks_map, &txn, "a");
        assert_eq!(ancestors.len(), 1, "cycle short-circuits at first repeat");
        assert_eq!(ancestors[0].id, "b");
    }

    /// Breadcrumb composition for a search hit takes `get_ancestors().take(5)` then
    /// REVERSES for rootmost-first display order. The reversal was added per
    /// CodeRabbit Major review on PR #281 to match the documented breadcrumb contract
    /// (nearest parent LAST, joined with " → " by skill helpers as root → leaf).
    /// `get_ancestors()` itself stays nearest-first — that's the programmatic
    /// contract; the reversal lives at the presentation boundary in the composer.
    #[test]
    fn search_breadcrumb_projection_returns_rootmost_first() {
        let doc = build_doc(&[
            ("root", None, "root"),
            ("a", Some("root"), "a"),
            ("b", Some("a"), "b"),
            ("c", Some("b"), "c"),
            ("d", Some("c"), "d"),
            ("e", Some("d"), "e"),
            ("f", Some("e"), "f"),
            ("hit", Some("f"), "hit"),
        ]);
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks").expect("blocks map");

        // Reproduce the exact projection from the search-hit composer.
        // hit's chain is f → e → d → c → b → a → root (7 ancestors).
        // get_ancestors caps at 10, take(5) keeps the nearest 5 (f..b),
        // .rev() flips to rootmost-first within that window: b..f.
        let ancestors = get_ancestors(&blocks_map, &txn, "hit");
        let crumbs: Vec<String> = ancestors
            .into_iter()
            .take(5)
            .rev()
            .map(|a| a.content)
            .collect();

        // Rootmost-first: b is 5-deep ancestor (visible window's root),
        // f is the immediate parent (visible window's leaf — last item).
        // Reads naturally as "b → c → d → e → f → hit" with " → " join.
        assert_eq!(crumbs, vec!["b", "c", "d", "e", "f"]);
    }

    /// Cycle detection (commit 4 of PR 1) replaces an inline parent-walk with
    /// `walk_ancestors(...).ids.contains(&id)` plus a depth-saturation check.
    /// This test reproduces the predicate against a Y.Doc — proves the
    /// `YDocParentLookup` adapter wiring catches the same descendant-cycle
    /// case the pre-migration loop caught.
    #[test]
    fn cycle_detection_rejects_descendant_as_new_parent() {
        // Existing tree: root → mid → leaf.
        // Attempt: reparent `root` under `leaf` (creates a cycle).
        // walk_ancestors(leaf) = [mid, root] → contains(root) → reject.
        let doc = build_doc(&[
            ("root", None, "root"),
            ("mid", Some("root"), "mid"),
            ("leaf", Some("mid"), "leaf"),
        ]);
        let txn = doc.transact();
        let blocks = txn.get_map("blocks").expect("blocks map");

        let lookup = YDocParentLookup::new(&blocks, &txn);
        let walk = walk_ancestors(&lookup, "leaf", 1001, None);
        assert!(walk.ids.iter().any(|aid| aid == "root"));
        assert!(
            walk.depth as usize <= 1000,
            "no false positive on depth cap"
        );
    }

    #[test]
    fn cycle_detection_allows_unrelated_subtree_reparent() {
        // Two branches: A→A1, B→B1. Reparenting A1 under B is legal.
        let doc = build_doc(&[
            ("a", None, "a"),
            ("a1", Some("a"), "a1"),
            ("b", None, "b"),
            ("b1", Some("b"), "b1"),
        ]);
        let txn = doc.transact();
        let blocks = txn.get_map("blocks").expect("blocks map");

        let lookup = YDocParentLookup::new(&blocks, &txn);
        let walk = walk_ancestors(&lookup, "b", 1001, None);
        // Walking b's ancestors: b → none. b is a root.
        assert!(walk.ids.is_empty());
        // The cycle predicate would be: walk.ids.contains(&"a1") → false.
        assert!(!walk.ids.iter().any(|aid| aid == "a1"));
    }

    #[test]
    fn cycle_detection_depth_saturation_signals_corruption() {
        // Build a 1002-deep chain. Walking with cap MAX+1 (1001) should saturate
        // at depth 1001 → triggers the "data corruption" rejection branch.
        let mut seeds: Vec<(String, Option<String>, String)> = Vec::new();
        for i in 0..1003 {
            let parent = if i == 0 {
                None
            } else {
                Some(format!("b{}", i - 1))
            };
            seeds.push((format!("b{}", i), parent, String::new()));
        }
        let seed_refs: Vec<(&str, Option<&str>, &str)> = seeds
            .iter()
            .map(|(id, p, c)| (id.as_str(), p.as_deref(), c.as_str()))
            .collect();
        let doc = build_doc(&seed_refs);
        let txn = doc.transact();
        let blocks = txn.get_map("blocks").expect("blocks map");

        let lookup = YDocParentLookup::new(&blocks, &txn);
        let walk = walk_ancestors(&lookup, "b1002", 1001, None);
        assert_eq!(walk.depth, 1001, "saturated at MAX_ANCESTOR_DEPTH + 1");
        assert!(walk.depth as usize > 1000, "triggers corruption branch");
    }

    #[test]
    fn cycle_detection_natural_cycle_terminates_safely() {
        // Synthetic cycle x ↔ y. The walker must terminate without running
        // away — pre-migration this hit the depth-1001 corruption branch;
        // post-migration the visited-set short-circuits.
        let doc = build_doc(&[("x", Some("y"), "x"), ("y", Some("x"), "y")]);
        let txn = doc.transact();
        let blocks = txn.get_map("blocks").expect("blocks map");

        let lookup = YDocParentLookup::new(&blocks, &txn);
        let walk = walk_ancestors(&lookup, "x", 1001, None);
        assert_eq!(walk.ids, vec!["y"]);
        assert!(
            (walk.depth as usize) <= 1000,
            "cycle terminates well under the cap"
        );
        assert_eq!(
            walk.termination,
            WalkTermination::Cycle,
            "termination = Cycle so reparent guards can reject"
        );
    }

    /// Greptile P1 + CodeRabbit Major on PR #281: pre-existing cycle in
    /// `new_parent_id`'s ancestor chain that does NOT involve `id`. Old
    /// inline loop spun until depth=1001 → `data corruption` reject. New
    /// walker terminates at the cycle (visited-set), `walk.depth` never
    /// reaches 1001, and the depth-saturation guard alone wouldn't fire.
    /// The `WalkTermination::Cycle` rejection MUST catch this.
    ///
    /// Asserts the walker contract directly (rejection is wired into the
    /// `update_block` reparent path; testing the full reparent flow needs
    /// a write-side fixture, which is out of scope for this regression
    /// test — the walker contract IS the regression).
    #[test]
    fn cycle_detection_rejects_pre_existing_cycle_in_new_parent_chain() {
        // new_parent_id `np` → p1 → p2 → p1 (cycle at p1, NOT involving
        // the block being reparented). Independent block `id` is fresh.
        let doc = build_doc(&[
            ("p1", Some("p2"), "p1"),
            ("p2", Some("p1"), "p2"),
            ("np", Some("p1"), "new parent"),
            ("id", None, "block being reparented (separate root)"),
        ]);
        let txn = doc.transact();
        let blocks = txn.get_map("blocks").expect("blocks map");

        let lookup = YDocParentLookup::new(&blocks, &txn);
        let walk = walk_ancestors(&lookup, "np", 1001, None);
        assert_eq!(
            walk.termination,
            WalkTermination::Cycle,
            "walker MUST surface Cycle so reparent rejects pre-existing corruption"
        );
        assert!(
            !walk.ids.iter().any(|aid| aid == "id"),
            "reparented block `id` is NOT in np's ancestry — cycle is upstream"
        );
        // Without the Cycle check, the depth-saturation branch would
        // be the only guard, and walk.depth here is just 2 — far from
        // 1001 — so the guard would NOT fire and the reparent would
        // silently succeed on corrupt data. That's the bug.
        assert!(
            (walk.depth as usize) < 1000,
            "visited-set short-circuit means depth never saturates"
        );
    }

    #[test]
    fn search_breadcrumb_short_chain_yields_short_crumbs() {
        let doc = build_doc(&[("root", None, "root"), ("hit", Some("root"), "hit")]);
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks").expect("blocks map");

        let ancestors = get_ancestors(&blocks_map, &txn, "hit");
        let crumbs: Vec<String> = ancestors.into_iter().take(5).map(|a| a.content).collect();
        assert_eq!(crumbs, vec!["root"]);
    }

    #[test]
    fn get_ancestors_missing_parent_treated_as_root() {
        // child references parent "ghost" that doesn't exist in the map.
        let doc = build_doc(&[("child", Some("ghost"), "child content")]);
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks").expect("blocks map");

        let ancestors = get_ancestors(&blocks_map, &txn, "child");
        assert_eq!(ancestors.len(), 1, "ghost parent yields one BlockRef");
        assert_eq!(ancestors[0].id, "ghost");
        assert_eq!(
            ancestors[0].content, "",
            "missing block content reads as empty string (preserves pre-migration behaviour)"
        );
    }
}
