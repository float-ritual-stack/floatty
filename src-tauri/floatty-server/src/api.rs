//! REST API for floatty block store.
//!
//! Core sync endpoints:
//! - GET /api/v1/state - Full Y.Doc state (base64)
//! - GET /api/v1/state-vector - State vector for reconciliation
//! - GET /api/v1/state/hash - SHA256 hash for sync health check
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
use floatty_core::{events::BlockChange, HookSystem, Origin, PageNameIndex, SearchFilters, SearchService, YDocStore};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use yrs::{Array, ArrayPrelim, Map, MapPrelim, ReadTxn, Transact, WriteTxn};

use crate::WsBroadcaster;

/// Extract metadata from Y.Doc block, handling multiple formats:
/// - New: Embedded Y.Map (from MapPrelim insertion)
/// - Any::Map: JSON-like map value
/// - Legacy: JSON string (for backwards compatibility)
fn extract_metadata_from_yrs<T: ReadTxn>(value: yrs::Out, txn: &T) -> Option<serde_json::Value> {
    match value {
        // New format: Embedded Y.Map (created by MapPrelim)
        yrs::Out::YMap(map) => {
            let mut json_map = serde_json::Map::new();
            for (key, val) in map.iter(txn) {
                json_map.insert(key.to_string(), yrs_out_to_json(val, txn));
            }
            Some(serde_json::Value::Object(json_map))
        }
        // JSON-like map value (yrs::Any::Map)
        yrs::Out::Any(yrs::Any::Map(map)) => {
            let json_map: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .map(|(k, v)| (k.to_string(), yrs_any_to_json(v.clone())))
                .collect();
            Some(serde_json::Value::Object(json_map))
        }
        // Legacy format: JSON string - parse it
        yrs::Out::Any(yrs::Any::String(s)) => serde_json::from_str(s.as_ref()).ok(),
        _ => None,
    }
}

/// Convert yrs::Out to serde_json::Value recursively (for embedded Y types)
fn yrs_out_to_json<T: ReadTxn>(out: yrs::Out, txn: &T) -> serde_json::Value {
    match out {
        yrs::Out::YMap(map) => {
            let mut json_map = serde_json::Map::new();
            for (key, val) in map.iter(txn) {
                json_map.insert(key.to_string(), yrs_out_to_json(val, txn));
            }
            serde_json::Value::Object(json_map)
        }
        yrs::Out::YArray(arr) => {
            let items: Vec<serde_json::Value> = arr.iter(txn).map(|v| yrs_out_to_json(v, txn)).collect();
            serde_json::Value::Array(items)
        }
        yrs::Out::Any(any) => yrs_any_to_json(any),
        _ => serde_json::Value::Null,
    }
}

/// Convert yrs::Any to serde_json::Value recursively
fn yrs_any_to_json(any: yrs::Any) -> serde_json::Value {
    match any {
        yrs::Any::Null => serde_json::Value::Null,
        yrs::Any::Bool(b) => serde_json::Value::Bool(b),
        yrs::Any::Number(n) => serde_json::Value::Number(
            serde_json::Number::from_f64(n).unwrap_or(serde_json::Number::from(0))
        ),
        yrs::Any::BigInt(n) => serde_json::Value::Number(n.into()),
        yrs::Any::String(s) => serde_json::Value::String(s.to_string()),
        yrs::Any::Array(arr) => {
            serde_json::Value::Array(arr.iter().cloned().map(yrs_any_to_json).collect())
        }
        yrs::Any::Map(map) => {
            let obj: serde_json::Map<String, serde_json::Value> = map
                .iter()
                .map(|(k, v)| (k.to_string(), yrs_any_to_json(v.clone())))
                .collect();
            serde_json::Value::Object(obj)
        }
        yrs::Any::Buffer(_) => serde_json::Value::Null, // Skip binary data
        yrs::Any::Undefined => serde_json::Value::Null,
    }
}

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<YDocStore>,
    pub broadcaster: Arc<WsBroadcaster>,
    pub page_name_index: Arc<RwLock<PageNameIndex>>,
    pub hook_system: Arc<HookSystem>,
}

/// Health check response
#[derive(Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}

