//! Path-address resolution — `GET /api/v1/resolve` (ADR-008 D5/D6, read side).
//!
//! Agent-facing counterpart to the low-level block CRUD: given a multi-segment
//! path (`page > section > block`), resolve it to a block without the agent
//! having to search → hunt block-id → GET. The grammar is parsed by the shared
//! `parse_path_segments` tokenizer (stage 1); segment 1 is always a page,
//! resolved via `PageNameIndex` (case-insensitive, oldest-createdAt); the
//! remaining segments walk down the child tree via the shared
//! [`walk_descendants`] primitive (stage 2a).
//!
//! Two modes over one grammar (ADR-008 D2):
//! - `mode=fuzzy` (default) — descendant selector, may skip levels, fuzzy
//!   ladder matching. This is the nav/read shape.
//! - `mode=exact` — direct-child only, no skipping, exact (write-predicate)
//!   matching. Mirrors what the mkdir-p WRITE path (stage 2b) would traverse.
//!
//! Miss policy (ADR-008 D3): a full miss on segment 1 is `404` (the page
//! doesn't exist — no junk-page creation from a read). A partial miss deeper in
//! the path is still `200` with `resolved: false`, the deepest-resolved block,
//! and the unresolved tail — so an agent can see how far the address got.
//!
//! The resolved (or deepest-resolved) block is returned in `BlockDto` shape
//! with `ancestorContext` attached via
//! [`crate::block_service::attach_ancestor_context`] — every block-returning
//! endpoint funnels through `compute_ancestor_context` (CLAUDE.md protected
//! architecture).

use axum::{extract::Query, extract::State, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use yrs::{Map, ReadTxn, Transact};

use super::{ApiError, AppState, BlockDto};
use crate::block_service::{
    attach_ancestor_context, extract_timestamp, lookup_inherited, read_block_dto,
    AncestorContextOpts,
};
use floatty_core::hooks::parsing::parse_path_segments;
use floatty_core::projections::{
    walk_descendants, DescendantCaps, DescendantTermination, MatchRung, NodeInfo, ResolveMode,
    YDocChildLookup,
};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/resolve", get(resolve_path))
}

// ============================================================================
// DTOs
// ============================================================================

/// Query parameters for `GET /api/v1/resolve`.
///
/// `path` is the (URL-decoded) multi-segment address. `mode` selects the
/// resolution mode; absent → fuzzy. camelCase + `deny_unknown_fields` per
/// `serde-api-patterns.md` — a mistyped param is a 400, not a silent drop.
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveQuery {
    /// The path to resolve, e.g. `page > section > block`.
    path: String,
    /// `"fuzzy"` (default) or `"exact"`.
    #[serde(default)]
    mode: Option<String>,
}

/// One resolved segment in the per-segment trace.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SegmentTraceDto {
    /// The segment text as parsed.
    pub segment: String,
    /// The block ID this segment resolved to.
    pub block_id: String,
    /// The ladder rung that matched (1 = exact … 4 = marker). Segment 1 (the
    /// page) is always rung 1 (PageNameIndex exact-name resolution).
    pub rung: u8,
    /// Human-readable rung name: `exact` | `markdownStripped` | `contains` |
    /// `marker`.
    pub rung_name: String,
}

/// Response for `GET /api/v1/resolve`.
///
/// Always carries a `block` — the fully-resolved leaf on success, or the
/// deepest block that DID resolve on a partial miss. `resolved` distinguishes
/// the two; `trace` records every resolved segment (page first); `unresolved`
/// carries the tail that a partial miss couldn't reach.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PathResolveResponse {
    /// Whether every segment resolved.
    pub resolved: bool,
    /// The mode used: `"fuzzy"` | `"exact"`.
    pub mode: String,
    /// The path as parsed into segments (first segment is the page).
    pub segments: Vec<String>,
    /// Per-segment resolution trace, page first, in path order. Only resolved
    /// segments appear here.
    pub trace: Vec<SegmentTraceDto>,
    /// Block ID of the deepest block that resolved.
    pub deepest_resolved_id: String,
    /// Segments that did NOT resolve, in path order. Empty on success.
    pub unresolved: Vec<String>,
    /// Why resolution stopped: `resolved` | `partial_miss` | `cap` | `cycle`.
    pub termination: String,
    /// The resolved (or deepest-resolved) block, in `BlockDto` shape with
    /// `ancestorContext` attached.
    pub block: BlockDto,
}

// ============================================================================
// Handler
// ============================================================================

