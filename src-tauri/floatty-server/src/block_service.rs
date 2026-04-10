//! Block CRUD service — shared block semantics for all route families.
//!
//! BlockService owns the canonical CRUD operations. Handlers (legacy and outline)
//! are thin wrappers that resolve an OutlineContext, call BlockService, and
//! format the HTTP response.
//!
//! **No route-awareness.** BlockService doesn't know whether the caller is
//! a legacy route or an outline route. Route-specific behavior belongs in handlers.

use crate::api::{self, ApiError, BlockDto, BlockRef, BlockSearchHit, BlockSearchQuery, BlockSearchResponse, BlocksResponse, InheritedMarkerDto, SiblingContext, TokenEstimate, TreeNode};
use crate::WsBroadcaster;
use floatty_core::events::BlockChange;
use floatty_core::hooks::InheritanceIndex;
use floatty_core::{HookSystem, IndexManager, Origin, SearchFilters, SearchService, YDocStore};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use yrs::{Array, ArrayPrelim, Map, MapPrelim, ReadTxn, Transact, WriteTxn};

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
        b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-'
            && trimmed.chars().enumerate().all(|(i, c)| {
                if i == 8 || i == 13 || i == 18 || i == 23 { c == '-' }
                else { c.is_ascii_hexdigit() }
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
        0 => Err(ApiError::NotFound(format!("No block matches prefix '{}'", trimmed))),
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
        ApiError::Ambiguous(n) => ApiError::InvalidRequest(
            format!("Ambiguous prefix in {}: {} matches", field_name, n),
        ),
        ApiError::NotFound(msg) => ApiError::NotFound(
            format!("{} not found: {}", field_name, msg),
        ),
        other => other,
    })
}

