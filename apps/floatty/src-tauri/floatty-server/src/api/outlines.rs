//! Outline management handlers — CRUD, per-outline sync, blocks, search.

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use floatty_core::{OutlineInfo, OutlineName, YDocStore};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use yrs::{Array, Map, ReadTxn, Transact};

use super::{
    ApiError, AppState, BlockDto, BlockSearchQuery, BlockSearchResponse, BlocksQuery,
    BlocksResponse, CreateBlockRequest, ErrorResponse, ImportBlockRequest, StateHashResponse,
    StateResponse, StateVectorResponse, UpdateBlockRequest, UpdateEntry, UpdateRequest,
    UpdatesResponse, UpdatesQuery,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/outlines",
            get(list_outlines).post(create_outline_handler),
        )
        .route("/api/v1/outlines/:name", delete(delete_outline_handler))
        // Per-outline sync
        .route("/api/v1/outlines/:name/state", get(outline_get_state))
        .route(
            "/api/v1/outlines/:name/state-vector",
            get(outline_get_state_vector),
        )
        .route(
            "/api/v1/outlines/:name/state/hash",
            get(outline_get_state_hash),
        )
        .route(
            "/api/v1/outlines/:name/update",
            post(outline_apply_update),
        )
        .route(
            "/api/v1/outlines/:name/updates",
            get(outline_get_updates_since),
        )
        .route(
            "/api/v1/outlines/:name/export/binary",
            get(outline_export_binary),
        )
        .route(
            "/api/v1/outlines/:name/export/json",
            get(outline_export_json),
        )
        // Per-outline block CRUD
        .route(
            "/api/v1/outlines/:name/blocks",
            get(outline_get_blocks).post(outline_create_block),
        )
        .route(
            "/api/v1/outlines/:name/blocks/import",
            post(outline_import_block),
        )
        .route(
            "/api/v1/outlines/:name/blocks/:id",
            get(outline_get_block)
                .patch(outline_update_block)
                .delete(outline_delete_block),
        )
        .route("/api/v1/outlines/:name/stats", get(outline_get_stats))
        .route(
            "/api/v1/outlines/:name/search",
            get(outline_search_blocks),
        )
        .route(
            "/api/v1/outlines/:name/pages/search",
            get(outline_page_search_not_impl),
        )
}

// ============================================================================
// DTOs
// ============================================================================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateOutlineRequest {
    name: String,
}

// ============================================================================
// Helpers
// ============================================================================

fn reject_default_mutation(name: &str) -> Result<(), ApiError> {
    if name == "default" {
        return Err(ApiError::InvalidRequest(
            "Use legacy routes (/api/v1/blocks, /api/v1/update) for the default outline".into(),
        ));
    }
    Ok(())
}

fn resolve_outline(state: &AppState, name: &str) -> Result<Arc<YDocStore>, ApiError> {
    state.outline_manager.get_or_default(name).map_err(|e| match &e {
        floatty_core::OutlineError::NotFound(_) => {
            ApiError::NotFound(format!("outline '{}' not found", name))
        }
        floatty_core::OutlineError::InvalidName(_)
        | floatty_core::OutlineError::ReservedName => ApiError::InvalidRequest(format!("{}", e)),
        _ => ApiError::Internal(format!("Failed to resolve outline: {}", e)),
    })
}

fn resolve_outline_context(
    state: &AppState,
    name: &str,
) -> Result<Arc<crate::OutlineContext>, ApiError> {
    state.outline_manager.get_context(name).map_err(|e| match &e {
        floatty_core::OutlineError::NotFound(_) => {
            ApiError::NotFound(format!("outline '{}' not found", name))
        }
        floatty_core::OutlineError::InvalidName(_)
        | floatty_core::OutlineError::ReservedName => ApiError::InvalidRequest(format!("{}", e)),
        _ => ApiError::Internal(format!("Failed to resolve outline: {}", e)),
    })
}

// ============================================================================
// Outline management handlers
// ============================================================================

async fn list_outlines(
    State(state): State<AppState>,
) -> Result<Json<Vec<OutlineInfo>>, ApiError> {
    let outlines = state
        .outline_manager
        .list_outlines()
        .map_err(|e| ApiError::Internal(format!("Failed to list outlines: {}", e)))?;
    Ok(Json(outlines))
}