async fn resolve_path(
    State(state): State<AppState>,
    Query(query): Query<ResolveQuery>,
) -> Result<Json<PathResolveResponse>, ApiError> {
    let path = query.path.trim();
    if path.is_empty() {
        return Err(ApiError::InvalidRequest("path is empty".to_string()));
    }

    let mode = match query.mode.as_deref() {
        None | Some("fuzzy") => ResolveMode::Fuzzy,
        Some("exact") => ResolveMode::Exact,
        Some(other) => {
            return Err(ApiError::InvalidRequest(format!(
                "invalid mode '{}': expected 'fuzzy' or 'exact'",
                other
            )));
        }
    };
    let mode_str = match mode {
        ResolveMode::Fuzzy => "fuzzy",
        ResolveMode::Exact => "exact",
    };

    let segments = parse_path_segments(path);
    // parse_path_segments always returns at least one segment (opaque fallback).
    let page_segment = segments[0].clone();

    // Segment 1 is always a page. Resolve via the SAME ladder the write side
    // uses (FINDING 3): PageNameIndex fast-path, then a direct Y.Doc pages::
    // container scan when the index misses. Without the scan tier, a page
    // created moments ago (via a path write, wikilink click, or raw POST
    // /blocks) is in the Y.Doc but not yet registered in the async
    // PageNameIndex — resolve would 404 during that hook-lag window. A miss on
    // BOTH tiers is the only 404 (ADR-008 D3: single-segment targets fall back
    // to page behavior; multi-segment never create pages).
    //
    // The index fast-path and container id are read under ONE pni guard, which
    // is released BEFORE the scan takes a doc read lock — mirroring
    // discovery.rs find_or_create_page_locked's discipline of never holding the
    // index lock across the scan's doc read (avoids an index↔doc lock-order
    // inversion under contention).
    let page_id = {
        let (fast, container_id) = {
            let pni = state
                .page_name_index
                .read()
                .map_err(|_| ApiError::LockPoisoned)?;
            (
                pni.page_block_id(&page_segment).map(String::from),
                pni.pages_container_id().map(String::from),
            )
        };
        match fast {
            Some(id) => Some(id),
            None => match container_id {
                Some(cid) => crate::api::discovery::scan_pages_container_for_name(
                    &state,
                    &cid,
                    &page_segment.to_lowercase(),
                )?,
                None => None,
            },
        }
    }
    .ok_or_else(|| ApiError::NotFound(format!("Page not found: {}", page_segment)))?;

    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();
    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    // Walk the remaining segments down the child tree. content_of + the child
    // lookup both borrow (blocks_map, txn) immutably.
    let lookup = YDocChildLookup::new(&blocks_map, &txn);
    let content_of = |id: &str| -> Option<NodeInfo> {
        let block_map = match blocks_map.get(&txn, id) {
            Some(yrs::Out::YMap(m)) => m,
            _ => return None,
        };
        let content = match block_map.get(&txn, "content") {
            Some(yrs::Out::Any(yrs::Any::String(s))) => s.to_string(),
            _ => return None,
        };
        let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));
        let updated_at = extract_timestamp(block_map.get(&txn, "updatedAt"));
        Some(NodeInfo {
            content,
            created_at,
            updated_at,
        })
    };

    let walk = walk_descendants(
        &lookup,
        content_of,
        &page_id,
        &segments[1..],
        mode,
        DescendantCaps::default(),
    );

    let resolved = walk.termination == DescendantTermination::Resolved;
    let deepest_id = walk.deepest_resolved.clone();

    // Build the per-segment trace: page first (always exact), then the walker's
    // descendant trace.
    let mut trace: Vec<SegmentTraceDto> = Vec::with_capacity(walk.trace.len() + 1);
    trace.push(SegmentTraceDto {
        segment: page_segment,
        block_id: page_id.clone(),
        rung: 1,
        rung_name: "exact".to_string(),
    });
    for r in &walk.trace {
        let (rung, rung_name) = rung_number_name(r.rung);
        trace.push(SegmentTraceDto {
            segment: r.segment.clone(),
            block_id: r.block_id.clone(),
            rung,
            rung_name: rung_name.to_string(),
        });
    }

    // Shape the deepest-resolved block as a BlockDto + ancestorContext.
    let value = blocks_map
        .get(&txn, &deepest_id)
        .ok_or_else(|| ApiError::NotFound(deepest_id.clone()))?;
    let block = if let yrs::Out::YMap(block_map) = value {
        let inh = state
            .inheritance_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        let inherited = lookup_inherited(&inh, &deepest_id);
        let mut dto = read_block_dto(&block_map, &txn, &deepest_id, inherited, true);

        let pni = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        // Singleton path: effective_markers always-on (matches /blocks/:id,
        // /daily/:date shaping — same builder call as blocks.rs).
        let opts = AncestorContextOpts::default().always_effective();
        attach_ancestor_context(&mut dto, &blocks_map, &txn, Some(&inh), Some(&pni), opts);
        // FLO-633 parity: door blocks resolved here carry renderedMarkdown
        // like every other singleton block-returning endpoint.
        super::blocks::inject_rendered_markdown(&mut dto, &state.projection_cache);
        dto
    } else {
        return Err(ApiError::NotFound(deepest_id));
    };

    Ok(Json(PathResolveResponse {
        resolved,
        mode: mode_str.to_string(),
        segments,
        trace,
        deepest_resolved_id: deepest_id,
        unresolved: walk.unresolved,
        termination: termination_str(walk.termination).to_string(),
        block,
    }))
}

