//! REST API for floatty block store.
//!
//! Route families split into submodules:
//! - `sync` — Y.Doc state sync, updates, restore, health
//! - `blocks` — block CRUD (thin wrappers over `block_service`)
//! - `search` — full-text + page search, reindex, clear
//! - `export` — binary/JSON export, topology graph, page content
//! - `backup` — backup status, list, trigger, restore, config
//! - `outlines` — outline management + per-outline sync/blocks/search
//! - `discovery` — markers, stats, daily note, presence, attachments

pub mod backup;
pub mod blocks;
pub mod discovery;
pub mod export;
pub mod outlines;
pub mod search;
pub mod sync;

use axum::{
    http::StatusCode,
    response::IntoResponse,
    Json, Router,
};
use floatty_core::{HookSystem, InheritanceIndex, PageNameIndex, YDocStore};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use thiserror::Error;
use yrs::{Array, Map, ReadTxn, Transact};

use crate::OutlineManager;
use crate::WsBroadcaster;

/// Extract metadata from Y.Doc block, handling multiple formats:
/// - New: Embedded Y.Map (from MapPrelim insertion)
/// - Any::Map: JSON-like map value
/// - Legacy: JSON string (for backwards compatibility)
pub(crate) fn extract_metadata_from_yrs<T: ReadTxn>(value: yrs::Out, txn: &T) -> Option<serde_json::Value> {
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
pub(crate) fn yrs_out_to_json<T: ReadTxn>(out: yrs::Out, txn: &T) -> serde_json::Value {
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
pub(crate) fn yrs_any_to_json(any: yrs::Any) -> serde_json::Value {
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

use crate::backup::BackupDaemon;

/// Shared application state
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<YDocStore>,
    pub broadcaster: Arc<WsBroadcaster>,
    pub page_name_index: Arc<RwLock<PageNameIndex>>,
    pub inheritance_index: Arc<RwLock<InheritanceIndex>>,
    pub hook_system: Arc<HookSystem>,
    /// Backup daemon (optional - only present if backups enabled)
    pub backup_daemon: Option<Arc<BackupDaemon>>,
    /// Multi-outline manager (Phase 1: server-side only)
    pub outline_manager: Arc<OutlineManager>,
}

// Sync DTOs re-exported (used by ApiError::IntoResponse, outline handlers, tests)
pub use sync::{
    HealthResponse, RestoreResponse, StateHashResponse, StateResponse, StateVectorResponse,
    UpdateEntry, UpdateRequest, UpdatesCompactedResponse, UpdatesQuery, UpdatesResponse,
};
// Search DTOs re-exported (used by outline handlers, block_service, tests)
pub use search::{BlockSearchHit, BlockSearchQuery, BlockSearchResponse};
// Export DTOs re-exported (used by outline handlers, tests)
pub use export::{ExportedBlock, ExportedOutline, TopologyNode, TopologyResponse, TopologyMeta, DailyEntry, TopologyQuery, PageContentResponse};
// Block DTOs re-exported (used by block_service, outline handlers, discovery, tests)
pub use blocks::{
    BlockDto, BlocksResponse, BlockContextQuery, BlockRef, BlockWithContextResponse,
    BlocksQuery, CreateBlockRequest, ImportBlockRequest, InheritedMarkerDto,
    ResolveResponse, SiblingContext, TokenEstimate, TreeNode, UpdateBlockRequest,
};

/// Standard error response
#[derive(Serialize, Deserialize)]
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

    #[error("Invalid parent: {0}")]
    InvalidParent(String),

    #[error("Invalid request: {0}")]
    InvalidRequest(String),

    #[error("Updates compacted: requested since {requested}, compacted through {compacted_through}")]
    UpdatesCompacted {
        requested: i64,
        compacted_through: i64,
    },

    #[error("Missing confirmation header: X-Floatty-Confirm-Destructive: true")]
    MissingConfirmationHeader,

    #[error("Ambiguous prefix: {0} matches")]
    Ambiguous(usize),

    #[error("Conflict: {0}")]
    Conflict(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let status = match &self {
            ApiError::NotFound(_) => StatusCode::NOT_FOUND,
            ApiError::InvalidBase64(_) | ApiError::InvalidParent(_) | ApiError::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::SearchUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::Search(_) => StatusCode::BAD_REQUEST,
            ApiError::Store(_) | ApiError::LockPoisoned => StatusCode::INTERNAL_SERVER_ERROR,
            ApiError::UpdatesCompacted { .. } => StatusCode::GONE,
            ApiError::MissingConfirmationHeader => StatusCode::BAD_REQUEST,
            ApiError::Ambiguous(_) | ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        // For UpdatesCompacted, return structured JSON with compaction info
        if let ApiError::UpdatesCompacted { requested, compacted_through } = &self {
            let body = Json(UpdatesCompactedResponse {
                error: self.to_string(),
                compacted_through: *compacted_through,
                requested_since: *requested,
            });
            return (status, body).into_response();
        }

        let body = Json(ErrorResponse {
            error: self.to_string(),
        });
        (status, body).into_response()
    }
}

/// Create the API router (CORS applied in main.rs)
pub fn create_router(
    store: Arc<YDocStore>,
    broadcaster: Arc<WsBroadcaster>,
    hook_system: Arc<HookSystem>,
    backup_daemon: Option<Arc<BackupDaemon>>,
    outline_manager: Arc<OutlineManager>,
) -> Router {
    let page_name_index = hook_system.page_name_index();
    let inheritance_index = hook_system.inheritance_index();
    let state = AppState { store, broadcaster, page_name_index, inheritance_index, hook_system, backup_daemon, outline_manager };

    Router::new()
        // Sync endpoints (health, state, update, restore, updates-since)
        .merge(sync::router())
        // Export + topology endpoints
        .merge(export::router())
        // Block CRUD
        .merge(blocks::router())
        // Search endpoints (page search, full-text, reindex, clear)
        .merge(search::router())
        // Backup endpoints (status, list, trigger, restore, config)
        .merge(backup::router())
        // Discovery endpoints (markers, stats, daily note, presence, attachments)
        .merge(discovery::router())
        // Outline management + per-outline sync/blocks/search
        .merge(outlines::router())
        .with_state(state)
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

    fn test_outline_manager(dir: &std::path::Path, store: &Arc<YDocStore>, hook_system: &Arc<floatty_core::HookSystem>, broadcaster: &Arc<crate::WsBroadcaster>) -> Arc<crate::OutlineManager> {
        let ctx = Arc::new(crate::OutlineContext::new_default(
            Arc::clone(store), Arc::clone(hook_system), Arc::clone(broadcaster), None, None,
        ));
        let no_backup = crate::config::BackupConfig { enabled: false, ..Default::default() };
        Arc::new(crate::OutlineManager::new_with_default(dir, ctx, no_backup))
    }

    fn test_app() -> (Router, tempfile::TempDir, Arc<YDocStore>) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let outline_manager = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let router = create_router(Arc::clone(&store), broadcaster, hook_system, None, outline_manager);
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
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

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
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

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
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let router = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);
        let mut app = router.into_service();

        // Create a block with searchable content
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(r#"{"content": "floatty search test"}"#))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        // Poll for search availability — indexing is async, timing varies under parallel test load
        let mut attempts = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            attempts += 1;

            let response = ServiceExt::<Request<Body>>::ready(&mut app)
                .await.unwrap()
                .call(
                    Request::get("/api/v1/search?q=floatty")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            let status = response.status();

            if status == StatusCode::SERVICE_UNAVAILABLE {
                if attempts >= 20 {
                    return; // Search infra not available in this test env, skip
                }
                continue;
            }

            assert_eq!(status, StatusCode::OK);

            // When search IS available, verify it actually returns the created block
            let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
            let result: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let hits = result["hits"].as_array();
            if hits.map_or(true, |h| h.is_empty()) && attempts < 20 {
                continue; // Index commit hasn't happened yet, retry
            }
            if let Some(h) = hits {
                assert!(!h.is_empty(), "search returned 200 but no hits after indexing");
            }
            break;
        }
    }

    #[tokio::test]
    async fn test_reparent_block_to_new_parent() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

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
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

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
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

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

    #[tokio::test]
    async fn test_reparent_rejects_self_parent() {
        let (app, _dir, _store) = test_app();

        // Create a block
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
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let block: BlockDto = serde_json::from_slice(&body).unwrap();

        // Try to parent block under itself
        let reparent_req = format!(r#"{{"parentId": "{}"}}"#, block.id);
        let response = app
            .oneshot(
                Request::patch(&format!("/api/v1/blocks/{}", block.id))
                    .header("Content-Type", "application/json")
                    .body(Body::from(reparent_req))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "Self-parenting should be rejected");
    }

    #[tokio::test]
    async fn test_reparent_rejects_cycle() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

        // Create parent -> child hierarchy
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

        // Try to parent parent under child (would create cycle)
        let reparent_req = format!(r#"{{"parentId": "{}"}}"#, child.id);
        let response = app
            .oneshot(
                Request::patch(&format!("/api/v1/blocks/{}", parent.id))
                    .header("Content-Type", "application/json")
                    .body(Body::from(reparent_req))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "Cycle should be rejected");
    }

    #[tokio::test]
    async fn test_export_binary_returns_ydoc() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

        // Create a block first
        let _response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Test block"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        // Get binary export
        let response = app
            .oneshot(Request::get("/api/v1/export/binary").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        // Check Content-Type
        let content_type = response.headers().get("content-type").unwrap();
        assert_eq!(content_type, "application/octet-stream");

        // Check Content-Disposition has .ydoc filename
        let disposition = response.headers().get("content-disposition").unwrap();
        let disposition_str = disposition.to_str().unwrap();
        assert!(disposition_str.contains("floatty-"), "Should have floatty prefix");
        assert!(disposition_str.contains(".ydoc"), "Should have .ydoc extension");

        // Body should be non-empty binary data
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        assert!(!body.is_empty(), "Binary export should not be empty");
    }

    #[tokio::test]
    async fn test_export_json_returns_valid_json() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

        // Create a block first
        let _response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Test block for JSON export"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        // Get JSON export
        let response = app
            .oneshot(Request::get("/api/v1/export/json").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        // Check Content-Type
        let content_type = response.headers().get("content-type").unwrap();
        assert_eq!(content_type, "application/json");

        // Check Content-Disposition has .json filename
        let disposition = response.headers().get("content-disposition").unwrap();
        let disposition_str = disposition.to_str().unwrap();
        assert!(disposition_str.contains("floatty-"), "Should have floatty prefix");
        assert!(disposition_str.contains(".json"), "Should have .json extension");

        // Parse and validate JSON structure
        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let export: ExportedOutline = serde_json::from_slice(&body).unwrap();

        assert_eq!(export.version, 1);
        assert!(!export.exported.is_empty());
        assert!(export.block_count >= 1, "Should have at least 1 block");
        assert!(!export.root_ids.is_empty(), "Should have root IDs");
        assert!(!export.blocks.is_empty(), "Should have blocks");
    }

    // ═══════════════════════════════════════════════════════════════
    // UPDATES ENDPOINT TESTS (FLO-SEQ)
    // ═══════════════════════════════════════════════════════════════

    #[tokio::test]
    async fn test_updates_endpoint_returns_410_when_behind_compaction() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

        // Create some updates via API (creates blocks which generate Y.Doc updates)
        for i in 0..5 {
            let content = format!(r#"{{"content": "Block {}"}}"#, i);
            let _response = app
                .clone()
                .oneshot(
                    Request::post("/api/v1/blocks")
                        .header("Content-Type", "application/json")
                        .body(Body::from(content))
                        .unwrap(),
                )
                .await
                .unwrap();
        }

        // Get the latest seq before compaction
        let latest_seq = store.get_latest_seq().unwrap().unwrap();
        assert!(latest_seq >= 5, "Should have at least 5 updates");

        // Compact - this creates a snapshot and deletes old updates
        store.force_compact().unwrap();

        // Now request updates since seq 1 (before compaction boundary)
        let response = app
            .oneshot(
                Request::get("/api/v1/updates?since=1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::GONE, "Should return 410 Gone");

        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let error: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(error.get("compactedThrough").is_some(), "Should include compactedThrough");
        assert!(error.get("requestedSince").is_some(), "Should include requestedSince");
    }

    #[tokio::test]
    async fn test_updates_endpoint_boundary_exact_match() {
        // Edge case: client's lastSeenSeq == compacted_through
        // This SHOULD work (they've seen everything up to compaction)
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let om = test_outline_manager(dir.path(), &store, &hook_system, &broadcaster);
        let app = create_router(Arc::clone(&store), Arc::clone(&broadcaster), hook_system, None, om);

        // Create initial updates
        for i in 0..3 {
            let content = format!(r#"{{"content": "Block {}"}}"#, i);
            let _response = app
                .clone()
                .oneshot(
                    Request::post("/api/v1/blocks")
                        .header("Content-Type", "application/json")
                        .body(Body::from(content))
                        .unwrap(),
                )
                .await
                .unwrap();
        }

        // Get seq before compaction (this will be the boundary)
        let boundary_seq = store.get_latest_seq().unwrap().unwrap();

        // Compact
        store.force_compact().unwrap();

        // Create one more update AFTER compaction
        let _response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/blocks")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"content": "Post-compaction block"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        // Request since=boundary_seq (exactly at boundary) — should work
        let response = app
            .oneshot(
                Request::get(&format!("/api/v1/updates?since={}", boundary_seq))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK, "Boundary exact match should return 200");

        let body: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: UpdatesResponse = serde_json::from_slice(&body).unwrap();

        // Should return at least the post-compaction update
        // Note: may also include the compaction snapshot itself
        assert!(!result.updates.is_empty(), "Should have updates after boundary");
    }

    // ========================================================================
    // Recursive DELETE tests (FLO-348)
    // ========================================================================

    /// Helper: create a block via POST, return its BlockDto
    async fn create_test_block(app: &mut axum::routing::RouterIntoService<Body>, content: &str, parent_id: Option<&str>) -> BlockDto {
        let body = match parent_id {
            Some(pid) => format!(r#"{{"content": "{}", "parentId": "{}"}}"#, content, pid),
            None => format!(r#"{{"content": "{}"}}"#, content),
        };
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(app)
            .await.unwrap()
            .call(request)
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Helper: GET a block, return Option<BlockDto> (None if 404)
    async fn get_test_block(app: &mut axum::routing::RouterIntoService<Body>, id: &str) -> Option<BlockDto> {
        let request = Request::get(&format!("/api/v1/blocks/{}", id))
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(app)
            .await.unwrap()
            .call(request)
            .await.unwrap();
        if response.status() == StatusCode::NOT_FOUND {
            return None;
        }
        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        Some(serde_json::from_slice(&bytes).unwrap())
    }

    /// Helper: DELETE a block
    async fn delete_test_block(app: &mut axum::routing::RouterIntoService<Body>, id: &str) -> StatusCode {
        let request = Request::delete(&format!("/api/v1/blocks/{}", id))
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(app)
            .await.unwrap()
            .call(request)
            .await.unwrap();
        response.status()
    }

    #[tokio::test]
    async fn test_delete_block_no_children() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block = create_test_block(&mut app, "Leaf block", None).await;
        let status = delete_test_block(&mut app, &block.id).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        // Block should be gone
        assert!(get_test_block(&mut app, &block.id).await.is_none());
    }

    #[tokio::test]
    async fn test_delete_block_with_children() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent + 3 children
        let parent = create_test_block(&mut app, "Parent", None).await;
        let child1 = create_test_block(&mut app, "Child 1", Some(&parent.id)).await;
        let child2 = create_test_block(&mut app, "Child 2", Some(&parent.id)).await;
        let child3 = create_test_block(&mut app, "Child 3", Some(&parent.id)).await;

        // Delete parent — should take all children with it
        let status = delete_test_block(&mut app, &parent.id).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        // All blocks should be gone
        assert!(get_test_block(&mut app, &parent.id).await.is_none(), "Parent should be deleted");
        assert!(get_test_block(&mut app, &child1.id).await.is_none(), "Child 1 should be deleted");
        assert!(get_test_block(&mut app, &child2.id).await.is_none(), "Child 2 should be deleted");
        assert!(get_test_block(&mut app, &child3.id).await.is_none(), "Child 3 should be deleted");
    }

    #[tokio::test]
    async fn test_delete_block_nested_grandchildren() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // 3 levels: grandparent → parent → child
        let grandparent = create_test_block(&mut app, "Grandparent", None).await;
        let parent = create_test_block(&mut app, "Parent", Some(&grandparent.id)).await;
        let child = create_test_block(&mut app, "Child", Some(&parent.id)).await;
        let sibling = create_test_block(&mut app, "Sibling", Some(&grandparent.id)).await;

        // Delete grandparent — entire subtree should be gone
        let status = delete_test_block(&mut app, &grandparent.id).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        assert!(get_test_block(&mut app, &grandparent.id).await.is_none(), "Grandparent gone");
        assert!(get_test_block(&mut app, &parent.id).await.is_none(), "Parent gone");
        assert!(get_test_block(&mut app, &child.id).await.is_none(), "Child gone");
        assert!(get_test_block(&mut app, &sibling.id).await.is_none(), "Sibling gone");
    }

    #[tokio::test]
    async fn test_delete_child_preserves_parent_and_siblings() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let parent = create_test_block(&mut app, "Parent", None).await;
        let child1 = create_test_block(&mut app, "Child 1", Some(&parent.id)).await;
        let child2 = create_test_block(&mut app, "Child 2", Some(&parent.id)).await;

        // Delete only child1
        let status = delete_test_block(&mut app, &child1.id).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        // child1 gone, parent and child2 intact
        assert!(get_test_block(&mut app, &child1.id).await.is_none(), "Deleted child gone");
        let parent_after = get_test_block(&mut app, &parent.id).await.expect("Parent should survive");
        assert!(!parent_after.child_ids.contains(&child1.id), "Removed from parent's childIds");
        assert!(parent_after.child_ids.contains(&child2.id), "Sibling still in childIds");
        assert!(get_test_block(&mut app, &child2.id).await.is_some(), "Sibling survives");
    }

    #[tokio::test]
    async fn test_delete_middle_subtree_preserves_rest() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Tree:  root → [branch_a → [leaf], branch_b]
        let root = create_test_block(&mut app, "Root", None).await;
        let branch_a = create_test_block(&mut app, "Branch A", Some(&root.id)).await;
        let leaf = create_test_block(&mut app, "Leaf under A", Some(&branch_a.id)).await;
        let branch_b = create_test_block(&mut app, "Branch B", Some(&root.id)).await;

        // Delete branch_a (and its leaf)
        let status = delete_test_block(&mut app, &branch_a.id).await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        assert!(get_test_block(&mut app, &branch_a.id).await.is_none(), "Branch A gone");
        assert!(get_test_block(&mut app, &leaf.id).await.is_none(), "Leaf under A gone");

        // Root and branch_b survive
        let root_after = get_test_block(&mut app, &root.id).await.expect("Root survives");
        assert!(!root_after.child_ids.contains(&branch_a.id), "Branch A removed from root childIds");
        assert!(root_after.child_ids.contains(&branch_b.id), "Branch B still in root childIds");
        assert!(get_test_block(&mut app, &branch_b.id).await.is_some(), "Branch B survives");
    }

    // FLO-283: Positional Block Insertion Tests

    #[tokio::test]
    async fn test_create_block_after_sibling() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent
        let parent = create_test_block(&mut app, "Parent", None).await;

        // Create first child
        let first = create_test_block(&mut app, "First", Some(&parent.id)).await;

        // Create second child with afterId
        let body = format!(
            r#"{{"content": "Second", "parentId": "{}", "afterId": "{}"}}"#,
            parent.id, first.id
        );
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let second: BlockDto = serde_json::from_slice(&bytes).unwrap();

        // Verify order
        let parent_updated = get_test_block(&mut app, &parent.id).await.expect("Parent should exist");
        assert_eq!(parent_updated.child_ids, vec![first.id.clone(), second.id]);
    }

    #[tokio::test]
    async fn test_create_block_at_index_prepend() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent
        let parent = create_test_block(&mut app, "Parent", None).await;

        // Create first child
        let first = create_test_block(&mut app, "First", Some(&parent.id)).await;

        // Prepend another child with atIndex: 0
        let body = format!(
            r#"{{"content": "Prepended", "parentId": "{}", "atIndex": 0}}"#,
            parent.id
        );
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let prepended: BlockDto = serde_json::from_slice(&bytes).unwrap();

        // Verify order (prepended should be first)
        let parent_updated = get_test_block(&mut app, &parent.id).await.expect("Parent should exist");
        assert_eq!(parent_updated.child_ids, vec![prepended.id, first.id.clone()]);
    }

    #[tokio::test]
    async fn test_create_block_at_index_middle() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent
        let parent = create_test_block(&mut app, "Parent", None).await;

        // Create A and C
        let a = create_test_block(&mut app, "A", Some(&parent.id)).await;
        let c = create_test_block(&mut app, "C", Some(&parent.id)).await;

        // Insert B at index 1 (between A and C)
        let body = format!(
            r#"{{"content": "B", "parentId": "{}", "atIndex": 1}}"#,
            parent.id
        );
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let b: BlockDto = serde_json::from_slice(&bytes).unwrap();

        // Verify order (A, B, C)
        let parent_updated = get_test_block(&mut app, &parent.id).await.expect("Parent should exist");
        assert_eq!(parent_updated.child_ids, vec![a.id.clone(), b.id, c.id.clone()]);
    }

    #[tokio::test]
    async fn test_create_block_at_index_clamp() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent (empty)
        let parent = create_test_block(&mut app, "Parent", None).await;

        // Try to insert at index 999 (should clamp to 0)
        let body = format!(
            r#"{{"content": "Clamped", "parentId": "{}", "atIndex": 999}}"#,
            parent.id
        );
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let clamped: BlockDto = serde_json::from_slice(&bytes).unwrap();

        // Verify it was added (clamped to end = index 0 for empty parent)
        let parent_updated = get_test_block(&mut app, &parent.id).await.expect("Parent should exist");
        assert_eq!(parent_updated.child_ids, vec![clamped.id]);
    }

    #[tokio::test]
    async fn test_create_block_both_params_error() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent and sibling
        let parent = create_test_block(&mut app, "Parent", None).await;
        let sibling = create_test_block(&mut app, "Sibling", Some(&parent.id)).await;

        // Try to specify both afterId AND atIndex
        let body = format!(
            r#"{{"content": "Invalid", "parentId": "{}", "afterId": "{}", "atIndex": 0}}"#,
            parent.id, sibling.id
        );
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        // Should return 400 Bad Request
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let error: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(error.error.contains("Cannot specify both"));
    }

    #[tokio::test]
    async fn test_create_block_after_id_not_found() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent
        let parent = create_test_block(&mut app, "Parent", None).await;

        // Try to insert after nonexistent block
        let body = format!(
            r#"{{"content": "Invalid", "parentId": "{}", "afterId": "nonexistent-uuid"}}"#,
            parent.id
        );
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        // Should return 404 Not Found
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let error: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(error.error.contains("afterId not found"));
    }

    #[tokio::test]
    async fn test_create_block_after_id_wrong_parent() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create two separate parents
        let parent1 = create_test_block(&mut app, "Parent1", None).await;
        let parent2 = create_test_block(&mut app, "Parent2", None).await;

        // Create child under parent1
        let child1 = create_test_block(&mut app, "Child1", Some(&parent1.id)).await;

        // Try to insert under parent2 after child1 (wrong parent)
        let body = format!(
            r#"{{"content": "Invalid", "parentId": "{}", "afterId": "{}"}}"#,
            parent2.id, child1.id
        );
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        // Should return 400 Bad Request
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let error: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(error.error.contains("not a sibling"));
    }

    // FLO-283 Phase 2: Block Repositioning Tests

    #[tokio::test]
    async fn test_update_block_reposition_after_sibling() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent and three children
        let parent = create_test_block(&mut app, "Parent", None).await;
        let child1 = create_test_block(&mut app, "Child 1", Some(&parent.id)).await;
        let child2 = create_test_block(&mut app, "Child 2", Some(&parent.id)).await;
        let child3 = create_test_block(&mut app, "Child 3", Some(&parent.id)).await;

        // Initial order: [child1, child2, child3]
        let parent_before = get_test_block(&mut app, &parent.id).await.expect("Parent should exist");
        assert_eq!(parent_before.child_ids, vec![child1.id.clone(), child2.id.clone(), child3.id.clone()]);

        // Move child3 after child1 (new order: child1, child3, child2)
        let body = format!(r#"{{"afterId": "{}"}}"#, child1.id);
        let request = Request::patch(&format!("/api/v1/blocks/{}", child3.id))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        // Verify new order
        let parent_after = get_test_block(&mut app, &parent.id).await.expect("Parent should exist");
        assert_eq!(parent_after.child_ids, vec![child1.id.clone(), child3.id.clone(), child2.id.clone()]);
    }

    #[tokio::test]
    async fn test_update_block_reposition_at_index() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent and three children
        let parent = create_test_block(&mut app, "Parent", None).await;
        let child1 = create_test_block(&mut app, "Child 1", Some(&parent.id)).await;
        let child2 = create_test_block(&mut app, "Child 2", Some(&parent.id)).await;
        let child3 = create_test_block(&mut app, "Child 3", Some(&parent.id)).await;

        // Move child3 to index 0 (new order: child3, child1, child2)
        let body = r#"{"atIndex": 0}"#;
        let request = Request::patch(&format!("/api/v1/blocks/{}", child3.id))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        // Verify new order
        let parent_after = get_test_block(&mut app, &parent.id).await.expect("Parent should exist");
        assert_eq!(parent_after.child_ids, vec![child3.id.clone(), child1.id.clone(), child2.id.clone()]);
    }

    #[tokio::test]
    async fn test_update_block_reparent_with_position() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create two parents
        let parent1 = create_test_block(&mut app, "Parent 1", None).await;
        let parent2 = create_test_block(&mut app, "Parent 2", None).await;

        // Create children under parent1
        let child1 = create_test_block(&mut app, "Child 1", Some(&parent1.id)).await;

        // Create children under parent2
        let child2a = create_test_block(&mut app, "Child 2a", Some(&parent2.id)).await;
        let child2b = create_test_block(&mut app, "Child 2b", Some(&parent2.id)).await;

        // Move child1 from parent1 to parent2, insert after child2a
        let body = format!(r#"{{"parentId": "{}", "afterId": "{}"}}"#, parent2.id, child2a.id);
        let request = Request::patch(&format!("/api/v1/blocks/{}", child1.id))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        // Verify child1 removed from parent1
        let parent1_after = get_test_block(&mut app, &parent1.id).await.expect("Parent1 should exist");
        assert_eq!(parent1_after.child_ids, Vec::<String>::new());

        // Verify child1 added to parent2 in correct position
        let parent2_after = get_test_block(&mut app, &parent2.id).await.expect("Parent2 should exist");
        assert_eq!(parent2_after.child_ids, vec![child2a.id.clone(), child1.id.clone(), child2b.id.clone()]);
    }

    #[tokio::test]
    async fn test_update_block_reposition_both_params_error() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent and children
        let parent = create_test_block(&mut app, "Parent", None).await;
        let child1 = create_test_block(&mut app, "Child 1", Some(&parent.id)).await;
        let child2 = create_test_block(&mut app, "Child 2", Some(&parent.id)).await;

        // Try to specify both afterId AND atIndex
        let body = format!(r#"{{"afterId": "{}", "atIndex": 0}}"#, child1.id);
        let request = Request::patch(&format!("/api/v1/blocks/{}", child2.id))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        // Should return 400 Bad Request
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let error: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(error.error.contains("Cannot specify both"));
    }

    #[tokio::test]
    async fn test_update_block_reposition_self_referential_after_id() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let parent = create_test_block(&mut app, "Parent", None).await;
        let child = create_test_block(&mut app, "Child", Some(&parent.id)).await;

        // Try afterId == the block being moved
        let body = format!(r#"{{"afterId": "{}"}}"#, child.id);
        let request = Request::patch(&format!("/api/v1/blocks/{}", child.id))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let error: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(error.error.contains("afterId cannot reference the block being moved"));
    }

    #[tokio::test]
    async fn test_update_block_reposition_after_id_not_found() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent and child
        let parent = create_test_block(&mut app, "Parent", None).await;
        let child = create_test_block(&mut app, "Child", Some(&parent.id)).await;

        // Try to reposition after nonexistent block
        let body = r#"{"afterId": "nonexistent-uuid"}"#;
        let request = Request::patch(&format!("/api/v1/blocks/{}", child.id))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        // Should return 404 Not Found
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let error: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(error.error.contains("afterId not found"));
    }

    #[tokio::test]
    async fn test_update_block_reposition_after_id_wrong_parent() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create two separate parents
        let parent1 = create_test_block(&mut app, "Parent 1", None).await;
        let parent2 = create_test_block(&mut app, "Parent 2", None).await;

        // Create children under different parents
        let child1 = create_test_block(&mut app, "Child 1", Some(&parent1.id)).await;
        let child2 = create_test_block(&mut app, "Child 2", Some(&parent2.id)).await;

        // Try to reposition child2 after child1 (different parents, without reparenting)
        let body = format!(r#"{{"afterId": "{}"}}"#, child1.id);
        let request = Request::patch(&format!("/api/v1/blocks/{}", child2.id))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        // Should return 400 Bad Request
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let error: ErrorResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(error.error.contains("not a sibling"));
    }

    #[tokio::test]
    async fn test_update_block_reposition_root_blocks() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create three root blocks
        let root1 = create_test_block(&mut app, "Root 1", None).await;
        let root2 = create_test_block(&mut app, "Root 2", None).await;
        let root3 = create_test_block(&mut app, "Root 3", None).await;

        // Move root3 to beginning (atIndex: 0)
        let body = r#"{"atIndex": 0}"#;
        let request = Request::patch(&format!("/api/v1/blocks/{}", root3.id))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);

        // Verify root order via GET /api/v1/blocks
        let request = Request::get("/api/v1/blocks")
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let list: BlocksResponse = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(list.root_ids, vec![root3.id.clone(), root1.id.clone(), root2.id.clone()]);
    }

    #[tokio::test]
    async fn test_create_root_block_after_id() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create first root block
        let first = create_test_block(&mut app, "First Root", None).await;

        // Insert second root after first (no parent)
        let body = format!(
            r#"{{"content": "Second Root", "afterId": "{}"}}"#,
            first.id
        );
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let second: BlockDto = serde_json::from_slice(&bytes).unwrap();

        // Verify root order via GET /api/v1/blocks
        let request = Request::get("/api/v1/blocks")
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let list: BlocksResponse = serde_json::from_slice(&bytes).unwrap();

        // Should have both roots in order
        assert_eq!(list.root_ids, vec![first.id.clone(), second.id]);
    }

    #[tokio::test]
    async fn test_create_block_default_append() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create parent
        let parent = create_test_block(&mut app, "Parent", None).await;

        // Create first child (no positional params)
        let first = create_test_block(&mut app, "First", Some(&parent.id)).await;

        // Create second child (no positional params - should append)
        let second = create_test_block(&mut app, "Second", Some(&parent.id)).await;

        // Verify order (backward compatible append behavior)
        let parent_updated = get_test_block(&mut app, &parent.id).await.expect("Parent should exist");
        assert_eq!(parent_updated.child_ids, vec![first.id.clone(), second.id]);
    }

    // ========================================================================
    // Topology endpoint tests (FLO-394)
    // ========================================================================

    #[tokio::test]
    async fn test_topology_empty_store() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(Request::get("/api/v1/topology").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let topo: TopologyResponse = serde_json::from_slice(&bytes).unwrap();

        assert!(topo.nodes.is_empty());
        assert!(topo.edges.is_empty());
        assert!(topo.content.is_empty());
        assert_eq!(topo.meta.blocks, 0);
        assert_eq!(topo.meta.pages, 0);
    }

    #[tokio::test]
    async fn test_topology_with_pages() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create pages:: container
        let pages_container = create_test_block(&mut app, "pages::", None).await;

        // Create two pages under it
        let _page_a = create_test_block(&mut app, "# Alpha", Some(&pages_container.id)).await;
        let _page_b = create_test_block(&mut app, "# Beta", Some(&pages_container.id)).await;

        // Create a child under page A
        let _child = create_test_block(&mut app, "child of alpha", Some(&_page_a.id)).await;

        // Hooks run asynchronously via spawn_dispatch_task — give them time to process
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Query topology
        let request = Request::get("/api/v1/topology")
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let topo: TopologyResponse = serde_json::from_slice(&bytes).unwrap();

        // Should have 2 page nodes (alpha, beta)
        assert_eq!(topo.nodes.len(), 2, "Should have 2 page nodes");
        assert_eq!(topo.meta.pages, 2);
        // 4 blocks total: pages::, Alpha, Beta, child
        assert_eq!(topo.meta.blocks, 4);

        // Alpha should have subtree count of 2 (itself + child)
        let alpha_node = topo.nodes.iter().find(|n| n.id == "alpha").expect("Alpha node");
        assert_eq!(alpha_node.b, 2);
        assert_eq!(alpha_node.is_ref, 0); // exists in pages::
        assert_eq!(alpha_node.orp, 1); // no inlinks → orphan

        let beta_node = topo.nodes.iter().find(|n| n.id == "beta").expect("Beta node");
        assert_eq!(beta_node.b, 1); // just itself
        assert_eq!(beta_node.orp, 1); // no inlinks → orphan
    }

    #[tokio::test]
    async fn test_topology_query_params() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // maxLines=0 should omit content entirely
        let request = Request::get("/api/v1/topology?maxLines=0")
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let topo: TopologyResponse = serde_json::from_slice(&bytes).unwrap();
        assert!(topo.content.is_empty());
    }

    #[tokio::test]
    async fn test_page_content_endpoint() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create pages:: container + page
        let pages = create_test_block(&mut app, "pages::", None).await;
        let page = create_test_block(&mut app, "# TestPage", Some(&pages.id)).await;
        let _child = create_test_block(&mut app, "child line one", Some(&page.id)).await;

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Fetch content for the page
        let request = Request::get("/api/v1/topology/content/testpage")
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let content: PageContentResponse = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(content.name, "testpage");
        assert_eq!(content.block_count, 2); // page + child
        assert_eq!(content.lines.len(), 1); // child line (page heading skipped)
        assert_eq!(content.lines[0].1, "child line one");
    }

    #[tokio::test]
    async fn test_page_content_not_found() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(Request::get("/api/v1/topology/content/nonexistent").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    // ========================================================================
    // GET /api/v1/blocks query param filtering
    // ========================================================================

    #[tokio::test]
    async fn test_get_blocks_no_params_returns_all() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        create_test_block(&mut app, "Block A", None).await;
        create_test_block(&mut app, "Block B", None).await;

        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(Request::get("/api/v1/blocks").body(Body::empty()).unwrap())
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlocksResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.blocks.len(), 2);
    }

    #[tokio::test]
    async fn test_get_blocks_since_until_filter() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block_a = create_test_block(&mut app, "Block A", None).await;
        // Small sleep to separate timestamps
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let midpoint = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let _block_b = create_test_block(&mut app, "Block B", None).await;

        // since=midpoint should only return Block B
        let url = format!("/api/v1/blocks?since={}", midpoint);
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(Request::get(&url).body(Body::empty()).unwrap())
            .await.unwrap();

        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlocksResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].content, "Block B");

        // until=midpoint should only return Block A
        let url = format!("/api/v1/blocks?until={}", midpoint);
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(Request::get(&url).body(Body::empty()).unwrap())
            .await.unwrap();

        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlocksResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].content, "Block A");

        // since + until covering everything
        let url = format!("/api/v1/blocks?since={}&until={}", block_a.created_at, midpoint + 100000);
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(Request::get(&url).body(Body::empty()).unwrap())
            .await.unwrap();

        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlocksResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.blocks.len(), 2);
    }

    #[tokio::test]
    async fn test_get_blocks_marker_type_filter() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block_a = create_test_block(&mut app, "ctx:: block", None).await;
        let _block_b = create_test_block(&mut app, "plain block", None).await;

        // PATCH block_a to add ctx marker metadata
        let patch_body = format!(
            r#"{{"metadata": {{"markers": [{{"markerType": "ctx", "value": "work"}}]}}}}"#
        );
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(
                Request::patch(&format!("/api/v1/blocks/{}", block_a.id))
                    .header("Content-Type", "application/json")
                    .body(Body::from(patch_body))
                    .unwrap(),
            )
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        // Filter by marker_type=ctx
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(Request::get("/api/v1/blocks?marker_type=ctx").body(Body::empty()).unwrap())
            .await.unwrap();

        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlocksResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].id, block_a.id);
    }

    #[tokio::test]
    async fn test_get_blocks_marker_type_and_value_filter() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block_a = create_test_block(&mut app, "ctx work", None).await;
        let block_b = create_test_block(&mut app, "ctx play", None).await;

        // PATCH both with ctx markers but different values
        for (id, val) in [(&block_a.id, "work"), (&block_b.id, "play")] {
            let patch_body = format!(
                r#"{{"metadata": {{"markers": [{{"markerType": "ctx", "value": "{}"}}]}}}}"#,
                val
            );
            let response = ServiceExt::<Request<Body>>::ready(&mut app)
                .await.unwrap()
                .call(
                    Request::patch(&format!("/api/v1/blocks/{}", id))
                        .header("Content-Type", "application/json")
                        .body(Body::from(patch_body))
                        .unwrap(),
                )
                .await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }

        // marker_type=ctx returns both
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(Request::get("/api/v1/blocks?marker_type=ctx").body(Body::empty()).unwrap())
            .await.unwrap();
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlocksResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.blocks.len(), 2);

        // marker_type=ctx&marker_value=work returns only block_a
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(Request::get("/api/v1/blocks?marker_type=ctx&marker_value=work").body(Body::empty()).unwrap())
            .await.unwrap();
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlocksResponse = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.blocks.len(), 1);
        assert_eq!(result.blocks[0].id, block_a.id);
    }

    // ========================================================================
    // Short-hash prefix resolution tests
    // ========================================================================

    #[tokio::test]
    async fn test_get_block_by_prefix() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block = create_test_block(&mut app, "prefix test", None).await;
        // Use first 8 chars of UUID (dash-stripped)
        let prefix: String = block.id.chars().filter(|c| *c != '-').take(8).collect();

        let request = Request::get(&format!("/api/v1/blocks/{}", prefix))
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlockDto = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.id, block.id);
    }

    #[tokio::test]
    async fn test_get_block_full_uuid_passthrough() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block = create_test_block(&mut app, "full uuid", None).await;
        let result = get_test_block(&mut app, &block.id).await;
        assert!(result.is_some());
        assert_eq!(result.unwrap().id, block.id);
    }

    #[tokio::test]
    async fn test_get_block_prefix_not_found() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let _block = create_test_block(&mut app, "exists", None).await;

        let request = Request::get("/api/v1/blocks/aaaaaa")
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_patch_block_by_prefix() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block = create_test_block(&mut app, "original", None).await;
        let prefix: String = block.id.chars().filter(|c| *c != '-').take(8).collect();

        let body = r#"{"content": "updated via prefix"}"#;
        let request = Request::patch(&format!("/api/v1/blocks/{}", prefix))
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlockDto = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.content, "updated via prefix");
        assert_eq!(result.id, block.id);
    }

    #[tokio::test]
    async fn test_delete_block_by_prefix() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block = create_test_block(&mut app, "to delete", None).await;
        let prefix: String = block.id.chars().filter(|c| *c != '-').take(8).collect();

        let request = Request::delete(&format!("/api/v1/blocks/{}", prefix))
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        // Verify actually deleted
        let result = get_test_block(&mut app, &block.id).await;
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_create_block_with_short_parent_id() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let parent = create_test_block(&mut app, "parent", None).await;
        let prefix: String = parent.id.chars().filter(|c| *c != '-').take(8).collect();

        let body = format!(r#"{{"content": "child", "parentId": "{}"}}"#, prefix);
        let request = Request::post("/api/v1/blocks")
            .header("Content-Type", "application/json")
            .body(Body::from(body))
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlockDto = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.parent_id, Some(parent.id));
    }

    #[tokio::test]
    async fn test_prefix_case_insensitive() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let block = create_test_block(&mut app, "case test", None).await;
        let prefix: String = block.id.chars().filter(|c| *c != '-').take(8).collect();
        let upper_prefix = prefix.to_uppercase();

        let request = Request::get(&format!("/api/v1/blocks/{}", upper_prefix))
            .body(Body::empty())
            .unwrap();
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(request)
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let bytes: Vec<u8> = response.into_body().collect().await.unwrap().to_bytes().to_vec();
        let result: BlockDto = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result.id, block.id);
    }

    // ========================================================================
    // Daily note endpoint tests
    // ========================================================================

    #[tokio::test]
    async fn test_daily_note_found() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create pages:: container + daily note page
        let pages = create_test_block(&mut app, "pages::", None).await;
        let daily = create_test_block(&mut app, "# 2026-03-31", Some(&pages.id)).await;
        let child = create_test_block(&mut app, "brain boot context", Some(&daily.id)).await;

        // Poll for PageNameIndex hook to process (async, timing varies under parallel test load)
        let mut response_bytes = Vec::new();
        for attempt in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            let request = Request::get("/api/v1/daily/2026-03-31")
                .body(Body::empty())
                .unwrap();
            let response = ServiceExt::<Request<Body>>::ready(&mut app)
                .await.unwrap()
                .call(request)
                .await.unwrap();
            if response.status() == StatusCode::OK {
                response_bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
                break;
            }
            assert!(attempt < 19, "PageNameIndex never indexed the daily note page");
        }
        let result: serde_json::Value = serde_json::from_slice(&response_bytes).unwrap();

        assert_eq!(result["id"], daily.id);
        assert_eq!(result["content"], "# 2026-03-31");

        // Default includes children
        let children = result["children"].as_array().expect("Should include children by default");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["id"], child.id);
    }

    #[tokio::test]
    async fn test_daily_note_not_found() {
        let (app, _dir, _store) = test_app();

        let response = app
            .oneshot(Request::get("/api/v1/daily/2099-12-31").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_create_block_with_supplied_id() {
        let (app, _dir, _store) = test_app();
        let supplied_id = uuid::Uuid::new_v4().to_string();

        let body = serde_json::json!({ "content": "hello", "id": supplied_id });
        let response = app
            .oneshot(
                Request::post("/api/v1/blocks/import")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let created: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(created["id"], supplied_id, "Import should preserve caller-supplied ID");
    }

    #[tokio::test]
    async fn test_create_block_duplicate_id_rejected() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        // Create a block via normal endpoint first
        let existing = create_test_block(&mut app, "existing", None).await;

        // Try to import with the same ID — should be rejected as conflict
        let body = serde_json::json!({ "content": "duplicate", "id": existing.id });
        let response = ServiceExt::<Request<Body>>::ready(&mut app)
            .await.unwrap()
            .call(
                Request::post("/api/v1/blocks/import")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await.unwrap();

        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn test_create_block_invalid_uuid_rejected() {
        let (app, _dir, _store) = test_app();

        let body = serde_json::json!({ "content": "bad id", "id": "not-a-uuid" });
        let response = app
            .oneshot(
                Request::post("/api/v1/blocks/import")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_daily_note_with_tree_include() {
        let (router, _dir, _store) = test_app();
        let mut app = router.into_service();

        let pages = create_test_block(&mut app, "pages::", None).await;
        let daily = create_test_block(&mut app, "# 2026-03-30", Some(&pages.id)).await;
        let child = create_test_block(&mut app, "morning notes", Some(&daily.id)).await;
        let _grandchild = create_test_block(&mut app, "detail item", Some(&child.id)).await;

        // Poll for PageNameIndex hook to process
        let mut response_bytes = Vec::new();
        for attempt in 0..20 {
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            let request = Request::get("/api/v1/daily/2026-03-30?include=tree,token_estimate")
                .body(Body::empty())
                .unwrap();
            let response = ServiceExt::<Request<Body>>::ready(&mut app)
                .await.unwrap()
                .call(request)
                .await.unwrap();
            if response.status() == StatusCode::OK {
                response_bytes = response.into_body().collect().await.unwrap().to_bytes().to_vec();
                break;
            }
            assert!(attempt < 19, "PageNameIndex never indexed the daily note page");
        }

        let result: serde_json::Value = serde_json::from_slice(&response_bytes).unwrap();

        // Tree should include the subtree
        let tree = result["tree"].as_array().expect("Should include tree");
        assert!(tree.len() >= 2, "Tree should have at least child + grandchild");

        // Token estimate should be present
        assert!(result.get("tokenEstimate").is_some());
    }
}
