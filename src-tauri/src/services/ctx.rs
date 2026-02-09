/// Context aggregator and configuration services
///
/// Pure business logic for ctx:: markers and app configuration.
/// Testable without Tauri runtime.

use crate::config::{AggregatorConfig, MarkerCounts};
use crate::db::{CtxMarker, FloattyDb};
use std::sync::Arc;

/// Get ctx:: markers for sidebar display
///
/// # Arguments
/// * `db` - Database handle
/// * `limit` - Maximum number of markers to return
/// * `offset` - Offset for pagination
pub fn get_markers(
    db: &Arc<FloattyDb>,
    limit: i32,
    offset: i32,
) -> Result<Vec<CtxMarker>, String> {
    db.get_all(limit, offset).map_err(|e| e.to_string())
}

/// Get marker counts by status (pending, parsed, error)
pub fn get_counts(db: &Arc<FloattyDb>) -> Result<MarkerCounts, String> {
    let (pending, parsed, error) = db.get_counts().map_err(|e| e.to_string())?;
    Ok(MarkerCounts {
        pending,
        parsed,
        error,
        total: pending + parsed + error,
    })
}

/// Clear all ctx:: markers and reset database
pub fn clear_markers(db: &Arc<FloattyDb>) -> Result<(), String> {
    db.clear_all().map_err(|e| e.to_string())
}

/// Get current configuration
pub fn get_config() -> AggregatorConfig {
    AggregatorConfig::load()
}

/// Update configuration (requires restart to take effect)
pub fn set_config(config: AggregatorConfig) -> Result<(), String> {
    config.save()
}

/// Get current theme name
pub fn get_theme() -> String {
    AggregatorConfig::load().theme
}

/// Set theme name (persists to config.toml)
pub fn set_theme(theme: String) -> Result<(), String> {
    let mut config = AggregatorConfig::load();
    config.theme = theme;
    config.save()
}

/// Toggle show_diagnostics flag and persist
pub fn toggle_diagnostics() -> Result<bool, String> {
    let mut config = AggregatorConfig::load();
    config.show_diagnostics = !config.show_diagnostics;
    let new_value = config.show_diagnostics;
    config.save()?;
    Ok(new_value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_config_loads_default() {
        let config = get_config();
        // Should not panic, returns default if config doesn't exist
        assert!(!config.ollama_model.is_empty());
    }

    #[test]
    fn test_theme_round_trip() {
        let original = get_theme();
        
        // Set a test theme
        set_theme("test-theme".to_string()).ok();
        assert_eq!(get_theme(), "test-theme");
        
        // Restore original
        set_theme(original.clone()).ok();
        assert_eq!(get_theme(), original);
    }
}
