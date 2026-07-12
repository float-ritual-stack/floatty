/// Tauri command wrapper for the recent-files service (FLO-799)
///
/// Thin adapter: extract state, delegate to the service.
use crate::services::files;
use crate::{db::FileEvent, AppState};
use tauri::State;

/// Recent agent-written files for the sidebar (newest first, one per path).
#[tauri::command]
pub fn get_recent_files(
    state: State<AppState>,
    limit: Option<i32>,
) -> Result<Vec<FileEvent>, String> {
    let inner = state
        .inner
        .as_ref()
        .ok_or_else(|| "ctx:: system unavailable: database failed to initialize".to_string())?;

    let limit = limit.unwrap_or(files::DEFAULT_RECENT_FILES_LIMIT);

    files::get_recent_files(&inner.db, limit)
}
