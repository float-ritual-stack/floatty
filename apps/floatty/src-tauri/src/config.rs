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

/// Server info returned to frontend for HTTP client initialization
///
/// NOTE: `api_key` is snake_case on the wire — it predates the camelCase
/// convention and several TS consumers read `serverInfo.api_key`. Don't "fix"
/// the casing without migrating them (same caveat as `RestoreResponse` in
/// `floatty-server/src/api/sync.rs`).
#[derive(Clone, Serialize)]
pub struct ServerInfo {
    pub url: String,
    pub api_key: String,
}

/// How this app's backing floatty-server resolved at startup (fast-boot Phase 0).
///
/// The old shape collapsed every failure into `ServerState = None`, which the
/// frontend read as the single string `"Server not running"`. That conflates two
/// materially different worlds:
///
/// - `remote_configured: false, reachable: false` — no remote is configured and
///   the local subprocess failed to spawn. Genuinely broken; there is nothing to
///   wait for.
/// - `remote_configured: true, reachable: false` — `remote_server_url` IS set
///   (FLO-762 thin-client mode) and float-box is simply down. The outline still
///   exists; the app is offline, not broken.
/// - `remote_configured: true, reachable: true, auth_failed: true` — the remote
///   answered its health probe but the local API key is missing or was
///   rejected. Misconfiguration, NOT an outage: waiting won't fix it, and a
///   cache-boot on top of a live-but-unauthorized remote would fork the
///   outline.
///
/// Only remote-down is recoverable by waiting, and only remote-down can legally
/// boot from the local cache. Phase 2's offline mode branches on exactly this
/// distinction, so the distinction has to survive the IPC boundary.
///
/// Readable via `get_server_status`, which — unlike `get_server_info` — returns
/// `Ok` even when there is no server. That is the whole point: the frontend owns
/// the offline decision because the frontend is what holds the cache.
///
/// The split-brain guard is untouched: an unreachable remote NEVER falls back to
/// a local spawn.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// `remote_server_url` is set in config.toml — this app is a thin client
    /// against a remote authority, not the owner of a local subprocess.
    pub remote_configured: bool,
    /// The server backing this app answered its startup probe.
    pub reachable: bool,
    /// The remote answered but authentication failed (no local key, or the
    /// key was rejected). Config problem — never the recoverable-offline case.
    pub auth_failed: bool,
}

/// Aggregator configuration (stored/loaded from ~/.floatty/config.toml)
#[derive(Clone, Serialize, Deserialize)]
pub struct AggregatorConfig {
    pub watch_path: String,
    pub ollama_endpoint: String,
    /// Default Ollama model (fallback for ctx_model)
    pub ollama_model: String,
    /// Model for ctx:: sidebar parsing (defaults to ollama_model if unset)
    #[serde(default)]
    pub ctx_model: Option<String>,
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
    /// Remote floatty-server URL (e.g., "http://float-box:8765"). When set, the
    /// app connects to this server instead of spawning a local subprocess, and
    /// `server_port` is ignored. The local `[server].api_key` must match the
    /// remote server's key. Unreachable remote = startup error, NOT a silent
    /// local spawn (avoids split-brain where edits land in a local outline
    /// while the user believes they're on the shared one). FLO-762.
    #[serde(default)]
    pub remote_server_url: Option<String>,
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
    /// Opacity of unfocused panes (0.0–1.0, default 0.7). Set to 1.0 to disable dimming.
    #[serde(default = "default_unfocused_pane_opacity")]
    pub unfocused_pane_opacity: f32,
    /// Max children to render per block (0 = no limit, renders all children).
    /// With expansion policy keeping children collapsed, rendering all is lightweight.
    #[serde(default)]
    pub child_render_limit: u32,
    /// Per-door plugin settings (e.g., [plugins.daily] notes_dir = "...")
    #[serde(default)]
    pub plugins: std::collections::HashMap<String, toml::Value>,
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

fn default_unfocused_pane_opacity() -> f32 {
    0.4
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
            ctx_model: None, // Falls back to ollama_model
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
            remote_server_url: None,
            split_collapse_depth: default_split_collapse_depth(),
            initial_collapse_depth: default_initial_collapse_depth(),
            show_diagnostics: default_show_diagnostics(),
            unfocused_pane_opacity: default_unfocused_pane_opacity(),
            child_render_limit: 0,
            plugins: std::collections::HashMap::new(),
            is_dev_build: cfg!(debug_assertions),
            data_dir: String::new(), // Populated by load_from
        }
    }
}

impl AggregatorConfig {
    /// Load config from specified path. A MISSING file falls back to defaults
    /// (legitimate first launch); an EXISTING file that cannot be read or
    /// parsed is fatal.
    ///
    /// Why fatal: defaults have no `remote_server_url`, so "warn + defaults"
    /// silently dropped remote-authority mode and booted a local spawn against
    /// a DIFFERENT outline — the exact split-brain the `resolve_server` guard
    /// exists to prevent, entered through the front door. It has happened once
    /// (config.toml carries a "Restored 2026-06-24" comment from the incident).
    /// Boot-sequence audit §3.6 / R6.
    ///
    /// Use `DataPaths::resolve().config` to get the path based on
    /// `FLOATTY_DATA_DIR` environment variable.
    pub fn load_from(path: &std::path::Path) -> Self {
        let mut config = if path.exists() {
            match std::fs::read_to_string(path) {
                Ok(contents) => match toml::from_str::<AggregatorConfig>(&contents) {
                    Ok(config) => {
                        log::info!("Loaded config from {:?}", path);
                        config
                    }
                    Err(e) => {
                        panic!(
                            "config.toml at {:?} is invalid TOML: {} — refusing to boot with \
                             defaults, which would drop remote_server_url and silently open a \
                             DIFFERENT outline (split-brain). Fix or delete the file.",
                            path, e
                        );
                    }
                },
                Err(e) => {
                    panic!(
                        "config.toml at {:?} exists but cannot be read: {} — refusing to boot \
                         with defaults (split-brain risk). Check permissions.",
                        path, e
                    );
                }
            }
        } else {
            log::info!("No config file at {:?}, using defaults", path);
            Self::default()
        };

        // Populate runtime-only fields (skipped by serde)
        config.is_dev_build = cfg!(debug_assertions);
        config.data_dir = path
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        config
    }

    /// Save current config to specified path.
    /// Preserves unknown sections (like [server]) that other processes may have written.
    pub fn save_to(&self, path: &std::path::Path) -> Result<(), String> {
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
        let self_str =
            toml::to_string(self).map_err(|e| format!("Failed to serialize config: {}", e))?;
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

    /// Get the model for ctx:: sidebar parsing.
    /// Falls back to ollama_model if ctx_model is unset or empty.
    pub fn get_ctx_model(&self) -> &str {
        self.ctx_model
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_config_file_falls_back_to_defaults() {
        // First launch: no file is legitimate, not an error.
        let dir = tempfile::tempdir().unwrap();
        let config = AggregatorConfig::load_from(&dir.path().join("config.toml"));
        assert_eq!(
            config.workspace_name,
            AggregatorConfig::default().workspace_name
        );
    }

    #[test]
    #[should_panic(expected = "invalid TOML")]
    fn malformed_config_file_is_fatal_not_defaults() {
        // R6 (boot-sequence audit §3.6): "warn + defaults" on a parse error
        // silently dropped remote_server_url and booted a local spawn against
        // a DIFFERENT outline — the split-brain the resolve_server guard
        // exists to prevent, entered through the front door.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "workspace_name = [this is not toml").unwrap();
        let _ = AggregatorConfig::load_from(&path);
    }
}
