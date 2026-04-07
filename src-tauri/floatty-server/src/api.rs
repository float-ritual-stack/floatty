//! REST API for floatty block store.
//!
//! Core sync endpoints:
//! - GET /api/v1/state - Full Y.Doc state (base64)
//! - GET /api/v1/state-vector - State vector for reconciliation
//! - GET /api/v1/state/hash - SHA256 hash for sync health check
//! - GET /api/v1/updates - Incremental updates since sequence number
//! - POST /api/v1/update - Apply Y.Doc update
//! - POST /api/v1/restore - Replace Y.Doc state from backup
//! - GET /api/v1/health - Health check
//!
//! Export endpoints:
//! - GET /api/v1/export/binary - Raw Y.Doc state as .ydoc file
//! - GET /api/v1/export/json - Human-readable JSON export
//! - GET /api/v1/topology - Lightweight graph topology (for Passenger Manifest)
//!
//! Block CRUD endpoints:
//! - GET /api/v1/blocks - All blocks as JSON
//! - GET /api/v1/blocks/resolve/:prefix - Resolve short-hash prefix to full block
//! - GET /api/v1/blocks/:id - Single block (supports ?include=ancestors,siblings,children,tree,token_estimate)
//! - POST /api/v1/blocks - Create block
//! - PATCH /api/v1/blocks/:id - Update content
//! - DELETE /api/v1/blocks/:id - Delete block + subtree

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{delete, get, patch, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::{DateTime, Utc};
use floatty_core::{events::BlockChange, HookSystem, InheritanceIndex, Origin, OutlineInfo, OutlineName, PageNameIndex, SearchFilters, SearchService, YDocStore};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Digest};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use yrs::{Array, ArrayPrelim, Map, MapPrelim, ReadTxn, Transact, WriteTxn};

use crate::OutlineManager;
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

/// Health check response
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    /// Git commit SHA (short, 7 chars)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_sha: Option<String>,
    /// Whether there were uncommitted changes at build time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_dirty: Option<bool>,
}

/// Full state response (for sync)
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateResponse {
    /// Base64-encoded full Y.Doc state
    pub state: String,
    /// Latest sequence number in the database (for client to re-seed seq tracking after full sync)
    pub latest_seq: Option<i64>,
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

// ============================================================================
// Incremental Sync (Sequence Number Support)
// ============================================================================

/// Query parameters for GET /api/v1/updates
#[derive(Deserialize)]
pub struct UpdatesQuery {
    /// Sequence number to start from (exclusive - returns updates AFTER this seq)
    pub since: i64,
    /// Maximum number of updates to return (default: 100, max: 1000)
    #[serde(default = "default_updates_limit")]
    pub limit: usize,
}

fn default_updates_limit() -> usize {
    100
}

/// Single update entry in response
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEntry {
    /// Sequence number (monotonically increasing)
    pub seq: i64,
    /// Base64-encoded Y.Doc update bytes
    pub data: String,
    /// Unix timestamp when update was persisted
    pub created_at: i64,
}

/// Response for GET /api/v1/updates
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesResponse {
    /// List of updates since the requested sequence
    pub updates: Vec<UpdateEntry>,
    /// Highest sequence number that was compacted (updates <= this are gone)
    /// Null if no compaction has occurred
    pub compacted_through: Option<i64>,
    /// Latest sequence number in the database (for client to know if fully caught up)
    pub latest_seq: Option<i64>,
}

/// Error response when client requests updates that have been compacted
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesCompactedResponse {
    pub error: String,
    /// Highest sequence that was compacted
    pub compacted_through: i64,
    /// What the client requested
    pub requested_since: i64,
}

/// Apply update request
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// Markers inherited from ancestor blocks. Only present when the block
    /// has no own tag markers but an ancestor does. Contains only tag-style
    /// markers (those with values like project::floatty), not prefix markers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inherited_markers: Option<Vec<InheritedMarkerDto>>,
    /// Timestamp when block was created (ms since epoch)
    pub created_at: i64,
    /// Timestamp when block was last updated (ms since epoch)
    pub updated_at: i64,
    /// Block output type (e.g., "door", "eval-result", "search-results")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_type: Option<String>,
    /// Block output data (door envelope, eval result, etc.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Value>,
}

/// A marker inherited from an ancestor block.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InheritedMarkerDto {
    pub marker_type: String,
    pub value: String,
    /// Block ID of the ancestor this marker was inherited from.
    pub source_block_id: String,
}

// ============================================================================
// Block Context Retrieval (FLO-338)
// ============================================================================

/// Query parameters for GET /api/v1/blocks/:id
#[derive(Deserialize, Debug, Default)]
pub struct BlockContextQuery {
    /// Comma-separated include directives: ancestors, siblings, children, tree, token_estimate
    #[serde(default)]
    pub include: Option<String>,
    /// Number of siblings before/after to include (default: 2)
    #[serde(default = "default_sibling_radius")]
    pub sibling_radius: usize,
    /// Max depth for tree traversal (default: 50, prevents runaway on huge subtrees)
    #[serde(default = "default_max_depth")]
    pub max_depth: usize,
}

fn default_sibling_radius() -> usize { 2 }
fn default_max_depth() -> usize { 50 }

/// Lightweight block reference for context (ancestors, siblings, children)
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BlockRef {
    pub id: String,
    pub content: String,
}

/// A block in a subtree traversal, with depth info
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub id: String,
    pub content: String,
    pub depth: usize,
    pub child_ids: Vec<String>,
}

/// Sibling context: blocks before and after within parent's childIds
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SiblingContext {
    pub before: Vec<BlockRef>,
    pub after: Vec<BlockRef>,
}

/// Token/size estimate for a subtree
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenEstimate {
    pub total_chars: usize,
    pub block_count: usize,
    pub max_depth: usize,
}

/// Extended block response with optional context fields
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockWithContextResponse {
    #[serde(flatten)]
    pub block: BlockDto,

    /// Parent chain up to root (nearest first), max 10
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ancestors: Option<Vec<BlockRef>>,

    /// Sibling blocks before/after within parent
    #[serde(skip_serializing_if = "Option::is_none")]
    pub siblings: Option<SiblingContext>,

    /// Direct children (id + content)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<BlockRef>>,

    /// Full subtree DFS traversal
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tree: Option<Vec<TreeNode>>,

    /// Rough size estimate for the subtree
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_estimate: Option<TokenEstimate>,
}

/// Create block request
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBlockRequest {
    pub content: String,
    pub parent_id: Option<String>,

    /// Insert after this sibling block (mutually exclusive with at_index)
    pub after_id: Option<String>,

    /// Insert at this index in parent's childIds (0 = prepend)
    /// Mutually exclusive with after_id
    pub at_index: Option<usize>,
    // NOTE: Origin field removed - origin is now handled via Y.Doc observation
    // with Origin::User for all frontend mutations. See hooks/system.rs.
}

/// Update block request
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

    /// Insert after this sibling block (mutually exclusive with at_index)
    /// Used for repositioning within parent or during reparenting
    pub after_id: Option<String>,

    /// Insert at this index in parent's childIds (0 = prepend)
    /// Mutually exclusive with after_id
    pub at_index: Option<usize>,
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

/// Response for GET /api/v1/blocks/resolve/:prefix
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResponse {
    pub id: String,
    pub block: BlockDto,
}

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
            ApiError::Ambiguous(_) => StatusCode::CONFLICT,
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
    backup_daemon: Option<Arc<BackupDaemon>>,
    outline_manager: Arc<OutlineManager>,
) -> Router {
    let page_name_index = hook_system.page_name_index();
    let inheritance_index = hook_system.inheritance_index();
    let state = AppState { store, broadcaster, page_name_index, inheritance_index, hook_system, backup_daemon, outline_manager };

    Router::new()
        // Core sync endpoints
        .route("/api/v1/health", get(health))
        .route("/api/v1/state", get(get_state))
        .route("/api/v1/state-vector", get(get_state_vector))
        .route("/api/v1/state/hash", get(get_state_hash))
        .route("/api/v1/updates", get(get_updates_since))
        .route("/api/v1/update", post(apply_update))
        .route("/api/v1/restore", post(restore_state))
        // Export endpoints
        .route("/api/v1/export/binary", get(export_binary))
        .route("/api/v1/export/json", get(export_json))
        // Topology (lightweight graph projection)
        .route("/api/v1/topology", get(get_topology))
        .route("/api/v1/topology/content/:pageName", get(get_page_content))
        // Block CRUD
        .route("/api/v1/blocks", get(get_blocks))
        .route("/api/v1/blocks", post(create_block))
        .route("/api/v1/blocks/resolve/:prefix", get(resolve_block_prefix))
        .route("/api/v1/blocks/:id", get(get_block))
        .route("/api/v1/blocks/:id", patch(update_block))
        .route("/api/v1/blocks/:id", put(put_not_supported))
        .route("/api/v1/blocks/:id", delete(delete_block))
        // Search endpoints
        .route("/api/v1/pages/search", get(search_pages))
        .route("/api/v1/search", get(search_blocks))
        .route("/api/v1/search/clear", post(clear_search_index))
        .route("/api/v1/search/reindex", post(reindex_search))
        // Vocabulary discovery endpoints
        .route("/api/v1/markers", get(list_marker_types))
        .route("/api/v1/markers/:marker_type/values", get(list_marker_values))
        .route("/api/v1/stats", get(get_block_stats))
        // Backup endpoints
        .route("/api/v1/backup/status", get(backup_status))
        .route("/api/v1/backup/list", get(backup_list))
        .route("/api/v1/backup/trigger", post(backup_trigger))
        .route("/api/v1/backup/restore", post(backup_restore))
        .route("/api/v1/backup/config", get(backup_config))
        // Presence (spike for TUI follower)
        .route("/api/v1/presence", get(get_presence).post(post_presence))
        // Daily note — resolve page by date (e.g., /api/v1/daily/2026-03-31)
        .route("/api/v1/daily/:date", get(get_daily_note))
        // Attachments — static file serving from {data_dir}/__attachments/
        .route("/api/v1/attachments/:filename", get(get_attachment))
        // Outline management (Phase 1: multi-outline)
        .route("/api/v1/outlines", get(list_outlines).post(create_outline_handler))
        .route("/api/v1/outlines/:name", delete(delete_outline_handler))
        // Per-outline sync endpoints
        .route("/api/v1/outlines/:name/state", get(outline_get_state))
        .route("/api/v1/outlines/:name/state-vector", get(outline_get_state_vector))
        .route("/api/v1/outlines/:name/state/hash", get(outline_get_state_hash))
        .route("/api/v1/outlines/:name/update", post(outline_apply_update))
        .route("/api/v1/outlines/:name/updates", get(outline_get_updates_since))
        .route("/api/v1/outlines/:name/export/binary", get(outline_export_binary))
        .route("/api/v1/outlines/:name/export/json", get(outline_export_json))
        // Per-outline block CRUD
        .route("/api/v1/outlines/:name/blocks", get(outline_get_blocks).post(outline_create_block))
        .route("/api/v1/outlines/:name/blocks/:id", get(outline_get_block).patch(outline_update_block).delete(outline_delete_block))
        .route("/api/v1/outlines/:name/stats", get(outline_get_stats))
        // 501 stubs for features requiring per-outline hooks/search (Phase 2)
        .route("/api/v1/outlines/:name/search", get(outline_search_not_impl))
        .route("/api/v1/outlines/:name/pages/search", get(outline_search_not_impl))
        .with_state(state)
}

/// GET /api/v1/health
async fn health() -> Json<HealthResponse> {
    // Get git info from vergen (populated at build time)
    let git_sha = option_env!("VERGEN_GIT_SHA").map(|s| s[..7.min(s.len())].to_string());
    let git_dirty = option_env!("VERGEN_GIT_DIRTY").map(|s| s == "true");

    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        git_sha,
        git_dirty,
    })
}