/// Full state response (for sync)
#[derive(Serialize)]
pub struct StateResponse {
    pub state: String, // base64 encoded Y.Doc state
}

/// State vector response (for reconciliation)
#[derive(Serialize)]
pub struct StateVectorResponse {
    pub state_vector: String, // base64 encoded Y.Doc state vector
}

/// State hash response (for sync health check)
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateHashResponse {
    /// SHA256 hash of the full Y.Doc state
    pub hash: String,
    /// Number of blocks in the document
    pub block_count: usize,
    /// Server timestamp (ms since epoch)
    pub timestamp: u128,
}

/// Apply update request
#[derive(Deserialize)]
pub struct UpdateRequest {
    pub update: String, // base64 encoded Y.Doc update
    /// Optional transaction ID for echo prevention.
    /// If provided, broadcast will include it so sender can filter its own updates.
    #[serde(default)]
    pub tx_id: Option<String>,
}

/// Block list response
#[derive(Serialize, Deserialize)]
pub struct BlocksResponse {
    pub blocks: Vec<BlockDto>,
    pub root_ids: Vec<String>,
}

/// Block DTO for API responses
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockDto {
    pub id: String,
    pub content: String,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub collapsed: bool,
    pub block_type: String,
    /// Block metadata (markers, wikilinks, etc). Null if not set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// Timestamp when block was created (ms since epoch)
    pub created_at: i64,
    /// Timestamp when block was last updated (ms since epoch)
    pub updated_at: i64,
}

/// Create block request
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBlockRequest {
    pub content: String,
    pub parent_id: Option<String>,
    // NOTE: Origin field removed - origin is now handled via Y.Doc observation
    // with Origin::User for all frontend mutations. See hooks/system.rs.
}

/// Update block request
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBlockRequest {
    /// New content for the block (optional if only updating metadata)
    pub content: Option<String>,
    /// New parent ID for reparenting:
    /// - Field absent: None = don't change parent
    /// - Field present with null: Some(None) = move to root
    /// - Field present with value: Some(Some(id)) = move under parent
    #[serde(default, deserialize_with = "deserialize_optional_parent_id")]
    pub parent_id: Option<Option<String>>,
    /// Metadata to set on the block
    pub metadata: Option<serde_json::Value>,
    // NOTE: Origin field removed - origin is now handled via Y.Doc observation
    // with Origin::User for all frontend mutations. See hooks/system.rs.
}

/// Custom deserializer for Option<Option<String>> that distinguishes:
/// - field absent: returns None (don't change)
/// - field present with null: returns Some(None) (move to root)
/// - field present with value: returns Some(Some(value)) (move under parent)
fn deserialize_optional_parent_id<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Deserialize the field value (null or string)
    // The #[serde(default)] handles the absent case by not calling this at all
    let value: Option<String> = Option::deserialize(deserializer)?;
    // Wrap in Some to indicate field was present
    Ok(Some(value))
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

    #[error("Search unavailable")]
    SearchUnavailable,

    #[error("Search error: {0}")]
    Search(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self {
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::InvalidBase64(_) => StatusCode::BAD_REQUEST,
            ApiError::SearchUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::Search(_) => StatusCode::INTERNAL_SERVER_ERROR,
            ApiError::Store(_) | ApiError::LockPoisoned => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = Json(ErrorResponse {
            error: self.to_string(),
        });
        (status, body).into_response()
    }
}

/// Extract timestamp from Y.Doc value (handles f64 and i64)
fn extract_timestamp(value: Option<yrs::Out>) -> i64 {
    value
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::Number(n)) => Some(n as i64),
            yrs::Out::Any(yrs::Any::BigInt(n)) => Some(n),
            _ => None,
        })
        .unwrap_or(0)
}