async fn create_outline_handler(
    State(state): State<AppState>,
    Json(req): Json<CreateOutlineRequest>,
) -> Result<(StatusCode, Json<OutlineInfo>), ApiError> {
    let name =
        OutlineName::new(&req.name).map_err(|e| ApiError::InvalidRequest(format!("{}", e)))?;
    let info = state
        .outline_manager
        .create_outline(&name)
        .map_err(|e| match &e {
            floatty_core::OutlineError::AlreadyExists(_) => {
                ApiError::Conflict(format!("{}", e))
            }
            floatty_core::OutlineError::InvalidName(_)
            | floatty_core::OutlineError::ReservedName => {
                ApiError::InvalidRequest(format!("{}", e))
            }
            _ => ApiError::Internal(format!("Failed to create outline: {}", e)),
        })?;
    Ok((StatusCode::CREATED, Json(info)))
}

async fn delete_outline_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, ApiError> {
    if name == "default" {
        return Err(ApiError::InvalidRequest(
            "Cannot delete the default outline".into(),
        ));
    }
    let validated =
        OutlineName::new(&name).map_err(|e| ApiError::InvalidRequest(format!("{}", e)))?;
    state
        .outline_manager
        .delete_outline(&validated)
        .map_err(|e| match &e {
            floatty_core::OutlineError::NotFound(_) => ApiError::NotFound(format!("{}", e)),
            _ => ApiError::Internal(format!("Failed to delete outline: {}", e)),
        })?;
    Ok(StatusCode::NO_CONTENT)
}

// ============================================================================
// Per-outline sync handlers
// ============================================================================

async fn outline_get_state(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<StateResponse>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let update = store.get_full_state()?;
    let latest_seq = store.get_latest_seq()?;
    Ok(Json(StateResponse {
        state: BASE64.encode(update),
        latest_seq,
    }))
}

async fn outline_get_state_vector(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<StateVectorResponse>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let sv = store.get_state_vector()?;
    Ok(Json(StateVectorResponse {
        state_vector: BASE64.encode(sv),
    }))
}

async fn outline_get_state_hash(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<StateHashResponse>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let full_state = store.get_full_state()?;

    let mut hasher = Sha256::new();
    hasher.update(&full_state);
    let hash = format!("{:x}", hasher.finalize());

    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();
    let block_count = txn
        .get_map("blocks")
        .map(|m| m.len(&txn) as usize)
        .unwrap_or(0);

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    Ok(Json(StateHashResponse {
        hash,
        block_count,
        timestamp,
    }))
}

#[tracing::instrument(skip(state, req), fields(route_family = "outlines", handler = "outline_apply_update"), err)]
async fn outline_apply_update(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<UpdateRequest>,
) -> Result<StatusCode, ApiError> {
    reject_default_mutation(&name)?;
    let ctx = resolve_outline_context(&state, &name)?;
    ctx.ensure_hook_system();
    let update_bytes = BASE64
        .decode(&req.update)
        .map_err(|e| ApiError::InvalidBase64(e.to_string()))?;

    ctx.store.apply_update(&update_bytes)?;
    Ok(StatusCode::OK)
}

async fn outline_get_updates_since(
    State(state): State<AppState>,
    Path(name): Path<String>,
    axum::extract::Query(query): axum::extract::Query<UpdatesQuery>,
) -> Result<Json<UpdatesResponse>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let limit = query.limit.min(1000);

    let compacted_through = store.get_compacted_through()?;
    if let Some(ct) = compacted_through {
        if query.since < ct {
            return Err(ApiError::UpdatesCompacted {
                requested: query.since,
                compacted_through: ct,
            });
        }
    }

    let updates = store.get_updates_since(query.since, limit)?;
    let latest_seq = store.get_latest_seq()?;

    Ok(Json(UpdatesResponse {
        updates: updates
            .into_iter()
            .map(|(seq, data, created_at)| UpdateEntry {
                seq,
                data: BASE64.encode(data),
                created_at,
            })
            .collect(),
        compacted_through,
        latest_seq,
    }))
}

async fn outline_export_binary(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let ydoc_state = store.get_full_state()?;
    let disposition = format!("attachment; filename=\"{}.ydoc\"", name);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        ydoc_state,
    ))
}

