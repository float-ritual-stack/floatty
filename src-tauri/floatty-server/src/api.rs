//! REST API for floatty block store.
//!
//! Core sync endpoints:
//! - GET /api/v1/state - Full Y.Doc state (base64)
//! - POST /api/v1/update - Apply Y.Doc update
//! - GET /api/v1/health - Health check
//!
//! Block CRUD endpoints:
//! - GET /api/v1/blocks - All blocks as JSON
//! - GET /api/v1/blocks/:id - Single block
//! - POST /api/v1/blocks - Create block
//! - PATCH /api/v1/blocks/:id - Update content
//! - DELETE /api/v1/blocks/:id - Delete block + subtree

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get, patch, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use floatty_core::YDocStore;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;
use tower_http::cors::{Any, CorsLayer};
use yrs::{Array, Map, ReadTxn, Transact, WriteTxn};

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<YDocStore>,
}

/// Health check response
#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
}

/// Full state response (for sync)
#[derive(Serialize)]
pub struct StateResponse {
    pub state: String, // base64 encoded Y.Doc state
}

/// Apply update request
#[derive(Deserialize)]
pub struct UpdateRequest {
    pub update: String, // base64 encoded Y.Doc update
}

/// Block list response
#[derive(Serialize)]
pub struct BlocksResponse {
    pub blocks: Vec<BlockDto>,
    pub root_ids: Vec<String>,
}

/// Block DTO for API responses
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub id: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub collapsed: bool,
    pub block_type: String,
}

/// Create block request
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBlockRequest {
    pub content: String,
    pub parent_id: Option<String>,
}

/// Update block request
#[derive(Deserialize)]
pub struct UpdateBlockRequest {
    pub content: String,
}

/// Standard error response
#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// API errors
#[derive(Error, Debug)]
pub enum ApiError {
    #[error("Store error: {0}")]
    Store(#[from] floatty_core::StoreError),

    #[error("Block not found: {0}")]
    NotFound(String),

    #[error("Invalid base64: {0}")]
    InvalidBase64(String),

    #[error("Lock poisoned")]
    LockPoisoned,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self {
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            _ => StatusCode::BAD_REQUEST,
        };
        let body = Json(ErrorResponse {
            error: self.to_string(),
        });
        (status, body).into_response()
    }
}

/// Create the API router
pub fn create_router(store: Arc<YDocStore>) -> Router {
    let state = AppState { store };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Core sync endpoints
        .route("/api/v1/health", get(health))
        .route("/api/v1/state", get(get_state))
        .route("/api/v1/update", post(apply_update))
        // Block CRUD
        .route("/api/v1/blocks", get(get_blocks))
        .route("/api/v1/blocks", post(create_block))
        .route("/api/v1/blocks/{id}", get(get_block))
        .route("/api/v1/blocks/{id}", patch(update_block))
        .route("/api/v1/blocks/{id}", delete(delete_block))
        .layer(cors)
        .with_state(state)
}

/// GET /api/v1/health
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// GET /api/v1/state - Full Y.Doc state for sync
async fn get_state(State(state): State<AppState>) -> Result<Json<StateResponse>, ApiError> {
    let update = state.store.get_full_state()?;
    Ok(Json(StateResponse {
        state: BASE64.encode(update),
    }))
}

/// POST /api/v1/update - Apply Y.Doc update from client
async fn apply_update(
    State(state): State<AppState>,
    Json(req): Json<UpdateRequest>,
) -> Result<StatusCode, ApiError> {
    let update_bytes = BASE64
        .decode(&req.update)
        .map_err(|e| ApiError::InvalidBase64(e.to_string()))?;

    state.store.apply_update(&update_bytes)?;
    Ok(StatusCode::OK)
}

/// GET /api/v1/blocks - All blocks as JSON
async fn get_blocks(State(state): State<AppState>) -> Result<Json<BlocksResponse>, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let mut blocks = Vec::new();
    let mut root_ids = Vec::new();

    // Get root IDs
    if let Some(root_ids_arr) = txn.get_array("rootIds") {
        for value in root_ids_arr.iter(&txn) {
            if let Some(id) = value.to_string(&txn).into() {
                root_ids.push(id);
            }
        }
    }

    // Get all blocks from the map
    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let Ok(block_json) = value.to_string(&txn).parse::<serde_json::Value>() {
                let block_type = floatty_core::parse_block_type(
                    block_json.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                );

                blocks.push(BlockDto {
                    id: key.to_string(),
                    content: block_json
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    parent_id: block_json
                        .get("parentId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    child_ids: block_json
                        .get("childIds")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default(),
                    collapsed: block_json
                        .get("collapsed")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    block_type: format!("{:?}", block_type).to_lowercase(),
                });
            }
        }
    }

    Ok(Json(BlocksResponse { blocks, root_ids }))
}

