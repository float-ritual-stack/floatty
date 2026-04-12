//! Search handlers — page search, full-text block search, reindex, clear.

use axum::{
    extract::State,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

use super::{ApiError, AppState};

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
    let index = state
        .page_name_index
        .read()
        .map_err(|_| ApiError::LockPoisoned)?;

    let results = if query.fuzzy {
        index.fuzzy_search(&query.prefix)
    } else {
        index.search(&query.prefix)
    };

    let pages: Vec<PageSearchResult> = results
        .into_iter()
        .take(query.limit)
        .map(|s| PageSearchResult {
            name: s.name,
            is_stub: s.is_stub,
            block_id: s.block_id,
        })
        .collect();

    Ok(Json(PageSearchResponse { pages }))
}

async fn search_blocks(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<BlockSearchQuery>,
) -> Result<Json<BlockSearchResponse>, ApiError> {
    let index_manager = state
        .hook_system
        .index_manager()
        .ok_or_else(|| ApiError::SearchUnavailable)?;
    let result = crate::block_service::search_blocks(&state.store, &index_manager, &query)?;
    Ok(Json(result))
}

async fn clear_search_index(State(state): State<AppState>) -> Result<StatusCode, ApiError> {
    state
        .hook_system
        .clear_search_index()
        .await
        .map_err(|e| ApiError::Search(format!("Failed to clear: {}", e)))?;

    Ok(StatusCode::NO_CONTENT)
}

async fn reindex_search(
    State(state): State<AppState>,
) -> Result<Json<ReindexResponse>, ApiError> {
    let count = state.hook_system.rehydrate_all_blocks(&state.store);
    tracing::info!("Reindex triggered: {} blocks rehydrated", count);
    Ok(Json(ReindexResponse { rehydrated: count }))
}