async fn outline_export_json(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let result = crate::block_service::get_blocks(&store, None, &BlocksQuery::default())?;

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string_pretty(&result).unwrap(),
    ))
}

// ============================================================================
// Per-outline block CRUD
// ============================================================================

async fn outline_get_blocks(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<BlocksResponse>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let result = crate::block_service::get_blocks(&store, None, &BlocksQuery::default())?;
    Ok(Json(result))
}

#[tracing::instrument(skip(state, req), fields(route_family = "outlines", handler = "outline_create_block"), err)]
async fn outline_create_block(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<CreateBlockRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    reject_default_mutation(&name)?;
    let ctx = resolve_outline_context(&state, &name)?;
    let block = crate::block_service::create_block(
        &ctx.store,
        &ctx.broadcaster,
        ctx.ensure_hook_system(),
        req,
    )?;
    Ok((StatusCode::CREATED, Json(block)))
}

async fn outline_import_block(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<ImportBlockRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    reject_default_mutation(&name)?;
    let ctx = resolve_outline_context(&state, &name)?;
    let dto = crate::block_service::import_block(
        &ctx.store,
        &ctx.broadcaster,
        ctx.ensure_hook_system(),
        req,
    )?;
    Ok((StatusCode::CREATED, Json(dto)))
}

async fn outline_get_block(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
) -> Result<Json<BlockDto>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound(format!("block '{}' not found", id)))?;

    let block_id = crate::block_service::resolve_block_id(&id, &blocks_map, &txn)?;

    match blocks_map.get(&txn, &block_id) {
        Some(yrs::Out::YMap(map)) => {
            let dto =
                crate::block_service::read_block_dto(&map, &txn, &block_id, None, false);
            Ok(Json(dto))
        }
        _ => Err(ApiError::NotFound(format!("block '{}' not found", id))),
    }
}

async fn outline_update_block(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
    Json(req): Json<UpdateBlockRequest>,
) -> Result<Json<BlockDto>, ApiError> {
    reject_default_mutation(&name)?;
    if req.parent_id.is_some()
        || req.metadata.is_some()
        || req.after_id.is_some()
        || req.at_index.is_some()
    {
        return Err(ApiError::InvalidRequest(
            "Per-outline PATCH currently supports content updates only".into(),
        ));
    }
    let ctx = resolve_outline_context(&state, &name)?;
    let block = crate::block_service::update_block(
        &ctx.store,
        &ctx.broadcaster,
        ctx.ensure_hook_system(),
        &id,
        req,
    )?;
    Ok(Json(block))
}

#[tracing::instrument(skip(state), fields(route_family = "outlines", handler = "outline_delete_block"), err)]
async fn outline_delete_block(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    reject_default_mutation(&name)?;
    let ctx = resolve_outline_context(&state, &name)?;
    crate::block_service::delete_block(
        &ctx.store,
        &ctx.broadcaster,
        ctx.ensure_hook_system(),
        &id,
    )?;
    Ok(StatusCode::NO_CONTENT)
}

async fn outline_get_stats(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let block_count = txn
        .get_map("blocks")
        .map(|m| m.len(&txn) as usize)
        .unwrap_or(0);

    let root_count = txn
        .get_array("rootIds")
        .map(|a| a.len(&txn) as usize)
        .unwrap_or(0);

    Ok(Json(serde_json::json!({
        "totalBlocks": block_count,
        "rootCount": root_count,
    })))
}

async fn outline_search_blocks(
    State(state): State<AppState>,
    Path(name): Path<String>,
    axum::extract::Query(query): axum::extract::Query<BlockSearchQuery>,
) -> Result<Json<BlockSearchResponse>, ApiError> {
    let ctx = resolve_outline_context(&state, &name)?;
    let hs = ctx.ensure_hook_system();
    let index_manager = hs
        .index_manager()
        .ok_or_else(|| ApiError::SearchUnavailable)?;
    let result = crate::block_service::search_blocks(&ctx.store, &index_manager, &query)?;
    Ok(Json(result))
}

async fn outline_page_search_not_impl() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(ErrorResponse {
            error: "page search not available for non-default outlines yet".into(),
        }),
    )
}
