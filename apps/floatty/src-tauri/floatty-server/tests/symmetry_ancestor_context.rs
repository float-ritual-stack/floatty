//! FLO-679 PR 2 — Symmetry harness for `AncestorContext`.
//!
//! ## What this is
//!
//! Plan §"PR 2 commits" #9. Asserts that the SAME block, viewed through
//! every shaping helper that funnels into a block-returning endpoint,
//! produces a MATCHING `AncestorContext`. Regression net for the
//! shape-consistency contract across `/api/v1/blocks/:id`,
//! `/api/v1/search`, presence, daily, etc.
//!
//! ## Why this is the right shape of test
//!
//! Every endpoint funnels through one of:
//! - `compute_ancestor_context` (singletons, presence, page-search, daily)
//! - `attach_ancestor_context` (thin wrapper around the above)
//! - `shape_search_hit` (BlockSearchHit)
//!
//! If those three produce matching shapes for the same Y.Doc fixture, every
//! endpoint above them does too — they're projections of the same call. The
//! plan's "every endpoint × matching ancestorContext" guarantee reduces to
//! these three call sites because all block-returning endpoints flow through
//! the same `block_service::*` helpers.
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
//!    fixture — i.e., block-returning endpoints can never drift again
//!    because they all flow through the same shaping function.
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

