//! Backup handlers — status, list, trigger, restore, config.

use axum::{
    extract::State,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use yrs::{Array, ReadTxn, Transact};

use super::{ApiError, AppState, RestoreResponse};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/backup/status", get(backup_status))
        .route("/api/v1/backup/list", get(backup_list))
        .route("/api/v1/backup/trigger", post(backup_trigger))
        .route("/api/v1/backup/restore", post(backup_restore))
        .route("/api/v1/backup/config", get(backup_config))
}

// ============================================================================
// DTOs
// ============================================================================

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFileInfo {
    pub filename: String,
    pub size_bytes: u64,
    pub created: String,
}

#[derive(Serialize)]
pub struct BackupListResponse {
    pub backups: Vec<BackupFileInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTriggerResponse {
    pub filename: String,
    pub size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackupRestoreRequest {
    pub filename: String,
}

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

// ============================================================================
// Handlers
// ============================================================================

fn format_system_time(t: SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    DateTime::from_timestamp(secs as i64, 0)
        .map(|dt: DateTime<Utc>| dt.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

async fn backup_status(
    State(state): State<AppState>,
) -> Result<Json<BackupStatusResponse>, ApiError> {
    let daemon = state
        .backup_daemon
        .as_ref()
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

async fn backup_list(
    State(state): State<AppState>,
) -> Result<Json<BackupListResponse>, ApiError> {
    let daemon = state
        .backup_daemon
        .as_ref()
        .ok_or_else(|| ApiError::Search("Backups not enabled".to_string()))?;

    let backups = daemon
        .list_backups()
        .map_err(|e| ApiError::Search(format!("Failed to list backups: {}", e)))?;

    let files: Vec<BackupFileInfo> = backups
        .into_iter()
        .map(|b| BackupFileInfo {
            filename: b.filename,
            size_bytes: b.size_bytes,
            created: format_system_time(b.created),
        })
        .collect();

    Ok(Json(BackupListResponse { backups: files }))
}

#[tracing::instrument(skip(state), fields(route_family = "backup", handler = "backup_trigger"), err)]
async fn backup_trigger(
    State(state): State<AppState>,
) -> Result<Json<BackupTriggerResponse>, ApiError> {
    let daemon = state
        .backup_daemon
        .as_ref()
        .ok_or_else(|| ApiError::Search("Backups not enabled".to_string()))?;

    let info = daemon
        .trigger_backup()
        .await
        .map_err(|e| ApiError::Search(e))?;

    Ok(Json(BackupTriggerResponse {
        filename: info.filename,
        size_bytes: info.size_bytes,
    }))
}

#[tracing::instrument(skip(state, headers, req), fields(route_family = "backup", handler = "backup_restore"), err)]
async fn backup_restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<BackupRestoreRequest>,
) -> Result<Json<RestoreResponse>, ApiError> {
    let confirmed = headers
        .get("x-floatty-confirm-destructive")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if !confirmed {
        return Err(ApiError::MissingConfirmationHeader);
    }

    let daemon = state
        .backup_daemon
        .as_ref()
        .ok_or_else(|| ApiError::Search("Backups not enabled".to_string()))?;

    let backups = daemon
        .list_backups()
        .map_err(|e| ApiError::Search(format!("Failed to list backups: {}", e)))?;

    let backup = backups
        .iter()
        .find(|b| b.filename == req.filename)
        .ok_or_else(|| ApiError::NotFound(format!("Backup not found: {}", req.filename)))?;

    let state_bytes = tokio::fs::read(&backup.path)
        .await
        .map_err(|e| ApiError::Search(format!("Failed to read backup: {}", e)))?;

    if let Err(e) = state.hook_system.clear_search_index().await {
        tracing::warn!("Failed to clear search index before restore: {}", e);
    }

    let block_count = state.store.reset_from_state(&state_bytes)?;

    let new_state = state.store.get_full_state()?;
    state.broadcaster.broadcast(new_state, None, None);

    let rehydrated = state.hook_system.rehydrate_all_blocks(&state.store);
    tracing::info!("Rehydrated {} blocks after backup restore", rehydrated);

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

    Ok(Json(RestoreResponse {
        block_count,
        root_count,
    }))
}

async fn backup_config(
    State(state): State<AppState>,
) -> Result<Json<BackupConfigResponse>, ApiError> {
    let daemon = state
        .backup_daemon
        .as_ref()
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