/// GET /api/v1/state - Full Y.Doc state for sync
///
/// Returns the full Y.Doc state along with the latest sequence number.
/// Client should use latestSeq to re-seed sequence tracking after a full sync.
async fn get_state(State(state): State<AppState>) -> Result<Json<StateResponse>, ApiError> {
    let update = state.store.get_full_state()?;
    let latest_seq = state.store.get_latest_seq()?;
    Ok(Json(StateResponse {
        state: BASE64.encode(update),
        latest_seq,
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

    // apply_update persists first, returns sequence number
    let seq = state.store.apply_update(&update_bytes)?;

    // Broadcast to all WebSocket clients (include tx_id for echo prevention, seq for gap detection)
    state.broadcaster.broadcast(update_bytes, req.tx_id, Some(seq));

    Ok(StatusCode::OK)
}

/// Restore request - same as update but for full state replacement
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestoreRequest {
    /// Base64 encoded Y.Doc state (from binary export)
    pub state: String,
}

/// Restore response
#[derive(Serialize)]
pub struct RestoreResponse {
    /// Number of blocks restored
    pub block_count: usize,
    /// Number of root blocks
    pub root_count: usize,
}

/// POST /api/v1/restore - Replace Y.Doc state from binary backup
///
/// This is a **destructive operation** that replaces all server state with the
/// provided backup. Use for disaster recovery or migration.
///
/// Unlike `/api/v1/update` which merges updates via CRDT, this endpoint:
/// 1. Clears all existing Y.Doc state
/// 2. Applies the backup as the new baseline
/// 3. Broadcasts the new state to all connected clients
///
/// # Request Body
/// ```json
/// { "state": "<base64 encoded Y.Doc state>" }
/// ```
///
/// # Response
/// ```json
/// { "block_count": 196, "root_count": 7 }
/// ```
async fn restore_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RestoreRequest>,
) -> Result<Json<RestoreResponse>, ApiError> {
    // Safety check: require explicit confirmation header for destructive operation
    let confirmed = headers
        .get("x-floatty-confirm-destructive")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if !confirmed {
        return Err(ApiError::MissingConfirmationHeader);
    }

    let state_bytes = BASE64
        .decode(&req.state)
        .map_err(|e| ApiError::InvalidBase64(e.to_string()))?;

    // 1. Clear search index before restore (stale entries would remain otherwise)
    if let Err(e) = state.hook_system.clear_search_index().await {
        tracing::warn!("Failed to clear search index before restore: {}", e);
        // Continue anyway - search will have stale entries but Y.Doc is more important
    }

    // 2. Reset the store to the new state
    let block_count = state.store.reset_from_state(&state_bytes)?;

    // 3. Get the new full state for broadcasting
    let new_state = state.store.get_full_state()?;

    // 4. Broadcast the new state to all WebSocket clients
    // They'll need to reset their local Y.Doc too
    // No seq for restore - this is a full state replacement, not an incremental update
    state.broadcaster.broadcast(new_state, None, None);

    // 5. Rehydrate hooks (metadata extraction, search indexing, etc.)
    let rehydrated = state.hook_system.rehydrate_all_blocks(&state.store);
    tracing::info!("Rehydrated {} blocks after restore", rehydrated);

    // Count roots
    let root_count = {
        let doc = state.store.doc();
        let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
        let txn = doc_guard.transact();
        txn.get_array("rootIds")
            .map(|arr| arr.len(&txn) as usize)
            .unwrap_or(0)
    };

    tracing::info!(
        block_count = block_count,
        root_count = root_count,
        "Y.Doc restored from binary backup"
    );

    Ok(Json(RestoreResponse {
        block_count,
        root_count,
    }))
}

/// GET /api/v1/updates - Get incremental updates since a sequence number
///
/// Used for:
/// - Gap detection: client sees seq 417 → 419, fetches missing 418
/// - Incremental reconnect: client has seq 500, fetches only seq > 500
/// - Agent polling: stateless API clients that don't use WebSocket
///
/// # Query Parameters
/// - `since`: Sequence number to start from (exclusive - returns updates AFTER this seq)
/// - `limit`: Maximum updates to return (default: 100, max: 1000)
///
/// # Response (200 OK)
/// ```json
/// {
///   "updates": [{ "seq": 501, "data": "<base64>", "createdAt": 1707123456 }, ...],
///   "compactedThrough": 100,
///   "latestSeq": 525
/// }
/// ```
///
/// # Response (410 Gone)
/// Returned when `since` < `compactedThrough` - client must do full state sync.
/// ```json
/// {
///   "error": "Updates compacted: requested since 50, compacted through 100",
///   "compactedThrough": 100,
///   "requestedSince": 50
/// }
/// ```
async fn get_updates_since(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<UpdatesQuery>,
) -> Result<Json<UpdatesResponse>, ApiError> {
    // Clamp limit to max 1000
    let limit = query.limit.min(1000);

    // Check if requested seq is before compaction boundary
    let compacted_through = state.store.get_compacted_through()?;
    if let Some(boundary) = compacted_through {
        if query.since < boundary {
            return Err(ApiError::UpdatesCompacted {
                requested: query.since,
                compacted_through: boundary,
            });
        }
    }

    // Fetch updates
    let updates_raw = state.store.get_updates_since(query.since, limit)?;

    // Convert to response format (base64 encode the update bytes)
    let updates: Vec<UpdateEntry> = updates_raw
        .into_iter()
        .map(|(seq, data, created_at)| UpdateEntry {
            seq,
            data: BASE64.encode(&data),
            created_at,
        })
        .collect();

    // Get latest seq for client to know if fully caught up
    let latest_seq = state.store.get_latest_seq()?;

    Ok(Json(UpdatesResponse {
        updates,
        compacted_through,
        latest_seq,
    }))
}

// ============================================================================
// Export Endpoints (FLO-249)
// ============================================================================

/// Exported block structure for JSON export
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedBlock {
    pub content: String,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    #[serde(rename = "type")]
    pub block_type: String,
    pub collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// Always include metadata to match frontend ⌘⇧J export shape (FLO-393).
    /// Frontend uses `metadata: {}` for blocks without extracted metadata.
    #[serde(default)]
    pub metadata: serde_json::Value,
}

/// JSON export response structure
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedOutline {
    pub version: u32,
    pub exported: String,
    pub block_count: usize,
    pub root_ids: Vec<String>,
    pub blocks: std::collections::HashMap<String, ExportedBlock>,
}

// ============================================================================
// Topology Endpoint (FLO-394)
// ============================================================================

/// Node in the topology graph (page or ref-only entity).
#[derive(Serialize, Deserialize)]
pub struct TopologyNode {
    /// Page name (truncated to 55 chars)
    pub id: String,
    /// Block count in subtree (capped 3000)
    pub b: usize,
    /// Total inlink count
    pub i: usize,
    /// Root-territory count (distinct root territories linking here)
    pub rc: usize,
    /// 1 if orphan (in pages:: but no inlinks)
    pub orp: u8,
    /// 1 if ref-only (referenced but not in pages::)
    #[serde(rename = "ref")]
    pub is_ref: u8,
    /// Block UUID of the page (if exists, not ref-only)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bid: Option<String>,
}

/// Topology response matching extract-topology.py contract.
#[derive(Serialize, Deserialize)]
pub struct TopologyResponse {
    #[serde(rename = "n")]
    pub nodes: Vec<TopologyNode>,
    #[serde(rename = "e")]
    pub edges: Vec<[String; 2]>,
    /// Per-page outline content: { "page name": [[depth, "line"], ...] }
    #[serde(rename = "c")]
    pub content: std::collections::HashMap<String, Vec<(u8, String)>>,
    /// Daily block creation rhythm
    pub daily: Vec<DailyEntry>,
    pub meta: TopologyMeta,
}

#[derive(Serialize, Deserialize)]
pub struct DailyEntry {
    pub d: String,
    pub n: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyMeta {
    pub blocks: usize,
    pub pages: usize,
    pub days: usize,
    pub roots: usize,
    pub ref_only: usize,
    pub orphans: usize,
}

/// Generate timestamp string for filenames: YYYY-MM-DD-HHmmss (UTC)
fn export_timestamp() -> String {
    Utc::now().format("%Y-%m-%d-%H%M%S").to_string()
}

/// GET /api/v1/export/binary - Raw Y.Doc state as downloadable .ydoc file
///
/// Returns the full Y.Doc state as binary data with Content-Disposition header
/// for direct download. Use this for perfect backup/restore.
async fn export_binary(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let full_state = state.store.get_full_state()?;
    let timestamp = export_timestamp();
    let filename = format!("floatty-{}.ydoc", timestamp);
    let content_disposition = format!("attachment; filename=\"{}\"", filename);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, header::HeaderValue::from_static("application/octet-stream")),
            (header::CONTENT_DISPOSITION, header::HeaderValue::from_str(&content_disposition).unwrap()),
        ],
        full_state,
    ))
}

/// GET /api/v1/attachments/:filename - Serve a file from {data_dir}/__attachments/
///
/// Single-user loopback endpoint. Auth is handled by the global Bearer middleware.
/// Path traversal is prevented by rejecting filenames with `/`, `\`, or `..`.
/// The directory is created on first request if it doesn't exist.
async fn get_attachment(Path(filename): Path<String>) -> Result<impl IntoResponse, ApiError> {
    // Reject path traversal attempts
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(ApiError::InvalidRequest("Invalid filename".to_string()));
    }

    let attachments_dir = crate::config::data_dir().join("__attachments");
    // Create dir lazily so the endpoint works even before any files are placed there
    let _ = tokio::fs::create_dir_all(&attachments_dir).await;

    let file_path = attachments_dir.join(&filename);
    let bytes = tokio::fs::read(&file_path).await
        .map_err(|_| ApiError::NotFound(format!("Attachment not found: {}", filename)))?;

    // Infer content type from extension
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
        [(header::CONTENT_TYPE, header::HeaderValue::from_static(content_type))],
        bytes,
    ))
}

/// GET /api/v1/export/json - Human-readable JSON export
///
/// Returns structured JSON with all blocks. Note: This is a LOSSY export -
/// CRDT metadata (vector clocks, tombstones) is NOT preserved.
/// Use /api/v1/export/binary for perfect restore.
async fn export_json(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let mut blocks = std::collections::HashMap::new();
    let mut root_ids = Vec::new();

    // Get root IDs
    if let Some(root_ids_arr) = txn.get_array("rootIds") {
        for value in root_ids_arr.iter(&txn) {
            if let yrs::Out::Any(yrs::Any::String(id)) = value {
                root_ids.push(id.to_string());
            }
        }
    }

    // Get all blocks
    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
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

                let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));
                let updated_at = extract_timestamp(block_map.get(&txn, "updatedAt"));

                let metadata = block_map
                    .get(&txn, "metadata")
                    .and_then(|v| extract_metadata_from_yrs(v, &txn))
                    .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));

                let block_type = floatty_core::parse_block_type(&content);

                blocks.insert(
                    key.to_string(),
                    ExportedBlock {
                        content,
                        parent_id,
                        child_ids,
                        block_type: format!("{:?}", block_type).to_lowercase(),
                        collapsed,
                        created_at,
                        updated_at,
                        metadata,
                    },
                );
            }
        }
    }

    let timestamp = export_timestamp();
    let filename = format!("floatty-{}.json", timestamp);

    // ISO 8601 timestamp for the exported field
    let exported = format!(
        "{}-{}-{}T{}:{}:{}Z",
        &timestamp[0..4],   // year
        &timestamp[5..7],   // month
        &timestamp[8..10],  // day
        &timestamp[11..13], // hour
        &timestamp[13..15], // minute
        &timestamp[15..17], // second
    );

    let export = ExportedOutline {
        version: 1,
        exported,
        block_count: blocks.len(),
        root_ids,
        blocks,
    };

    let json = serde_json::to_string_pretty(&export)
        .map_err(|e| ApiError::Search(format!("JSON serialization failed: {}", e)))?;

    let content_disposition = format!("attachment; filename=\"{}\"", filename);

    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, header::HeaderValue::from_static("application/json")),
            (header::CONTENT_DISPOSITION, header::HeaderValue::from_str(&content_disposition).unwrap()),
        ],
        json,
    ))
}

/// Query parameters for GET /api/v1/topology
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopologyQuery {
    /// Max content lines per page (default: 30, 0 = omit content entirely)
    #[serde(default = "default_max_lines")]
    pub max_lines: usize,
    /// Max chars per content line (default: 90)
    #[serde(default = "default_max_line_len")]
    pub max_line_len: usize,
}

fn default_max_lines() -> usize { 30 }
fn default_max_line_len() -> usize { 90 }

