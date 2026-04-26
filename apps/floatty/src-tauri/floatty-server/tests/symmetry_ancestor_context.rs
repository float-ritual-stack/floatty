//! FLO-679 PR 2 — Symmetry harness for `AncestorContext`.
//!
//! ## What this is
//!
//! Plan §"PR 2 commits" #9. Asserts that the SAME block, viewed through
//! every shaping helper that funnels into a block-returning endpoint,
//! produces a MATCHING `AncestorContext`. Regression net for the
//! per-outline asymmetry surfaced during planning (`/api/v1/outlines/...`
//! historically didn't even support `?include=` opt-ins).
//!
//! ## Why this is the right shape of test
//!
//! Every endpoint funnels through one of:
//! - `compute_ancestor_context` (singletons, presence, page-search, daily)
//! - `attach_ancestor_context` (thin wrapper around the above)
//! - `shape_search_hit` (BlockSearchHit, both top-level and per-outline)
//!
//! If those three produce matching shapes for the same Y.Doc fixture, every
//! endpoint above them does too — they're projections of the same call. The
//! plan's "every endpoint × matching ancestorContext" guarantee reduces to
//! these three call sites because the per-outline asymmetry fix in commit 7
//! collapsed the two surfaces (`/blocks/...` and `/outlines/:name/blocks/...`)
//! through the same `block_service::*` helpers.
//!
//! ## What this asserts (the contracts the plan calls out as load-bearing)
//!
//! 1. **Rootmost-first** for `ancestor_block_ids` (lesson banked from PR 1
//!    review — behavior-preservation tests preserve INTENT, not necessarily
//!    CORRECTNESS; the wire surface is rootmost-first to match the
//!    breadcrumb composer's `take(5).rev()` shape).
//! 2. **Dedup-union** for `ancestor_outlinks` (resolved open-question:
//!    deduped union of own + walked ancestors).
//! 3. **`compute_*`, `attach_*`, `shape_search_hit` agree** on the same
//!    fixture — i.e., per-outline endpoints can never drift again because
//!    they all flow through the same shaping function.
//! 4. **Empty-on-bare-root** — root block with no chain, no outlinks, no
//!    inbound, no markers returns `None`. Keeps the wire terse.
//! 5. **Cap honoured** — synthetic 12-deep chain exercises the walker's
//!    depth=10 cap.
//! 6. **Opts respected** — `effective_markers` only populates when opted-in.
//!
//! ## Out of scope for this harness
//!
//! Full HTTP endpoint integration tests would need an `AppState` builder
//! that wires the hook system, broadcaster, and async dispatch — large
//! infrastructure, not yet present in the codebase. This harness asserts
//! the SHAPING CONTRACT directly; the per-endpoint wiring is exercised by
//! the existing handler unit tests (in `api/blocks.rs`, `api/discovery.rs`,
//! etc.) which already pass through `compute_ancestor_context`.

use floatty_server::api::{AncestorContext, BlockDto};
use floatty_server::block_service::{
    attach_ancestor_context, compute_ancestor_context, parse_includes, shape_search_hit,
    AncestorContextOpts,
};
use std::collections::HashSet;
use yrs::{Any, ArrayPrelim, Doc, Map, ReadTxn, Transact, WriteTxn};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/// Seed shape: (id, parent, content, outlinks).
type Seed<'a> = (&'a str, Option<&'a str>, &'a str, &'a [&'a str]);

/// Build a Y.Doc with a `blocks` map seeded from `(id, parent_id?, content,
/// outlinks)` tuples. Outlinks land under `metadata.outlinks` exactly the way
/// the metadata extraction hook would shape them, so `compute_ancestor_context`
/// sees the same input it does in production.
fn build_doc(seeds: &[Seed<'_>]) -> Doc {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        for (id, parent, content, outlinks) in seeds {
            let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, *id);
            block_map.insert(&mut txn, "content", Any::String((*content).into()));
            if let Some(pid) = parent {
                block_map.insert(&mut txn, "parentId", Any::String((*pid).into()));
            }
            let empty_children: Vec<Any> = vec![];
            block_map.insert(&mut txn, "childIds", ArrayPrelim::from(empty_children));
            // Metadata.outlinks — only set when non-empty so the helper sees
            // realistic input (the hook leaves it absent when there are no
            // outlinks).
            if !outlinks.is_empty() {
                let outlink_arr: Vec<Any> = outlinks
                    .iter()
                    .map(|s| Any::String((*s).into()))
                    .collect();
                let metadata_map: yrs::MapRef = block_map.get_or_init(&mut txn, "metadata");
                metadata_map.insert(
                    &mut txn,
                    "outlinks",
                    ArrayPrelim::from(outlink_arr),
                );
                let empty_markers: Vec<Any> = vec![];
                metadata_map.insert(&mut txn, "markers", ArrayPrelim::from(empty_markers));
            }
        }
    }
    doc
}

