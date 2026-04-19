//! Discovery handlers — markers, stats, daily note, presence, attachments.
//!
//! Also hosts the "semantic endpoints for outline conventions" track
//! ([[FLO-652]]): `POST /api/v1/pages/:name` (upsert) and
//! `POST /api/v1/daily/:date/append` — both hide the `pages::`-container
//! structural detail from API consumers so agents (ink-chat, Desktop
//! Daddy, future surfaces) don't have to rediscover outline layout rules
//! on every new tool.

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use yrs::{Map, ReadTxn, Transact};

use crate::api::{self, BlockDto};
use crate::block_service::{lookup_inherited, read_block_dto};
use super::{ApiError, AppState, BlockContextQuery, BlockWithContextResponse};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/markers", get(list_marker_types))
        .route(
            "/api/v1/markers/:marker_type/values",
            get(list_marker_values),
        )
        .route("/api/v1/stats", get(get_block_stats))
        .route(
            "/api/v1/presence",
            get(get_presence).post(post_presence),
        )
        .route("/api/v1/daily/:date", get(get_daily_note))
        .route("/api/v1/daily/:date/append", post(append_to_daily_note))
        .route("/api/v1/pages/:name", post(upsert_page))
        .route("/api/v1/attachments/:filename", get(get_attachment))
}

// ============================================================================
// DTOs
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresenceRequest {
    block_id: String,
    pane_id: Option<String>,
}

/// Body for `POST /api/v1/daily/:date/append` — append a child block to the
/// specified daily note (auto-creates the daily note page if missing).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DailyAppendRequest {
    content: String,
}

/// Body for `POST /api/v1/pages/:name` — upsert a page by name. Body is
/// currently empty-shaped; kept as a struct so we can extend with optional
/// initial content without breaking the wire contract later.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpsertPageRequest {}

// ============================================================================
// Handlers
// ============================================================================

async fn list_marker_types(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let types = state.store.enumerate_marker_types();
    let items: Vec<serde_json::Value> = types
        .into_iter()
        .map(|(marker_type, count)| serde_json::json!({ "type": marker_type, "count": count }))
        .collect();
    Ok(Json(
        serde_json::json!({ "markers": items, "total": items.len() }),
    ))
}

async fn list_marker_values(
    State(state): State<AppState>,
    Path(marker_type): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let values = state.store.enumerate_marker_values(&marker_type);
    let items: Vec<serde_json::Value> = values
        .into_iter()
        .map(|(value, count)| serde_json::json!({ "value": value, "count": count }))
        .collect();
    Ok(Json(serde_json::json!({
        "markerType": marker_type,
        "values": items,
        "total": items.len()
    })))
}

async fn get_block_stats(
    State(state): State<AppState>,
) -> Result<Json<floatty_core::store::BlockStats>, ApiError> {
    Ok(Json(state.store.get_stats()))
}

#[tracing::instrument(skip(state), fields(route_family = "discovery", handler = "get_daily_note"), err)]
async fn get_daily_note(
    State(state): State<AppState>,
    Path(date): Path<String>,
    axum::extract::Query(mut ctx_query): axum::extract::Query<BlockContextQuery>,
) -> Result<Json<BlockWithContextResponse>, ApiError> {
    let page_block_id = {
        let page_index = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        page_index.page_block_id(&date).map(String::from)
    };

    let page_id =
        page_block_id.ok_or_else(|| ApiError::NotFound(format!("Page not found: {}", date)))?;

    if ctx_query
        .include
        .as_deref()
        .map_or(true, |s| s.trim().is_empty())
    {
        ctx_query.include = Some("children".to_string());
    }

    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    let value = blocks_map
        .get(&txn, &page_id)
        .ok_or_else(|| ApiError::NotFound(page_id.clone()))?;

    if let yrs::Out::YMap(block_map) = value {
        let inherited_markers = {
            let index = state
                .inheritance_index
                .read()
                .map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, &page_id)
        };
        let block_dto = read_block_dto(&block_map, &txn, &page_id, inherited_markers, true);
        Ok(Json(crate::block_service::build_block_context_response(
            &blocks_map,
            &txn,
            &page_id,
            block_dto,
            &ctx_query,
        )))
    } else {
        Err(ApiError::NotFound(page_id))
    }
}

async fn get_presence(State(state): State<AppState>) -> impl IntoResponse {
    let Some(info) = state.broadcaster.get_last_presence() else {
        return StatusCode::NO_CONTENT.into_response();
    };

    let doc = state.store.doc();
    let Ok(doc_guard) = doc.read() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let txn = doc_guard.transact();
    let block_exists = txn
        .get_map("blocks")
        .and_then(|m| m.get(&txn, &info.block_id))
        .is_some();

    if !block_exists {
        return StatusCode::NO_CONTENT.into_response();
    }

    Json(serde_json::json!({
        "blockId": info.block_id,
        "paneId": info.pane_id,
    }))
    .into_response()
}

async fn post_presence(
    State(state): State<AppState>,
    Json(req): Json<PresenceRequest>,
) -> StatusCode {
    state
        .broadcaster
        .broadcast_presence(req.block_id, req.pane_id);
    StatusCode::OK
}