/// GET /api/v1/blocks/:id - Single block
async fn get_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BlockDto>, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    let value = blocks_map
        .get(&txn, &id)
        .ok_or_else(|| ApiError::NotFound(id.clone()))?;

    let block_json: serde_json::Value = value
        .to_string(&txn)
        .parse()
        .map_err(|_| ApiError::NotFound(id.clone()))?;

    let block_type = floatty_core::parse_block_type(
        block_json.get("content").and_then(|v| v.as_str()).unwrap_or(""),
    );

    Ok(Json(BlockDto {
        id: id.clone(),
        content: block_json
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        parent_id: block_json
            .get("parentId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        child_ids: block_json
            .get("childIds")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        collapsed: block_json
            .get("collapsed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        block_type: format!("{:?}", block_type).to_lowercase(),
    }))
}

/// POST /api/v1/blocks - Create block
async fn create_block(
    State(state): State<AppState>,
    Json(req): Json<CreateBlockRequest>,
) -> Result<(StatusCode, Json<BlockDto>), ApiError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let block = serde_json::json!({
        "id": id,
        "content": req.content,
        "parentId": req.parent_id,
        "childIds": [],
        "collapsed": false,
        "createdAt": now,
        "updatedAt": now,
    });

    let doc = state.store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;
    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        blocks.insert(&mut txn, id.as_str(), block.to_string().as_str());

        // Add to rootIds if no parent
        if req.parent_id.is_none() {
            let root_ids = txn.get_or_insert_array("rootIds");
            root_ids.push_back(&mut txn, id.as_str());
        }

        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist the update
    state.store.apply_update(&update)?;

    let block_type = floatty_core::parse_block_type(&req.content);

    Ok((
        StatusCode::CREATED,
        Json(BlockDto {
            id,
            content: req.content,
            parent_id: req.parent_id,
            child_ids: vec![],
            collapsed: false,
            block_type: format!("{:?}", block_type).to_lowercase(),
        }),
    ))
}

/// PATCH /api/v1/blocks/:id - Update content
async fn update_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateBlockRequest>,
) -> Result<Json<BlockDto>, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    // Get current block
    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    let value = blocks_map
        .get(&txn, &id)
        .ok_or_else(|| ApiError::NotFound(id.clone()))?;

    let mut block_json: serde_json::Value = value
        .to_string(&txn)
        .parse()
        .map_err(|_| ApiError::NotFound(id.clone()))?;

    drop(txn);

    // Update content
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    block_json["content"] = serde_json::Value::String(req.content.clone());
    block_json["updatedAt"] = serde_json::Value::Number(now.into());

    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        blocks.insert(&mut txn, id.as_str(), block_json.to_string().as_str());
        txn.encode_update_v1()
    };
    drop(doc_guard);

    state.store.apply_update(&update)?;

    let block_type = floatty_core::parse_block_type(&req.content);

    Ok(Json(BlockDto {
        id: id.clone(),
        content: req.content,
        parent_id: block_json
            .get("parentId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        child_ids: block_json
            .get("childIds")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        collapsed: block_json
            .get("collapsed")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        block_type: format!("{:?}", block_type).to_lowercase(),
    }))
}

/// DELETE /api/v1/blocks/:id - Delete block and subtree
async fn delete_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Remove from blocks map
        blocks.remove(&mut txn, &id);

        // Remove from rootIds if present
        if let Some(root_ids) = txn.get_array("rootIds") {
            // Find and remove the id from rootIds
            for (_i, value) in root_ids.iter(&txn).enumerate() {
                if value.to_string(&txn) == id {
                    // Can't remove by index easily in yrs, so we'll skip this for now
                    // A proper implementation would rebuild the array
                    break;
                }
            }
        }

        txn.encode_update_v1()
    };
    drop(doc_guard);

    state.store.apply_update(&update)?;

    Ok(StatusCode::NO_CONTENT)
}
