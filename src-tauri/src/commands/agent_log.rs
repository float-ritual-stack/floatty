/// Tauri command wrappers for agent activity log
///
/// Thin adapters that extract state and delegate to services.

use crate::services::agent_log;
use crate::AppState;
use crate::db::AgentActivityEntry;
use tauri::State;

/// Log an agent activity entry (called from frontend agent enrichment projection)
#[tauri::command]
pub fn log_agent_activity(
    state: State<AppState>,
    id: String,
    timestamp: i64,
    block_id: String,
    action: String,
    added_markers: Option<String>,
    reason: Option<String>,
) -> Result<(), String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "Agent log unavailable: database failed to initialize".to_string())?;

    agent_log::log_activity(
        &inner.db,
        &id,
        timestamp,
        &block_id,
        &action,
        added_markers.as_deref(),
        reason.as_deref(),
        72, // max_age_hours — matches ctx:: config pattern
    )
}

/// Get recent agent activity log entries for sidebar display
#[tauri::command]
pub fn get_agent_log(
    state: State<AppState>,
    limit: Option<i32>,
) -> Result<Vec<AgentActivityEntry>, String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "Agent log unavailable: database failed to initialize".to_string())?;

    agent_log::get_activity(&inner.db, limit.unwrap_or(50))
}

/// Clear all agent activity log entries
#[tauri::command]
pub fn clear_agent_log(state: State<AppState>) -> Result<(), String> {
    let inner = state.inner.as_ref()
        .ok_or_else(|| "Agent log unavailable: database failed to initialize".to_string())?;

    agent_log::clear_activity(&inner.db)
}