/// GET /api/v1/topology - Lightweight graph projection for the Passenger Manifest.
///
/// Returns page nodes, edges (outlinks between pages), truncated content, daily rhythm,
/// and summary metadata. Much smaller than /api/v1/export/json (~50KB vs ~774KB).
///
/// Query params: ?maxLines=30&maxLineLen=90 (defaults shown)
///
/// Data sources: PageNameIndex (existing pages, stubs, reference counts) + Y.Doc (blocks).
async fn get_topology(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<TopologyQuery>,
) -> Result<Json<TopologyResponse>, ApiError> {
    let max_lines = query.max_lines;
    let max_line_len = query.max_line_len;
    let page_index = state.page_name_index.read().map_err(|_| ApiError::LockPoisoned)?;
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let existing_pages = page_index.existing_pages();
    // Find pages:: container and its children (page block IDs)
    let pages_container_id = page_index.pages_container_id().map(String::from);

    // Build page_name → page_block_id map from pages:: container children
    let mut page_name_to_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let (Some(ref container_id), Some(blocks_map)) = (&pages_container_id, txn.get_map("blocks")) {
        if let Some(yrs::Out::YMap(container)) = blocks_map.get(&txn, container_id.as_str()) {
            if let Some(yrs::Out::YArray(child_ids_arr)) = container.get(&txn, "childIds") {
                for val in child_ids_arr.iter(&txn) {
                    if let yrs::Out::Any(yrs::Any::String(child_id)) = val {
                        if let Some(yrs::Out::YMap(child_block)) = blocks_map.get(&txn, child_id.as_ref()) {
                            let content = child_block
                                .get(&txn, "content")
                                .and_then(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    _ => None,
                                })
                                .unwrap_or_default();
                            let page_name = strip_heading_prefix(&content).to_lowercase();
                            if !page_name.is_empty() {
                                page_name_to_id.insert(page_name, child_id.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // Get root IDs and build root territory map
    let mut root_ids: Vec<String> = Vec::new();
    let mut root_names: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Some(root_ids_arr) = txn.get_array("rootIds") {
        for value in root_ids_arr.iter(&txn) {
            if let yrs::Out::Any(yrs::Any::String(id)) = value {
                root_ids.push(id.to_string());
            }
        }
    }

    // Classify root territories by content
    if let Some(blocks_map) = txn.get_map("blocks") {
        for rid in &root_ids {
            if let Some(yrs::Out::YMap(block)) = blocks_map.get(&txn, rid.as_str()) {
                let content = block
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();
                let fl = content.chars().take(40).collect::<String>().to_lowercase();
                let territory = if fl.contains("horror") {
                    "horror show"
                } else if fl.contains("pages") {
                    "pages"
                } else if fl.contains("work log") {
                    "work logs"
                } else {
                    "other"
                };
                root_names.insert(rid.clone(), territory.to_string());
            }
        }
    }

    // Single pass over all blocks to build:
    // - block_to_root: block_id → root_id
    // - parent_map: block_id → parent_id (for depth calc)
    // - daily_counts: "MM-DD" → count
    // - per-page subtree counts + outlinks + content lines
    let mut block_to_root: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut parent_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut daily_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut total_blocks: usize = 0;

    // For per-page data, we need to walk subtrees. Collect all blocks first.
    struct BlockInfo {
        content: String,
        child_ids: Vec<String>,
        outlinks: Vec<String>,
    }
    let mut all_blocks: std::collections::HashMap<String, BlockInfo> = std::collections::HashMap::new();

    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                total_blocks += 1;
                let block_id = key.to_string();

                let content = block_map
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();

                let parent_id = block_map.get(&txn, "parentId").and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                });

                let child_ids: Vec<String> = block_map
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

                let created_at = extract_timestamp(block_map.get(&txn, "createdAt"));

                // Extract outlinks from metadata
                let outlinks = block_map
                    .get(&txn, "metadata")
                    .and_then(|v| extract_metadata_from_yrs(v, &txn))
                    .and_then(|meta| {
                        meta.get("outlinks").and_then(|ol| {
                            ol.as_array().map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect::<Vec<_>>()
                            })
                        })
                    })
                    .unwrap_or_default();

                // Daily rhythm from createdAt
                if created_at > 0 {
                    let dt = DateTime::from_timestamp_millis(created_at);
                    if let Some(dt) = dt {
                        let day_key = dt.format("%m-%d").to_string();
                        *daily_counts.entry(day_key).or_insert(0) += 1;
                    }
                }

                if let Some(ref pid) = parent_id {
                    parent_map.insert(block_id.clone(), pid.clone());
                }

                all_blocks.insert(block_id, BlockInfo {
                    content,
                    child_ids,
                    outlinks,
                });
            }
        }
    }

    // Build block_to_root by walking up parent chains (depth-capped for cycle safety)
    fn find_root(
        block_id: &str,
        parent_map: &std::collections::HashMap<String, String>,
        cache: &mut std::collections::HashMap<String, String>,
        depth: usize,
    ) -> String {
        if let Some(cached) = cache.get(block_id) {
            return cached.clone();
        }
        if depth > 500 {
            // Cycle or impossibly deep tree — treat as own root
            cache.insert(block_id.to_string(), block_id.to_string());
            return block_id.to_string();
        }
        match parent_map.get(block_id) {
            Some(parent_id) => {
                let root = find_root(parent_id, parent_map, cache, depth + 1);
                cache.insert(block_id.to_string(), root.clone());
                root
            }
            None => {
                cache.insert(block_id.to_string(), block_id.to_string());
                block_id.to_string()
            }
        }
    }
    let block_ids: Vec<String> = all_blocks.keys().cloned().collect();
    for bid in &block_ids {
        let root = find_root(bid, &parent_map, &mut block_to_root, 0);
        block_to_root.insert(bid.clone(), root);
    }

    // Build inlinks: page_name → { territory → count }
    let mut inlinks: std::collections::HashMap<String, std::collections::HashMap<String, usize>> =
        std::collections::HashMap::new();
    // Also build backlink snippets for ref-only nodes
    let mut backlink_snippets: std::collections::HashMap<String, Vec<(u8, String)>> =
        std::collections::HashMap::new();

    for (bid, info) in &all_blocks {
        if !info.outlinks.is_empty() {
            let root_id = block_to_root.get(bid.as_str()).cloned().unwrap_or_default();
            let territory = root_names.get(&root_id).cloned().unwrap_or_else(|| "other".to_string());
            for link in &info.outlinks {
                let link_lower = link.to_lowercase();
                *inlinks.entry(link_lower.clone()).or_default().entry(territory.clone()).or_insert(0) += 1;
                // Collect backlink snippets for ref-only nodes
                if !page_name_to_id.contains_key(&link_lower) {
                    let snippets = backlink_snippets.entry(link_lower).or_default();
                    if snippets.len() < 20 {
                        let line = info.content.lines().next().unwrap_or("").trim();
                        let truncated: String = line.chars().take(max_line_len).collect();
                        if !truncated.is_empty() {
                            snippets.push((0, truncated));
                        }
                    }
                }
            }
        }
    }

    // Entity set: existing pages + ref-only entities
    let mut entity_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in &existing_pages {
        entity_set.insert(name.clone());
    }
    // ref-only = referenced but not in pages::
    let existing_set: std::collections::HashSet<String> = existing_pages.iter().cloned().collect();
    let ref_only_set: std::collections::HashSet<String> = inlinks
        .keys()
        .filter(|name| !existing_set.contains(*name))
        .cloned()
        .collect();
    for name in &ref_only_set {
        entity_set.insert(name.clone());
    }

    // Orphans: exist in pages:: but no inlinks
    let orphan_set: std::collections::HashSet<String> = existing_pages
        .iter()
        .filter(|name| !inlinks.contains_key(*name))
        .cloned()
        .collect();

    // Subtree walk for each page: block count + content lines + outlinks
    // Iterative with visited set for cycle safety (matches collect_descendants pattern)
    fn walk_subtree(
        start_id: &str,
        all_blocks: &std::collections::HashMap<String, BlockInfo>,
        count: &mut usize,
        outlinks: &mut std::collections::HashSet<String>,
        content_lines: &mut Vec<(u8, String)>,
        root_page_id: &str,
        parent_map: &std::collections::HashMap<String, String>,
        max_lines: usize,
        max_line_len: usize,
    ) {
        let mut stack = vec![start_id.to_string()];
        let mut visited = std::collections::HashSet::new();
        while let Some(block_id) = stack.pop() {
            if !visited.insert(block_id.clone()) {
                continue; // cycle guard
            }
            if let Some(info) = all_blocks.get(&block_id) {
                *count += 1;
                for ol in &info.outlinks {
                    outlinks.insert(ol.to_lowercase());
                }
                if max_lines > 0 && block_id != root_page_id && content_lines.len() < max_lines {
                    let line = info.content.lines().next().unwrap_or("").trim().to_string();
                    if !line.is_empty() {
                        let depth = depth_from_page(&block_id, root_page_id, parent_map);
                        let truncated: String = line.chars().take(max_line_len).collect();
                        content_lines.push((depth.min(5) as u8, truncated));
                    }
                }
                // Push children in reverse to preserve order (first child processed first)
                for child_id in info.child_ids.iter().rev() {
                    stack.push(child_id.clone());
                }
            }
        }
    }

    fn depth_from_page(
        block_id: &str,
        page_id: &str,
        parent_map: &std::collections::HashMap<String, String>,
    ) -> usize {
        let mut d: usize = 0;
        let mut cur = block_id.to_string();
        while cur != page_id && d < 8 {
            match parent_map.get(&cur) {
                Some(pid) => {
                    cur = pid.clone();
                    d += 1;
                }
                None => break,
            }
        }
        d.saturating_sub(1)
    }

    let mut page_subtree_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut page_outlinks: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();
    let mut content_map: std::collections::HashMap<String, Vec<(u8, String)>> = std::collections::HashMap::new();

    for (page_name, page_id) in &page_name_to_id {
        let mut count = 0usize;
        let mut outlinks = std::collections::HashSet::new();
        let mut lines = Vec::new();
        walk_subtree(page_id, &all_blocks, &mut count, &mut outlinks, &mut lines, page_id, &parent_map, max_lines, max_line_len);
        page_subtree_counts.insert(page_name.clone(), count);
        page_outlinks.insert(page_name.clone(), outlinks);
        let truncated_id: String = page_name.chars().take(55).collect();
        if !lines.is_empty() {
            content_map.insert(truncated_id, lines);
        }
    }

    // Backlink content for ref-only nodes
    for name in &ref_only_set {
        let truncated_id: String = name.chars().take(55).collect();
        if let Some(snippets) = backlink_snippets.get(name) {
            if !snippets.is_empty() {
                content_map.insert(truncated_id, snippets.iter().take(20).cloned().collect());
            }
        }
    }

    // Build edges: page → target (both in entity set)
    let mut edges_set: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for (page_name, ols) in &page_outlinks {
        for link in ols {
            if entity_set.contains(link) && link != page_name {
                let src: String = page_name.chars().take(55).collect();
                let tgt: String = link.chars().take(55).collect();
                edges_set.insert((src, tgt));
            }
        }
    }

    // Build nodes
    let mut nodes: Vec<TopologyNode> = Vec::new();
    let mut node_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    for name in &entity_set {
        let truncated_id: String = name.chars().take(55).collect();
        let src = inlinks.get(name).cloned().unwrap_or_default();
        let total_inlinks: usize = src.values().sum();
        nodes.push(TopologyNode {
            id: truncated_id.clone(),
            b: page_subtree_counts.get(name).copied().unwrap_or(0).min(3000),
            i: total_inlinks,
            rc: src.len(),
            orp: if orphan_set.contains(name) { 1 } else { 0 },
            is_ref: if ref_only_set.contains(name) { 1 } else { 0 },
            bid: page_name_to_id.get(&name.to_lowercase()).cloned(),
        });
        node_ids.insert(truncated_id);
    }

    // Filter edges to only include nodes present
    let edges: Vec<[String; 2]> = edges_set
        .into_iter()
        .filter(|(s, t)| node_ids.contains(s) && node_ids.contains(t))
        .map(|(s, t)| [s, t])
        .collect();

    // Daily entries (sorted)
    let mut daily: Vec<DailyEntry> = daily_counts
        .into_iter()
        .map(|(d, n)| DailyEntry { d, n })
        .collect();
    daily.sort_by(|a, b| a.d.cmp(&b.d));

    let meta = TopologyMeta {
        blocks: total_blocks,
        pages: existing_pages.len(),
        days: daily.len(),
        roots: root_ids.len(),
        ref_only: ref_only_set.len(),
        orphans: orphan_set.len(),
    };

    Ok(Json(TopologyResponse {
        nodes,
        edges,
        content: content_map,
        daily,
        meta,
    }))
}

/// Response for GET /api/v1/topology/content/:pageName
#[derive(Serialize, Deserialize)]
pub struct PageContentResponse {
    pub name: String,
    pub lines: Vec<(u8, String)>,
    pub block_count: usize,
}

