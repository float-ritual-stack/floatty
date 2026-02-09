/// Tauri command wrappers for ctx and config services
///
/// Thin adapters that extract state and delegate to services.

use crate::services::ctx;
use crate::{AppState, config::{AggregatorConfig, MarkerCounts}, db::CtxMarker};
use tauri::State;

/// Get ctx:: markers for sidebar display
#[tauri::command]
pub fn get_ctx_markers(
    state: State<AppState>,
    limit: Option<i32>,
    offset: Option<i32>,
) -> Result<Vec<CtxMarker>, String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable: database failed to initialize".to_string())?;

    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);

    ctx::get_markers(&inner.db, limit, offset)
}

/// Get marker counts by status
#[tauri::command]
pub fn get_ctx_counts(state: State<AppState>) -> Result<MarkerCounts, String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable: database failed to initialize".to_string())?;

    ctx::get_counts(&inner.db)
}

/// Clear all ctx:: markers and reset database
#[tauri::command]
pub fn clear_ctx_markers(state: State<AppState>) -> Result<(), String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "ctx:: system unavailable: database failed to initialize".to_string())?;

    ctx::clear_markers(&inner.db)
}

/// Get current configuration
#[tauri::command]
pub fn get_ctx_config() -> AggregatorConfig {
    ctx::get_config()
}

/// Update configuration (requires restart to take effect)
#[tauri::command]
pub fn set_ctx_config(config: AggregatorConfig) -> Result<(), String> {
    ctx::set_config(config)
}

/// Get current theme name
#[tauri::command]
pub fn get_theme() -> String {
    ctx::get_theme()
}

/// Set theme name (persists to config.toml)
#[tauri::command]
pub fn set_theme(theme: String) -> Result<(), String> {
    ctx::set_theme(theme)
}

/// Get the configured model for /send conversations
/// Returns send_model if set, otherwise ollama_model
#[tauri::command]
pub fn get_send_model() -> String {
    let config = ctx::get_config();
    config.get_send_model().to_string()
}

/// Toggle diagnostics strip visibility (port, build type, config path)
/// Returns the new value after toggle
#[tauri::command]
pub fn toggle_diagnostics() -> Result<bool, String> {
    ctx::toggle_diagnostics()
}
