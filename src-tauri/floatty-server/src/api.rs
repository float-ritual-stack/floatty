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
use yrs::{Array, ArrayPrelim, Map, MapPrelim, ReadTxn, Transact, WriteTxn};

use crate::WsBroadcaster;

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<YDocStore>,
    pub broadcaster: Arc<WsBroadcaster>,
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
#[derive(Serialize, Deserialize)]
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
            ApiError::InvalidBase64(_) => StatusCode::BAD_REQUEST,
            ApiError::Store(_) | ApiError::LockPoisoned => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = Json(ErrorResponse {
            error: self.to_string(),
        });
        (status, body).into_response()
    }
}

/// Create the API router (CORS applied in main.rs)
pub fn create_router(store: Arc<YDocStore>, broadcaster: Arc<WsBroadcaster>) -> Router {
    let state = AppState { store, broadcaster };

    Router::new()
        // Core sync endpoints
        .route("/api/v1/health", get(health))
        .route("/api/v1/state", get(get_state))
        .route("/api/v1/update", post(apply_update))
        // Block CRUD
        .route("/api/v1/blocks", get(get_blocks))
        .route("/api/v1/blocks", post(create_block))
        .route("/api/v1/blocks/:id", get(get_block))
        .route("/api/v1/blocks/:id", patch(update_block))
        .route("/api/v1/blocks/:id", delete(delete_block))
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

/// POST /api/v1/update - Apply Y.Doc update from client
async fn apply_update(
    State(state): State<AppState>,
    Json(req): Json<UpdateRequest>,
) -> Result<StatusCode, ApiError> {
    let update_bytes = BASE64
        .decode(&req.update)
        .map_err(|e| ApiError::InvalidBase64(e.to_string()))?;

    state.store.apply_update(&update_bytes)?;

    // Broadcast to all WebSocket clients
    state.broadcaster.broadcast(update_bytes);

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
            if let yrs::Value::Any(yrs::Any::String(id)) = value {
                root_ids.push(id.to_string());
            }
        }
    }

    // Get all blocks from the map
    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            // Handle nested Y.Map (new format)
            if let yrs::Value::YMap(block_map) = value {
                let content = block_map
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();

                let parent_id = block_map.get(&txn, "parentId").and_then(|v| match v {
                    yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    yrs::Value::Any(yrs::Any::Null) => None,
                    _ => None,
                });

                let child_ids = block_map
                    .get(&txn, "childIds")
                    .and_then(|v| match v {
                        yrs::Value::YArray(arr) => Some(
                            arr.iter(&txn)
                                .filter_map(|v| match v {
                                    yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
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
                        yrs::Value::Any(yrs::Any::Bool(b)) => Some(b),
                        _ => None,
                    })
                    .unwrap_or(false);

                let block_type = floatty_core::parse_block_type(&content);

                blocks.push(BlockDto {
                    id: key.to_string(),
                    content,
                    parent_id,
                    child_ids,
                    collapsed,
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

    // Handle nested Y.Map (new format)
    if let yrs::Value::YMap(block_map) = value {
        let content = block_map
            .get(&txn, "content")
            .and_then(|v| match v {
                yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .unwrap_or_default();

        let parent_id = block_map.get(&txn, "parentId").and_then(|v| match v {
            yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
            yrs::Value::Any(yrs::Any::Null) => None,
            _ => None,
        });

        let child_ids = block_map
            .get(&txn, "childIds")
            .and_then(|v| match v {
                yrs::Value::YArray(arr) => Some(
                    arr.iter(&txn)
                        .filter_map(|v| match v {
                            yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
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
                yrs::Value::Any(yrs::Any::Bool(b)) => Some(b),
                _ => None,
            })
            .unwrap_or(false);

        let block_type = floatty_core::parse_block_type(&content);

        Ok(Json(BlockDto {
            id: id.clone(),
            content,
            parent_id,
            child_ids,
            collapsed,
            block_type: format!("{:?}", block_type).to_lowercase(),
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
            // Add to parent's childIds array
            if let Some(yrs::Value::YMap(parent_map)) = blocks.get(&txn, parent_id) {
                if let Some(yrs::Value::YArray(child_ids)) = parent_map.get(&txn, "childIds") {
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
    state.broadcaster.broadcast(update);

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

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    // Read existing block data and update in place (granular CRDT update)
    let (parent_id, child_ids, collapsed) = {
        let txn = doc_guard.transact();
        let blocks_map = txn
            .get_map("blocks")
            .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

        let value = blocks_map
            .get(&txn, &id)
            .ok_or_else(|| ApiError::NotFound(id.clone()))?;

        if let yrs::Value::YMap(block_map) = value {
            let parent_id = block_map.get(&txn, "parentId").and_then(|v| match v {
                yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
                yrs::Value::Any(yrs::Any::Null) => None,
                _ => None,
            });

            let child_ids = block_map
                .get(&txn, "childIds")
                .and_then(|v| match v {
                    yrs::Value::YArray(arr) => Some(
                        arr.iter(&txn)
                            .filter_map(|v| match v {
                                yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
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
                    yrs::Value::Any(yrs::Any::Bool(b)) => Some(b),
                    _ => None,
                })
                .unwrap_or(false);

            (parent_id, child_ids, collapsed)
        } else {
            return Err(ApiError::NotFound(id));
        }
    };

    // Update only content and updatedAt (granular - doesn't rewrite whole block)
    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        if let Some(yrs::Value::YMap(block_map)) = blocks.get(&txn, &id) {
            block_map.insert(&mut txn, "content", req.content.clone());
            block_map.insert(&mut txn, "updatedAt", now as f64);
        }
        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    state.store.persist_update(&update)?;
    state.broadcaster.broadcast(update);

    let block_type = floatty_core::parse_block_type(&req.content);

    Ok(Json(BlockDto {
        id: id.clone(),
        content: req.content,
        parent_id,
        child_ids,
        collapsed,
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

        // Get block and its parentId before deleting
        let parent_id: Option<String> = match blocks.get(&txn, &id) {
            Some(yrs::Value::YMap(block_map)) => {
                block_map.get(&txn, "parentId").and_then(|v| match v {
                    yrs::Value::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
            }
            Some(_) => return Err(ApiError::NotFound(id)), // Wrong format
            None => return Err(ApiError::NotFound(id)),
        };

        // Remove from parent's childIds if this block has a parent
        if let Some(ref pid) = parent_id {
            if let Some(yrs::Value::YMap(parent_map)) = blocks.get(&txn, pid) {
                if let Some(yrs::Value::YArray(child_ids)) = parent_map.get(&txn, "childIds") {
                    // Find index of this id in parent's childIds
                    let mut remove_idx: Option<u32> = None;
                    for (i, value) in child_ids.iter(&txn).enumerate() {
                        if let yrs::Value::Any(yrs::Any::String(s)) = value {
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
                if let yrs::Value::Any(yrs::Any::String(s)) = value {
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

        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    state.store.persist_update(&update)?;
    state.broadcaster.broadcast(update);

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
        let router = create_router(Arc::clone(&store), broadcaster);
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
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster));

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
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster));

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
}