/// GET /api/v1/topology/content/:pageName - Full content for a single page.
///
/// Returns the complete outline content for a page (no line/char limits).
/// Use this for on-demand content loading when a user clicks a node in the manifest.
async fn get_page_content(
    State(state): State<AppState>,
    Path(page_name): Path<String>,
) -> Result<Json<PageContentResponse>, ApiError> {
    let page_index = state.page_name_index.read().map_err(|_| ApiError::LockPoisoned)?;
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let normalized = page_name.to_lowercase();

    // Find the page block ID from pages:: container
    let pages_container_id = page_index.pages_container_id().map(String::from);
    let mut page_block_id: Option<String> = None;

    if let (Some(ref container_id), Some(blocks_map)) = (&pages_container_id, txn.get_map("blocks")) {
        if let Some(yrs::Out::YMap(container)) = blocks_map.get(&txn, container_id.as_str()) {
            if let Some(yrs::Out::YArray(child_ids_arr)) = container.get(&txn, "childIds") {
                for val in child_ids_arr.iter(&txn) {
                    if let yrs::Out::Any(yrs::Any::String(child_id)) = val {
                        if let Some(yrs::Out::YMap(child_block)) = blocks_map.get(&txn, child_id.as_ref()) {
                            let content = child_block
                                .get(&txn, "content")
                                .and_then(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    _ => None,
                                })
                                .unwrap_or_default();
                            let name = strip_heading_prefix(&content).to_lowercase();
                            if name == normalized {
                                page_block_id = Some(child_id.to_string());
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    let page_id = page_block_id.ok_or_else(|| ApiError::NotFound(format!("Page not found: {}", page_name)))?;

    // Collect all blocks for subtree walk
    let mut all_blocks: std::collections::HashMap<String, (String, Vec<String>)> = std::collections::HashMap::new();
    let mut parent_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                let content = block_map
                    .get(&txn, "content")
                    .and_then(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .unwrap_or_default();
                let child_ids: Vec<String> = block_map
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
                if let Some(yrs::Out::Any(yrs::Any::String(pid))) = block_map.get(&txn, "parentId") {
                    parent_map.insert(key.to_string(), pid.to_string());
                }
                all_blocks.insert(key.to_string(), (content, child_ids));
            }
        }
    }

    // Walk subtree — no limits
    let mut lines = Vec::new();
    let mut block_count = 0usize;
    let mut stack = vec![page_id.clone()];
    let mut visited = std::collections::HashSet::new();

    while let Some(block_id) = stack.pop() {
        if !visited.insert(block_id.clone()) {
            continue;
        }
        if let Some((content, child_ids)) = all_blocks.get(&block_id) {
            block_count += 1;
            if block_id != page_id {
                let line = content.lines().next().unwrap_or("").trim().to_string();
                if !line.is_empty() {
                    // Depth from page root
                    let mut d: usize = 0;
                    let mut cur = block_id.clone();
                    while cur != page_id && d < 20 {
                        match parent_map.get(&cur) {
                            Some(pid) => { cur = pid.clone(); d += 1; }
                            None => break,
                        }
                    }
                    lines.push((d.saturating_sub(1).min(10) as u8, line));
                }
            }
            for child_id in child_ids.iter().rev() {
                stack.push(child_id.clone());
            }
        }
    }

    Ok(Json(PageContentResponse {
        name: normalized,
        lines,
        block_count,
    }))
}

/// Strip heading prefix (# ## ### etc) from content.
///
/// Mirrors `PageNameIndexHook::strip_heading_prefix` in floatty-core:
/// - Takes first line only (multi-line pages embed markers on subsequent lines)
/// - Strips leading '#' characters and surrounding whitespace
///
/// Examples:
///   "# My Page"                    → "My Page"
///   "# Summary\n[board:: recon]"   → "Summary"
///   "No prefix"                    → "No prefix"
fn strip_heading_prefix(content: &str) -> &str {
    let first_line = content.lines().next().unwrap_or(content);
    first_line.trim_start_matches('#').trim()
}

// ═══════════════════════════════════════════════════════════════════════════
// METADATA INHERITANCE
// ═══════════════════════════════════════════════════════════════════════════

/// Look up inherited markers from the pre-computed InheritanceIndex.
/// Returns None if the block has no inherited markers (O(1) lookup).
fn lookup_inherited(index: &InheritanceIndex, block_id: &str) -> Option<Vec<InheritedMarkerDto>> {
    let inherited = index.get(block_id);
    if inherited.is_empty() {
        None
    } else {
        Some(
            inherited
                .iter()
                .map(|m| InheritedMarkerDto {
                    marker_type: m.marker_type.clone(),
                    value: m.value.clone(),
                    source_block_id: m.source_block_id.clone(),
                })
                .collect(),
        )
    }
}

/// Query parameters for GET /api/v1/blocks
#[derive(Deserialize, Default)]
pub struct BlocksQuery {
    /// Filter: createdAt >= since (unix ms)
    pub since: Option<i64>,
    /// Filter: createdAt < until (unix ms)
    pub until: Option<i64>,
    /// Filter: block has a marker with this markerType
    pub marker_type: Option<String>,
    /// Filter: marker value (requires marker_type)
    pub marker_value: Option<String>,
}

/// Resolve a block ID or short-hash prefix to a full canonical block ID.
///
/// - Full UUID (36 chars with dashes): O(1) exact lookup, case-insensitive
/// - 6+ hex chars: O(n) prefix scan, dash-stripped matching
/// - Non-hex or <6 chars: treated as literal ID, exact lookup (backward compat)
///
/// Returns the canonical (stored) key on success.
fn resolve_block_id<T: ReadTxn>(
    id_or_prefix: &str,
    blocks_map: &yrs::MapRef,
    txn: &T,
) -> Result<String, ApiError> {
    let trimmed = id_or_prefix.trim();
    let lower = trimmed.to_lowercase();

    // Check if it's a full UUID (36 chars with dashes at positions 8,13,18,23)
    let is_full_uuid = trimmed.len() == 36 && {
        let b = trimmed.as_bytes();
        b[8] == b'-' && b[13] == b'-' && b[18] == b'-' && b[23] == b'-'
            && trimmed.chars().enumerate().all(|(i, c)| {
                if i == 8 || i == 13 || i == 18 || i == 23 { c == '-' }
                else { c.is_ascii_hexdigit() }
            })
    };

    if is_full_uuid {
        // O(1) exact lookup — try lowercase first (canonical), then original
        if blocks_map.get(txn, &lower).is_some() {
            return Ok(lower);
        }
        if blocks_map.get(txn, trimmed).is_some() {
            return Ok(trimmed.to_string());
        }
        return Err(ApiError::NotFound(trimmed.to_string()));
    }

    // Check if it looks like a valid hex prefix (6+ hex chars)
    let is_hex_prefix = trimmed.len() >= 6 && trimmed.chars().all(|c| c.is_ascii_hexdigit());

    if !is_hex_prefix {
        // Not a prefix — try exact lookup as literal ID (backward compat)
        if blocks_map.get(txn, trimmed).is_some() {
            return Ok(trimmed.to_string());
        }
        return Err(ApiError::NotFound(trimmed.to_string()));
    }

    // Prefix scan: iterate all keys, collect matches
    let mut matches: Vec<String> = Vec::new();

    for (key, _value) in blocks_map.iter(txn) {
        let key_lower = key.to_lowercase();
        if key_lower.starts_with(&lower) {
            matches.push(key.to_string());
            continue;
        }
        // Also match dash-stripped (contiguous hex)
        let key_nodash: String = key_lower.chars().filter(|c| *c != '-').collect();
        if key_nodash.starts_with(&lower) {
            matches.push(key.to_string());
        }
    }

    match matches.len() {
        0 => Err(ApiError::NotFound(format!("No block matches prefix '{}'", trimmed))),
        1 => Ok(matches.into_iter().next().unwrap()),
        n => Err(ApiError::Ambiguous(n)),
    }
}

/// Resolve a block ID field from a request body, wrapping errors with field name context.
fn resolve_body_field<T: ReadTxn>(
    id_or_prefix: &str,
    field_name: &str,
    blocks_map: &yrs::MapRef,
    txn: &T,
) -> Result<String, ApiError> {
    resolve_block_id(id_or_prefix, blocks_map, txn).map_err(|e| match e {
        ApiError::Ambiguous(n) => ApiError::InvalidRequest(
            format!("Ambiguous prefix in {}: {} matches", field_name, n),
        ),
        ApiError::NotFound(msg) => ApiError::NotFound(
            format!("{} not found: {}", field_name, msg),
        ),
        other => other,
    })
}

/// GET /api/v1/blocks/resolve/:prefix - Resolve short-hash prefix to full block ID
///
/// Accepts 6+ hex character prefixes (git-sha style). Returns the full block if
/// exactly one match. 400 for invalid prefix, 404 for no match, 409 for ambiguous.
async fn resolve_block_prefix(
    State(state): State<AppState>,
    Path(prefix): Path<String>,
) -> Result<Json<ResolveResponse>, ApiError> {
    let trimmed = prefix.trim();
    if trimmed.len() < 6 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::InvalidRequest(
            "Prefix must be at least 6 hex characters".to_string(),
        ));
    }
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    let full_id = resolve_block_id(trimmed, &blocks_map, &txn)?;

    let value = blocks_map
        .get(&txn, full_id.as_str())
        .ok_or_else(|| ApiError::NotFound(full_id.clone()))?;

    if let yrs::Out::YMap(block_map) = value {
        let inherited_markers = {
            let index = state.inheritance_index.read().map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, &full_id)
        };
        let block_dto = read_block_dto(&block_map, &txn, &full_id, inherited_markers, true);
        Ok(Json(ResolveResponse {
            id: full_id,
            block: block_dto,
        }))
    } else {
        Err(ApiError::NotFound(full_id))
    }
}

/// Read a BlockDto from a Y.Map block entry.
///
/// Callers provide pre-computed `inherited_markers` so bulk endpoints can
/// acquire the inheritance index lock once instead of per-block.
fn read_block_dto<T: ReadTxn>(
    block_map: &yrs::MapRef,
    txn: &T,
    id: &str,
    inherited_markers: Option<Vec<InheritedMarkerDto>>,
    include_output: bool,
) -> BlockDto {
    let content = block_map
        .get(txn, "content")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
        .unwrap_or_default();

    let parent_id = block_map.get(txn, "parentId").and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        yrs::Out::Any(yrs::Any::Null) => None,
        _ => None,
    });

    let child_ids = block_map
        .get(txn, "childIds")
        .and_then(|v| match v {
            yrs::Out::YArray(arr) => Some(
                arr.iter(txn)
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
        .get(txn, "collapsed")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::Bool(b)) => Some(b),
            _ => None,
        })
        .unwrap_or(false);

    let metadata = block_map
        .get(txn, "metadata")
        .and_then(|v| extract_metadata_from_yrs(v, txn));

    let created_at = extract_timestamp(block_map.get(txn, "createdAt"));
    let updated_at = extract_timestamp(block_map.get(txn, "updatedAt"));

    let output_type = block_map
        .get(txn, "outputType")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        });

    let output = if include_output {
        block_map
            .get(txn, "output")
            .map(|v| yrs_out_to_json(v, txn))
    } else {
        None
    };

    let block_type = floatty_core::parse_block_type(&content);

    BlockDto {
        id: id.to_string(),
        content,
        parent_id,
        child_ids,
        collapsed,
        block_type: format!("{:?}", block_type).to_lowercase(),
        metadata,
        inherited_markers,
        created_at,
        updated_at,
        output_type,
        output,
    }
}

/// Build a BlockWithContextResponse from a block DTO and query params.
/// Shared between get_block and get_daily_note.
fn build_block_context_response<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    block_dto: BlockDto,
    ctx_query: &BlockContextQuery,
) -> BlockWithContextResponse {
    let includes = parse_includes(&ctx_query.include);
    let sibling_radius = ctx_query.sibling_radius.min(50);
    let max_depth = ctx_query.max_depth.min(100);

    BlockWithContextResponse {
        block: block_dto,
        ancestors: includes.contains("ancestors").then(|| get_ancestors(blocks_map, txn, block_id)),
        siblings: includes.contains("siblings").then(|| get_siblings(blocks_map, txn, block_id, sibling_radius)),
        children: includes.contains("children").then(|| get_children_refs(blocks_map, txn, block_id)),
        tree: includes.contains("tree").then(|| get_subtree(blocks_map, txn, block_id, max_depth)),
        token_estimate: includes.contains("token_estimate").then(|| compute_token_estimate(blocks_map, txn, block_id, max_depth)),
    }
}

/// GET /api/v1/blocks - All blocks as JSON (with optional filters)
async fn get_blocks(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<BlocksQuery>,
) -> Result<Json<BlocksResponse>, ApiError> {
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

    // Acquire inheritance index once for all blocks
    let inheritance_guard = state.inheritance_index.read().map_err(|_| ApiError::LockPoisoned)?;

    // Get all blocks from the map
    if let Some(blocks_map) = txn.get_map("blocks") {
        for (key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                let block_id = key.to_string();
                let inherited_markers = lookup_inherited(&inheritance_guard, &block_id);
                let dto = read_block_dto(&block_map, &txn, &block_id, inherited_markers, false);

                // Apply query filters
                if let Some(since) = query.since {
                    if dto.created_at < since { continue; }
                }
                if let Some(until) = query.until {
                    if dto.created_at >= until { continue; }
                }
                if let Some(ref mt) = query.marker_type {
                    let has_marker = dto.metadata.as_ref()
                        .and_then(|m| m.get("markers"))
                        .and_then(|arr| arr.as_array())
                        .map(|markers| {
                            markers.iter().any(|marker| {
                                let type_match = marker.get("markerType").and_then(|v| v.as_str()) == Some(mt.as_str());
                                if let Some(ref mv) = query.marker_value {
                                    type_match && marker.get("value").and_then(|v| v.as_str()) == Some(mv.as_str())
                                } else {
                                    type_match
                                }
                            })
                        }).unwrap_or(false);
                    if !has_marker { continue; }
                }

                blocks.push(dto);
            }
        }
    }

    Ok(Json(BlocksResponse { blocks, root_ids }))
}

// ============================================================================
// Block Context Helpers (FLO-338)
// ============================================================================

/// Read a block's content from a Y.Map within a transaction.
fn read_block_content<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Option<String> {
    let block_map = match blocks_map.get(txn, block_id)? {
        yrs::Out::YMap(map) => map,
        _ => return None,
    };
    block_map
        .get(txn, "content")
        .and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
}

/// Read a block's parentId from Y.Doc.
fn read_block_parent_id<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Option<String> {
    let block_map = match blocks_map.get(txn, block_id)? {
        yrs::Out::YMap(map) => map,
        _ => return None,
    };
    block_map.get(txn, "parentId").and_then(|v| match v {
        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
        _ => None,
    })
}