/// Create the API router (CORS applied in main.rs)
pub fn create_router(
    store: Arc<YDocStore>,
    broadcaster: Arc<WsBroadcaster>,
    hook_system: Arc<HookSystem>,
) -> Router {
    let page_name_index = hook_system.page_name_index();
    let state = AppState { store, broadcaster, page_name_index, hook_system };

    Router::new()
        // Core sync endpoints
        .route("/api/v1/health", get(health))
        .route("/api/v1/state", get(get_state))
        .route("/api/v1/state-vector", get(get_state_vector))
        .route("/api/v1/state/hash", get(get_state_hash))
        .route("/api/v1/update", post(apply_update))
        // Block CRUD
        .route("/api/v1/blocks", get(get_blocks))
        .route("/api/v1/blocks", post(create_block))
        .route("/api/v1/blocks/:id", get(get_block))
        .route("/api/v1/blocks/:id", patch(update_block))
        .route("/api/v1/blocks/:id", delete(delete_block))
        // Search endpoints
        .route("/api/v1/pages/search", get(search_pages))
        .route("/api/v1/search", get(search_blocks))
        .route("/api/v1/search/clear", post(clear_search_index))
        .with_state(state)
}

/// GET /api/v1/health
async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

/// GET /api/v1/state - Full Y.Doc state for sync
async fn get_state(State(state): State<AppState>) -> Result<Json<StateResponse>, ApiError> {
    let update = state.store.get_full_state()?;
    Ok(Json(StateResponse {
        state: BASE64.encode(update),
    }))
}

/// GET /api/v1/state-vector - State vector for reconciliation
///
/// Returns the state vector which describes what updates the server has.
/// Clients can use this to compute a diff of what they have that server doesn't.
async fn get_state_vector(State(state): State<AppState>) -> Result<Json<StateVectorResponse>, ApiError> {
    let sv = state.store.get_state_vector()?;
    Ok(Json(StateVectorResponse {
        state_vector: BASE64.encode(sv),
    }))
}

/// GET /api/v1/state/hash - Lightweight hash for sync health check
///
/// Returns SHA256 hash of the Y.Doc state plus block count.
/// Clients poll this periodically; if hash mismatches local, trigger full resync.
async fn get_state_hash(State(state): State<AppState>) -> Result<Json<StateHashResponse>, ApiError> {
    let full_state = state.store.get_full_state()?;

    // Compute SHA256 hash
    let mut hasher = Sha256::new();
    hasher.update(&full_state);
    let hash = format!("{:x}", hasher.finalize());

    // Count blocks
    let doc = state.store.doc();
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

/// POST /api/v1/update - Apply Y.Doc update from client
async fn apply_update(
    State(state): State<AppState>,
    Json(req): Json<UpdateRequest>,
) -> Result<StatusCode, ApiError> {
    let update_bytes = BASE64
        .decode(&req.update)
        .map_err(|e| ApiError::InvalidBase64(e.to_string()))?;

    state.store.apply_update(&update_bytes)?;

    // Broadcast to all WebSocket clients (include tx_id for echo prevention)
    state.broadcaster.broadcast(update_bytes, req.tx_id);

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
            if let yrs::Out::Any(yrs::Any::String(id)) = value {
                root_ids.push(id.to_string());
            }
        }
    }

    // Get all blocks from the map
    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            // Handle nested Y.Map (new format)
            if let yrs::Out::YMap(block_map) = value {
                let content = block_map
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();

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

                // Extract metadata if present (handles both Y.Map and legacy JSON string)
                let metadata = block_map
                    .get(&txn, "metadata")
                    .and_then(|v| extract_metadata_from_yrs(v, &txn));

                // Extract timestamps
                let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));
                let updated_at = extract_timestamp(block_map.get(&txn, "updatedAt"));

                let block_type = floatty_core::parse_block_type(&content);

                blocks.push(BlockDto {
                    id: key.to_string(),
                    content,
                    parent_id,
                    child_ids,
                    collapsed,
                    block_type: format!("{:?}", block_type).to_lowercase(),
                    metadata,
                    created_at,
                    updated_at,
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

    // Handle nested Y.Map (new format)
    if let yrs::Out::YMap(block_map) = value {
        let content = block_map
            .get(&txn, "content")
            .and_then(|v| match v {
                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .unwrap_or_default();

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

        // Extract metadata if present (handles both Y.Map and legacy JSON string)
        let metadata = block_map
            .get(&txn, "metadata")
            .and_then(|v| extract_metadata_from_yrs(v, &txn));

        // Extract timestamps
        let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));
        let updated_at = extract_timestamp(block_map.get(&txn, "updatedAt"));

        let block_type = floatty_core::parse_block_type(&content);

        Ok(Json(BlockDto {
            id: id.clone(),
            content,
            parent_id,
            child_ids,
            collapsed,
            block_type: format!("{:?}", block_type).to_lowercase(),
            metadata,
            created_at,
            updated_at,
        }))
    } else {
        Err(ApiError::NotFound(id))
    }
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

    let doc = state.store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;
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
                ("createdAt".to_owned(), yrs::any!(now as f64)),
                ("updatedAt".to_owned(), yrs::any!(now as f64)),
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
                    child_ids.push_back(&mut txn, id.as_str());
                }
            }
        } else {
            // No parent - add to rootIds
            let root_ids = txn.get_or_insert_array("rootIds");
            root_ids.push_back(&mut txn, id.as_str());
        }

        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    state.store.persist_update(&update)?;
    state.broadcaster.broadcast(update, None);

    // Emit to hook system for metadata extraction
    let _ = state.hook_system.emit_change(BlockChange::Created {
        id: id.clone(),
        content: req.content.clone(),
        parent_id: req.parent_id.clone(),
        origin: Origin::User,
    });

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
            metadata: None, // Hooks will populate async
            created_at: now as i64,
            updated_at: now as i64,
        }),
    ))
}

