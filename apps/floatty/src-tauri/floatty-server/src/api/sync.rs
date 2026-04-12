//! Y.Doc sync handlers — state, update, restore, incremental updates, health.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use yrs::{Array, Map, ReadTxn, Transact};

use super::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/state", get(get_state))
        .route("/api/v1/state-vector", get(get_state_vector))
        .route("/api/v1/state/hash", get(get_state_hash))
        .route("/api/v1/updates", get(get_updates_since))
        .route("/api/v1/update", post(apply_update))
        .route("/api/v1/restore", post(restore_state))
}

// ============================================================================
// DTOs
// ============================================================================

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_dirty: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateResponse {
    pub state: String,
    pub latest_seq: Option<i64>,
}

#[derive(Serialize)]
pub struct StateVectorResponse {
    pub state_vector: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateHashResponse {
    pub hash: String,
    pub block_count: usize,
    pub timestamp: u128,
}

#[derive(Deserialize)]
pub struct UpdatesQuery {
    pub since: i64,
    #[serde(default = "default_updates_limit")]
    pub limit: usize,
}

fn default_updates_limit() -> usize {
    100
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEntry {
    pub seq: i64,
    pub data: String,
    pub created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesResponse {
    pub updates: Vec<UpdateEntry>,
    pub compacted_through: Option<i64>,
    pub latest_seq: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesCompactedResponse {
    pub error: String,
    pub compacted_through: i64,
    pub requested_since: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateRequest {
    pub update: String,
    #[serde(default)]
    pub tx_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RestoreRequest {
    pub state: String,
}

#[derive(Serialize)]
pub struct RestoreResponse {
    pub block_count: usize,
    pub root_count: usize,
}

// ============================================================================
// Handlers
// ============================================================================

async fn health() -> Json<HealthResponse> {
    let git_sha = option_env!("VERGEN_GIT_SHA").map(|s| s[..7.min(s.len())].to_string());
    let git_dirty = option_env!("VERGEN_GIT_DIRTY").map(|s| s == "true");

    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        git_sha,
        git_dirty,
    })
}

async fn get_state(State(state): State<AppState>) -> Result<Json<StateResponse>, ApiError> {
    let update = state.store.get_full_state()?;
    let latest_seq = state.store.get_latest_seq()?;
    Ok(Json(StateResponse {
        state: BASE64.encode(update),
        latest_seq,
    }))
}

async fn get_state_vector(
    State(state): State<AppState>,
) -> Result<Json<StateVectorResponse>, ApiError> {
    let sv = state.store.get_state_vector()?;
    Ok(Json(StateVectorResponse {
        state_vector: BASE64.encode(sv),
    }))
}

async fn get_state_hash(
    State(state): State<AppState>,
) -> Result<Json<StateHashResponse>, ApiError> {
    let full_state = state.store.get_full_state()?;

    let mut hasher = Sha256::new();
    hasher.update(&full_state);
    let hash = format!("{:x}", hasher.finalize());

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

#[tracing::instrument(skip(state, req), fields(route_family = "sync", handler = "apply_update"), err)]
async fn apply_update(
    State(state): State<AppState>,
    Json(req): Json<UpdateRequest>,
) -> Result<StatusCode, ApiError> {
    let update_bytes = BASE64
        .decode(&req.update)
        .map_err(|e| ApiError::InvalidBase64(e.to_string()))?;

    let seq = state.store.apply_update(&update_bytes)?;
    state
        .broadcaster
        .broadcast(update_bytes, req.tx_id, Some(seq));

    Ok(StatusCode::OK)
}

#[tracing::instrument(skip(state, headers, req), fields(route_family = "sync", handler = "restore_state"), err)]
async fn restore_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<RestoreRequest>,
) -> Result<Json<RestoreResponse>, ApiError> {
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

    if let Err(e) = state.hook_system.clear_search_index().await {
        tracing::warn!("Failed to clear search index before restore: {}", e);
    }

    let block_count = state.store.reset_from_state(&state_bytes)?;
    let new_state = state.store.get_full_state()?;
    state.broadcaster.broadcast(new_state, None, None);

    let rehydrated = state.hook_system.rehydrate_all_blocks(&state.store);
    tracing::info!("Rehydrated {} blocks after restore", rehydrated);

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

#[tracing::instrument(skip(state, query), fields(route_family = "sync", handler = "get_updates_since"), err)]
async fn get_updates_since(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<UpdatesQuery>,
) -> Result<Json<UpdatesResponse>, ApiError> {
    let limit = query.limit.min(1000);

    let compacted_through = state.store.get_compacted_through()?;
    if let Some(boundary) = compacted_through {
        if query.since < boundary {
            return Err(ApiError::UpdatesCompacted {
                requested: query.since,
                compacted_through: boundary,
            });
        }
    }

    let updates_raw = state.store.get_updates_since(query.since, limit)?;
    let updates: Vec<UpdateEntry> = updates_raw
        .into_iter()
        .map(|(seq, data, created_at)| UpdateEntry {
            seq,
            data: BASE64.encode(&data),
            created_at,
        })
        .collect();

    let latest_seq = state.store.get_latest_seq()?;

    Ok(Json(UpdatesResponse {
        updates,
        compacted_through,
        latest_seq,
    }))
}