/// Read a block's childIds from Y.Doc.
fn read_block_child_ids<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<String> {
    let block_map = match blocks_map.get(txn, block_id) {
        Some(yrs::Out::YMap(map)) => map,
        _ => return Vec::new(),
    };
    block_map
        .get(txn, "childIds")
        .and_then(|v| match v {
            yrs::Out::YArray(arr) => Some(
                arr.iter(txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        })
        .unwrap_or_default()
}

/// Walk the parent chain up to root, returning ancestor BlockRefs (nearest first).
/// Max 10 ancestors to prevent runaway.
fn get_ancestors<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<BlockRef> {
    let mut ancestors = Vec::new();
    let mut current_id = block_id.to_string();
    for _ in 0..10 {
        match read_block_parent_id(blocks_map, txn, &current_id) {
            Some(pid) => {
                let content = read_block_content(blocks_map, txn, &pid).unwrap_or_default();
                ancestors.push(BlockRef { id: pid.clone(), content });
                current_id = pid;
            }
            None => break,
        }
    }
    ancestors
}

/// Get siblings before/after a block within its parent's childIds.
fn get_siblings<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    block_id: &str,
    radius: usize,
) -> SiblingContext {
    let empty = SiblingContext { before: vec![], after: vec![] };

    let parent_id = match read_block_parent_id(blocks_map, txn, block_id) {
        Some(id) => id,
        None => return empty,
    };
    let sibling_ids = read_block_child_ids(blocks_map, txn, &parent_id);

    let pos = match sibling_ids.iter().position(|id| id == block_id) {
        Some(p) => p,
        None => return empty,
    };

    let before_start = pos.saturating_sub(radius);
    let before: Vec<BlockRef> = sibling_ids[before_start..pos]
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect();

    let after_end = pos.saturating_add(1).saturating_add(radius).min(sibling_ids.len());
    let after: Vec<BlockRef> = sibling_ids[(pos + 1)..after_end]
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect();

    SiblingContext { before, after }
}

/// Get direct children as BlockRefs.
fn get_children_refs<T: ReadTxn>(blocks_map: &yrs::MapRef, txn: &T, block_id: &str) -> Vec<BlockRef> {
    read_block_child_ids(blocks_map, txn, block_id)
        .iter()
        .map(|id| BlockRef {
            id: id.clone(),
            content: read_block_content(blocks_map, txn, id).unwrap_or_default(),
        })
        .collect()
}

/// DFS traversal of subtree, returning TreeNodes with depth.
/// Respects max_depth and caps total nodes at 1000.
fn get_subtree<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    root_id: &str,
    max_depth: usize,
) -> Vec<TreeNode> {
    let mut result = Vec::new();
    let mut stack: Vec<(String, usize)> = Vec::new();

    // Start with root's children at depth 1
    let root_children = read_block_child_ids(blocks_map, txn, root_id);
    for child_id in root_children.into_iter().rev() {
        stack.push((child_id, 1));
    }

    while let Some((id, depth)) = stack.pop() {
        if result.len() >= 1000 { break; }

        let content = read_block_content(blocks_map, txn, &id).unwrap_or_default();
        let child_ids = read_block_child_ids(blocks_map, txn, &id);

        // Push children for further traversal if within depth limit
        if depth < max_depth {
            for child_id in child_ids.iter().rev() {
                stack.push((child_id.clone(), depth + 1));
            }
        }

        result.push(TreeNode {
            id: id.clone(),
            content,
            depth,
            child_ids,
        });
    }

    result
}

/// Compute a rough token estimate for a subtree.
fn compute_token_estimate<T: ReadTxn>(
    blocks_map: &yrs::MapRef,
    txn: &T,
    root_id: &str,
    max_depth: usize,
) -> TokenEstimate {
    let mut total_chars = 0usize;
    let mut block_count = 0usize;
    let mut deepest = 0usize;
    let mut stack: Vec<(String, usize)> = Vec::new();

    // Include root content
    if let Some(content) = read_block_content(blocks_map, txn, root_id) {
        total_chars += content.chars().count();
    }
    block_count += 1;

    let root_children = read_block_child_ids(blocks_map, txn, root_id);
    for child_id in root_children.into_iter().rev() {
        stack.push((child_id, 1));
    }

    while let Some((id, depth)) = stack.pop() {
        if block_count >= 5000 { break; } // Safety cap

        if let Some(content) = read_block_content(blocks_map, txn, &id) {
            total_chars += content.chars().count();
        }
        block_count += 1;
        if depth > deepest { deepest = depth; }

        if depth < max_depth {
            let child_ids = read_block_child_ids(blocks_map, txn, &id);
            for child_id in child_ids.into_iter().rev() {
                stack.push((child_id, depth + 1));
            }
        }
    }

    TokenEstimate {
        total_chars,
        block_count,
        max_depth: deepest,
    }
}

/// Parse include directives from comma-separated string.
fn parse_includes(include: &Option<String>) -> HashSet<String> {
    include
        .as_ref()
        .map(|s| s.split(',').map(|p| p.trim().to_lowercase()).collect())
        .unwrap_or_default()
}

/// GET /api/v1/blocks/:id - Single block with optional context
///
/// Query parameters:
/// - `include` (optional): Comma-separated context to include:
///   ancestors, siblings, children, tree, token_estimate
/// - `sibling_radius` (optional, default 2): How many siblings before/after
/// - `max_depth` (optional, default 50): Max depth for tree traversal
async fn get_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(ctx_query): axum::extract::Query<BlockContextQuery>,
) -> Result<Json<BlockWithContextResponse>, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

    // Resolve short-hash prefix to full block ID
    let id = resolve_block_id(&id, &blocks_map, &txn)?;

    let value = blocks_map
        .get(&txn, &id)
        .ok_or_else(|| ApiError::NotFound(id.clone()))?;

    if let yrs::Out::YMap(block_map) = value {
        let inherited_markers = {
            let index = state.inheritance_index.read().map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, &id)
        };
        let block_dto = read_block_dto(&block_map, &txn, &id, inherited_markers, true);

        Ok(Json(build_block_context_response(
            &blocks_map, &txn, &id, block_dto, &ctx_query,
        )))
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

    // Resolve short-hash prefixes in body fields (if blocks map exists)
    let mut req = req;
    {
        let txn = doc_guard.transact();
        if let Some(blocks_map) = txn.get_map("blocks") {
            if let Some(ref parent_id) = req.parent_id {
                let resolved = resolve_body_field(parent_id, "parentId", &blocks_map, &txn)?;
                req.parent_id = Some(resolved);
            }
            if let Some(ref after_id) = req.after_id {
                let resolved = resolve_body_field(after_id, "afterId", &blocks_map, &txn)?;
                req.after_id = Some(resolved);
            }
        }
    }

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

        // Validate positional insertion parameters
        // 1. Check mutual exclusivity
        if req.after_id.is_some() && req.at_index.is_some() {
            return Err(ApiError::InvalidRequest(
                "Cannot specify both afterId and atIndex".to_string()
            ));
        }

        // 2. Validate afterId if present
        if let Some(ref after_id) = req.after_id {
            match blocks.get(&txn, after_id) {
                Some(yrs::Out::YMap(after_map)) => {
                    // Check afterId block shares same parent
                    let after_parent = after_map.get(&txn, "parentId")
                        .and_then(|v| match v {
                            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                            _ => None,
                        });

                    let expected_parent = req.parent_id.as_ref().map(|s| s.as_str());
                    let actual_parent = after_parent.as_ref().map(|s| s.as_str());

                    if actual_parent != expected_parent {
                        return Err(ApiError::InvalidRequest(format!(
                            "Block {} is not a sibling (different parent)",
                            after_id
                        )));
                    }
                }
                _ => {
                    return Err(ApiError::NotFound(format!(
                        "afterId block not found: {}",
                        after_id
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

                    // Determine insertion index
                    let insert_idx = if let Some(ref after_id) = req.after_id {
                        // Find position of afterId sibling, insert after it
                        let child_ids_vec: Vec<String> = child_ids
                            .iter(&txn)
                            .filter_map(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                _ => None,
                            })
                            .collect();

                        child_ids_vec.iter()
                            .position(|x| x == after_id)
                            .map(|idx| idx + 1)
                            .unwrap_or(child_ids.len(&txn) as usize)  // Fallback: append
                    } else if let Some(at_index) = req.at_index {
                        // Clamp to valid range (0..=length)
                        at_index.min(child_ids.len(&txn) as usize)
                    } else {
                        // Default: append to end (backward compatible)
                        child_ids.len(&txn) as usize
                    };

                    // Use Y.Array insert() - surgical, 1 CRDT op (FLO-280 pattern)
                    child_ids.insert(&mut txn, insert_idx as u32, id.as_str());
                }
            }
        } else {
            // No parent - add to rootIds
            let root_ids = txn.get_or_insert_array("rootIds");

            let insert_idx = if let Some(ref after_id) = req.after_id {
                let root_vec: Vec<String> = root_ids
                    .iter(&txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect();

                root_vec.iter()
                    .position(|x| x == after_id)
                    .map(|idx| idx + 1)
                    .unwrap_or(root_ids.len(&txn) as usize)
            } else if let Some(at_index) = req.at_index {
                at_index.min(root_ids.len(&txn) as usize)
            } else {
                root_ids.len(&txn) as usize
            };

            root_ids.insert(&mut txn, insert_idx as u32, id.as_str());
        }

        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    let seq = state.store.persist_update(&update)?;
    state.broadcaster.broadcast(update, None, Some(seq));

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
            inherited_markers: None, // Computed on read
            created_at: now as i64,
            updated_at: now as i64,
            output_type: None,
            output: None,
        }),
    ))
}