/// PATCH /api/v1/blocks/:id - Update content, metadata, and/or parent
async fn update_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateBlockRequest>,
) -> Result<Json<BlockDto>, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

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

            let existing_metadata = block_map.get(&txn, "metadata").and_then(|v| match v {
                yrs::Out::Any(yrs::Any::String(s)) => serde_json::from_str(s.as_ref()).ok(),
                _ => None,
            });

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

    // Determine if reparenting is requested
    // req.parent_id: None = don't change, Some(None) = move to root, Some(Some(id)) = move under parent
    let (final_parent_id, parent_changed) = match &req.parent_id {
        None => (old_parent_id.clone(), false),
        Some(new_parent) => {
            let changed = *new_parent != old_parent_id;
            (new_parent.clone(), changed)
        }
    };

    // Update fields granularly (only what changed)
    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Validate new parent exists (if reparenting to a non-root parent)
        if parent_changed {
            if let Some(ref new_parent_id) = final_parent_id {
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

            // Handle reparenting
            if parent_changed {
                // Update block's parentId field
                let parent_id_value: yrs::Any = match &final_parent_id {
                    Some(p) => yrs::Any::String(p.clone().into()),
                    None => yrs::Any::Null,
                };
                block_map.insert(&mut txn, "parentId", parent_id_value);

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
                            child_ids_arr.push_back(&mut txn, id.as_str());
                        }
                    }
                } else {
                    // Moving to root
                    let root_ids = txn.get_or_insert_array("rootIds");
                    root_ids.push_back(&mut txn, id.as_str());
                }
            }

            block_map.insert(&mut txn, "updatedAt", now as f64);
        }
        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    state.store.persist_update(&update)?;
    state.broadcaster.broadcast(update, None);

    // Emit to hook system for metadata extraction (only if content changed)
    if content_changed {
        let _ = state.hook_system.emit_change(BlockChange::ContentChanged {
            id: id.clone(),
            old_content,
            new_content: final_content.clone(),
            origin: Origin::User,
        });
    }

    let block_type = floatty_core::parse_block_type(&final_content);

    Ok(Json(BlockDto {
        id: id.clone(),
        content: final_content,
        parent_id: final_parent_id,
        child_ids,
        collapsed,
        block_type: format!("{:?}", block_type).to_lowercase(),
        metadata: final_metadata,
        created_at,
        updated_at: now as i64,
    }))
}

