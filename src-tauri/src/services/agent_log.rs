/// Agent activity log service
///
/// Pure business logic for agent activity log CRUD.
/// Testable without Tauri runtime.

use crate::db::{AgentActivityEntry, FloattyDb};
use std::sync::Arc;

/// Insert an agent activity entry with auto-pruning.
pub fn log_activity(
    db: &Arc<FloattyDb>,
    id: &str,
    timestamp: i64,
    block_id: &str,
    action: &str,
    added_markers: Option<&str>,
    reason: Option<&str>,
    max_age_hours: i64,
) -> Result<(), String> {
    db.insert_agent_activity(id, timestamp, block_id, action, added_markers, reason, max_age_hours)
        .map_err(|e| e.to_string())
}

/// Get recent agent activity log entries for display.
pub fn get_activity(
    db: &Arc<FloattyDb>,
    limit: i32,
) -> Result<Vec<AgentActivityEntry>, String> {
    db.get_agent_activity(limit).map_err(|e| e.to_string())
}

/// Clear all agent activity log entries.
pub fn clear_activity(db: &Arc<FloattyDb>) -> Result<(), String> {
    db.clear_agent_activity().map_err(|e| e.to_string())
}