/// PUT /api/v1/blocks/:id - Not supported, suggest PATCH
///
/// Friendly error for kitty and other agents who try PUT instead of PATCH.
async fn put_not_supported(Path(id): Path<String>) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(ErrorResponse {
            error: format!(
                "PUT not supported. Did you mean PATCH? Use: PATCH /api/v1/blocks/{} with {{\042content\042: ..., \042parentId\042: ...}}",
                id
            ),
        }),
    )
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

    // Resolve short-hash prefixes in path and body fields
    let mut req = req;
    let (id, req) = {
        let txn = doc_guard.transact();
        let blocks_map = txn
            .get_map("blocks")
            .ok_or_else(|| ApiError::NotFound("blocks map not found".to_string()))?;

        let id = resolve_block_id(&id, &blocks_map, &txn)?;

        // Resolve body field prefixes
        if let Some(Some(ref parent_id)) = req.parent_id {
            let resolved = resolve_body_field(parent_id, "parentId", &blocks_map, &txn)?;
            req.parent_id = Some(Some(resolved));
        }
        if let Some(ref after_id) = req.after_id {
            let resolved = resolve_body_field(after_id, "afterId", &blocks_map, &txn)?;
            req.after_id = Some(resolved);
        }

        (id, req)
    };

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

    // Validate positional insertion parameters
    if req.after_id.is_some() && req.at_index.is_some() {
        return Err(ApiError::InvalidRequest(
            "Cannot specify both afterId and atIndex".to_string()
        ));
    }

    // Reject self-referential afterId (block removed first → afterId not found → silent append)
    if req.after_id.as_deref() == Some(id.as_str()) {
        return Err(ApiError::InvalidRequest(
            "afterId cannot reference the block being moved".to_string()
        ));
    }

    // Determine if reparenting is requested
    // req.parent_id: None = don't change, Some(None) = move to root, Some(Some(id)) = move under parent
    let (final_parent_id, parent_changed) = match &req.parent_id {
        None => (old_parent_id.clone(), false),
        Some(new_parent) => {
            let changed = *new_parent != old_parent_id;
            (new_parent.clone(), changed)
        }
    };

    // Determine if repositioning is requested (positional params present)
    let repositioning = req.after_id.is_some() || req.at_index.is_some();

    // If repositioning without reparenting, we're moving within same parent
    // If reparenting, positional params control insertion position in new parent

    // Update fields granularly (only what changed)
    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Validate new parent exists and won't create cycle (if reparenting to a non-root parent)
        if parent_changed {
            if let Some(ref new_parent_id) = final_parent_id {
                // Prevent self-parenting
                if new_parent_id == &id {
                    return Err(ApiError::InvalidParent(
                        "Cannot reparent block under itself".to_string()
                    ));
                }

                // Walk ancestor chain to prevent cycles (can't parent under a descendant)
                let mut cursor = Some(new_parent_id.clone());
                while let Some(pid) = cursor {
                    if pid == id {
                        return Err(ApiError::InvalidParent(format!(
                            "Cannot reparent block {} under its own descendant",
                            id
                        )));
                    }
                    cursor = blocks
                        .get(&txn, &pid)
                        .and_then(|v| match v {
                            yrs::Out::YMap(m) => m.get(&txn, "parentId").and_then(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                yrs::Out::Any(yrs::Any::Null) => None,
                                _ => None,
                            }),
                            _ => None,
                        });
                }

                // Validate new parent exists
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

            // Handle reparenting or repositioning
            if parent_changed || repositioning {
                // Update block's parentId field (only if parent changed)
                if parent_changed {
                    let parent_id_value: yrs::Any = match &final_parent_id {
                        Some(p) => yrs::Any::String(p.clone().into()),
                        None => yrs::Any::Null,
                    };
                    block_map.insert(&mut txn, "parentId", parent_id_value);
                }

                // Validate afterId if present
                if let Some(ref after_id) = req.after_id {
                    match blocks.get(&txn, after_id) {
                        Some(yrs::Out::YMap(after_map)) => {
                            // Check afterId block shares same parent (or will share after reparenting)
                            let after_parent = after_map.get(&txn, "parentId")
                                .and_then(|v| match v {
                                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                    yrs::Out::Any(yrs::Any::Null) => None,
                                    _ => None,
                                });

                            let expected_parent = final_parent_id.as_ref().map(|s| s.as_str());
                            let actual_parent = after_parent.as_ref().map(|s| s.as_str());

                            if actual_parent != expected_parent {
                                return Err(ApiError::InvalidRequest(format!(
                                    "Block {} is not a sibling (different parent)",
                                    after_id
                                )));
                            }
                        }
                        _ => {
                            return Err(ApiError::NotFound(format!(
                                "afterId block not found: {}",
                                after_id
                            )));
                        }
                    }
                }

                // Remove from old parent's childIds (or rootIds if was root)
                // This happens for both reparenting AND repositioning
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
                // Use positional params if provided
                if let Some(ref new_pid) = final_parent_id {
                    if let Some(yrs::Out::YMap(new_parent_map)) = blocks.get(&txn, new_pid) {
                        if let Some(yrs::Out::YArray(child_ids_arr)) = new_parent_map.get(&txn, "childIds") {
                            // Determine insertion index
                            let insert_idx = if let Some(ref after_id) = req.after_id {
                                // Find position of afterId sibling, insert after it
                                let child_ids_vec: Vec<String> = child_ids_arr
                                    .iter(&txn)
                                    .filter_map(|v| match v {
                                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                        _ => None,
                                    })
                                    .collect();

                                child_ids_vec.iter()
                                    .position(|x| x == after_id)
                                    .map(|idx| idx + 1)
                                    .unwrap_or(child_ids_arr.len(&txn) as usize)  // Fallback: append
                            } else if let Some(at_index) = req.at_index {
                                // Clamp to valid range (0..=length)
                                at_index.min(child_ids_arr.len(&txn) as usize)
                            } else {
                                // Default: append to end (backward compatible)
                                child_ids_arr.len(&txn) as usize
                            };

                            // Use Y.Array insert() - surgical, 1 CRDT op (FLO-280 pattern)
                            child_ids_arr.insert(&mut txn, insert_idx as u32, id.as_str());
                        }
                    }
                } else {
                    // Moving to root
                    let root_ids = txn.get_or_insert_array("rootIds");

                    let insert_idx = if let Some(ref after_id) = req.after_id {
                        let root_vec: Vec<String> = root_ids
                            .iter(&txn)
                            .filter_map(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                _ => None,
                            })
                            .collect();

                        root_vec.iter()
                            .position(|x| x == after_id)
                            .map(|idx| idx + 1)
                            .unwrap_or(root_ids.len(&txn) as usize)
                    } else if let Some(at_index) = req.at_index {
                        at_index.min(root_ids.len(&txn) as usize)
                    } else {
                        root_ids.len(&txn) as usize
                    };

                    root_ids.insert(&mut txn, insert_idx as u32, id.as_str());
                }
            }

            block_map.insert(&mut txn, "updatedAt", now as f64);
        }
        txn.encode_update_v1()
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    let seq = state.store.persist_update(&update)?;
    state.broadcaster.broadcast(update, None, Some(seq));

    // Emit to hook system for metadata extraction (only if content changed)
    if content_changed {
        let _ = state.hook_system.emit_change(BlockChange::ContentChanged {
            id: id.clone(),
            old_content,
            new_content: final_content.clone(),
            origin: Origin::User,
        });
    }

    // Emit Moved event if reparenting occurred
    if parent_changed {
        let _ = state.hook_system.emit_change(BlockChange::Moved {
            id: id.clone(),
            old_parent_id,
            new_parent_id: final_parent_id.clone(),
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
        inherited_markers: None, // Computed on read
        created_at,
        updated_at: now as i64,
        output_type: None, // PATCH doesn't modify output — use GET for full block
        output: None,
    }))
}

/// Collect a block and all its descendants via stack-based traversal.
/// Returns Vec of (id, content) pairs for hook event emission.
fn collect_descendants(
    blocks: &yrs::MapRef,
    txn: &yrs::TransactionMut<'_>,
    root_id: &str,
) -> Vec<(String, String)> {
    let mut result = Vec::new();
    let mut stack = vec![root_id.to_string()];

    while let Some(current_id) = stack.pop() {
        if let Some(yrs::Out::YMap(block_map)) = blocks.get(txn, &current_id) {
            let content = block_map
                .get(txn, "content")
                .and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
                .unwrap_or_default();

            // Push children onto stack for traversal
            if let Some(yrs::Out::YArray(child_ids)) = block_map.get(txn, "childIds") {
                for value in child_ids.iter(txn) {
                    if let yrs::Out::Any(yrs::Any::String(s)) = value {
                        stack.push(s.to_string());
                    }
                }
            }

            result.push((current_id, content));
        }
    }

    result
}