/// Map InheritanceIndex results to InheritedMarkerDto for API responses.
pub(crate) fn lookup_inherited(index: &InheritanceIndex, block_id: &str) -> Option<Vec<InheritedMarkerDto>> {
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

    let output_type = block_map
        .get(txn, "outputType")
        .and_then(|v| match v {
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
    }
}

// =========================================================================
// Block field readers (used by context helpers below)
// =========================================================================

/// Read a block's content from a Y.Map within a transaction.
pub(crate) fn read_block_content<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Option<String> {
    let block_map = match blocks_map.get(txn, block_id)? {
        yrs::Out::YMap(map) => map,
        _ => return None,
    };
    block_map
        .get(txn, "content")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
}

/// Read a block's parentId from Y.Doc.
pub(crate) fn read_block_parent_id<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Option<String> {
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
pub(crate) fn read_block_child_ids<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<String> {
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
pub(crate) fn parse_includes(include: &Option<String>) -> HashSet<String> {
    include
        .as_ref()
        .map(|s| s.split(',').map(|p| p.trim().to_lowercase()).collect())
        .unwrap_or_default()
}

// =========================================================================
// Block context helpers (FLO-338)
// =========================================================================

/// Walk the parent chain up to root, returning ancestor BlockRefs (nearest first).
/// Max 10 ancestors to prevent runaway.
pub(crate) fn get_ancestors<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<BlockRef> {
    let mut ancestors = Vec::new();
    let mut current_id = block_id.to_string();
    for _ in 0..10 {
        match read_block_parent_id(blocks_map, txn, &current_id) {
            Some(pid) => {
                let content = read_block_content(blocks_map, txn, &pid).unwrap_or_default();
                ancestors.push(BlockRef { id: pid.clone(), content });
                current_id = pid;
            }
            None => break,
        }
    }
    ancestors
}

/// Get siblings before/after a block within its parent's childIds.
pub(crate) fn get_siblings<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    radius: usize,
) -> SiblingContext {
    let empty = SiblingContext { before: vec![], after: vec![] };

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

    let after_end = pos.saturating_add(1).saturating_add(radius).min(sibling_ids.len());
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
pub(crate) fn get_children_refs<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<BlockRef> {
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
        if result.len() >= 1000 { break; }

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
        if block_count >= 5000 { break; } // Safety cap

        if let Some(content) = read_block_content(blocks_map, txn, &id) {
            total_chars += content.chars().count();
        }
        block_count += 1;
        if depth > deepest { deepest = depth; }

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
        ancestors: includes.contains("ancestors").then(|| get_ancestors(blocks_map, txn, block_id)),
        siblings: includes.contains("siblings").then(|| get_siblings(blocks_map, txn, block_id, sibling_radius)),
        children: includes.contains("children").then(|| get_children_refs(blocks_map, txn, block_id)),
        tree: includes.contains("tree").then(|| get_subtree(blocks_map, txn, block_id, max_depth)),
        token_estimate: includes.contains("token_estimate").then(|| compute_token_estimate(blocks_map, txn, block_id, max_depth)),
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
pub(crate) fn get_blocks(
    store: &Arc<YDocStore>,
    inheritance_index: Option<&RwLock<InheritanceIndex>>,
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

    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                let block_id = key.to_string();
                let inherited_markers = inheritance_guard
                    .as_ref()
                    .and_then(|guard| lookup_inherited(guard, &block_id));
                let dto = read_block_dto(&block_map, &txn, &block_id, inherited_markers, false);

                // Apply query filters
                if let Some(since) = query.since {
                    if dto.created_at < since { continue; }
                }
                if let Some(until) = query.until {
                    if dto.created_at >= until { continue; }
                }
                if let Some(ref mt) = query.marker_type {
                    let has_marker = dto.metadata.as_ref()
                        .and_then(|m| m.get("markers"))
                        .and_then(|arr| arr.as_array())
                        .map(|markers| {
                            markers.iter().any(|marker| {
                                let type_match = marker.get("markerType").and_then(|v| v.as_str()) == Some(mt.as_str());
                                if let Some(ref mv) = query.marker_value {
                                    type_match && marker.get("value").and_then(|v| v.as_str()) == Some(mv.as_str())
                                } else {
                                    type_match
                                }
                            })
                        }).unwrap_or(false);
                    if !has_marker { continue; }
                }

                blocks.push(dto);
            }
        }
    }

    Ok(BlocksResponse { blocks, root_ids })
}

/// Get a single block by ID with optional context (?include= params).
pub(crate) fn get_block(
    store: &Arc<YDocStore>,
    inheritance_index: &RwLock<InheritanceIndex>,
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
        let inherited_markers = {
            let index = inheritance_index.read().map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, &id)
        };
        let block_dto = read_block_dto(&block_map, &txn, &id, inherited_markers, true);

        Ok(build_block_context_response(
            &blocks_map, &txn, &id, block_dto, ctx_query,
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
                "Cannot specify both afterId and atIndex".to_string()
            ));
        }

        // 2. Validate afterId if present
        if let Some(ref after_id) = req.after_id {
            match blocks.get(&txn, after_id) {
                Some(yrs::Out::YMap(after_map)) => {
                    // Check afterId block shares same parent
                    let after_parent = after_map.get(&txn, "parentId")
                        .and_then(|v| match v {
                            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                            _ => None,
                        });

                    let expected_parent = req.parent_id.as_ref().map(|s| s.as_str());
                    let actual_parent = after_parent.as_ref().map(|s| s.as_str());

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
                            None => return Err(ApiError::InvalidRequest(format!(
                                "afterId '{}' not found in parent's childIds", after_id
                            ))),
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
                    None => return Err(ApiError::InvalidRequest(format!(
                        "afterId '{}' not found in rootIds", after_id
                    ))),
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
        metadata: None, // Hooks will populate async
        inherited_markers: None, // Computed on read
        created_at,
        updated_at,
        output_type: None,
        output: None,
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
    // Fast-fail UUID format check before acquiring any lock
    if uuid::Uuid::parse_str(&req.id).is_err() {
        return Err(ApiError::InvalidRequest(format!(
            "id '{}' is not a valid UUID", req.id
        )));
    }

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
                    "Block '{}' already exists in this outline", req.id
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

            let existing_metadata = block_map.get(&txn, "metadata")
                .and_then(|v| api::extract_metadata_from_yrs(v, &txn));

            // Extract created_at (doesn't change on update)
            let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));

            (parent_id, child_ids, collapsed, existing_content, existing_metadata, created_at)
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
            "Cannot specify both afterId and atIndex".to_string()
        ));
    }

    // Reject self-referential afterId (block removed first → afterId not found → silent append)
    if req.after_id.as_deref() == Some(id.as_str()) {
        return Err(ApiError::InvalidRequest(
            "afterId cannot reference the block being moved".to_string()
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
                        "Cannot reparent block under itself".to_string()
                    ));
                }

                // Walk ancestor chain to prevent cycles (can't parent under a descendant)
                let mut cursor = Some(new_parent_id.clone());
                let mut depth = 0;
                const MAX_ANCESTOR_DEPTH: usize = 1000;
                while let Some(pid) = cursor {
                    if pid == id {
                        return Err(ApiError::InvalidParent(format!(
                            "Cannot reparent block {} under its own descendant",
                            id
                        )));
                    }
                    depth += 1;
                    if depth > MAX_ANCESTOR_DEPTH {
                        return Err(ApiError::InvalidParent(
                            "Ancestor chain exceeds depth limit — possible data corruption".to_string()
                        ));
                    }
                    cursor = blocks
                        .get(&txn, &pid)
                        .and_then(|v| match v {
                            yrs::Out::YMap(m) => m.get(&txn, "parentId").and_then(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                yrs::Out::Any(yrs::Any::Null) => None,
                                _ => None,
                            }),
                            _ => None,
                        });
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
                            let after_parent = after_map.get(&txn, "parentId")
                                .and_then(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    yrs::Out::Any(yrs::Any::Null) => None,
                                    _ => None,
                                });

                            let expected_parent = final_parent_id.as_ref().map(|s| s.as_str());
                            let actual_parent = after_parent.as_ref().map(|s| s.as_str());

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
                        if let Some(yrs::Out::YArray(child_ids_arr)) = old_parent_map.get(&txn, "childIds") {
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
                        if let Some(yrs::Out::YArray(child_ids_arr)) = new_parent_map.get(&txn, "childIds") {
                            // Determine insertion index
                            let insert_idx = if let Some(ref after_id) = req.after_id {
                                let child_ids_vec: Vec<String> = child_ids_arr
                                    .iter(&txn)
                                    .filter_map(|v| match v {
                                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                        _ => None,
                                    })
                                    .collect();

                                child_ids_vec.iter()
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

                        root_vec.iter()
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
        updated_at: now as i64,
        output_type: None,
        output: None,
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
pub(crate) fn search_blocks(
    store: &Arc<YDocStore>,
    index_manager: &Arc<IndexManager>,
    query: &BlockSearchQuery,
) -> Result<BlockSearchResponse, ApiError> {
    let service = SearchService::new(Arc::clone(index_manager));

    // Build filters from query params
    let has_explicit_types = query.types.is_some();
    let filters = SearchFilters {
        block_types: query.types.as_ref().map(|t| {
            t.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
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
            Some(t) => t.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
            None if !has_explicit_types => vec!["picker".into(), "output".into(), "ran".into()],
            None => vec![],
        }),
    };

    let (total, hits) = service
        .search_with_filters(&query.q, filters, query.limit)
        .map_err(|e| ApiError::Search(e.to_string()))?;

    let want_breadcrumb = query.include_breadcrumb.unwrap_or(false);
    let want_metadata = query.include_metadata.unwrap_or(false);

    // Hydrate content from Y.Doc for each hit
    let hits: Vec<BlockSearchHit> = {
        let doc = store.doc();
        let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
        let txn = doc_guard.transact();
        let blocks_map = txn.get_map("blocks");

        hits.into_iter()
            .map(|h| {
                let (content, breadcrumb, metadata, block_type) = if let Some(ref bmap) = blocks_map {
                    let content = bmap
                        .get(&txn, &h.block_id)
                        .and_then(|v| match v {
                            yrs::Out::YMap(block_map) => Some(block_map),
                            _ => None,
                        })
                        .and_then(|block_map| {
                            block_map.get(&txn, "content").and_then(|v| match v {
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
                        let ancestors = get_ancestors(bmap, &txn, &h.block_id);
                        let crumbs: Vec<String> = ancestors.into_iter().take(5).map(|a| a.content).collect();
                        if crumbs.is_empty() { None } else { Some(crumbs) }
                    } else {
                        None
                    };

                    let metadata = if want_metadata {
                        bmap.get(&txn, &h.block_id)
                            .and_then(|v| match v {
                                yrs::Out::YMap(block_map) => block_map
                                    .get(&txn, "metadata")
                                    .and_then(|m| api::extract_metadata_from_yrs(m, &txn)),
                                _ => None,
                            })
                    } else {
                        None
                    };

                    let block_type = content.as_ref().map(|c| {
                        floatty_core::parse_block_type(c).as_str().to_string()
                    });

                    (content, breadcrumb, metadata, block_type)
                } else {
                    (None, None, None, None)
                };

                BlockSearchHit {
                    block_id: h.block_id,
                    score: h.score,
                    content,
                    breadcrumb,
                    metadata,
                    snippet: h.snippet,
                    block_type,
                }
            })
            .collect()
    };

    Ok(BlockSearchResponse { hits, total })
}