/// Map a [`MatchRung`] to its `(number, name)` wire representation.
fn rung_number_name(rung: MatchRung) -> (u8, &'static str) {
    match rung {
        MatchRung::Exact => (1, "exact"),
        MatchRung::MarkdownStripped => (2, "markdownStripped"),
        MatchRung::Contains => (3, "contains"),
        MatchRung::Marker => (4, "marker"),
    }
}

/// Map a [`DescendantTermination`] to its snake_case wire string.
fn termination_str(t: DescendantTermination) -> &'static str {
    match t {
        DescendantTermination::Resolved => "resolved",
        DescendantTermination::PartialMiss => "partial_miss",
        DescendantTermination::Cap => "cap",
        DescendantTermination::Cycle => "cycle",
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WsBroadcaster;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use floatty_core::{HookSystem, YDocStore};
    use http_body_util::BodyExt;
    use lru::LruCache;
    use std::num::NonZeroUsize;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use tower::ServiceExt;
    use yrs::{Any, ArrayPrelim, Map, Transact, WriteTxn};

    /// Minimal hermetic AppState (no Tantivy) — mirrors discovery.rs test_state.
    fn test_state() -> (AppState, TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(WsBroadcaster::new(64));
        let hook_system = Arc::new(HookSystem::initialize_at(Arc::clone(&store), None));
        let page_name_index = hook_system.page_name_index();
        let inheritance_index = hook_system.inheritance_index();
        let projection_cache = Arc::new(Mutex::new(LruCache::new(
            NonZeroUsize::new(10_000).expect("nonzero"),
        )));
        let semantic_cache = Arc::new(Mutex::new(crate::api::discovery::SemanticCache::new()));
        let state = AppState {
            store,
            broadcaster,
            page_name_index,
            inheritance_index,
            hook_system,
            backup_daemon: None,
            projection_cache,
            semantic_cache,
        };
        (state, dir)
    }

    /// Seed a block directly into the Y.Doc (bypassing hooks): content,
    /// createdAt, parentId, childIds. Pages must be registered separately via
    /// [`register_page`] since no hook fires.
    fn seed_block(
        state: &AppState,
        id: &str,
        content: &str,
        created_at: i64,
        parent: Option<&str>,
        child_ids: &[&str],
    ) {
        let doc = state.store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block: yrs::MapRef = blocks.get_or_init(&mut txn, id);
        block.insert(&mut txn, "content", Any::String(content.into()));
        block.insert(&mut txn, "createdAt", Any::BigInt(created_at));
        if let Some(p) = parent {
            block.insert(&mut txn, "parentId", Any::String(p.into()));
        }
        let kids: Vec<Any> = child_ids.iter().map(|s| Any::String((*s).into())).collect();
        block.insert(&mut txn, "childIds", ArrayPrelim::from(kids));
    }

    /// Like [`seed_block`] but with an explicit `updatedAt` — the D2 recency
    /// signal, so endpoint tests can exercise the updatedAt → NodeInfo wiring.
    #[allow(clippy::too_many_arguments)]
    fn seed_block_upd(
        state: &AppState,
        id: &str,
        content: &str,
        created_at: i64,
        updated_at: i64,
        parent: Option<&str>,
        child_ids: &[&str],
    ) {
        seed_block(state, id, content, created_at, parent, child_ids);
        let doc = state.store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block: yrs::MapRef = blocks.get_or_init(&mut txn, id);
        block.insert(&mut txn, "updatedAt", Any::BigInt(updated_at));
    }

    /// Register a page name → block id in PageNameIndex (bypasses the hook).
    fn register_page(state: &AppState, name: &str, block_id: &str, created_at: i64) {
        state
            .page_name_index
            .write()
            .unwrap()
            .add_existing_page(name, block_id, created_at);
    }

    /// Seed `Demo Page > A > B > C` (linear direct-child chain).
    fn seed_demo_tree(state: &AppState) {
        seed_block(state, "page1", "# Demo Page", 10, None, &["a"]);
        seed_block(state, "a", "A", 20, Some("page1"), &["b"]);
        seed_block(state, "b", "B", 30, Some("a"), &["c"]);
        seed_block(state, "c", "C", 40, Some("b"), &[]);
        register_page(state, "Demo Page", "page1", 10);
    }

    async fn get_resolve(state: &AppState, query: &str) -> (StatusCode, serde_json::Value) {
        let app = router().with_state(state.clone());
        let uri = format!("/api/v1/resolve?{}", query);
        let response = app
            .oneshot(Request::get(&uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
        };
        (status, json)
    }

    #[tokio::test]
    async fn single_segment_resolves_page() {
        let (state, _dir) = test_state();
        seed_demo_tree(&state);
        let (status, body) = get_resolve(&state, "path=Demo%20Page").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], true);
        assert_eq!(body["mode"], "fuzzy");
        assert_eq!(body["deepestResolvedId"], "page1");
        assert_eq!(body["block"]["id"], "page1");
        // Trace has just the page segment.
        assert_eq!(body["trace"].as_array().unwrap().len(), 1);
        assert_eq!(body["trace"][0]["blockId"], "page1");
    }

    #[tokio::test]
    async fn exact_linear_chain_resolves_leaf() {
        let (state, _dir) = test_state();
        seed_demo_tree(&state);
        let (status, body) = get_resolve(
            &state,
            "path=Demo%20Page%20%3E%20A%20%3E%20B%20%3E%20C&mode=exact",
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], true);
        assert_eq!(body["mode"], "exact");
        assert_eq!(body["deepestResolvedId"], "c");
        assert_eq!(body["block"]["id"], "c");
        assert_eq!(body["termination"], "resolved");
        // Full trace: page + A + B + C.
        let trace = body["trace"].as_array().unwrap();
        assert_eq!(trace.len(), 4);
        assert_eq!(trace[3]["blockId"], "c");
        assert_eq!(trace[3]["rungName"], "exact");
    }

    /// Corpus roundtrip property `read_skips_levels_write_does_not`: fuzzy
    /// finds nested C via descendant skip; exact does NOT.
    #[tokio::test]
    async fn fuzzy_skips_levels_exact_does_not() {
        let (state, _dir) = test_state();
        seed_demo_tree(&state);

        // Fuzzy: 'Demo Page > C' finds nested c.
        let (status, body) = get_resolve(&state, "path=Demo%20Page%20%3E%20C&mode=fuzzy").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], true);
        assert_eq!(body["deepestResolvedId"], "c");
        assert_eq!(body["block"]["id"], "c");

        // Exact: 'Demo Page > C' does NOT match nested c → partial miss at page.
        let (status, body) = get_resolve(&state, "path=Demo%20Page%20%3E%20C&mode=exact").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], false);
        assert_eq!(body["termination"], "partial_miss");
        assert_eq!(body["deepestResolvedId"], "page1");
        assert_eq!(body["block"]["id"], "page1");
        assert_eq!(body["unresolved"], serde_json::json!(["C"]));
    }

    /// Corpus roundtrip property `miss_lands_deepest`: partial miss lands at the
    /// deepest resolved with the unresolved tail, still 200.
    #[tokio::test]
    async fn partial_miss_lands_deepest_still_200() {
        let (state, _dir) = test_state();
        seed_demo_tree(&state);
        let (status, body) =
            get_resolve(&state, "path=Demo%20Page%20%3E%20A%20%3E%20missing").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], false);
        assert_eq!(body["termination"], "partial_miss");
        assert_eq!(body["deepestResolvedId"], "a");
        assert_eq!(body["block"]["id"], "a");
        assert_eq!(body["unresolved"], serde_json::json!(["missing"]));
    }

    #[tokio::test]
    async fn missing_page_is_404() {
        let (state, _dir) = test_state();
        seed_demo_tree(&state);
        let (status, _body) = get_resolve(&state, "path=No%20Such%20Page%20%3E%20A").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn default_mode_is_fuzzy() {
        let (state, _dir) = test_state();
        seed_demo_tree(&state);
        // No mode param → fuzzy → nested C resolves.
        let (status, body) = get_resolve(&state, "path=Demo%20Page%20%3E%20C").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["mode"], "fuzzy");
        assert_eq!(body["resolved"], true);
        assert_eq!(body["deepestResolvedId"], "c");
    }

    #[tokio::test]
    async fn invalid_mode_is_400() {
        let (state, _dir) = test_state();
        seed_demo_tree(&state);
        let (status, _body) = get_resolve(&state, "path=Demo%20Page&mode=sideways").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn case_insensitive_page_and_fuzzy_rungs() {
        let (state, _dir) = test_state();
        // Page 'Notes' with a child heading '## Section B' and a marker child.
        seed_block(&state, "np", "# Notes", 10, None, &["s1", "s2"]);
        seed_block(&state, "s1", "## Section B", 20, Some("np"), &[]);
        seed_block(
            &state,
            "s2",
            "Investigated [sc::link-test-002] output",
            30,
            Some("np"),
            &[],
        );
        register_page(&state, "Notes", "np", 10);

        // Case-insensitive page + markdown-stripped rung 2 on the heading.
        let (status, body) = get_resolve(&state, "path=notes%20%3E%20Section%20B").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], true);
        assert_eq!(body["deepestResolvedId"], "s1");
        // Descendant trace entry (index 1) resolved 'Section B'.
        assert_eq!(body["trace"][1]["blockId"], "s1");

        // Marker rung 4: segment only present inside [sc::...].
        let (status, body) = get_resolve(&state, "path=notes%20%3E%20link-test-002").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], true);
        assert_eq!(body["deepestResolvedId"], "s2");
        assert_eq!(body["trace"][1]["rungName"], "marker");
    }

    /// End-to-end wiring of the D2 recency signal: `content_of` reads
    /// `updatedAt` off the Y.Doc and the walker ranks it ABOVE the createdAt
    /// tie-break — the newer-EDITED sibling wins even though it was created
    /// later. Same disagreement case as the walker-level unit test
    /// (`fuzzy_recency_beats_created_at_within_same_rung_depth`), asserted
    /// through the HTTP surface.
    #[tokio::test]
    async fn recency_beats_created_at_through_endpoint() {
        let (state, _dir) = test_state();
        seed_block(
            &state,
            "rp",
            "# Recency Page",
            10,
            None,
            &["stale", "fresh"],
        );
        seed_block_upd(&state, "stale", "C", 100, 500, Some("rp"), &[]);
        seed_block_upd(&state, "fresh", "C", 200, 900, Some("rp"), &[]);
        register_page(&state, "Recency Page", "rp", 10);

        let (status, body) = get_resolve(&state, "path=Recency%20Page%20%3E%20C").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], true);
        assert_eq!(
            body["deepestResolvedId"], "fresh",
            "updatedAt 900 > 500 outranks oldest-createdAt (100 < 200)"
        );
    }

    /// FINDING 3: a page present in the Y.Doc but NOT yet registered in the
    /// PageNameIndex (the async page-name hook-lag window) must still resolve.
    /// Resolve falls back to the same `pages::` container scan the write side
    /// uses — without it, a just-created page would 404 until the hook lands.
    #[tokio::test]
    async fn resolve_page_via_scan_fallback_when_not_in_index() {
        let (state, _dir) = test_state();
        // pages:: container + one page + a child section, seeded straight into
        // the Y.Doc (no hook fires — the page is invisible to the index).
        seed_block(&state, "pages", "pages::", 5, None, &["lagpage"]);
        seed_block(&state, "lagpage", "# Lag Page", 10, Some("pages"), &["kid"]);
        seed_block(&state, "kid", "Section", 20, Some("lagpage"), &[]);
        // The container IS known to the index (that's the scan's precondition),
        // but the page name is deliberately NOT registered.
        state
            .page_name_index
            .write()
            .unwrap()
            .set_pages_container_id(Some("pages".to_string()));
        assert!(
            state
                .page_name_index
                .read()
                .unwrap()
                .page_block_id("Lag Page")
                .is_none(),
            "page must be absent from the index so the fallback is exercised"
        );

        // Single segment: index misses → scan fallback resolves the page.
        let (status, body) = get_resolve(&state, "path=Lag%20Page").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], true);
        assert_eq!(body["deepestResolvedId"], "lagpage");
        assert_eq!(body["block"]["id"], "lagpage");

        // The multi-segment walk still descends from the scan-resolved page.
        let (status, body) = get_resolve(&state, "path=Lag%20Page%20%3E%20Section").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["resolved"], true);
        assert_eq!(body["deepestResolvedId"], "kid");
    }
}
