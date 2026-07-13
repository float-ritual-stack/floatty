//! Y.Doc sync handlers — state, update, restore, incremental updates, health.

// FLO-698 — read-path instrumentation for freeze-on-load diagnostics.
// Write paths (apply_update, restore_state, get_updates_since) already
// carry #[tracing::instrument]; reads were the asymmetric gap. Loki gets
// per-phase timing now to pinpoint which step dominates during a freeze.
use std::time::Instant;

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
use yrs::updates::decoder::Decode;
use yrs::{Array, Map, ReadTxn, StateVector, Transact};

use super::{ApiError, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/state", get(get_state))
        .route("/api/v1/state-vector", get(get_state_vector))
        .route("/api/v1/state-diff", post(get_state_diff))
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
    /// Seq of the last update APPLIED to the returned snapshot — captured under
    /// the same doc read guard as the encode, so a client seeding its baseline
    /// from this value never skips an update the snapshot doesn't contain.
    pub latest_seq: Option<i64>,
    /// Doc epoch. Increments on every destructive restore; clients hard-reset
    /// (adopt, never merge/push) on mismatch.
    pub epoch: i64,
}

#[derive(Serialize)]
pub struct StateVectorResponse {
    pub state_vector: String,
}

/// Request body for `POST /api/v1/state-diff` — the client's Y.Doc state vector
/// (`Y.encodeStateVector(doc)`, base64).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StateDiffRequest {
    pub state_vector: String,
}

