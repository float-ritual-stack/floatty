//! Application configuration types and persistence.
//!
//! This module contains the main configuration structures for floatty,
//! including server info and user-configurable aggregator settings.

use crate::ctx_parser::ParserConfig;
use crate::ctx_watcher::WatcherConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Server info returned to frontend for HTTP client initialization
#[derive(Clone, Serialize)]
pub struct ServerInfo {
    pub url: String,
    pub api_key: String,
}

/// Aggregator configuration (stored/loaded from ~/.floatty/config.toml)
#[derive(Clone, Serialize, Deserialize)]
pub struct AggregatorConfig {
    pub watch_path: String,
    pub ollama_endpoint: String,
    pub ollama_model: String,
    pub poll_interval_ms: u64,
    pub max_retries: i32,
    pub max_age_hours: u64,
    /// UI theme name (default, dracula, nord, etc.)
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Terminal font size in pixels
    #[serde(default = "default_font_size")]
    pub font_size: u32,
    /// Terminal font weight (300 = light, 400 = normal, 500 = medium)
    #[serde(default = "default_font_weight")]
    pub font_weight: u32,
    /// Terminal bold font weight
    #[serde(default = "default_font_weight_bold")]
    pub font_weight_bold: u32,
    /// Terminal line height multiplier
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    /// Max bytes for sh:: block output before truncation (default 64KB)
    #[serde(default = "default_max_shell_output")]
    pub max_shell_output_bytes: usize,
}

fn default_theme() -> String {
    "default".to_string()
}

fn default_font_size() -> u32 {
    13
}

fn default_font_weight() -> u32 {
    300
}

fn default_font_weight_bold() -> u32 {
    500
}

fn default_line_height() -> f32 {
    1.2
}

fn default_max_shell_output() -> usize {
    65536 // 64KB
}

impl Default for AggregatorConfig {
    fn default() -> Self {
        let default_watcher = WatcherConfig::default();
        let default_parser = ParserConfig::default();

        Self {
            watch_path: default_watcher.watch_path.to_string_lossy().to_string(),
            ollama_endpoint: "http://localhost:11434".to_string(),
            ollama_model: "llama3.2:latest".to_string(),
            poll_interval_ms: default_parser.poll_interval_ms,
            max_retries: default_parser.max_retries,
            max_age_hours: 72, // Default: last 3 days (matches CLAUDE.md docs)
            theme: default_theme(),
            font_size: default_font_size(),
            font_weight: default_font_weight(),
            font_weight_bold: default_font_weight_bold(),
            line_height: default_line_height(),
            max_shell_output_bytes: default_max_shell_output(),
        }
    }
}

impl AggregatorConfig {
    /// Config file path: ~/.floatty/config.toml
    fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".floatty")
            .join("config.toml")
    }

    /// Load config from file, falling back to defaults
    pub fn load() -> Self {
        let path = Self::config_path();

        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(contents) => {
                    match toml::from_str::<AggregatorConfig>(&contents) {
                        Ok(config) => {
                            log::info!("Loaded config from {:?}", path);
                            return config;
                        }
                        Err(e) => {
                            log::warn!("Failed to parse config: {}, using defaults", e);
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to read config file: {}, using defaults", e);
                }
            }
        } else {
            log::info!("No config file at {:?}, using defaults", path);
        }

        Self::default()
    }

    /// Save current config to file
    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let contents = toml::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, contents).map_err(|e| e.to_string())?;

        log::info!("Saved config to {:?}", path);
        Ok(())
    }
}

/// Status counts for sidebar
#[derive(Serialize)]
pub struct MarkerCounts {
    pub pending: i32,
    pub parsed: i32,
    pub error: i32,
    pub total: i32,
}