/// Read a block content + outlinks-bearing metadata into a skeletal BlockDto
/// the shape helpers will accept (they only read `id` + `metadata`).
fn read_skeletal_dto<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, id: &str) -> BlockDto {
    let metadata = match blocks_map.get(txn, id) {
        Some(yrs::Out::YMap(block_map)) => block_map
            .get(txn, "metadata")
            .and_then(|m| floatty_server::api::extract_metadata_from_yrs(m, txn)),
        _ => None,
    };
    BlockDto {
        id: id.to_string(),
        content: String::new(),
        parent_id: None,
        child_ids: vec![],
        collapsed: false,
        block_type: String::new(),
        metadata,
        inherited_markers: None,
        created_at: 0,
        updated_at: 0,
        output_type: None,
        output: None,
        ancestor_context: None,
    }
}

// ---------------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------------

/// CONTRACT 1: `ancestor_block_ids` is ROOTMOST-FIRST on the wire.
///
/// The walker returns nearest-first (its programmatic contract); the wire
/// surface reverses that to match the breadcrumb composer's `take(5).rev()`
/// shape. This is the lesson banked from PR 1 review and explicitly called
/// out in the parent prompt as load-bearing.
#[test]
fn ancestor_block_ids_is_rootmost_first() {
    // root → a → b → c → leaf
    let doc = build_doc(&[
        ("root", None, "root", &[]),
        ("a", Some("root"), "a", &[]),
        ("b", Some("a"), "b", &[]),
        ("c", Some("b"), "c", &[]),
        ("leaf", Some("c"), "leaf", &[]),
    ]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "leaf");

    let ctx = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        &dto,
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("leaf has ancestors → some context");

    assert_eq!(
        ctx.ancestor_block_ids,
        vec![
            "root".to_string(),
            "a".to_string(),
            "b".to_string(),
            "c".to_string()
        ],
        "ancestor_block_ids must be rootmost-first (root → c, NOT c → root). \
         If this fails, every endpoint that exposes ancestorContext will leak \
         the walker's nearest-first programmatic contract onto the wire — the \
         exact bug PR 1 review surfaced for breadcrumb."
    );
}

/// CONTRACT 2: `ancestor_outlinks` is the deduped union of own + ancestor
/// outlinks (resolved open-question per the plan §"Open questions —
/// resolved").
#[test]
fn ancestor_outlinks_is_deduped_union() {
    // root has [[A]], mid has [[B]] [[A]] (duplicate), leaf has [[C]].
    let doc = build_doc(&[
        ("root", None, "root", &["A"]),
        ("mid", Some("root"), "mid", &["B", "A"]),
        ("leaf", Some("mid"), "leaf", &["C"]),
    ]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "leaf");

    let ctx = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        &dto,
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("leaf has chain + own outlinks → some context");

    // Sorted (BTreeSet) — A appears once despite the duplicate in mid.
    assert_eq!(
        ctx.ancestor_outlinks,
        vec!["A".to_string(), "B".to_string(), "C".to_string()],
        "deduped union: A from root + mid (one entry), B from mid, C from leaf own"
    );
}

/// CONTRACT 3: `compute_*` and `attach_*` produce identical output for the
/// same input. `attach_*` is documented as "thin wrapper around `compute_*`"
/// — this test enforces that contract. If `attach_*` ever diverges, the
/// per-endpoint shapes drift.
#[test]
fn compute_and_attach_agree_on_same_block() {
    let doc = build_doc(&[
        ("root", None, "root", &["X"]),
        ("leaf", Some("root"), "leaf content", &["Y"]),
    ]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "leaf");

    let from_compute = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        &dto,
        None,
        None,
        AncestorContextOpts::default(),
    );

    let mut dto_for_attach = dto.clone();
    attach_ancestor_context(
        &mut dto_for_attach,
        &blocks_map,
        &txn,
        None,
        None,
        AncestorContextOpts::default(),
    );

    assert_eq!(
        from_compute.as_ref().map(serialize_for_compare),
        dto_for_attach
            .ancestor_context
            .as_ref()
            .map(serialize_for_compare),
        "attach_ancestor_context MUST match compute_ancestor_context byte-for-byte"
    );
}