/// Response for `POST /api/v1/state-diff` — the state-vector PULL diff.
///
/// The symmetric partner of the existing state-vector PUSH
/// (`Y.encodeStateAsUpdate(doc, serverSV)` → `POST /api/v1/update`). Because it
/// diffs against actual doc state rather than the seq log, it **survives
/// compaction** — unlike `GET /api/v1/updates?since=N`, which 410s once the
/// server compacts past the client's last seq and forces a full-state refetch.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDiffResponse {
    /// Base64 `encode_state_as_update_v1(serverDoc, clientStateVector)` — only
    /// the ops the client is missing.
    pub update: String,
    /// Seq of the last update APPLIED to the doc this diff was encoded from —
    /// captured under the SAME read guard as the encode. A mispaired seq lets a
    /// client seed its baseline past an update the diff doesn't contain.
    /// (Same pairing contract as `StateResponse::latest_seq`.)
    pub latest_seq: Option<i64>,
    /// Doc epoch, captured under the same read guard. A client pulling a diff
    /// across a restore boundary must detect the lineage change and hard-reset
    /// (adopt, never merge) rather than merging a foreign history.
    pub epoch: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateHashResponse {
    pub hash: String,
    pub block_count: usize,
    pub timestamp: u128,
    /// Doc epoch — lets the periodic drift detector (useSyncHealth polls this
    /// route) notice a missed restore even when block counts happen to match.
    #[serde(default)]
    pub epoch: i64,
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
    /// Highest seq in the persisted log (pagination bound — may briefly run
    /// ahead of the in-memory doc under persist-first ordering; that is fine
    /// for "is there more to fetch").
    pub latest_seq: Option<i64>,
    /// Doc epoch — a client gap-filling across a restore boundary must detect
    /// the epoch change and hard-reset instead of merging foreign updates.
    #[serde(default)]
    pub epoch: i64,
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

// NOTE: no rename_all — this response predates the camelCase convention and
// consumers (binary-import script) read snake_case fields. `epoch` is
// casing-neutral. Don't "fix" the casing without migrating consumers.
#[derive(Serialize)]
pub struct RestoreResponse {
    pub block_count: usize,
    pub root_count: usize,
    /// The new doc epoch after this restore.
    pub epoch: i64,
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

// FLO-698 — read-path instrumentation. `get_state` is the largest
// payload returned to clients (full Y.Doc encoded); per-phase timing
// (lock_acquire / encode / base64) lets a freeze repro point at which
// step blocks. `get_state_vector` and `get_state_hash` get the same
// span treatment for symmetry, with hash-specific phases on the latter.
//
// Inline the equivalent of `store.get_full_state()` here so we can time
// lock acquire and encode separately. A future refactor could push the
// timing into `Store::get_full_state` and emit via tracing::span there;
// keeping it at the handler keeps the diff small per Daddy's "5-line
// copy" + "small focused PR" guidance in the FLO-698 handoff.
//
// Resolution: microseconds. Millisecond truncation (`as_millis()`) loses
// every phase that completes in < 1 ms — for small documents on fast
// hardware, every field would log as `0` and Loki would only ever see
// non-zero values during genuine freezes, hiding the baseline we need
// to compare against. `as_micros() as u64` keeps three orders of
// magnitude more resolution; u64 holds 584,554 years of microseconds
// so saturation is not a concern. (Greptile P2 #293.)
#[tracing::instrument(skip(state), fields(route_family = "sync", handler = "get_state"), err)]
async fn get_state(State(state): State<AppState>) -> Result<Json<StateResponse>, ApiError> {
    let lock_start = Instant::now();
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let lock_acquire_us = lock_start.elapsed().as_micros() as u64;

    let encode_start = Instant::now();
    let update = doc_guard
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    let encode_us = encode_start.elapsed().as_micros() as u64;

    // Read the sync position UNDER the same guard as the encode. Persist-first
    // ordering means persistence MAX(id) can run ahead of the doc; reporting
    // that value with this snapshot would let a client baseline past an update
    // it never received (quirk-audit 2026-07-09, sync cluster).
    let latest_seq = state.store.last_applied_seq();
    let epoch = state.store.doc_epoch();
    drop(doc_guard); // release the read lock before doing base64

    let base64_start = Instant::now();
    let encoded = BASE64.encode(&update);
    let base64_us = base64_start.elapsed().as_micros() as u64;

    tracing::info!(
        lock_acquire_us,
        encode_us,
        base64_us,
        update_bytes = update.len(),
        "get_state phase timing"
    );

    Ok(Json(StateResponse {
        state: encoded,
        latest_seq,
        epoch,
    }))
}

#[tracing::instrument(
    skip(state),
    fields(route_family = "sync", handler = "get_state_vector"),
    err
)]
async fn get_state_vector(
    State(state): State<AppState>,
) -> Result<Json<StateVectorResponse>, ApiError> {
    let total_start = Instant::now();
    let sv = state.store.get_state_vector()?;
    let lock_encode_us = total_start.elapsed().as_micros() as u64;

    let base64_start = Instant::now();
    let encoded = BASE64.encode(&sv);
    let base64_us = base64_start.elapsed().as_micros() as u64;

    tracing::info!(
        lock_encode_us,
        base64_us,
        sv_bytes = sv.len(),
        "get_state_vector phase timing"
    );

    Ok(Json(StateVectorResponse {
        state_vector: encoded,
    }))
}

/// `POST /api/v1/state-diff` — state-vector PULL diff (FLO fast-boot Phase 0).
///
/// Read-only: decodes the client's state vector, encodes only the ops the
/// server has that the client lacks, and reports the sync position of the doc
/// snapshot that diff was taken from.
///
/// **Seq pairing (load-bearing).** `latest_seq` and `epoch` are read under the
/// SAME `doc.read()` guard as the encode — persist-first ordering means the
/// persistence layer's MAX(id) can run ahead of the in-memory doc, so reporting
/// that value alongside this diff would let a client baseline past an update the
/// diff does not contain (quirk-audit 2026-07-09, sync cluster). `get_state`
/// establishes this contract; this handler mirrors it exactly.
#[tracing::instrument(
    skip(state, req),
    fields(route_family = "sync", handler = "get_state_diff"),
    err
)]
async fn get_state_diff(
    State(state): State<AppState>,
    Json(req): Json<StateDiffRequest>,
) -> Result<Json<StateDiffResponse>, ApiError> {
    let sv_bytes = BASE64
        .decode(&req.state_vector)
        .map_err(|e| ApiError::InvalidBase64(e.to_string()))?;
    let client_sv = StateVector::decode_v1(&sv_bytes)
        .map_err(|e| ApiError::InvalidRequest(format!("invalid state vector: {}", e)))?;

    let lock_start = Instant::now();
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let lock_acquire_us = lock_start.elapsed().as_micros() as u64;

    let encode_start = Instant::now();
    let update = doc_guard.transact().encode_state_as_update_v1(&client_sv);
    let encode_us = encode_start.elapsed().as_micros() as u64;

    // Under the same guard as the encode — see the doc comment above.
    let latest_seq = state.store.last_applied_seq();
    let epoch = state.store.doc_epoch();
    drop(doc_guard); // release the read lock before doing base64

    let base64_start = Instant::now();
    let encoded = BASE64.encode(&update);
    let base64_us = base64_start.elapsed().as_micros() as u64;

    tracing::info!(
        lock_acquire_us,
        encode_us,
        base64_us,
        client_sv_bytes = sv_bytes.len(),
        update_bytes = update.len(),
        "get_state_diff phase timing"
    );

    Ok(Json(StateDiffResponse {
        update: encoded,
        latest_seq,
        epoch,
    }))
}

