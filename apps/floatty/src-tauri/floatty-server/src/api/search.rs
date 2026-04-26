//! Search handlers — page search, full-text block search, reindex, clear.

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use super::{ApiError, AppState};
use crate::api::AncestorContext;
use yrs::{Map, ReadTxn, Transact};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/pages/search", get(search_pages))
        .route("/api/v1/search", get(search_blocks))
        .route("/api/v1/search/clear", post(clear_search_index))
        .route("/api/v1/search/reindex", post(reindex_search))
}

// ============================================================================
// DTOs
// ============================================================================

#[derive(Deserialize)]
pub struct PageSearchQuery {
    #[serde(default)]
    pub prefix: String,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub fuzzy: bool,
    /// Comma-separated `?include=` directives for AncestorContext.
    /// Recognised: `effective_markers`, `inbound_samples`. Always-on cheap
    /// fields populate regardless. Stubs (no block_id) skip ancestor_context.
    #[serde(default)]
    pub include: Option<String>,
    #[serde(default)]
    pub inbound_sample_count: Option<usize>,
}

fn default_limit() -> usize {
    10
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSearchResult {
    pub name: String,
    pub is_stub: bool,
    pub block_id: Option<String>,
    /// Navigation-layer surface for the page block.
    /// Populated only for non-stub pages (a stub has no `block_id`, so no
    /// ancestors / inbound shape to compute). Always-on for cheap fields;
    /// effective_markers and inbound_samples respect the same `?include=`
    /// directives the search endpoints honour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ancestor_context: Option<AncestorContext>,
}

#[derive(Serialize)]
pub struct PageSearchResponse {
    pub pages: Vec<PageSearchResult>,
}

#[derive(Deserialize)]
pub struct BlockSearchQuery {
    #[serde(default)]
    pub q: String,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
    #[serde(default)]
    pub types: Option<String>,
    #[serde(default)]
    pub has_markers: Option<bool>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub include_breadcrumb: Option<bool>,
    #[serde(default)]
    pub include_metadata: Option<bool>,
    #[serde(default)]
    pub outlink: Option<String>,
    #[serde(default)]
    pub marker_type: Option<String>,
    #[serde(default)]
    pub marker_val: Option<String>,
    #[serde(default)]
    pub created_after: Option<i64>,
    #[serde(default)]
    pub created_before: Option<i64>,
    #[serde(default)]
    pub ctx_after: Option<i64>,
    #[serde(default)]
    pub ctx_before: Option<i64>,
    #[serde(default)]
    pub inherited: Option<bool>,
    #[serde(default)]
    pub exclude_types: Option<String>,
    /// Comma-separated `?include=` directives for AncestorContext.
    /// Recognised: `effective_markers`, `inbound_samples`. Cheap fields are
    /// always-on regardless of this parameter.
    #[serde(default)]
    pub include: Option<String>,
    /// Cap for `inbound_samples` (default 5; max 50). Only honoured when
    /// `include=inbound_samples`.
    #[serde(default)]
    pub inbound_sample_count: Option<usize>,
}

fn default_search_limit() -> usize {
    20
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSearchHit {
    pub block_id: String,
    pub score: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breadcrumb: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_type: Option<String>,
    /// Navigation-layer surface. Always-on cheap fields;
    /// `effective_markers` and `inbound_samples` populated only when the
    /// caller passed the corresponding `?include=` directive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ancestor_context: Option<AncestorContext>,
}

#[derive(Serialize, Deserialize)]
pub struct BlockSearchResponse {
    pub hits: Vec<BlockSearchHit>,
    pub total: usize,
}

#[derive(Serialize)]
struct ReindexResponse {
    rehydrated: usize,
}

// ============================================================================
// Handlers
// ============================================================================

async fn search_pages(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<PageSearchQuery>,
) -> Result<Json<PageSearchResponse>, ApiError> {
    // Acquire indices ONCE — the AncestorContext shape per page reads from
    // both. Drop the page-name read guard before re-locking inside compute_*
    // helpers (we reuse the same guard reference).
    let pni = state
        .page_name_index
        .read()
        .map_err(|_| ApiError::LockPoisoned)?;

    let results = if query.fuzzy {
        pni.fuzzy_search(&query.prefix)
    } else {
        pni.search(&query.prefix)
    };

    // Build the result vector with AncestorContext for non-stub pages.
    // Stubs have no block_id → no ancestor chain to compute → ancestor_context
    // stays None. The result keeps the original page sort order from the
    // index search.
    let suggestions: Vec<floatty_core::PageSuggestion> =
        results.into_iter().take(query.limit).collect();

    // Short-circuits the documented "expand_page" 2-call tax — caller can
    // read AncestorContext from the page-search hit instead of a follow-up
    // GET on the page block.
    let inh = state
        .inheritance_index
        .read()
        .map_err(|_| ApiError::LockPoisoned)?;
    let includes = crate::block_service::parse_includes(&query.include);
    let ac_opts = crate::block_service::AncestorContextOpts::from_raw(
        &includes,
        query.inbound_sample_count.unwrap_or(5),
    );

    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();
    let blocks_map = txn.get_map("blocks");

    let pages: Vec<PageSearchResult> = suggestions
        .into_iter()
        .map(|s| {
            let ancestor_context = match (&blocks_map, &s.block_id) {
                (Some(bmap), Some(block_id)) => {
                    // Read metadata directly — compute_ancestor_context takes
                    // `Option<&serde_json::Value>` so no skeletal DTO scaffold.
                    let metadata = match bmap.get(&txn, block_id) {
                        Some(yrs::Out::YMap(block_map)) => block_map
                            .get(&txn, "metadata")
                            .and_then(|m| crate::api::extract_metadata_from_yrs(m, &txn)),
                        _ => None,
                    };
                    crate::block_service::compute_ancestor_context(
                        bmap,
                        &txn,
                        block_id,
                        metadata.as_ref(),
                        Some(&inh),
                        Some(&pni),
                        ac_opts,
                    )
                }
                _ => None,
            };

            PageSearchResult {
                name: s.name,
                is_stub: s.is_stub,
                block_id: s.block_id,
                ancestor_context,
            }
        })
        .collect();

    Ok(Json(PageSearchResponse { pages }))
}

#[tracing::instrument(
    skip(state, query),
    fields(route_family = "search", handler = "search_blocks"),
    err
)]
async fn search_blocks(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<BlockSearchQuery>,
) -> Result<Json<BlockSearchResponse>, ApiError> {
    let index_manager = state
        .hook_system
        .index_manager()
        .ok_or_else(|| ApiError::SearchUnavailable)?;
    let result = crate::block_service::search_blocks(
        &state.store,
        &index_manager,
        Some(&state.inheritance_index),
        Some(&state.page_name_index),
        &query,
    )?;
    Ok(Json(result))
}

#[tracing::instrument(
    skip(state),
    fields(route_family = "search", handler = "clear_search_index"),
    err
)]
async fn clear_search_index(State(state): State<AppState>) -> Result<StatusCode, ApiError> {
    state
        .hook_system
        .clear_search_index()
        .await
        .map_err(|e| ApiError::Search(format!("Failed to clear: {}", e)))?;

    Ok(StatusCode::NO_CONTENT)
}

#[tracing::instrument(
    skip(state),
    fields(route_family = "search", handler = "reindex_search"),
    err
)]
async fn reindex_search(State(state): State<AppState>) -> Result<Json<ReindexResponse>, ApiError> {
    state
        .hook_system
        .clear_search_index()
        .await
        .map_err(|e| ApiError::Search(format!("Failed to clear before reindex: {}", e)))?;
    let count = state.hook_system.rehydrate_all_blocks(&state.store);
    tracing::info!("Reindex triggered: {} blocks rehydrated", count);
    Ok(Json(ReindexResponse { rehydrated: count }))
}