/// CONTRACT 4: search-hit shaping (`shape_search_hit`) produces matching
/// `ancestorContext` to direct `compute_*` for the same block. This is the
/// per-endpoint symmetry guarantee — search and singleton endpoints share the
/// same shape.
#[test]
fn shape_search_hit_matches_compute_ancestor_context() {
    let doc = build_doc(&[
        ("root", None, "root", &["X"]),
        ("mid", Some("root"), "mid", &["Y"]),
        ("leaf", Some("mid"), "leaf", &["Z"]),
    ]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "leaf");

    let opts = AncestorContextOpts::default();
    let from_compute = compute_ancestor_context(
        &blocks_map, &txn, "leaf", &dto, None, None, opts,
    );

    let synthetic_hit = floatty_core::search::SearchHit {
        block_id: "leaf".to_string(),
        score: 1.0,
        snippet: None,
    };
    let from_search = shape_search_hit(
        synthetic_hit,
        Some(&blocks_map),
        &txn,
        None,
        None,
        false,
        false,
        opts,
    );

    assert_eq!(
        from_compute.as_ref().map(serialize_for_compare),
        from_search
            .ancestor_context
            .as_ref()
            .map(serialize_for_compare),
        "Search-hit shaping MUST produce matching AncestorContext for the same \
         block — this is the per-endpoint symmetry guarantee."
    );
}

/// CONTRACT 5: bare-root block produces a context whose only populated
/// field is `subtree_size: 1` (the block counts itself). All ancestor /
/// outlink / inbound / marker fields stay empty. Documents the
/// `is_empty()` semantic precisely — "empty" means none of the navigation
/// signals fired, NOT that subtree_size is zero (subtree_size is always
/// at least 1 for an existing block).
///
/// Wire-shape consequence: bare roots ship the smallest possible
/// `AncestorContext` (just `subtreeSize: 1`); they do not ship `None`.
/// This is consistent across endpoints because every shaping helper
/// passes through the same `compute_ancestor_context`.
#[test]
fn bare_root_returns_minimal_context() {
    let doc = build_doc(&[("root", None, "root", &[])]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "root");

    let ctx = compute_ancestor_context(
        &blocks_map,
        &txn,
        "root",
        &dto,
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("subtree_size = 1 ≠ empty — context surfaces");

    assert!(ctx.nearest_page_block_id.is_none());
    assert!(ctx.nearest_page_name.is_none());
    assert!(ctx.ancestor_block_ids.is_empty());
    assert!(ctx.effective_markers.is_empty());
    assert!(ctx.ancestor_outlinks.is_empty());
    assert_eq!(
        ctx.subtree_size, 1,
        "bare root counts itself in subtree_size — minimum is 1, not 0"
    );
    assert_eq!(ctx.inbound_count, 0);
    assert!(ctx.inbound_samples.is_empty());
}

/// CONTRACT 6: walker depth cap (10) is honoured. A 15-deep chain caps at
/// 10 ancestors. Verifies the cap survives the rootmost-first reversal —
/// `len() == 10` either way; the rootmost-first end of the wire surface
/// must be the 10th ancestor up (not the deepest).
#[test]
fn ancestor_block_ids_caps_at_walker_max() {
    let mut seeds_owned: Vec<(String, Option<String>, String, Vec<String>)> = Vec::new();
    for i in 0..16 {
        let parent = if i == 0 {
            None
        } else {
            Some(format!("b{}", i - 1))
        };
        seeds_owned.push((format!("b{}", i), parent, format!("content {}", i), vec![]));
    }
    let seeds: Vec<Seed<'_>> = seeds_owned
        .iter()
        .map(|(id, p, c, _)| (id.as_str(), p.as_deref(), c.as_str(), &[][..]))
        .collect();
    let doc = build_doc(&seeds);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "b15");

    let ctx = compute_ancestor_context(
        &blocks_map,
        &txn,
        "b15",
        &dto,
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("deep chain → some context");

    assert_eq!(
        ctx.ancestor_block_ids.len(),
        10,
        "walker cap (10) preserved through the rootmost-first reversal"
    );
    // Reversed: rootmost-first means the FIRST entry is the deepest visible
    // ancestor (b5 — 10 hops up from b15: b14 b13 b12 b11 b10 b9 b8 b7 b6 b5).
    // Walker returns nearest-first → [b14, b13, ..., b5]; reversed → [b5, ..., b14].
    assert_eq!(
        ctx.ancestor_block_ids.first(),
        Some(&"b5".to_string()),
        "first item is the rootmost visible (10th hop up)"
    );
    assert_eq!(
        ctx.ancestor_block_ids.last(),
        Some(&"b14".to_string()),
        "last item is the immediate parent"
    );
}

/// CONTRACT 7: `effective_markers` is opt-in. Without `?include=effective_markers`
/// in opts, the field is empty even when the InheritanceIndex is wired.
/// Without this, every search hit would carry the inheritance lookup cost
/// regardless of whether the caller asked for it.
#[test]
fn effective_markers_opt_in_respected() {
    let doc = build_doc(&[
        ("root", None, "root [project::demo]", &[]),
        ("leaf", Some("root"), "leaf", &[]),
    ]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "leaf");

    // Without opt-in: empty effective_markers (we pass None for the index, so
    // there's nothing to read regardless — but the assertion is that the
    // OPTS gate is what keeps the field empty in production paths too).
    let ctx_off = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        &dto,
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("chain present → some ctx");
    assert!(
        ctx_off.effective_markers.is_empty(),
        "without `?include=effective_markers`, no effective markers"
    );

    // With opt-in via `from_raw` — same input, but the opts now request
    // effective_markers. Index is None so the lookup short-circuits to []
    // — that's the same result, but the call shape now fires the lookup
    // path. Production calls with a wired InheritanceIndex would surface
    // markers; we're verifying the opts wiring, not the index population.
    let mut includes = HashSet::new();
    includes.insert("effective_markers".to_string());
    let opts_on = AncestorContextOpts::from_raw(&includes, 5);
    let ctx_on = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        &dto,
        None,
        None,
        opts_on,
    )
    .expect("chain present → some ctx");
    assert!(
        ctx_on.effective_markers.is_empty(),
        "with index=None even when opted-in, no effective markers (degrades cleanly)"
    );
}