// One lock, one snapshot. Previously the handler took two separate
// transactions: `state.store.get_full_state()` for the encode + hash, then
// a fresh `doc.read()` guard for the block-count traversal. Two
// consequences:
//   1. A concurrent write between the two transactions could make the
//      returned (hash, block_count) pair internally inconsistent —
//      caller's drift detection sees a spurious mismatch (CodeRabbit P1).
//   2. The second `doc.read()` await was being attributed to `count_ms`,
//      so under writer-starvation contention the timing said "block
//      traversal is slow" when the real cost was "second lock contended"
//      (Greptile P2). This was the wrong signal for the freeze diagnostic.
//
// Fix: acquire one read guard, encode + count under it, drop the guard,
// then hash. Both encode_us and count_us now measure pure work without
// any second-lock-acquire blend.
#[tracing::instrument(
    skip(state),
    fields(route_family = "sync", handler = "get_state_hash"),
    err
)]
async fn get_state_hash(
    State(state): State<AppState>,
) -> Result<Json<StateHashResponse>, ApiError> {
    let lock_encode_start = Instant::now();
    let doc = state.store.doc();
    let doc_guard = doc.read().map_err(|_| ApiError::LockPoisoned)?;
    let txn = doc_guard.transact();
    let full_state = txn.encode_state_as_update_v1(&StateVector::default());
    let lock_encode_us = lock_encode_start.elapsed().as_micros() as u64;

    let count_start = Instant::now();
    let block_count = txn
        .get_map("blocks")
        .map(|m| m.len(&txn) as usize)
        .unwrap_or(0);
    let count_us = count_start.elapsed().as_micros() as u64;
    drop(txn); // txn borrows doc_guard — release it before the guard
    drop(doc_guard);

    let hash_start = Instant::now();
    let mut hasher = Sha256::new();
    hasher.update(&full_state);
    let hash = format!("{:x}", hasher.finalize());
    let hash_us = hash_start.elapsed().as_micros() as u64;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    tracing::info!(
        lock_encode_us,
        hash_us,
        count_us,
        block_count,
        full_state_bytes = full_state.len(),
        "get_state_hash phase timing"
    );

    Ok(Json(StateHashResponse {
        hash,
        block_count,
        timestamp,
        epoch: state.store.doc_epoch(),
    }))
}

#[tracing::instrument(
    skip(state, req),
    fields(route_family = "sync", handler = "apply_update"),
    err
)]
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

#[tracing::instrument(
    skip(state, headers, req),
    fields(route_family = "sync", handler = "restore_state"),
    err
)]
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
    let epoch = state.store.doc_epoch();
    let new_state = state.store.get_full_state()?;
    // Epoch-carrying frame: clients MUST hard-reset (adopt, never CRDT-merge,
    // never push their local diff) — a plain update broadcast here was the
    // deleted-content resurrection vector (quirk-audit 2026-07-09).
    state.broadcaster.broadcast_restore(new_state, epoch);

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
        epoch,
    }))
}

#[tracing::instrument(
    skip(state, query),
    fields(route_family = "sync", handler = "get_updates_since"),
    err
)]
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
        epoch: state.store.doc_epoch(),
    }))
}
