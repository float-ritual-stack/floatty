/// Tauri command wrappers for workspace services
///
/// Thin adapters that extract state and delegate to services.
use crate::db::WorkspaceStateRecord;
use crate::services::workspace;
use crate::AppState;
use tauri::State;

/// Get persisted workspace layout state (JSON blob)
#[tauri::command]
pub fn get_workspace_state(
    state: State<AppState>,
    key: String,
) -> Result<Option<WorkspaceStateRecord>, String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "Workspace system unavailable: database not initialized".to_string())?;

    workspace::get_state(&inner.db, &key)
}

/// Save workspace layout state (JSON blob).
/// Returns `true` if the write was accepted, `false` if rejected as stale.
#[tauri::command]
pub fn save_workspace_state(
    state: State<AppState>,
    key: String,
    state_json: String,
    save_seq: i64,
) -> Result<bool, String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "Workspace system unavailable: database not initialized".to_string())?;

    workspace::set_state(&inner.db, &key, &state_json, save_seq)
}

/// List all workspace state keys (FLO-83: layout presets are `layout:<name>` rows)
#[tauri::command]
pub fn list_workspace_states(state: State<AppState>) -> Result<Vec<String>, String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "Workspace system unavailable: database not initialized".to_string())?;

    workspace::list_state_keys(&inner.db)
}

/// Delete a workspace state row by key. Returns true if a row was deleted.
#[tauri::command]
pub fn delete_workspace_state(state: State<AppState>, key: String) -> Result<bool, String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "Workspace system unavailable: database not initialized".to_string())?;

    workspace::delete_state(&inner.db, &key)
}

/// Clear the entire workspace (blocks and rootIds) efficiently
#[tauri::command]
pub fn clear_workspace(state: State<AppState>) -> Result<(), String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "Workspace system unavailable: database not initialized".to_string())?;

    // Local-mode only: in remote-authority mode this command used to wipe the
    // LOCAL shadow store while the remote authority kept the real outline —
    // silently targeting the wrong doc (boot-sequence audit §3.4).
    let store = inner.store.as_ref().ok_or_else(|| {
        "clear_workspace targets the local Y.Doc store; in remote-authority mode the \
         outline lives on the remote server — refusing to clear the wrong doc"
            .to_string()
    })?;

    workspace::clear(store)
}