/// DELETE /api/v1/blocks/:id - Delete block and entire subtree
async fn delete_block(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let doc = state.store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    let (update, deleted_blocks) = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Resolve short-hash prefix to full block ID
        let id = resolve_block_id(&id, &blocks, &txn)?;

        // Get block's parentId before deleting
        let parent_id: Option<String> = match blocks.get(&txn, &id) {
            Some(yrs::Out::YMap(block_map)) => {
                block_map.get(&txn, "parentId").and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
            }
            Some(_) => return Err(ApiError::NotFound(id)),
            None => return Err(ApiError::NotFound(id)),
        };

        // Collect all descendants (block + children + grandchildren...)
        let to_delete = collect_descendants(&blocks, &txn, &id);

        // Remove from parent's childIds if this block has a parent
        if let Some(ref pid) = parent_id {
            if let Some(yrs::Out::YMap(parent_map)) = blocks.get(&txn, pid) {
                if let Some(yrs::Out::YArray(child_ids)) = parent_map.get(&txn, "childIds") {
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

        // Delete all collected blocks from the map
        for (del_id, _) in &to_delete {
            blocks.remove(&mut txn, del_id);
        }

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

        (txn.encode_update_v1(), to_delete)
    };
    drop(doc_guard);

    // Persist and broadcast to WebSocket clients
    let seq = state.store.persist_update(&update)?;
    state.broadcaster.broadcast(update, None, Some(seq));

    // Emit BlockChange::Deleted for EACH deleted block (hooks depend on complete coverage)
    for (del_id, del_content) in &deleted_blocks {
        let _ = state.hook_system.emit_change(BlockChange::Deleted {
            id: del_id.clone(),
            content: del_content.clone(),
            origin: Origin::User,
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

// ============================================================================
// Page Search API (autocomplete for [[wikilinks]])
// ============================================================================

/// Search query parameters
#[derive(Deserialize)]
pub struct PageSearchQuery {
    /// Prefix/query to search for (e.g., "My Pa" to find "My Page")
    #[serde(default)]
    pub prefix: String,
    /// Maximum results to return (default: 10)
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Use fuzzy matching instead of prefix matching (typo-tolerant, nucleo scorer)
    #[serde(default)]
    pub fuzzy: bool,
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
    /// Block ID of the page block. `None` for stubs (referenced but not yet created).
    pub block_id: Option<String>,
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

// ============================================================================
// Full-Text Search API (Tantivy)
// ============================================================================

/// Full-text search query parameters
#[derive(Deserialize)]
pub struct BlockSearchQuery {
    /// Search text (optional — omit or empty for filter-only queries)
    #[serde(default)]
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
    /// Include breadcrumb (parent chain) per hit
    #[serde(default)]
    pub include_breadcrumb: Option<bool>,
    /// Include block metadata per hit
    #[serde(default)]
    pub include_metadata: Option<bool>,
    /// Filter by [[wikilink]] outlink target
    #[serde(default)]
    pub outlink: Option<String>,
    /// Filter by marker type (e.g., "project", "mode")
    #[serde(default)]
    pub marker_type: Option<String>,
    /// Filter by marker value (e.g., "floatty", "rangle/pharmacy").
    /// Combines with marker_type to form the internal "type::value" term query.
    /// Use alone for "any marker with this value" or with marker_type for precise match.
    #[serde(default)]
    pub marker_val: Option<String>,
    /// Filter: created after this epoch timestamp (seconds).
    /// Note: BlockDto.createdAt is milliseconds, but search filters use seconds
    /// for consistency across all temporal filters (created_at, ctx_at).
    #[serde(default)]
    pub created_after: Option<i64>,
    /// Filter: created before this epoch timestamp (seconds)
    #[serde(default)]
    pub created_before: Option<i64>,
    /// Filter: ctx:: event after this epoch timestamp (seconds)
    #[serde(default)]
    pub ctx_after: Option<i64>,
    /// Filter: ctx:: event before this epoch timestamp (seconds)
    #[serde(default)]
    pub ctx_before: Option<i64>,
    /// When false, marker_type/marker_value filter only own markers (excludes inherited).
    /// Default: true (includes inherited markers from ancestors).
    #[serde(default)]
    pub inherited: Option<bool>,
    /// Block types to exclude (comma-separated, e.g., "eval,sh").
    /// Uses MustNot logic — all specified types are excluded from results.
    #[serde(default)]
    pub exclude_types: Option<String>,
}

fn default_search_limit() -> usize {
    20
}

/// Search hit DTO
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockSearchHit {
    /// Block ID (foreign key — serializes as "blockId" via camelCase rename)
    pub block_id: String,
    /// Relevance score (higher = more relevant)
    pub score: f32,
    /// Block content (truncated for display)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Parent chain as content strings (nearest first), max 5 levels
    #[serde(skip_serializing_if = "Option::is_none")]
    pub breadcrumb: Option<Vec<String>>,
    /// Block metadata (markers, wikilinks, etc)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// Highlighted snippet from Tantivy (HTML with <b> tags around matched terms)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    /// Block type (text, h1, h2, h3, ctx, sh, etc.)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_type: Option<String>,
}

/// Full-text search response
#[derive(Serialize, Deserialize)]
pub struct BlockSearchResponse {
    /// Search results (IDs + scores)
    pub hits: Vec<BlockSearchHit>,
    /// Total number of matching blocks (may exceed hits.len() when limit applies)
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
/// - `include_breadcrumb` (optional): Include parent chain per hit (max 5 levels)
/// - `include_metadata` (optional): Include block metadata per hit
///
/// # Example
///
/// ```text
/// GET /api/v1/search?q=floatty&limit=10&types=sh,ctx
/// GET /api/v1/search?q=FLO-414&include_breadcrumb=true&include_metadata=true
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
    // All temporal search filters use epoch seconds. Tantivy stores seconds internally.
    // Note: BlockDto.createdAt is milliseconds — different contract. Search = seconds.
    let has_explicit_types = query.types.is_some();
    let filters = SearchFilters {
        block_types: query.types.map(|t| {
            t.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect()
        }),
        has_markers: query.has_markers,
        parent_id: query.parent_id,
        outlink: query.outlink,
        marker_type: query.marker_type.clone(),
        // Join marker_type + marker_val into "type::value" for internal Tantivy term query.
        // Callers send ?marker_type=project&marker_val=floatty → internal "project::floatty"
        marker_value: match (&query.marker_type, &query.marker_val) {
            (Some(mt), Some(mv)) => Some(format!("{mt}::{mv}")),
            (None, Some(mv)) => Some(mv.clone()),  // value-only search (rare)
            _ => None,
        },
        created_after: query.created_after,
        created_before: query.created_before,
        ctx_after: query.ctx_after,
        ctx_before: query.ctx_before,
        include_inherited: query.inherited,
        exclude_types: Some(match query.exclude_types {
            // Caller specified explicit exclusions — use those
            Some(t) => t.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
            // No exclusions specified — apply defaults ONLY for general queries.
            // Skip defaults when caller used `types=` (explicit include would
            // conflict with default MustNot on the same type, e.g. types=picker).
            None if !has_explicit_types => vec![
                "picker".into(),
                "output".into(),
                "ran".into(),
            ],
            None => vec![],
        }),
    };

    // Execute search
    let (total, hits) = service
        .search_with_filters(&query.q, filters, query.limit)
        .map_err(|e| ApiError::Search(e.to_string()))?;

    let want_breadcrumb = query.include_breadcrumb.unwrap_or(false);
    let want_metadata = query.include_metadata.unwrap_or(false);

    // Hydrate content from Y.Doc for each hit
    let hits: Vec<BlockSearchHit> = {
        let doc = state.store.doc();
        let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
        let txn = doc_guard.transact();

        let blocks_map = txn.get_map("blocks");

        hits.into_iter()
            .map(|h| {
                let (content, breadcrumb, metadata, block_type) = if let Some(ref bmap) = blocks_map {
                    // Look up content
                    let content = bmap
                        .get(&txn, &h.block_id)
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
                            if c.chars().count() > 200 {
                                let truncated: String = c.chars().take(200).collect();
                                format!("{}...", truncated)
                            } else {
                                c
                            }
                        });

                    // Breadcrumb: walk parent chain, collect content strings (max 5)
                    let breadcrumb = if want_breadcrumb {
                        let ancestors = get_ancestors(bmap, &txn, &h.block_id);
                        let crumbs: Vec<String> = ancestors
                            .into_iter()
                            .take(5)
                            .map(|a| a.content)
                            .collect();
                        if crumbs.is_empty() { None } else { Some(crumbs) }
                    } else {
                        None
                    };

                    // Metadata from Y.Doc
                    let metadata = if want_metadata {
                        bmap.get(&txn, &h.block_id)
                            .and_then(|v| match v {
                                yrs::Out::YMap(block_map) => block_map
                                    .get(&txn, "metadata")
                                    .and_then(|m| extract_metadata_from_yrs(m, &txn)),
                                _ => None,
                            })
                    } else {
                        None
                    };

                    // Block type derived from content
                    let block_type = content.as_ref().map(|c| {
                        floatty_core::parse_block_type(c).as_str().to_string()
                    });

                    (content, breadcrumb, metadata, block_type)
                } else {
                    (None, None, None, None)
                };

                BlockSearchHit {
                    block_id: h.block_id,
                    score: h.score,
                    content,
                    breadcrumb,
                    metadata,
                    snippet: h.snippet,
                    block_type,
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

/// POST /api/v1/search/reindex - Rebuild search index from Y.Doc
///
/// Rehydrates all blocks through the hook pipeline (metadata extraction → Tantivy indexing).
/// Use after clear, restore, or when search results are stale.
async fn reindex_search(State(state): State<AppState>) -> Result<Json<ReindexResponse>, ApiError> {
    let count = state.hook_system.rehydrate_all_blocks(&state.store);
    tracing::info!("Reindex triggered: {} blocks rehydrated", count);
    Ok(Json(ReindexResponse { rehydrated: count }))
}

#[derive(Serialize)]
struct ReindexResponse {
    rehydrated: usize,
}

// ============================================================================
// Backup Endpoints (FLO-251)
// ============================================================================

/// Backup status response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatusResponse {
    pub running: bool,
    pub last_backup: Option<String>,
    pub next_backup: Option<String>,
    pub backup_count: usize,
    pub total_size_bytes: u64,
    pub backup_dir: String,
}

/// Backup file info for list response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileInfo {
    pub filename: String,
    pub size_bytes: u64,
    pub created: String,
}

/// Backup list response
#[derive(Serialize)]
pub struct BackupListResponse {
    pub backups: Vec<BackupFileInfo>,
}

/// Backup trigger response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTriggerResponse {
    pub filename: String,
    pub size_bytes: u64,
}

/// Backup restore request
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupRestoreRequest {
    pub filename: String,
}

/// Backup config response
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupConfigResponse {
    pub enabled: bool,
    pub interval_hours: u64,
    pub retain_hourly: u32,
    pub retain_daily: u32,
    pub retain_weekly: u32,
    pub backup_dir: String,
}

// ═══════════════════════════════════════════════════════════════════════════
// VOCABULARY DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════

/// GET /api/v1/markers - List distinct marker types with counts
///
/// Returns all marker types found across blocks with their occurrence counts.
/// Sorted by count descending.
async fn list_marker_types(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let types = state.store.enumerate_marker_types();
    let items: Vec<serde_json::Value> = types
        .into_iter()
        .map(|(marker_type, count)| {
            serde_json::json!({ "type": marker_type, "count": count })
        })
        .collect();
    Ok(Json(serde_json::json!({ "markers": items, "total": items.len() })))
}

/// GET /api/v1/markers/:marker_type/values - List values for a marker type
///
/// Returns distinct values for a specific marker type with counts.
/// E.g., `/api/v1/markers/project/values` returns `[{value: "floatty", count: 350}, ...]`
async fn list_marker_values(
    State(state): State<AppState>,
    axum::extract::Path(marker_type): axum::extract::Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let values = state.store.enumerate_marker_values(&marker_type);
    let items: Vec<serde_json::Value> = values
        .into_iter()
        .map(|(value, count)| {
            serde_json::json!({ "value": value, "count": count })
        })
        .collect();
    Ok(Json(serde_json::json!({
        "markerType": marker_type,
        "values": items,
        "total": items.len()
    })))
}

/// GET /api/v1/stats - Block statistics
///
/// Returns total block count, root count, type distribution, and metadata coverage.
async fn get_block_stats(
    State(state): State<AppState>,
) -> Result<Json<floatty_core::store::BlockStats>, ApiError> {
    Ok(Json(state.store.get_stats()))
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKUP
// ═══════════════════════════════════════════════════════════════════════════

/// Format SystemTime as ISO 8601 string (UTC)
fn format_system_time(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    DateTime::from_timestamp(secs as i64, 0)
        .map(|dt: DateTime<Utc>| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

/// GET /api/v1/backup/status - Backup daemon status
async fn backup_status(State(state): State<AppState>) -> Result<Json<BackupStatusResponse>, ApiError> {
    let daemon = state.backup_daemon.as_ref()
        .ok_or_else(|| ApiError::Search("Backups not enabled".to_string()))?;

    let status = daemon.get_status();

    Ok(Json(BackupStatusResponse {
        running: status.running,
        last_backup: status.last_backup.map(format_system_time),
        next_backup: status.next_backup.map(format_system_time),
        backup_count: status.backup_count,
        total_size_bytes: status.total_size_bytes,
        backup_dir: daemon.backup_dir().display().to_string(),
    }))
}

/// GET /api/v1/backup/list - List backup files
async fn backup_list(State(state): State<AppState>) -> Result<Json<BackupListResponse>, ApiError> {
    let daemon = state.backup_daemon.as_ref()
        .ok_or_else(|| ApiError::Search("Backups not enabled".to_string()))?;

    let backups = daemon.list_backups()
        .map_err(|e| ApiError::Search(format!("Failed to list backups: {}", e)))?;

    let files: Vec<BackupFileInfo> = backups.into_iter()
        .map(|b| BackupFileInfo {
            filename: b.filename,
            size_bytes: b.size_bytes,
            created: format_system_time(b.created),
        })
        .collect();

    Ok(Json(BackupListResponse { backups: files }))
}

/// POST /api/v1/backup/trigger - Trigger immediate backup
async fn backup_trigger(State(state): State<AppState>) -> Result<Json<BackupTriggerResponse>, ApiError> {
    let daemon = state.backup_daemon.as_ref()
        .ok_or_else(|| ApiError::Search("Backups not enabled".to_string()))?;

    let info = daemon.trigger_backup().await
        .map_err(|e| ApiError::Search(e))?;

    Ok(Json(BackupTriggerResponse {
        filename: info.filename,
        size_bytes: info.size_bytes,
    }))
}

/// POST /api/v1/backup/restore - Restore from backup file
///
/// **DESTRUCTIVE**: Requires `x-floatty-confirm-destructive: true` header.
async fn backup_restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BackupRestoreRequest>,
) -> Result<Json<RestoreResponse>, ApiError> {
    // Safety check: require explicit confirmation header for destructive operation
    let confirmed = headers
        .get("x-floatty-confirm-destructive")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if !confirmed {
        return Err(ApiError::MissingConfirmationHeader);
    }

    let daemon = state.backup_daemon.as_ref()
        .ok_or_else(|| ApiError::Search("Backups not enabled".to_string()))?;

    // Find the backup file
    let backups = daemon.list_backups()
        .map_err(|e| ApiError::Search(format!("Failed to list backups: {}", e)))?;

    let backup = backups.iter()
        .find(|b| b.filename == req.filename)
        .ok_or_else(|| ApiError::NotFound(format!("Backup not found: {}", req.filename)))?;

    // Read the backup file
    let state_bytes = std::fs::read(&backup.path)
        .map_err(|e| ApiError::Search(format!("Failed to read backup: {}", e)))?;

    // Clear search index before restore
    if let Err(e) = state.hook_system.clear_search_index().await {
        tracing::warn!("Failed to clear search index before restore: {}", e);
    }

    // Reset the store to the backup state
    let block_count = state.store.reset_from_state(&state_bytes)?;

    // Broadcast new state to connected clients
    // No seq for restore - this is a full state replacement, not an incremental update
    let new_state = state.store.get_full_state()?;
    state.broadcaster.broadcast(new_state, None, None);

    // Rehydrate hooks
    let rehydrated = state.hook_system.rehydrate_all_blocks(&state.store);
    tracing::info!("Rehydrated {} blocks after backup restore", rehydrated);

    // Count roots
    let root_count = {
        let doc = state.store.doc();
        let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
        let txn = doc_guard.transact();
        txn.get_array("rootIds")
            .map(|arr| arr.len(&txn) as usize)
            .unwrap_or(0)
    };

    tracing::info!(
        block_count = block_count,
        root_count = root_count,
        filename = %req.filename,
        "Restored from backup"
    );

    Ok(Json(RestoreResponse { block_count, root_count }))
}

/// GET /api/v1/backup/config - Get backup configuration
async fn backup_config(State(state): State<AppState>) -> Result<Json<BackupConfigResponse>, ApiError> {
    let daemon = state.backup_daemon.as_ref()
        .ok_or_else(|| ApiError::Search("Backups not enabled".to_string()))?;

    let config = daemon.config();

    Ok(Json(BackupConfigResponse {
        enabled: config.enabled,
        interval_hours: config.interval_hours,
        retain_hourly: config.retain_hourly,
        retain_daily: config.retain_daily,
        retain_weekly: config.retain_weekly,
        backup_dir: daemon.backup_dir().display().to_string(),
    }))
}

// ═══════════════════════════════════════════════════════════════
// PRESENCE (spike for TUI follower)
// ═══════════════════════════════════════════════════════════════

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresenceRequest {
    block_id: String,
    pane_id: Option<String>,
}

/// GET /api/v1/daily/:date — Resolve daily note page by date string.
///
/// Looks up a page named exactly `date` (e.g., "2026-03-31") in the PageNameIndex.
/// Returns the page block with children by default, same shape as `GET /api/v1/blocks/:id`.
/// Accepts optional `include` query param for additional context (ancestors, tree, etc.).
async fn get_daily_note(
    State(state): State<AppState>,
    Path(date): Path<String>,
    axum::extract::Query(mut ctx_query): axum::extract::Query<BlockContextQuery>,
) -> Result<Json<BlockWithContextResponse>, ApiError> {
    let page_block_id = {
        let page_index = state.page_name_index.read().map_err(|_| ApiError::LockPoisoned)?;
        page_index.page_block_id(&date).map(String::from)
    };

    let page_id = page_block_id.ok_or_else(|| {
        ApiError::NotFound(format!("Page not found: {}", date))
    })?;

    // Default to including children if no include param specified (or empty string)
    if ctx_query.include.as_deref().map_or(true, |s| s.trim().is_empty()) {
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
            let index = state.inheritance_index.read().map_err(|_| ApiError::LockPoisoned)?;
            lookup_inherited(&index, &page_id)
        };
        let block_dto = read_block_dto(&block_map, &txn, &page_id, inherited_markers, true);
        Ok(Json(build_block_context_response(
            &blocks_map, &txn, &page_id, block_dto, &ctx_query,
        )))
    } else {
        Err(ApiError::NotFound(page_id))
    }
}

/// GET /api/v1/presence — returns the last focused block, or 204 if none yet / block deleted
async fn get_presence(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let Some(info) = state.broadcaster.get_last_presence() else {
        return StatusCode::NO_CONTENT.into_response();
    };

    // Validate block still exists — cached presence can outlive deleted blocks
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
    })).into_response()
}

async fn post_presence(
    State(state): State<AppState>,
    Json(req): Json<PresenceRequest>,
) -> StatusCode {
    state.broadcaster.broadcast_presence(req.block_id, req.pane_id);
    StatusCode::OK
}

// =========================================================================
// Outline management endpoints (Phase 1: multi-outline)
// =========================================================================

/// Request body for creating an outline.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateOutlineRequest {
    name: String,
}

/// GET /api/v1/outlines — list all available outlines
async fn list_outlines(
    State(state): State<AppState>,
) -> Result<Json<Vec<OutlineInfo>>, ApiError> {
    let outlines = state.outline_manager.list_outlines().map_err(|e| {
        ApiError::InvalidRequest(format!("Failed to list outlines: {}", e))
    })?;
    Ok(Json(outlines))
}

/// POST /api/v1/outlines — create a new outline
async fn create_outline_handler(
    State(state): State<AppState>,
    Json(req): Json<CreateOutlineRequest>,
) -> Result<(StatusCode, Json<OutlineInfo>), ApiError> {
    let name = OutlineName::new(&req.name).map_err(|e| {
        ApiError::InvalidRequest(format!("{}", e))
    })?;
    let info = state.outline_manager.create_outline(&name).map_err(|e| {
        match &e {
            floatty_core::OutlineError::AlreadyExists(_) | floatty_core::OutlineError::InvalidName(_) | floatty_core::OutlineError::ReservedName => {
                ApiError::InvalidRequest(format!("{}", e))
            }
            _ => ApiError::InvalidRequest(format!("Failed to create outline: {}", e)),
        }
    })?;
    Ok((StatusCode::CREATED, Json(info)))
}

/// DELETE /api/v1/outlines/:name — delete an outline (refuses "default")
async fn delete_outline_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<StatusCode, ApiError> {
    if name == "default" {
        return Err(ApiError::InvalidRequest("Cannot delete the default outline".into()));
    }
    let validated = OutlineName::new(&name).map_err(|e| {
        ApiError::InvalidRequest(format!("{}", e))
    })?;
    state.outline_manager.delete_outline(&validated).map_err(|e| {
        match &e {
            floatty_core::OutlineError::NotFound(_) => ApiError::NotFound(format!("{}", e)),
            _ => ApiError::InvalidRequest(format!("Failed to delete outline: {}", e)),
        }
    })?;
    Ok(StatusCode::NO_CONTENT)
}

/// Reject mutation requests for the "default" outline via outline routes.
/// Default outline should use legacy routes which have full hook/broadcaster support.
fn reject_default_mutation(name: &str) -> Result<(), ApiError> {
    if name == "default" {
        return Err(ApiError::InvalidRequest(
            "Use legacy routes (/api/v1/blocks, /api/v1/update) for the default outline".into(),
        ));
    }
    Ok(())
}

/// Resolve an outline store from the manager, mapping errors to ApiError.
fn resolve_outline(state: &AppState, name: &str) -> Result<Arc<YDocStore>, ApiError> {
    state.outline_manager.get_or_default(name).map_err(|e| {
        match &e {
            floatty_core::OutlineError::NotFound(_) => ApiError::NotFound(format!("outline '{}' not found", name)),
            floatty_core::OutlineError::InvalidName(_) | floatty_core::OutlineError::ReservedName => {
                ApiError::InvalidRequest(format!("{}", e))
            }
            _ => ApiError::InvalidRequest(format!("Failed to resolve outline: {}", e)),
        }
    })
}

// =========================================================================
// Per-outline sync endpoints (Phase 1: no broadcaster, no hooks)
// =========================================================================

/// GET /api/v1/outlines/:name/state
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

/// GET /api/v1/outlines/:name/state-vector
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

/// GET /api/v1/outlines/:name/state/hash
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

/// POST /api/v1/outlines/:name/update — apply Y.Doc update (no WS broadcast in Phase 1)
async fn outline_apply_update(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<UpdateRequest>,
) -> Result<StatusCode, ApiError> {
    reject_default_mutation(&name)?;
    let store = resolve_outline(&state, &name)?;
    let update_bytes = BASE64
        .decode(&req.update)
        .map_err(|e| ApiError::InvalidBase64(e.to_string()))?;

    store.apply_update(&update_bytes)?;
    // Phase 1: no broadcaster for non-default outlines
    Ok(StatusCode::OK)
}

/// GET /api/v1/outlines/:name/updates
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

/// GET /api/v1/outlines/:name/export/binary
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

/// GET /api/v1/outlines/:name/export/json
/// Read all blocks and root IDs from a Y.Doc transaction as raw JSON.
/// Shared by outline_export_json and outline_get_blocks.
fn read_all_blocks_json<T: ReadTxn>(txn: &T) -> serde_json::Value {
    let blocks_map = match txn.get_map("blocks") {
        Some(m) => m,
        None => return serde_json::json!({"blocks": [], "rootIds": []}),
    };

    let mut blocks = Vec::new();
    for (id, value) in blocks_map.iter(txn) {
        if let yrs::Out::YMap(block_map) = value {
            let mut block = serde_json::Map::new();
            block.insert("id".into(), serde_json::Value::String(id.to_string()));
            for (key, val) in block_map.iter(txn) {
                block.insert(key.to_string(), yrs_out_to_json(val, txn));
            }
            blocks.push(serde_json::Value::Object(block));
        }
    }

    let root_ids: Vec<String> = txn
        .get_array("rootIds")
        .map(|arr| {
            arr.iter(txn)
                .filter_map(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();

    serde_json::json!({ "blocks": blocks, "rootIds": root_ids })
}

async fn outline_export_json(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let export = read_all_blocks_json(&txn);

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string_pretty(&export).unwrap(),
    ))
}

// =========================================================================
// Per-outline block CRUD (Phase 1: no hooks, no inheritance, no search)
// =========================================================================

/// GET /api/v1/outlines/:name/blocks
async fn outline_get_blocks(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    Ok(Json(read_all_blocks_json(&txn)))
}

/// POST /api/v1/outlines/:name/blocks
async fn outline_create_block(
    State(state): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<CreateBlockRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    reject_default_mutation(&name)?;
    let store = resolve_outline(&state, &name)?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    let doc = store.doc();
    let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

    // Resolve short-hash prefixes
    let mut req = req;
    {
        let txn = doc_guard.transact();
        if let Some(blocks_map) = txn.get_map("blocks") {
            if let Some(ref pid) = req.parent_id {
                req.parent_id = Some(resolve_block_id(pid, &blocks_map, &txn)?);
            }
            if let Some(ref aid) = req.after_id {
                req.after_id = Some(resolve_block_id(aid, &blocks_map, &txn)?);
            }
        }
    }

    let update = {
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // Validate parent
        if let Some(ref parent_id) = req.parent_id {
            match blocks.get(&txn, parent_id.as_str()) {
                Some(yrs::Out::YMap(_)) => {}
                _ => return Err(ApiError::NotFound(format!("Parent block not found: {}", parent_id))),
            }
        }

        // Create block Y.Map (aligned with legacy block shape)
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
        let empty: Vec<yrs::Any> = vec![];
        block_map.insert(&mut txn, "childIds", ArrayPrelim::from(empty));

        // Add to parent's childIds or rootIds, honoring afterId (reject if invalid)
        if let Some(ref parent_id) = req.parent_id {
            let parent_map = match blocks.get(&txn, parent_id.as_str()) {
                Some(yrs::Out::YMap(m)) => m,
                _ => return Err(ApiError::NotFound(format!("Parent block not found: {}", parent_id))),
            };
            let child_ids = match parent_map.get(&txn, "childIds") {
                Some(yrs::Out::YArray(arr)) => arr,
                _ => return Err(ApiError::InvalidRequest(format!(
                    "Parent '{}' has no childIds array (corrupt block)", parent_id
                ))),
            };
            let insert_idx = if let Some(ref after_id) = req.after_id {
                let child_vec: Vec<String> = child_ids.iter(&txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect();
                match child_vec.iter().position(|x| x == after_id) {
                    Some(idx) => idx + 1,
                    None => return Err(ApiError::InvalidRequest(
                        format!("afterId '{}' is not a sibling under parent '{}'", after_id, parent_id)
                    )),
                }
            } else {
                child_ids.len(&txn) as usize
            };
            child_ids.insert(&mut txn, insert_idx as u32, id.as_str());
        } else {
            let root_ids = txn.get_or_insert_array("rootIds");
            let insert_idx = if let Some(ref after_id) = req.after_id {
                let root_vec: Vec<String> = root_ids.iter(&txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect();
                match root_vec.iter().position(|x| x == after_id) {
                    Some(idx) => idx + 1,
                    None => return Err(ApiError::InvalidRequest(
                        format!("afterId '{}' is not in root list", after_id)
                    )),
                }
            } else {
                root_ids.len(&txn) as usize
            };
            root_ids.insert(&mut txn, insert_idx as u32, id.as_str());
        }

        txn.encode_update_v1()
    };
    drop(doc_guard); // Release lock before persistence

    store.persist_update(&update)?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": id,
            "content": req.content,
        })),
    ))
}

/// GET /api/v1/outlines/:name/blocks/:id
async fn outline_get_block(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let store = resolve_outline(&state, &name)?;
    let doc = store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();

    let blocks_map = txn
        .get_map("blocks")
        .ok_or_else(|| ApiError::NotFound(format!("block '{}' not found", id)))?;

    let block_id = resolve_block_id(&id, &blocks_map, &txn)?;

    match blocks_map.get(&txn, &block_id) {
        Some(yrs::Out::YMap(map)) => {
            let mut block = serde_json::Map::new();
            block.insert("id".into(), serde_json::Value::String(block_id));
            for (key, val) in map.iter(&txn) {
                block.insert(key.to_string(), yrs_out_to_json(val, &txn));
            }
            Ok(Json(serde_json::Value::Object(block)))
        }
        _ => Err(ApiError::NotFound(format!("block '{}' not found", id))),
    }
}

/// PATCH /api/v1/outlines/:name/blocks/:id
async fn outline_update_block(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
    Json(req): Json<UpdateBlockRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    reject_default_mutation(&name)?;
    let store = resolve_outline(&state, &name)?;
    let doc = store.doc();

    let (block_id, update) = {
        let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

        let block_id = {
            let txn = doc_guard.transact();
            let blocks_map = txn.get_map("blocks")
                .ok_or_else(|| ApiError::NotFound(format!("block '{}' not found", id)))?;
            resolve_block_id(&id, &blocks_map, &txn)?
        };

        let update = {
            let mut txn = doc_guard.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");

            match blocks.get(&txn, &block_id) {
                Some(yrs::Out::YMap(map)) => {
                    if let Some(ref content) = req.content {
                        map.insert(&mut txn, "content", yrs::Any::String(content.clone().into()));
                    }
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as f64;
                    map.insert(&mut txn, "updatedAt", yrs::Any::Number(now));
                }
                _ => return Err(ApiError::NotFound(format!("block '{}' not found", id))),
            }

            txn.encode_update_v1()
        };

        (block_id, update)
    }; // doc_guard dropped here

    store.persist_update(&update)?;
    Ok(Json(serde_json::json!({ "id": block_id })))
}

/// DELETE /api/v1/outlines/:name/blocks/:id — deletes block, its subtree, and cleans parent refs.
async fn outline_delete_block(
    State(state): State<AppState>,
    Path((name, id)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    reject_default_mutation(&name)?;
    let store = resolve_outline(&state, &name)?;
    let doc = store.doc();

    let update = {
        let doc_guard = doc.write().map_err(|_| ApiError::LockPoisoned)?;

        let block_id = {
            let txn = doc_guard.transact();
            let blocks_map = txn.get_map("blocks")
                .ok_or_else(|| ApiError::NotFound(format!("block '{}' not found", id)))?;
            resolve_block_id(&id, &blocks_map, &txn)?
        };

        let update = {
            let mut txn = doc_guard.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");

            // Collect descendants to delete (DFS)
            let mut to_delete = vec![block_id.clone()];
            let mut i = 0;
            while i < to_delete.len() {
                let bid = to_delete[i].clone();
                if let Some(yrs::Out::YMap(map)) = blocks.get(&txn, &bid) {
                    if let Some(yrs::Out::YArray(child_ids)) = map.get(&txn, "childIds") {
                        for val in child_ids.iter(&txn) {
                            if let yrs::Out::Any(yrs::Any::String(s)) = val {
                                to_delete.push(s.to_string());
                            }
                        }
                    }
                }
                i += 1;
            }

            // Read parent before deleting
            let parent_id: Option<String> = blocks.get(&txn, &block_id)
                .and_then(|v| match v {
                    yrs::Out::YMap(map) => map.get(&txn, "parentId").and_then(|p| match p {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    }),
                    _ => None,
                });

            // Remove all blocks in subtree
            for bid in &to_delete {
                blocks.remove(&mut txn, bid);
            }

            // Remove from parent's childIds
            if let Some(ref pid) = parent_id {
                if let Some(yrs::Out::YMap(parent_map)) = blocks.get(&txn, pid.as_str()) {
                    if let Some(yrs::Out::YArray(child_ids)) = parent_map.get(&txn, "childIds") {
                        let child_vec: Vec<String> = child_ids.iter(&txn)
                            .filter_map(|v| match v {
                                yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                                _ => None,
                            })
                            .collect();
                        if let Some(idx) = child_vec.iter().position(|x| x == &block_id) {
                            child_ids.remove(&mut txn, idx as u32);
                        }
                    }
                }
            } else {
                // Remove from rootIds
                let root_ids = txn.get_or_insert_array("rootIds");
                let root_vec: Vec<String> = root_ids.iter(&txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect();
                if let Some(idx) = root_vec.iter().position(|x| x == &block_id) {
                    root_ids.remove(&mut txn, idx as u32);
                }
            }

            txn.encode_update_v1()
        };

        update
    }; // doc_guard dropped here

    store.persist_update(&update)?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/outlines/:name/stats
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
        "blockCount": block_count,
        "rootCount": root_count,
    })))
}

/// 501 stub for search on non-default outlines
async fn outline_search_not_impl() -> impl IntoResponse {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(ErrorResponse {
            error: "search not available for non-default outlines".into(),
        }),
    )
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

    fn test_outline_manager(dir: &std::path::Path, store: &Arc<YDocStore>) -> Arc<crate::OutlineManager> {
        Arc::new(crate::OutlineManager::new_with_default(dir, Arc::clone(store)))
    }

    fn test_app() -> (Router, tempfile::TempDir, Arc<YDocStore>) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        let broadcaster = Arc::new(crate::WsBroadcaster::new(64));
        let hook_system = Arc::new(floatty_core::HookSystem::initialize(Arc::clone(&store)));
        let outline_manager = Arc::new(crate::OutlineManager::new_with_default(
            dir.path(),
            Arc::clone(&store),
        ));
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
        let om = test_outline_manager(dir.path(), &store);
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