use floatty_core::{InheritanceIndex, InheritedMarker, PageNameIndex};
use floatty_server::api::{AncestorContext, BlockDto, BlockKind};
use floatty_server::block_service::{
    attach_ancestor_context, classify_block_kind, compute_ancestor_context,
    compute_ancestor_context_with_hints, parse_includes, shape_search_hit, AncestorContextHints,
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
                let outlink_arr: Vec<Any> =
                    outlinks.iter().map(|s| Any::String((*s).into())).collect();
                let metadata_map: yrs::MapRef = block_map.get_or_init(&mut txn, "metadata");
                metadata_map.insert(&mut txn, "outlinks", ArrayPrelim::from(outlink_arr));
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
        output_status: None,
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
        dto.metadata.as_ref(),
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
        dto.metadata.as_ref(),
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
        dto.metadata.as_ref(),
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
        &blocks_map,
        &txn,
        "leaf",
        dto.metadata.as_ref(),
        None,
        None,
        opts,
    );

    let synthetic_hit = floatty_core::search::SearchHit {
        block_id: "leaf".to_string(),
        score: 1.0,
        snippet: None,
        // Symmetry test exercises the no-hint fallback path so search-shape
        // and singleton-shape produce IDENTICAL ancestorContext for the
        // same fixture. The Tantivy STORED hints (subtree_size_hint etc.)
        // are wiring-only — they don't change the shape of the produced
        // AncestorContext, only skip recomputing fields the indexer already
        // populated. Default to None here (no hints available) so the
        // shaping helper falls back to the same Y.Doc walks the singleton
        // path uses.
        ..Default::default()
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

/// CONTRACT 5: bare-root block (no chain, no outlinks, no markers, no
/// inbound) returns `None` from `compute_ancestor_context` — keeps the
/// wire surface terse on blocks with no navigation signal.
///
/// `subtree_size` is intentionally NOT a navigation signal here: every
/// existing block trivially has `subtree_size >= 1` (it counts itself), so
/// gating `None` on `subtree_size == 0` would make every block surface a
/// `Some(ctx)` with just `subtreeSize: 1` — pure noise. The `is_empty()`
/// docstring matches: "empty" = no navigation signal fired, regardless of
/// `subtree_size`.
///
/// Wire-shape consequence: bare roots ship `ancestorContext: None`
/// (suppressed by `#[serde(skip_serializing_if = "Option::is_none")]`).
/// Once any signal fires (own outlinks, inbound, an ancestor chain),
/// the context surfaces with `subtreeSize` populated alongside.
#[test]
fn bare_root_returns_none() {
    let doc = build_doc(&[("root", None, "root", &[])]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "root");

    let ctx = compute_ancestor_context(
        &blocks_map,
        &txn,
        "root",
        dto.metadata.as_ref(),
        None,
        None,
        AncestorContextOpts::default(),
    );

    assert!(
        ctx.is_none(),
        "bare root with no navigation signal must return None — keeps the wire \
         surface terse. If this fails, every block in the outline will ship a \
         pointless ancestorContext payload."
    );
}

/// CONTRACT 6: walker depth cap (`ANCESTOR_CONTEXT_MAX_DEPTH = 20`) is
/// honoured. A 25-deep chain caps at 20 ancestors. Verifies the cap survives
/// the rootmost-first reversal — `len() == 20` either way; the rootmost-first
/// end of the wire surface must be the 20th ancestor up (not the deepest).
///
/// Cap was 10 before 2026-04-26; bumped to 20 after a live-outline depth
/// probe found real-world max=16 (~700 blocks above the old cap). See
/// `block_service.rs::ANCESTOR_CONTEXT_MAX_DEPTH` for the full rationale.
#[test]
fn ancestor_block_ids_caps_at_walker_max() {
    // 25 blocks: b0 (root) → b1 → ... → b24 (leaf). 24 ancestors above b24,
    // walker caps at 20 → expect 20 visible (b4..b23).
    let mut seeds_owned: Vec<(String, Option<String>, String, Vec<String>)> = Vec::new();
    for i in 0..25 {
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
    let dto = read_skeletal_dto(&blocks_map, &txn, "b24");

    let ctx = compute_ancestor_context(
        &blocks_map,
        &txn,
        "b24",
        dto.metadata.as_ref(),
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("deep chain → some context");

    assert_eq!(
        ctx.ancestor_block_ids.len(),
        20,
        "walker cap (ANCESTOR_CONTEXT_MAX_DEPTH = 20) preserved through the rootmost-first reversal"
    );
    // Reversed: rootmost-first means the FIRST entry is the deepest visible
    // ancestor (b4 — 20 hops up from b24: b23 b22 b21 b20 b19 b18 b17 b16
    // b15 b14 b13 b12 b11 b10 b9 b8 b7 b6 b5 b4).
    // Walker returns nearest-first → [b23, b22, ..., b4]; reversed → [b4, ..., b23].
    assert_eq!(
        ctx.ancestor_block_ids.first(),
        Some(&"b4".to_string()),
        "first item is the rootmost visible (20th hop up)"
    );
    assert_eq!(
        ctx.ancestor_block_ids.last(),
        Some(&"b23".to_string()),
        "last item is the immediate parent"
    );
}

/// CONTRACT 7: `effective_markers` is opt-in. Without `?include=effective_markers`
/// in opts, the field is empty even when the InheritanceIndex is wired with
/// real inherited markers. With `?include=effective_markers` AND a wired
/// index, the field populates.
///
/// PR #282 review (CodeRabbit Minor) banked this lesson: behavior-preservation
/// tests preserve INTENT, not necessarily CORRECTNESS. The prior test passed
/// `None` for the index in BOTH branches, so `effective_markers` stayed empty
/// regardless of the gate — a regression that eagerly populated markers
/// would still pass. This version builds a real `InheritanceIndex` fixture
/// via `set_inherited` and proves the gate actually flips.
#[test]
fn effective_markers_opt_in_respected() {
    let doc = build_doc(&[
        ("root", None, "root [project::demo]", &[]),
        ("leaf", Some("root"), "leaf", &[]),
    ]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "leaf");

    // Real InheritanceIndex fixture: `leaf` inherits `[project::demo]` from
    // `root`. Production path is `index.rebuild(&YDocStore)` walking ancestor
    // metadata; this test uses the `set_inherited` direct mutator so the
    // assertion focuses on the OPTS gate rather than rebuild correctness
    // (which has its own coverage in `floatty_core::hooks::inheritance_index`).
    let mut inh = InheritanceIndex::new();
    inh.set_inherited(
        "leaf",
        vec![InheritedMarker {
            marker_type: "project".to_string(),
            value: "demo".to_string(),
            source_block_id: "root".to_string(),
        }],
    );

    // GATE OFF: without `?include=effective_markers` in opts, the field
    // stays empty even though the wired index has data for "leaf". This is
    // the load-bearing assertion — if a regression made `compute_*`
    // eagerly read the index regardless of opts, this would fail.
    let ctx_off = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        dto.metadata.as_ref(),
        Some(&inh),
        None,
        AncestorContextOpts::default(),
    )
    .expect("chain present → some ctx");
    assert!(
        ctx_off.effective_markers.is_empty(),
        "without `?include=effective_markers`, no effective markers — \
         even when the InheritanceIndex has data for this block"
    );

    // GATE ON: same input + same wired index, but opts now request
    // effective_markers. The inherited [project::demo] from root surfaces.
    let mut includes = HashSet::new();
    includes.insert("effective_markers".to_string());
    let opts_on = AncestorContextOpts::from_raw(&includes, 5);
    let ctx_on = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        dto.metadata.as_ref(),
        Some(&inh),
        None,
        opts_on,
    )
    .expect("chain present → some ctx");
    assert!(
        !ctx_on.effective_markers.is_empty(),
        "with `?include=effective_markers` AND a wired index with data, \
         effective_markers must populate — proves the gate flips"
    );
    let project_marker = ctx_on
        .effective_markers
        .iter()
        .find(|m| m.marker_type == "project")
        .expect("inherited [project::demo] from root must surface when gate is ON");
    assert_eq!(
        project_marker.value, "demo",
        "value preserved through the inheritance lookup"
    );
}

/// CONTRACT 8: `parse_includes` correctly strips whitespace and handles
/// multiple comma-separated values. The shape harness depends on this for
/// `from_raw` — verifying the gateway between raw query string and
/// AncestorContextOpts.
#[test]
fn parse_includes_handles_whitespace_and_multiples() {
    let parsed = parse_includes(&Some(" effective_markers , inbound_samples ".to_string()));
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

/// CONTRACT 8b (PR #303 review — CodeRabbit Major): `from_raw_with_caps`
/// threads `children_preview_count` through and caps it at 20. The search-
/// blocks path was using `from_raw` which ignored the caller's
/// `children_preview_count` value, leaving the singleton path
/// (`from_query` → cap respected) and search path asymmetric.
///
/// This test locks both the threading AND the cap. The actual symmetry
/// fix lives at the `search_blocks` call site swap from `from_raw` →
/// `from_raw_with_caps`; this test catches a regression that swapped it
/// back.
#[test]
fn from_raw_with_caps_threads_children_preview_count() {
    let mut includes = HashSet::new();
    includes.insert("children_preview".to_string());

    // Caller-supplied cap honoured.
    let opts = AncestorContextOpts::from_raw_with_caps(&includes, 5, 12);
    assert!(opts.include_children_preview);
    assert_eq!(
        opts.children_preview_count, 12,
        "children_preview_count threaded through from_raw_with_caps"
    );

    // Cap at 20 — protects against per-hit cost blowup on broad searches.
    let opts_huge = AncestorContextOpts::from_raw_with_caps(&includes, 5, 999);
    assert_eq!(
        opts_huge.children_preview_count, 20,
        "children_preview_count capped at 20 regardless of caller"
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
        dto.metadata.as_ref(),
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

/// CONTRACT 10 (PR #282 review — CodeRabbit Major / Greptile P2): when a
/// search hit's stored hint is capped at `INBOUND_SAMPLES_CAP` (5) but the
/// consumer requests more samples (`?inbound_sample_count > 5`) AND total
/// inbound count exceeds 5, the helper MUST fall back to the live
/// `PageNameIndex` path so the consumer gets up to `min(N, 50)` samples
/// instead of a silently-truncated 5.
///
/// Three branches verified:
/// 1. requested_cap > 5 AND total > 5 → fallback fires (live path returns 8)
/// 2. requested_cap ≤ 5 → trust the hint (returns 5)
/// 3. total ≤ 5 → trust the hint even when requested_cap is large
///    (no fallback could surface more samples anyway)
#[test]
fn inbound_sample_cap_falls_back_when_hint_insufficient() {
    // Page "Target" with 8 inbound references — exceeds INBOUND_SAMPLES_CAP (5).
    // Each inbound block has a metadata.outlinks entry pointing at "Target".
    //
    // Layout: leaf is the block being shaped (NOT a page). Its parent is
    // the "Target" page block (a child of `pages::`) so `nearest_page_name`
    // resolves to "Target". The 8 inbound source blocks are siblings under a
    // separate root.
    let doc = build_doc(&[
        // Pages container + the target page
        ("pages", None, "pages::", &[]),
        ("target_page", Some("pages"), "# Target", &[]),
        ("leaf", Some("target_page"), "leaf content", &[]),
        // 8 inbound references — separate root, each links to "Target"
        ("ref_root", None, "ref root", &[]),
        ("ref1", Some("ref_root"), "ref 1", &["Target"]),
        ("ref2", Some("ref_root"), "ref 2", &["Target"]),
        ("ref3", Some("ref_root"), "ref 3", &["Target"]),
        ("ref4", Some("ref_root"), "ref 4", &["Target"]),
        ("ref5", Some("ref_root"), "ref 5", &["Target"]),
        ("ref6", Some("ref_root"), "ref 6", &["Target"]),
        ("ref7", Some("ref_root"), "ref 7", &["Target"]),
        ("ref8", Some("ref_root"), "ref 8", &["Target"]),
    ]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "leaf");

    // Build a real PageNameIndex with the 8 inbound references registered
    // against "Target". Lowercased per the PageNameIndex contract.
    let mut pni = PageNameIndex::new();
    pni.add_existing_page("target", "target_page");
    for ref_id in [
        "ref1", "ref2", "ref3", "ref4", "ref5", "ref6", "ref7", "ref8",
    ] {
        pni.add_references(ref_id, &["target".to_string()]);
    }

    // Hint state mirroring what the indexer would have written to Tantivy:
    //   inbound_count = 8 (true total)
    //   inbound_block_ids = top-5 only (sorted), per INBOUND_SAMPLES_CAP
    let mut sorted_top5: Vec<String> = vec![
        "ref1".to_string(),
        "ref2".to_string(),
        "ref3".to_string(),
        "ref4".to_string(),
        "ref5".to_string(),
    ];
    sorted_top5.sort();
    let hints = AncestorContextHints {
        subtree_size: None,
        inbound_count: Some(8),
        inbound_block_ids: Some(sorted_top5.clone()),
    };

    // Branch 1: requested_cap = 8 > INBOUND_SAMPLES_CAP (5) AND total = 8 > 5
    // → fallback fires, samples come from live PageNameIndex (all 8 ids).
    let mut includes = HashSet::new();
    includes.insert("inbound_samples".to_string());
    let opts_large = AncestorContextOpts::from_raw(&includes, 8);
    let ctx_large = compute_ancestor_context_with_hints(
        &blocks_map,
        &txn,
        "leaf",
        dto.metadata.as_ref(),
        None,
        Some(&pni),
        opts_large,
        hints.clone(),
    )
    .expect("leaf has chain → some ctx");
    assert_eq!(
        ctx_large.inbound_count, 8,
        "inbound_count reflects the true total (hint was correct on count)"
    );
    assert_eq!(
        ctx_large.inbound_samples.len(),
        8,
        "fallback fired: live PageNameIndex returned all 8 samples — hint's \
         5-id capacity would have silently truncated to 5"
    );

    // Branch 2: requested_cap = 3 ≤ INBOUND_SAMPLES_CAP (5)
    // → hint is sufficient, no fallback needed; truncated to 3.
    let opts_small = AncestorContextOpts::from_raw(&includes, 3);
    let ctx_small = compute_ancestor_context_with_hints(
        &blocks_map,
        &txn,
        "leaf",
        dto.metadata.as_ref(),
        None,
        Some(&pni),
        opts_small,
        hints.clone(),
    )
    .expect("leaf has chain → some ctx");
    assert_eq!(
        ctx_small.inbound_samples.len(),
        3,
        "requested_cap ≤ 5: hint sufficient, truncated to requested_cap"
    );

    // Branch 3: total inbound count ≤ INBOUND_SAMPLES_CAP, even with large
    // requested_cap → trust the hint (no fallback could surface more).
    let small_total_hints = AncestorContextHints {
        subtree_size: None,
        inbound_count: Some(3),
        inbound_block_ids: Some(vec![
            "ref1".to_string(),
            "ref2".to_string(),
            "ref3".to_string(),
        ]),
    };
    let opts_large_small_total = AncestorContextOpts::from_raw(&includes, 50);
    let ctx_small_total = compute_ancestor_context_with_hints(
        &blocks_map,
        &txn,
        "leaf",
        dto.metadata.as_ref(),
        None,
        Some(&pni),
        opts_large_small_total,
        small_total_hints,
    )
    .expect("leaf has chain → some ctx");
    assert_eq!(
        ctx_small_total.inbound_count, 3,
        "count_hint Some(3) wins over PageNameIndex live count of 8 — \
         the hint is the count source when total ≤ cap"
    );
    assert_eq!(
        ctx_small_total.inbound_samples.len(),
        3,
        "total ≤ cap: hint is comprehensive, fallback unnecessary"
    );
}

// ---------------------------------------------------------------------------
// FLO-684 — BlockSearchHit timestamps + outputType symmetry
// ---------------------------------------------------------------------------

/// CONTRACT 7 (FLO-684): `shape_search_hit` carries `createdAt`,
/// `updatedAt`, and `outputType` directly from the block's Y.Map fields —
/// matching the singleton `read_block_dto` path that powers
/// `GET /api/v1/blocks/:id`.
///
/// Why this lives in the symmetry harness: the failure mode is silent
/// drift between two read paths. A future write path that updates the
/// Y.Map differently (or a `shape_search_hit` refactor that reads from a
/// stale Tantivy STORED column instead of the live block) would break
/// recency sort on the artifact's inbound panel and door-vs-text
/// classification on agent consumers — neither would be caught by the
/// per-handler unit tests because both surfaces still return *some*
/// value. This test asserts the values match the source of truth.
///
/// Companion to the indexer fix in
/// `floatty-core/src/hooks/tantivy_index.rs:244` (was `Utc::now()`,
/// now reads `block.updated_at`). The indexer fix protects Tantivy's
/// `updated_at` STORED column from drifting on every reindex; this test
/// protects the wire-level `BlockSearchHit` from drifting at response
/// shaping. Both layers must stay coherent for recency sort to work
/// across restarts.
#[test]
fn shape_search_hit_carries_timestamps_and_output_type() {
    let created_at_ms: i64 = 1_700_000_000_000;
    let updated_at_ms: i64 = 1_700_001_234_567;

    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, "the-block");
        block_map.insert(&mut txn, "content", Any::String("hello".into()));
        let empty_children: Vec<Any> = vec![];
        block_map.insert(&mut txn, "childIds", ArrayPrelim::from(empty_children));
        // f64 storage matches what the frontend writes via the Y.Map JS API
        // (numbers are f64 by default); `extract_timestamp` accepts both
        // f64 (Number) and i64 (BigInt) — both cases need to round-trip.
        block_map.insert(&mut txn, "createdAt", Any::Number(created_at_ms as f64));
        block_map.insert(&mut txn, "updatedAt", Any::Number(updated_at_ms as f64));
        block_map.insert(&mut txn, "outputType", Any::String("door".into()));
    }
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");

    let synthetic_hit = floatty_core::search::SearchHit {
        block_id: "the-block".to_string(),
        score: 1.0,
        snippet: None,
        ..Default::default()
    };
    let hit = shape_search_hit(
        synthetic_hit,
        Some(&blocks_map),
        &txn,
        None,
        None,
        false,
        false,
        AncestorContextOpts::default(),
    );

    assert_eq!(
        hit.created_at, created_at_ms,
        "BlockSearchHit.createdAt must equal the block's Y.Map createdAt — \
         protects recency sort and creation-time queries against write-path \
         drift between BlockDto (singleton path) and BlockSearchHit (search \
         path)."
    );
    assert_eq!(
        hit.updated_at, updated_at_ms,
        "BlockSearchHit.updatedAt must equal the block's Y.Map updatedAt — \
         this is the same symmetry FLO-684 fixed at the indexer level. The \
         indexer was clobbering Tantivy's updated_at with Utc::now() at \
         index time; this test ensures the wire-level DTO doesn't introduce \
         a parallel drift at response shaping."
    );
    assert_eq!(
        hit.output_type.as_deref(),
        Some("door"),
        "BlockSearchHit.outputType must mirror BlockDto.outputType so MCP \
         and agent consumers can distinguish a door spec from a plain text \
         block without a follow-up /blocks/:id GET (the N+1 the FLO-684 \
         plumbing eliminates)."
    );
}

/// CONTRACT 7b (FLO-684): the no-blocks-map early-return path produces a
/// hit with default-zero timestamps + `None` outputType. Some test paths
/// synthesize hits without a Y.Doc — the wire shape stays stable
/// (zero-value gets dropped via `skip_serializing_if`).
#[test]
fn shape_search_hit_without_blocks_map_defaults_timestamp_fields() {
    let synthetic_hit = floatty_core::search::SearchHit {
        block_id: "ghost-block".to_string(),
        score: 0.5,
        snippet: None,
        ..Default::default()
    };
    // No txn is read on this path — pass a throwaway one for the signature.
    let doc = Doc::new();
    let txn = doc.transact();
    let hit = shape_search_hit(
        synthetic_hit,
        None,
        &txn,
        None,
        None,
        false,
        false,
        AncestorContextOpts::default(),
    );

    assert_eq!(
        hit.created_at, 0,
        "no-blocks-map path: createdAt defaults to 0"
    );
    assert_eq!(
        hit.updated_at, 0,
        "no-blocks-map path: updatedAt defaults to 0"
    );
    assert_eq!(
        hit.output_type, None,
        "no-blocks-map path: outputType defaults to None"
    );
    // Sanity-check the serde guards drop zero/None on the wire so consumers
    // don't see noise from the synthetic-hit path.
    let json = serde_json::to_string(&hit).expect("serializes");
    assert!(
        !json.contains("\"createdAt\""),
        "skip_serializing_if drops zero createdAt: {json}"
    );
    assert!(
        !json.contains("\"updatedAt\""),
        "skip_serializing_if drops zero updatedAt: {json}"
    );
    assert!(
        !json.contains("\"outputType\""),
        "skip_serializing_if drops None outputType: {json}"
    );
}

// ---------------------------------------------------------------------------
// Backlinks legibility — nav_classification opt-in (PR-B Tier 2A)
// ---------------------------------------------------------------------------

/// CONTRACT 11: `kind` is opt-in via `?include=nav_classification`. Without
/// the directive, `kind` is None even for a heading-shaped block. With the
/// directive, the field populates with the classification derived from
/// content-shape + child-presence.
///
/// `is_empty()` exclusion (mirrors subtree_size): a bare-root block with
/// only `kind` populated should still return `None` from
/// `compute_ancestor_context` — kind is not a navigation signal on its own.
/// This test exercises a block with a real chain so the ctx surfaces and
/// `kind` rides along, NOT a bare root that would be `None` regardless.
#[test]
fn nav_classification_opt_in_respected() {
    // root → leaf, where leaf has heading-shaped content.
    let doc = build_doc(&[
        ("root", None, "root", &[]),
        ("leaf", Some("root"), "## arcs", &[]),
    ]);
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "leaf");

    // GATE OFF: default opts → no `nav_classification` directive → kind None.
    let ctx_off = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        dto.metadata.as_ref(),
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("leaf has chain → some ctx");
    assert_eq!(
        ctx_off.kind, None,
        "without `?include=nav_classification`, kind stays None — \
         even when the block content is heading-shaped"
    );

    // GATE ON: opts include `nav_classification` → kind populated.
    let mut includes = HashSet::new();
    includes.insert("nav_classification".to_string());
    let opts_on = AncestorContextOpts::from_raw(&includes, 5);
    let ctx_on = compute_ancestor_context(
        &blocks_map,
        &txn,
        "leaf",
        dto.metadata.as_ref(),
        None,
        None,
        opts_on,
    )
    .expect("leaf has chain → some ctx");
    // "## arcs" with no children → leaf_marker (heading-only, no kids).
    assert_eq!(
        ctx_on.kind,
        Some(BlockKind::LeafMarker),
        "with `?include=nav_classification`, kind classifies the block — \
         heading-only + no children → leaf_marker"
    );
}

/// `classify_block_kind` direct unit tests. Mirror the 6-row fixture in
/// `apps/floatty/src/lib/backlinkClassify.test.ts` so cross-implementation
/// drift is detected by re-running the matching fixture against either side.
#[test]
fn classify_block_kind_fixture_parity() {
    // Same rows as the TS test's `cross-implementation parity fixture`.
    // Order matters — drift is detected by index match.
    let fixtures: &[(&str, bool, BlockKind)] = &[
        ("## arcs", true, BlockKind::NavNode),
        ("## empty", false, BlockKind::LeafMarker),
        ("## arcs\nbody", true, BlockKind::ContentBlock),
        ("plain content", true, BlockKind::ContentBlock),
        ("", false, BlockKind::ContentBlock),
        ("## bones\n\n", true, BlockKind::NavNode),
    ];

    for (idx, (content, has_children, expected)) in fixtures.iter().enumerate() {
        let actual = classify_block_kind(content, *has_children);
        assert_eq!(
            actual, *expected,
            "row {idx}: classify_block_kind({content:?}, has_children={has_children}) \
             expected {expected:?}, got {actual:?}. Cross-implementation drift with \
             apps/floatty/src/lib/backlinkClassify.test.ts — re-run that test for the \
             matching row to identify which side moved."
        );
    }
}

/// Edge case: heading WITH prose + no children → content_block (NOT
/// leaf_marker). Caught during PR-A vitest run on 2026-05-08 — the rule
/// needed tightening from `(heading + no children → leaf)` to
/// `(heading_only + no children → leaf)`. Documented in
/// `block_service.rs::classify_block_kind` doc comment.
#[test]
fn classify_block_kind_heading_with_body_no_children_is_content() {
    assert_eq!(
        classify_block_kind("## arcs\nbody text", false),
        BlockKind::ContentBlock,
        "heading + body + no children must be content_block — the prose IS \
         the content. A too-greedy `(heading + !has_children → leaf_marker)` \
         rule mis-classifies this as leaf_marker."
    );
}

/// CONTRACT 12: `children_preview` is opt-in via
/// `?include=children_preview`. Without the directive, `children_preview`
/// is empty (Vec::is_empty drops it from the wire). With the directive,
/// the field populates with the first N children as `BlockRef`s. The cap
/// `&children_preview_count=N` is honoured (capped at 20).
///
/// Tests three branches:
/// 1. gate off → empty
/// 2. gate on, N=2 → exactly 2 children, content present
/// 3. gate on, N=999 → capped at 20 by AncestorContextOpts::from_query
///    constructor (caller can't bypass the cost-cap by passing huge N)
#[test]
fn children_preview_opt_in_and_cap_respected() {
    // Build a parent with 25 children so the cap-at-20 branch has room.
    let mut seeds_owned: Vec<(String, Option<String>, String, Vec<String>)> = Vec::new();
    seeds_owned.push(("root".to_string(), None, "root".to_string(), vec![]));
    seeds_owned.push((
        "parent".to_string(),
        Some("root".to_string()),
        "parent".to_string(),
        vec![],
    ));
    for i in 0..25 {
        seeds_owned.push((
            format!("c{}", i),
            Some("parent".to_string()),
            format!("child {} content", i),
            vec![],
        ));
    }
    let seeds: Vec<Seed<'_>> = seeds_owned
        .iter()
        .map(|(id, p, c, _)| (id.as_str(), p.as_deref(), c.as_str(), &[][..]))
        .collect();
    let doc = build_doc(&seeds);
    // Wire children into parent's childIds Y.Array. build_doc sets each block
    // to empty childIds — patch parent's childIds to include c0..c24 so
    // get_children_refs sees them.
    {
        let mut txn = doc.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let parent_map: yrs::MapRef = blocks.get_or_init(&mut txn, "parent");
        let child_id_strs: Vec<Any> = (0..25)
            .map(|i| Any::String(format!("c{}", i).into()))
            .collect();
        parent_map.insert(&mut txn, "childIds", ArrayPrelim::from(child_id_strs));
    }
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "parent");

    // Branch 1: gate off → empty.
    let ctx_off = compute_ancestor_context(
        &blocks_map,
        &txn,
        "parent",
        dto.metadata.as_ref(),
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("parent has chain → some ctx");
    assert!(
        ctx_off.children_preview.is_empty(),
        "without `?include=children_preview`, the field is empty"
    );

    // Branch 2: gate on, N=2 → exactly 2 children, content non-empty.
    let mut includes = HashSet::new();
    includes.insert("children_preview".to_string());
    let opts_n2 = AncestorContextOpts::from_raw_with_caps(&includes, 5, 2);
    let ctx_n2 = compute_ancestor_context(
        &blocks_map,
        &txn,
        "parent",
        dto.metadata.as_ref(),
        None,
        None,
        opts_n2,
    )
    .expect("parent has chain → some ctx");
    assert_eq!(
        ctx_n2.children_preview.len(),
        2,
        "N=2 returns exactly 2 children"
    );
    assert_eq!(
        ctx_n2.children_preview[0].id, "c0",
        "first child preserves childIds order"
    );
    assert_eq!(
        ctx_n2.children_preview[0].content, "child 0 content",
        "content under truncation cap survives intact"
    );

    // Branch 3: gate on, N=999 → capped at 20 by from_raw_with_caps.
    let opts_huge = AncestorContextOpts::from_raw_with_caps(&includes, 5, 999);
    let ctx_huge = compute_ancestor_context(
        &blocks_map,
        &txn,
        "parent",
        dto.metadata.as_ref(),
        None,
        None,
        opts_huge,
    )
    .expect("parent has chain → some ctx");
    assert_eq!(
        ctx_huge.children_preview.len(),
        20,
        "N=999 capped at 20 — protects against per-hit cost blowup on broad searches"
    );
}

/// CONTRACT 12b: content truncation at CHILDREN_PREVIEW_CONTENT_LIMIT (200).
/// Long child content gets sliced UTF-8-safely; short content survives intact.
#[test]
fn children_preview_truncates_long_content_utf8_safe() {
    // Content with multibyte chars near the 200-byte boundary.
    let long_content = "x".repeat(195) + "你好世界"; // 195 + 12 bytes (4 chars × 3) = 207 bytes
    let doc = build_doc(&[
        ("root", None, "root", &[]),
        ("parent", Some("root"), "parent", &[]),
        ("only_child", Some("parent"), &long_content, &[]),
    ]);
    {
        let mut txn = doc.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let parent_map: yrs::MapRef = blocks.get_or_init(&mut txn, "parent");
        let child_ids: Vec<Any> = vec![Any::String("only_child".into())];
        parent_map.insert(&mut txn, "childIds", ArrayPrelim::from(child_ids));
    }
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");
    let dto = read_skeletal_dto(&blocks_map, &txn, "parent");

    let mut includes = HashSet::new();
    includes.insert("children_preview".to_string());
    let opts = AncestorContextOpts::from_raw_with_caps(&includes, 5, 5);
    let ctx = compute_ancestor_context(
        &blocks_map,
        &txn,
        "parent",
        dto.metadata.as_ref(),
        None,
        None,
        opts,
    )
    .expect("parent has chain → some ctx");

    let preview = &ctx.children_preview[0];
    assert!(
        preview.content.len() <= 200,
        "truncated to ≤ 200 bytes (got {})",
        preview.content.len()
    );
    // Result must be valid UTF-8 (no half-character splits) — implicit via
    // String type, but assert via roundtrip just to make the contract loud.
    let _: &str = preview.content.as_str();
}

/// CONTRACT 13: `siblings` is opt-in via `?include=siblings`. Without
/// the directive, `siblings` is None. With the directive, the field
/// populates with prev/next siblings (radius=1) via `get_siblings` —
/// the SAME helper that powers `/blocks/:id?include=siblings`, so both
/// surfaces have identical SiblingContext shape by construction.
///
/// Edge cases verified:
/// - root block (no parent) → siblings None even with gate on
/// - middle child → before+after both populated
/// - first child → before empty, after populated
/// - last child → before populated, after empty
#[test]
fn siblings_opt_in_respected() {
    // root → parent → [c0, c1, c2]
    let doc = build_doc(&[
        ("root", None, "root", &[]),
        ("parent", Some("root"), "parent", &[]),
        ("c0", Some("parent"), "first child", &[]),
        ("c1", Some("parent"), "middle child", &[]),
        ("c2", Some("parent"), "last child", &[]),
    ]);
    {
        let mut txn = doc.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let parent_map: yrs::MapRef = blocks.get_or_init(&mut txn, "parent");
        let child_ids: Vec<Any> = vec![
            Any::String("c0".into()),
            Any::String("c1".into()),
            Any::String("c2".into()),
        ];
        parent_map.insert(&mut txn, "childIds", ArrayPrelim::from(child_ids));
    }
    let txn = doc.transact();
    let blocks_map = txn.get_map("blocks").expect("blocks map");

    let mut includes = HashSet::new();
    includes.insert("siblings".to_string());
    let opts_on = AncestorContextOpts::from_raw(&includes, 5);

    // Gate off: middle child returns None for siblings.
    let dto_c1 = read_skeletal_dto(&blocks_map, &txn, "c1");
    let ctx_off = compute_ancestor_context(
        &blocks_map,
        &txn,
        "c1",
        dto_c1.metadata.as_ref(),
        None,
        None,
        AncestorContextOpts::default(),
    )
    .expect("c1 has chain → some ctx");
    assert!(
        ctx_off.siblings.is_none(),
        "without `?include=siblings`, the field stays None"
    );

    // Gate on, middle child: before=c0, after=c2.
    let ctx_middle = compute_ancestor_context(
        &blocks_map,
        &txn,
        "c1",
        dto_c1.metadata.as_ref(),
        None,
        None,
        opts_on,
    )
    .expect("c1 has chain → some ctx");
    let sib = ctx_middle
        .siblings
        .expect("siblings populated when gate on");
    assert_eq!(sib.before.len(), 1, "middle child: one before");
    assert_eq!(sib.before[0].id, "c0");
    assert_eq!(sib.after.len(), 1, "middle child: one after");
    assert_eq!(sib.after[0].id, "c2");

    // First child: before empty, after has c1.
    let dto_c0 = read_skeletal_dto(&blocks_map, &txn, "c0");
    let ctx_first = compute_ancestor_context(
        &blocks_map,
        &txn,
        "c0",
        dto_c0.metadata.as_ref(),
        None,
        None,
        opts_on,
    )
    .expect("c0 has chain → some ctx");
    let sib_first = ctx_first.siblings.expect("siblings populated");
    assert!(sib_first.before.is_empty(), "first child: before empty");
    assert_eq!(sib_first.after.len(), 1);
    assert_eq!(sib_first.after[0].id, "c1");

    // Last child: before has c1, after empty.
    let dto_c2 = read_skeletal_dto(&blocks_map, &txn, "c2");
    let ctx_last = compute_ancestor_context(
        &blocks_map,
        &txn,
        "c2",
        dto_c2.metadata.as_ref(),
        None,
        None,
        opts_on,
    )
    .expect("c2 has chain → some ctx");
    let sib_last = ctx_last.siblings.expect("siblings populated");
    assert_eq!(sib_last.before.len(), 1);
    assert_eq!(sib_last.before[0].id, "c1");
    assert!(sib_last.after.is_empty(), "last child: after empty");

    // Root block (no parent): siblings stays None even with gate on.
    // Skip — bare root would return None from compute_ancestor_context entirely
    // (no chain, no outlinks). Use a root with an outlink so we get a ctx
    // back, then assert siblings is None on that.
    let doc2 = build_doc(&[("solo_root", None, "solo", &["A"])]);
    let txn2 = doc2.transact();
    let blocks_map2 = txn2.get_map("blocks").expect("blocks map");
    let dto_solo = read_skeletal_dto(&blocks_map2, &txn2, "solo_root");
    let ctx_solo = compute_ancestor_context(
        &blocks_map2,
        &txn2,
        "solo_root",
        dto_solo.metadata.as_ref(),
        None,
        None,
        opts_on,
    )
    .expect("root has own outlink → some ctx");
    assert!(
        ctx_solo.siblings.is_none(),
        "root block (no parent) has no siblings — None even with gate on"
    );
}

/// Edge case: trailing-newline shapes still count as heading-only. The
/// edit-time DOM serialisation occasionally introduces trailing `\n` or
/// `\n\n` on heading blocks; the classifier must tolerate them.
#[test]
fn classify_block_kind_tolerates_trailing_newlines() {
    assert_eq!(
        classify_block_kind("## bones\n", true),
        BlockKind::NavNode,
        "trailing single newline still heading-only"
    );
    assert_eq!(
        classify_block_kind("## tldr\n\n", true),
        BlockKind::NavNode,
        "trailing double newline still heading-only"
    );
    assert_eq!(
        classify_block_kind("# top\n", false),
        BlockKind::LeafMarker,
        "trailing single newline + no children still heading-only → leaf_marker"
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