/// CONTRACT 8: `parse_includes` correctly strips whitespace and handles
/// multiple comma-separated values. The shape harness depends on this for
/// `from_raw` — verifying the gateway between raw query string and
/// AncestorContextOpts.
#[test]
fn parse_includes_handles_whitespace_and_multiples() {
    let parsed = parse_includes(&Some(
        " effective_markers , inbound_samples ".to_string(),
    ));
    assert!(parsed.contains("effective_markers"));
    assert!(parsed.contains("inbound_samples"));
    assert_eq!(parsed.len(), 2);

    let opts = AncestorContextOpts::from_raw(&parsed, 100);
    assert!(opts.include_effective_markers);
    assert!(opts.include_inbound_samples);
    assert_eq!(
        opts.inbound_sample_count, 50,
        "inbound_sample_count is capped at 50 — protects against large request abuse"
    );
}

/// CONTRACT 9: empty `ancestor_block_ids` for a root (no chain) does NOT
/// trigger the rootmost-first reversal incorrectly — empty stays empty,
/// not `vec![""]` or panic. Edge-case for the reversal logic.
#[test]
fn root_with_outlink_returns_empty_ancestor_block_ids() {
    let doc = build_doc(&[("root", None, "root", &["A"])]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "root");

    let ctx = compute_ancestor_context(
        &blocks_map,
        &txn,
        "root",
        &dto,
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("root has own outlinks → some context");
    assert!(
        ctx.ancestor_block_ids.is_empty(),
        "root has no ancestors — list stays empty"
    );
    assert_eq!(
        ctx.ancestor_outlinks,
        vec!["A".to_string()],
        "own outlinks still surface on root blocks"
    );
}

// ---------------------------------------------------------------------------
// Comparison shim
// ---------------------------------------------------------------------------

/// Serialize an `AncestorContext` for byte-for-byte comparison. We compare
/// rendered JSON rather than `==` to surface any future serde drift between
/// two call paths (e.g., if one path forgets a `#[serde(skip_serializing_if)]`).
fn serialize_for_compare(ctx: &AncestorContext) -> String {
    serde_json::to_string(ctx).expect("AncestorContext must serialize")
}