async fn get_attachment(Path(filename): Path<String>) -> Result<impl IntoResponse, ApiError> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(ApiError::InvalidRequest("Invalid filename".to_string()));
    }

    let attachments_dir = crate::config::data_dir().join("__attachments");
    let _ = tokio::fs::create_dir_all(&attachments_dir).await;

    let file_path = attachments_dir.join(&filename);
    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|_| ApiError::NotFound(format!("Attachment not found: {}", filename)))?;

    let content_type: &'static str = match file_path.extension().and_then(|e| e.to_str()) {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("pdf") => "application/pdf",
        Some("html") | Some("htm") => "text/html",
        _ => "application/octet-stream",
    };

    Ok((
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            header::HeaderValue::from_static(content_type),
        )],
        bytes,
    ))
}

// ============================================================================
// Semantic endpoints — FLO-652 ("agents shouldn't need to know pages:: layout")
// ============================================================================

/// Resolve a page name to an existing block id, creating the page (and the
/// `pages::` container if needed) when absent.
///
/// The page content uses the canonical `# ${name}` heading form so it renders
/// correctly when zoomed. This mirrors `createPage` in the frontend's
/// `useBacklinkNavigation.ts` — same content shape, same parent chain.
fn find_or_create_page(state: &AppState, name: &str) -> Result<String, ApiError> {
    // Fast path: page already exists in the PageNameIndex.
    {
        let index = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        if let Some(id) = index.page_block_id(name) {
            return Ok(id.to_string());
        }
    }

    // Ensure `pages::` container exists — create as a root block if the
    // outline has never had any pages.
    let pages_container_id = {
        let index = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        index.pages_container_id().map(String::from)
    };

    let pages_container_id = match pages_container_id {
        Some(id) => id,
        None => {
            let container = crate::block_service::create_block(
                &state.store,
                &state.broadcaster,
                &state.hook_system,
                api::CreateBlockRequest {
                    content: "pages::".to_string(),
                    parent_id: None,
                    after_id: None,
                    at_index: None,
                },
            )?;
            container.id
        }
    };

    // Create the page block under the pages:: container.
    let page = crate::block_service::create_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        api::CreateBlockRequest {
            content: format!("# {}", name),
            parent_id: Some(pages_container_id),
            after_id: None,
            at_index: None,
        },
    )?;

    Ok(page.id)
}

/// Read a page block as a `BlockDto` for returning from the upsert handler.
/// Scoped to this module — the full `get_block` in `block_service` builds a
/// context response (ancestors, siblings, etc.) that we don't need here.
fn read_page_dto(state: &AppState, id: &str) -> Result<BlockDto, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    let value = blocks_map
        .get(&txn, id)
        .ok_or_else(|| ApiError::NotFound(id.to_string()))?;

    if let yrs::Out::YMap(block_map) = value {
        let inherited_markers = {
            let index = state
                .inheritance_index
                .read()
                .map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, id)
        };
        Ok(read_block_dto(&block_map, &txn, id, inherited_markers, true))
    } else {
        Err(ApiError::NotFound(id.to_string()))
    }
}

/// `POST /api/v1/pages/:name` — upsert a page under the `pages::` container.
///
/// Idempotent: returns the existing page when one matches the name
/// (case-insensitive, via PageNameIndex). Creates a new page and the
/// `pages::` container (if absent) otherwise.
///
/// Responses:
/// - `200 OK` when the page already existed
/// - `201 Created` when the page was freshly created
#[tracing::instrument(skip(state, _req), fields(route_family = "semantic", handler = "upsert_page"), err)]
async fn upsert_page(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(_req): Json<UpsertPageRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::InvalidRequest("Page name cannot be empty".to_string()));
    }

    let existed = {
        let index = state
            .page_name_index
            .read()
            .map_err(|_| ApiError::LockPoisoned)?;
        index.page_block_id(&name).is_some()
    };

    let page_id = find_or_create_page(&state, &name)?;
    let dto = read_page_dto(&state, &page_id)?;
    let status = if existed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    Ok((status, Json(dto)))
}

/// `POST /api/v1/daily/:date/append` — append a child block under the
/// specified daily note. The daily note (and `pages::` container) are
/// autocreated when missing — same ergonomic contract as typing
/// `[[YYYY-MM-DD]]` in the frontend.
///
/// Responses:
/// - `201 Created` with the new child's `BlockDto`
#[tracing::instrument(skip(state, req), fields(route_family = "semantic", handler = "append_to_daily_note"), err)]
async fn append_to_daily_note(
    State(state): State<AppState>,
    Path(date): Path<String>,
    Json(req): Json<DailyAppendRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    if date.trim().is_empty() {
        return Err(ApiError::InvalidRequest("Date cannot be empty".to_string()));
    }

    let daily_id = find_or_create_page(&state, &date)?;

    let dto = crate::block_service::create_block(
        &state.store,
        &state.broadcaster,
        &state.hook_system,
        api::CreateBlockRequest {
            content: req.content,
            parent_id: Some(daily_id),
            after_id: None,
            at_index: None,
        },
    )?;

    Ok((StatusCode::CREATED, Json(dto)))
}
