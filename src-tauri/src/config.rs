//! Application configuration types and persistence.
//!
//! This module contains the main configuration structures for floatty,
//! including server info and user-configurable aggregator settings.

use crate::ctx_parser::ParserConfig;
use crate::ctx_watcher::WatcherConfig;
use serde::{Deserialize, Serialize};

/// Default Ollama model used for ctx:: marker parsing.
/// Shared between AggregatorConfig (user-facing) and ParserConfig (internal).
pub const DEFAULT_OLLAMA_MODEL: &str = "qwen2.5:7b";
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
    /// Default Ollama model (fallback for ctx_model and send_model)
    pub ollama_model: String,
    /// Model for ctx:: sidebar parsing (defaults to ollama_model if unset)
    #[serde(default)]
    pub ctx_model: Option<String>,
    /// Model for /send conversations (defaults to ollama_model if unset)
    #[serde(default)]
    pub send_model: Option<String>,
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
    /// Workspace name for title bar display (default: "default")
    #[serde(default = "default_workspace_name")]
    pub workspace_name: String,
    /// Server port (default: 8765)
    #[serde(default = "default_server_port")]
    pub server_port: u16,
    /// Collapse depth when splitting outliner panes (0 = disabled; recommended 2)
    /// Higher numbers show more levels: 1 = roots only, 2 = roots + children, etc.
    #[serde(default = "default_split_collapse_depth")]
    pub split_collapse_depth: u32,
    /// Collapse depth on initial app load (0 = disabled, 2 = recommended for large outlines)
    /// Applies to all panes on first mount. Helps with 1000+ block outlines.
    #[serde(default = "default_initial_collapse_depth")]
    pub initial_collapse_depth: u32,
    /// Show diagnostics strip in status bar (port, build type, config path).
    /// Defaults to true in debug builds, false in release builds.
    #[serde(default = "default_show_diagnostics", alias = "dev_mode_visuals")]
    pub show_diagnostics: bool,
    /// Whether this is a dev (debug) build. Populated at load time, not stored in TOML.
    #[serde(skip_deserializing, default)]
    pub is_dev_build: bool,
    /// Resolved data directory path. Populated at load time, not stored in TOML.
    #[serde(skip_deserializing, default)]
    pub data_dir: String,
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

fn default_workspace_name() -> String {
    "default".to_string()
}

fn default_server_port() -> u16 {
    // Build profile determines port - prevents accidental cross-talk
    #[cfg(debug_assertions)]
    {
        33333 // Dev builds
    }

    #[cfg(not(debug_assertions))]
    {
        8765 // Release builds
    }
}

fn default_split_collapse_depth() -> u32 {
    0 // Disabled by default (clone exact expansion state)
}

fn default_initial_collapse_depth() -> u32 {
    0 // Disabled by default (show all expanded)
}

fn default_show_diagnostics() -> bool {
    cfg!(debug_assertions)
}

impl Default for AggregatorConfig {
    fn default() -> Self {
        let default_watcher = WatcherConfig::default();
        let default_parser = ParserConfig::default();

        Self {
            watch_path: default_watcher.watch_path.to_string_lossy().to_string(),
            ollama_endpoint: "http://localhost:11434".to_string(),
            ollama_model: DEFAULT_OLLAMA_MODEL.to_string(),
            ctx_model: None,  // Falls back to ollama_model
            send_model: None, // Falls back to ollama_model
            poll_interval_ms: default_parser.poll_interval_ms,
            max_retries: default_parser.max_retries,
            max_age_hours: 72, // Default: last 3 days (matches CLAUDE.md docs)
            theme: default_theme(),
            font_size: default_font_size(),
            font_weight: default_font_weight(),
            font_weight_bold: default_font_weight_bold(),
            line_height: default_line_height(),
            max_shell_output_bytes: default_max_shell_output(),
            workspace_name: default_workspace_name(),
            server_port: default_server_port(),
            split_collapse_depth: default_split_collapse_depth(),
            initial_collapse_depth: default_initial_collapse_depth(),
            show_diagnostics: default_show_diagnostics(),
            is_dev_build: cfg!(debug_assertions),
            data_dir: String::new(), // Populated by load_from
        }
    }
}

impl AggregatorConfig {
    /// Load config from specified path, falling back to defaults.
    ///
    /// Use `DataPaths::resolve().config` to get the path based on
    /// `FLOATTY_DATA_DIR` environment variable.
    pub fn load_from(path: &PathBuf) -> Self {
        let mut config = if path.exists() {
            match std::fs::read_to_string(path) {
                Ok(contents) => {
                    match toml::from_str::<AggregatorConfig>(&contents) {
                        Ok(config) => {
                            log::info!("Loaded config from {:?}", path);
                            config
                        }
                        Err(e) => {
                            log::warn!("Failed to parse config: {}, using defaults", e);
                            Self::default()
                        }
                    }
                }
                Err(e) => {
                    log::warn!("Failed to read config file: {}, using defaults", e);
                    Self::default()
                }
            }
        } else {
            log::info!("No config file at {:?}, using defaults", path);
            Self::default()
        };

        // Populate runtime-only fields (skipped by serde)
        config.is_dev_build = cfg!(debug_assertions);
        config.data_dir = path.parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        config
    }

    /// Load config from default path (~/.floatty/config.toml).
    ///
    /// Deprecated: prefer `load_from(paths.config)` for explicit path control.
    pub fn load() -> Self {
        let path = Self::default_config_path();
        Self::load_from(&path)
    }

    /// Default config file path.
    ///
    /// Uses `FLOATTY_DATA_DIR` if set, otherwise `~/.floatty`.
    pub fn default_config_path() -> PathBuf {
        std::env::var("FLOATTY_DATA_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".floatty")
            })
            .join("config.toml")
    }

    /// Save current config to specified path.
    /// Preserves unknown sections (like [server]) that other processes may have written.
    pub fn save_to(&self, path: &PathBuf) -> Result<(), String> {
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        // Read existing config to preserve unknown sections (like [server].api_key)
        let mut doc: toml::Table = if path.exists() {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_default()
        } else {
            toml::Table::new()
        };

        // Merge our fields into the existing doc
        let self_str = toml::to_string(self)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        let self_table: toml::Table = self_str
            .parse()
            .map_err(|e| format!("Failed to parse serialized config: {}", e))?;

        // Runtime-only fields (skip_deserializing) should not be persisted to TOML
        const RUNTIME_ONLY_KEYS: &[&str] = &["is_dev_build", "data_dir"];

        for (key, value) in self_table {
            if RUNTIME_ONLY_KEYS.contains(&key.as_str()) {
                continue;
            }
            doc.insert(key, value);
        }

        let contents = toml::to_string_pretty(&doc).map_err(|e| e.to_string())?;
        std::fs::write(path, contents).map_err(|e| e.to_string())?;

        log::info!("Saved config to {:?}", path);
        Ok(())
    }

    /// Save current config to default path.
    ///
    /// Deprecated: prefer `save_to(paths.config)` for explicit path control.
    pub fn save(&self) -> Result<(), String> {
        self.save_to(&Self::default_config_path())
    }

    /// Get the model for ctx:: sidebar parsing.
    /// Falls back to ollama_model if ctx_model is unset or empty.
    pub fn get_ctx_model(&self) -> &str {
        self.ctx_model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.ollama_model)
    }

    /// Get the model for /send conversations.
    /// Falls back to ollama_model if send_model is unset or empty.
    pub fn get_send_model(&self) -> &str {
        self.send_model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.ollama_model)
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