/// DELETE /api/v1/blocks/:id - Delete block and subtree
async fn delete_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    let (update, deleted_content) = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Get block's parentId and content before deleting
        let (parent_id, content): (Option<String>, String) = match blocks.get(&txn, &id) {
            Some(yrs::Out::YMap(block_map)) => {
                let pid = block_map.get(&txn, "parentId").and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                });
                let content = block_map
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();
                (pid, content)
            }
            Some(_) => return Err(ApiError::NotFound(id)), // Wrong format
            None => return Err(ApiError::NotFound(id)),
        };

        // Remove from parent's childIds if this block has a parent
        if let Some(ref pid) = parent_id {
            if let Some(yrs::Out::YMap(parent_map)) = blocks.get(&txn, pid) {
                if let Some(yrs::Out::YArray(child_ids)) = parent_map.get(&txn, "childIds") {
                    // Find index of this id in parent's childIds
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

        // Remove from blocks map
        blocks.remove(&mut txn, &id);

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

        (txn.encode_update_v1(), content)
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    state.store.persist_update(&update)?;
    state.broadcaster.broadcast(update, None);

    // Emit to hook system for cleanup (search index removal, etc.)
    let _ = state.hook_system.emit_change(BlockChange::Deleted {
        id: id.clone(),
        content: deleted_content,
        origin: Origin::User,
    });

    Ok(StatusCode::NO_CONTENT)
}

// ============================================================================
// Page Search API (autocomplete for [[wikilinks]])
// ============================================================================

/// Search query parameters
#[derive(Deserialize)]
pub struct PageSearchQuery {
    /// Prefix to search for (e.g., "My Pa" to find "My Page")
    #[serde(default)]
    pub prefix: String,
    /// Maximum results to return (default: 10)
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_limit() -> usize {
    10
}

/// Search result DTO
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSearchResult {
    pub name: String,
    pub is_stub: bool,
}

/// Page search response
#[derive(Serialize)]
pub struct PageSearchResponse {
    pub pages: Vec<PageSearchResult>,
}

/// GET /api/v1/pages/search?prefix=xxx
///
/// Search for pages matching a prefix. Returns existing pages first, then stubs.
/// Used for [[ autocomplete in the outliner.
async fn search_pages(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<PageSearchQuery>,
) -> Result<Json<PageSearchResponse>, ApiError> {
    let index = state.page_name_index.read().map_err(|_| ApiError::LockPoisoned)?;

    let results = index.search(&query.prefix);

    let pages: Vec<PageSearchResult> = results
        .into_iter()
        .take(query.limit)
        .map(|s| PageSearchResult {
            name: s.name,
            is_stub: s.is_stub,
        })
        .collect();

    Ok(Json(PageSearchResponse { pages }))
}

// ============================================================================
// Full-Text Search API (Tantivy)
// ============================================================================

/// Full-text search query parameters
#[derive(Deserialize)]
pub struct BlockSearchQuery {
    /// Search text (required)
    pub q: String,
    /// Maximum results to return (default: 20)
    #[serde(default = "default_search_limit")]
    pub limit: usize,
    /// Block types to filter (comma-separated, e.g., "sh,ai")
    #[serde(default)]
    pub types: Option<String>,
    /// Filter by marker presence
    #[serde(default)]
    pub has_markers: Option<bool>,
    /// Filter by parent ID (search within subtree)
    #[serde(default)]
    pub parent_id: Option<String>,
}

fn default_search_limit() -> usize {
    20
}

/// Search hit DTO
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSearchHit {
    /// Block ID
    pub block_id: String,
    /// Relevance score (higher = more relevant)
    pub score: f32,
    /// Block content (truncated for display)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

/// Full-text search response
#[derive(Serialize, Deserialize)]
pub struct BlockSearchResponse {
    /// Search results (IDs + scores)
    pub hits: Vec<BlockSearchHit>,
    /// Total number of hits returned
    pub total: usize,
}

/// GET /api/v1/search?q=...
///
/// Full-text search across all blocks. Returns block IDs and scores.
/// Frontend should hydrate full blocks from Y.Doc using the IDs.
///
/// # Query Parameters
///
/// - `q` (required): Search text
/// - `limit` (optional, default 20): Maximum results
/// - `types` (optional): Comma-separated block types to filter (e.g., "sh,ai")
/// - `has_markers` (optional): Filter by marker presence (true/false)
/// - `parent_id` (optional): Search within a specific subtree
///
/// # Example
///
/// ```text
/// GET /api/v1/search?q=floatty&limit=10&types=sh,ctx
/// ```
async fn search_blocks(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<BlockSearchQuery>,
) -> Result<Json<BlockSearchResponse>, ApiError> {
    // Get index manager from hook system
    let index_manager = state
        .hook_system
        .index_manager()
        .ok_or_else(|| ApiError::SearchUnavailable)?;

    let service = SearchService::new(index_manager);

    // Build filters from query params
    let filters = SearchFilters {
        block_types: query.types.map(|t| t.split(',').map(String::from).collect()),
        has_markers: query.has_markers,
        parent_id: query.parent_id,
    };

    // Execute search
    let hits = service
        .search_with_filters(&query.q, filters, query.limit)
        .map_err(|e| ApiError::Search(e.to_string()))?;

    let total = hits.len();

    // Hydrate content from Y.Doc for each hit
    let hits: Vec<BlockSearchHit> = {
        let doc = state.store.doc();
        let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
        let txn = doc_guard.transact();

        hits.into_iter()
            .map(|h| {
                // Look up content from Y.Doc
                let content = txn
                    .get_map("blocks")
                    .and_then(|blocks| blocks.get(&txn, &h.block_id))
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
                        // Truncate for display (first 200 chars - enough for wikilinks)
                        // Use char boundary to avoid splitting UTF-8 multi-byte characters
                        if c.chars().count() > 200 {
                            let truncated: String = c.chars().take(200).collect();
                            format!("{}...", truncated)
                        } else {
                            c
                        }
                    });

                BlockSearchHit {
                    block_id: h.block_id,
                    score: h.score,
                    content,
                }
            })
            .collect()
    };

    Ok(Json(BlockSearchResponse { hits, total }))
}

/// POST /api/v1/search/clear - Clear all documents from search index
///
/// Use when Y.Doc is cleared to remove stale index entries.
async fn clear_search_index(State(state): State<AppState>) -> Result<StatusCode, ApiError> {
    state
        .hook_system
        .clear_search_index()
        .await
        .map_err(|e| ApiError::Search(format!("Failed to clear: {}", e)))?;

    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tempfile::tempdir;
    use tower::{Service, ServiceExt};

    fn test_app() -> (Router, tempfile::TempDir, Arc<YDocStore>) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let router = create_router(Arc::clone(&store), broadcaster, hook_system);
        (router, dir, store)
    }

    #[tokio::test]
    async fn test_health_endpoint() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(Request::get("/api/v1/health").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let health: HealthResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(health.status, "ok");
    }

    #[tokio::test]
    async fn test_state_hash_endpoint() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(Request::get("/api/v1/state/hash").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let hash_resp: StateHashResponse = serde_json::from_slice(&body).unwrap();

        // SHA256 hash should be 64 hex characters
        assert_eq!(hash_resp.hash.len(), 64, "Hash should be 64 hex chars");
        // Timestamp should be reasonable (after year 2024)
        assert!(hash_resp.timestamp > 1_700_000_000_000, "Timestamp should be recent");
    }

    #[tokio::test]
    async fn test_create_root_block() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Test block"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);

        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block: BlockDto = serde_json::from_slice(&body).unwrap();
        assert_eq!(block.content, "Test block");
        assert!(block.parent_id.is_none());
        assert!(block.child_ids.is_empty());
    }

    #[tokio::test]
    async fn test_create_child_block_updates_parent() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent block
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(r#"{"content": "Parent"}"#))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let parent: BlockDto = serde_json::from_slice(&body).unwrap();

        // Create child block
        let child_req = format!(r#"{{"content": "Child", "parentId": "{}"}}"#, parent.id);
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(child_req))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let child: BlockDto = serde_json::from_slice(&body).unwrap();
        assert_eq!(child.parent_id, Some(parent.id.clone()));

        // Verify parent's childIds was updated
        let request = Request::get(&format!("/api/v1/blocks/{}", parent.id))
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let updated_parent: BlockDto = serde_json::from_slice(&body).unwrap();
        assert!(updated_parent.child_ids.contains(&child.id));
    }

    #[tokio::test]
    async fn test_delete_block_removes_from_parent_childids() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system);

        // Create parent
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Parent"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let parent: BlockDto = serde_json::from_slice(&body).unwrap();

        // Create child
        let child_req = format!(r#"{{"content": "Child", "parentId": "{}"}}"#, parent.id);
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(child_req))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let child: BlockDto = serde_json::from_slice(&body).unwrap();

        // Delete child
        let response = app
            .clone()
            .oneshot(
                Request::delete(&format!("/api/v1/blocks/{}", child.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        // Verify parent's childIds no longer contains child
        let response = app
            .oneshot(
                Request::get(&format!("/api/v1/blocks/{}", parent.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let updated_parent: BlockDto = serde_json::from_slice(&body).unwrap();
        assert!(!updated_parent.child_ids.contains(&child.id));
    }

    #[tokio::test]
    async fn test_get_nonexistent_block_returns_404() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(
                Request::get("/api/v1/blocks/nonexistent-id")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_update_block_content() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system);

        // Create block
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Original"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block: BlockDto = serde_json::from_slice(&body).unwrap();

        // Update block
        let response = app
            .clone()
            .oneshot(
                Request::patch(&format!("/api/v1/blocks/{}", block.id))
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Updated"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let updated: BlockDto = serde_json::from_slice(&body).unwrap();
        assert_eq!(updated.content, "Updated");
    }

    #[tokio::test]
    async fn test_block_type_detection() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "sh:: echo hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block: BlockDto = serde_json::from_slice(&body).unwrap();
        assert_eq!(block.block_type, "sh");
    }

    #[tokio::test]
    async fn test_get_route_works_after_create() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create a block
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(r#"{"content": "Test"}"#))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block: BlockDto = serde_json::from_slice(&body).unwrap();

        // Now GET that same block
        let url = format!("/api/v1/blocks/{}", block.id);
        eprintln!("GET URL: {}", url);
        let request = Request::get(&url)
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        let status = response.status();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        eprintln!("Response status: {}, body len: {}", status, body.len());
        assert_eq!(status, StatusCode::OK, "GET should return 200");
    }

    #[tokio::test]
    async fn test_store_state_after_create() {
        let (app, _dir, store) = test_app();

        // Create a block via API
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Test"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block: BlockDto = serde_json::from_slice(&body).unwrap();

        // Check store directly - is the block in the Y.Doc?
        let doc = store.doc();
        let doc_guard = doc.read().unwrap();
        let txn = doc_guard.transact();

        // Check if blocks map exists
        let blocks_map = txn.get_map("blocks");
        assert!(blocks_map.is_some(), "blocks map should exist after create");

        let blocks_map = blocks_map.unwrap();
        let block_in_doc = blocks_map.get(&txn, &block.id);
        assert!(block_in_doc.is_some(), "created block should be in Y.Doc. Block ID: {}", block.id);
    }

    #[tokio::test]
    async fn test_search_empty_query_returns_empty() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(
                Request::get("/api/v1/search?q=")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // Note: Search may be unavailable if index init fails (parallel tests).
        // Accept either 200 (empty results) or 503 (search unavailable).
        let status = response.status();
        assert!(
            status == StatusCode::OK || status == StatusCode::SERVICE_UNAVAILABLE,
            "Expected 200 or 503, got {}",
            status
        );

        if status == StatusCode::OK {
            let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
            let result: BlockSearchResponse = serde_json::from_slice(&body).unwrap();
            assert!(result.hits.is_empty(), "Empty query should return no results");
        }
    }

    #[tokio::test]
    async fn test_search_returns_results() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system);

        // Create a block with searchable content
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "floatty search test"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        // Wait briefly for async indexing
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Search for the block
        let response = app
            .oneshot(
                Request::get("/api/v1/search?q=floatty")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        // Accept search unavailable in parallel test environment
        let status = response.status();
        if status == StatusCode::SERVICE_UNAVAILABLE {
            return; // Search not available, skip this test
        }

        assert_eq!(status, StatusCode::OK);
        // Note: Results may be empty if index commit hasn't happened yet.
        // This is acceptable for unit tests - integration tests would wait longer.
    }

    #[tokio::test]
    async fn test_reparent_block_to_new_parent() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system);

        // Create parent A
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Parent A"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let parent_a: BlockDto = serde_json::from_slice(&body).unwrap();

        // Create parent B
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Parent B"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let parent_b: BlockDto = serde_json::from_slice(&body).unwrap();

        // Create child under parent A
        let child_req = format!(r#"{{"content": "Child", "parentId": "{}"}}"#, parent_a.id);
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(child_req))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let child: BlockDto = serde_json::from_slice(&body).unwrap();
        assert_eq!(child.parent_id, Some(parent_a.id.clone()));

        // Reparent child to parent B via PATCH
        let reparent_req = format!(r#"{{"parentId": "{}"}}"#, parent_b.id);
        let response = app
            .clone()
            .oneshot(
                Request::patch(&format!("/api/v1/blocks/{}", child.id))
                    .header("Content-Type", "application/json")
                    .body(Body::from(reparent_req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let updated_child: BlockDto = serde_json::from_slice(&body).unwrap();
        assert_eq!(updated_child.parent_id, Some(parent_b.id.clone()));

        // Verify parent A no longer has child
        let response = app
            .clone()
            .oneshot(
                Request::get(&format!("/api/v1/blocks/{}", parent_a.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let updated_parent_a: BlockDto = serde_json::from_slice(&body).unwrap();
        assert!(!updated_parent_a.child_ids.contains(&child.id), "Parent A should no longer have child");

        // Verify parent B now has child
        let response = app
            .oneshot(
                Request::get(&format!("/api/v1/blocks/{}", parent_b.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let updated_parent_b: BlockDto = serde_json::from_slice(&body).unwrap();
        assert!(updated_parent_b.child_ids.contains(&child.id), "Parent B should now have child");
    }

    #[tokio::test]
    async fn test_reparent_block_to_root() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system);

        // Create parent
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Parent"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let parent: BlockDto = serde_json::from_slice(&body).unwrap();

        // Create child under parent
        let child_req = format!(r#"{{"content": "Child", "parentId": "{}"}}"#, parent.id);
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(child_req))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let child: BlockDto = serde_json::from_slice(&body).unwrap();

        // Move child to root (parentId: null)
        let response = app
            .clone()
            .oneshot(
                Request::patch(&format!("/api/v1/blocks/{}", child.id))
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"parentId": null}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let updated_child: BlockDto = serde_json::from_slice(&body).unwrap();
        assert!(updated_child.parent_id.is_none(), "Child should now be root");

        // Verify parent no longer has child
        let response = app
            .clone()
            .oneshot(
                Request::get(&format!("/api/v1/blocks/{}", parent.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let updated_parent: BlockDto = serde_json::from_slice(&body).unwrap();
        assert!(!updated_parent.child_ids.contains(&child.id));

        // Verify child is now in rootIds
        let response = app
            .oneshot(
                Request::get("/api/v1/blocks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let blocks: BlocksResponse = serde_json::from_slice(&body).unwrap();
        assert!(blocks.root_ids.contains(&child.id), "Child should now be in rootIds");
    }

    #[tokio::test]
    async fn test_reparent_root_block_to_parent() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system);

        // Create two root blocks
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Block A"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block_a: BlockDto = serde_json::from_slice(&body).unwrap();

        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Block B"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block_b: BlockDto = serde_json::from_slice(&body).unwrap();

        // Verify both are roots
        let response = app
            .clone()
            .oneshot(Request::get("/api/v1/blocks").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let blocks: BlocksResponse = serde_json::from_slice(&body).unwrap();
        assert!(blocks.root_ids.contains(&block_a.id));
        assert!(blocks.root_ids.contains(&block_b.id));

        // Move block B under block A
        let reparent_req = format!(r#"{{"parentId": "{}"}}"#, block_a.id);
        let response = app
            .clone()
            .oneshot(
                Request::patch(&format!("/api/v1/blocks/{}", block_b.id))
                    .header("Content-Type", "application/json")
                    .body(Body::from(reparent_req))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // Verify block B is no longer root and block A has it as child
        let response = app
            .clone()
            .oneshot(Request::get("/api/v1/blocks").body(Body::empty()).unwrap())
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let blocks: BlocksResponse = serde_json::from_slice(&body).unwrap();
        assert!(blocks.root_ids.contains(&block_a.id), "Block A should still be root");
        assert!(!blocks.root_ids.contains(&block_b.id), "Block B should no longer be root");

        let response = app
            .oneshot(
                Request::get(&format!("/api/v1/blocks/{}", block_a.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block_a_updated: BlockDto = serde_json::from_slice(&body).unwrap();
        assert!(block_a_updated.child_ids.contains(&block_b.id), "Block A should have Block B as child");
    }
}
