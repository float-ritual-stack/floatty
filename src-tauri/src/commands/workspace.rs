/// Tauri command wrappers for workspace services
///
/// Thin adapters that extract state and delegate to services.

use crate::services::workspace;
use crate::AppState;
use tauri::State;

/// Get persisted workspace layout state (JSON blob)
#[tauri::command]
pub fn get_workspace_state(
    state: State<AppState>,
    key: String,
) -> Result<Option<String>, String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "ctx:: system unavailable".to_string())?;

    workspace::get_state(&inner.db, &key)
}

/// Save workspace layout state (JSON blob)
#[tauri::command]
pub fn save_workspace_state(
    state: State<AppState>,
    key: String,
    state_json: String,
) -> Result<(), String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "ctx:: system unavailable".to_string())?;

    workspace::set_state(&inner.db, &key, &state_json)
}

/// Clear the entire workspace (blocks and rootIds) efficiently
#[tauri::command]
pub fn clear_workspace(state: State<AppState>) -> Result<(), String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "ctx:: system unavailable".to_string())?;

    workspace::clear(&inner.store)
}
