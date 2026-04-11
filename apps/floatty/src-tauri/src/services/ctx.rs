/// Context aggregator and configuration services
///
/// Pure business logic for ctx:: markers and app configuration.
/// Testable without Tauri runtime.

use crate::config::{AggregatorConfig, MarkerCounts};
use crate::db::{CtxMarker, FloattyDb};
use std::path::Path;
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
pub fn get_config(config_path: &Path) -> AggregatorConfig {
    AggregatorConfig::load_from(config_path)
}

/// Update configuration (requires restart to take effect)
pub fn set_config(config: AggregatorConfig, config_path: &Path) -> Result<(), String> {
    config.save_to(config_path)
}

/// Get current theme name
pub fn get_theme(config_path: &Path) -> String {
    AggregatorConfig::load_from(config_path).theme
}

/// Set theme name (persists to config.toml)
pub fn set_theme(theme: String, config_path: &Path) -> Result<(), String> {
    let mut config = AggregatorConfig::load_from(config_path);
    config.theme = theme;
    config.save_to(config_path)
}

/// Toggle show_diagnostics flag and persist
pub fn toggle_diagnostics(config_path: &Path) -> Result<bool, String> {
    let mut config = AggregatorConfig::load_from(config_path);
    config.show_diagnostics = !config.show_diagnostics;
    let new_value = config.show_diagnostics;
    config.save_to(config_path)?;
    Ok(new_value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_config_loads_default() {
        let dir = tempfile::TempDir::new().unwrap();
        let fake_path = dir.path().join("config.toml");
        let config = get_config(&fake_path);
        assert!(!config.ollama_model.is_empty());
    }

    #[test]
    fn test_theme_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        let config_path = dir.path().join("config.toml");

        let mut config = AggregatorConfig::default();
        config.theme = "test-theme".to_string();
        config.save_to(&config_path).unwrap();

        let loaded = get_config(&config_path);
        assert_eq!(loaded.theme, "test-theme");
    }
}
