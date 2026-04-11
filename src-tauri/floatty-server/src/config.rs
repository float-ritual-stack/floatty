//! Server configuration loaded from config.toml.
//!
//! Config path is determined by:
//! 1. `FLOATTY_DATA_DIR` environment variable (if set) → `{FLOATTY_DATA_DIR}/config.toml`
//! 2. Default: `~/.floatty/config.toml`

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Default port for the floatty-server (release builds)
pub const DEFAULT_PORT: u16 = 8765;

/// Default port for dev builds (visually distinct for log scanning)
pub const DEV_PORT: u16 = 33333;

/// Re-export canonical data_dir from floatty-core (FLO-317 consolidation).
pub use floatty_core::data_dir;

/// Server configuration section from config.toml
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Enable/disable the server
    #[serde(default = "default_enabled")]
    pub enabled: bool,

    /// Port to listen on
    #[serde(default = "default_port")]
    pub port: u16,

    /// API key for authentication (required when auth_enabled=true)
    pub api_key: Option<String>,

    /// Bind address (default: 127.0.0.1 for local only)
    #[serde(default = "default_bind")]
    pub bind: String,

    /// Enable API key authentication (default: true)
    #[serde(default = "default_auth_enabled")]
    pub auth_enabled: bool,

    /// OTLP log export endpoint (e.g., `http://127.0.0.1:3100/otlp/v1/logs`
    /// for a local Loki instance, or any OTLP HTTP collector).
    ///
    /// When set, floatty-server ships logs to this OTLP HTTP collector in addition
    /// to writing them to the local JSONL file. Leave unset (or commented out) to
    /// disable OTLP export — floatty still works fine offline, the file is always
    /// the source of truth.
    ///
    /// Env var overrides (first match wins): `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`,
    /// `OTEL_EXPORTER_OTLP_ENDPOINT`, then this config field.
    #[serde(default)]
    pub otlp_endpoint: Option<String>,
}

fn default_enabled() -> bool {
    true
}

fn default_port() -> u16 {
    // Build profile determines port - prevents accidental cross-talk
    #[cfg(debug_assertions)]
    {
        DEV_PORT // 33333
    }

    #[cfg(not(debug_assertions))]
    {
        DEFAULT_PORT // 8765
    }
}

fn default_bind() -> String {
    "127.0.0.1".to_string()
}

fn default_auth_enabled() -> bool {
    true
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            port: default_port(),
            api_key: None,
            bind: default_bind(),
            auth_enabled: default_auth_enabled(),
            otlp_endpoint: None,
        }
    }
}

/// Backup daemon configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupConfig {
    /// Enable/disable automated backups (default: true)
    #[serde(default = "default_backup_enabled")]
    pub enabled: bool,

    /// Backup interval in hours (default: 1)
    #[serde(default = "default_backup_interval_hours")]
    pub interval_hours: u64,

    /// Hours to keep hourly backups (default: 24)
    #[serde(default = "default_backup_retain_hourly")]
    pub retain_hourly: u32,

    /// Days to keep daily backups (default: 7)
    #[serde(default = "default_backup_retain_daily")]
    pub retain_daily: u32,

    /// Weeks to keep weekly backups (default: 4)
    #[serde(default = "default_backup_retain_weekly")]
    pub retain_weekly: u32,
}

fn default_backup_enabled() -> bool {
    true
}

fn default_backup_interval_hours() -> u64 {
    1
}

fn default_backup_retain_hourly() -> u32 {
    24
}

fn default_backup_retain_daily() -> u32 {
    7
}

fn default_backup_retain_weekly() -> u32 {
    4
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: default_backup_enabled(),
            interval_hours: default_backup_interval_hours(),
            retain_hourly: default_backup_retain_hourly(),
            retain_daily: default_backup_retain_daily(),
            retain_weekly: default_backup_retain_weekly(),
        }
    }
}

impl BackupConfig {
    /// Load backup config from file, with env var overrides for testing
    pub fn load() -> Self {
        let config_path = ServerConfig::config_path();

        let backup_config = if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|contents| toml::from_str::<Config>(&contents).ok())
                .map(|c| c.backup)
                .unwrap_or_default()
        } else {
            Self::default()
        };

        // Note: FLOATTY_BACKUP_INTERVAL_SECS env var is handled in backup.rs run() method
        // for testing/development. The config.interval_hours value is always in hours.

        backup_config
    }
}

/// Full config file structure (matches floatty's config.toml)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    /// Top-level server_port (preferred, same as main app reads)
    pub server_port: Option<u16>,

    /// Legacy [server] section (for backwards compatibility)
    #[serde(default)]
    pub server: ServerConfig,

    /// Backup daemon configuration
    #[serde(default)]
    pub backup: BackupConfig,
}

impl ServerConfig {
    /// Load config from ~/.floatty/config.toml
    ///
    /// Port resolution order:
    /// 1. `server_port` at top level (same as main app)
    /// 2. `[server].port` (legacy/backwards compat)
    /// 3. Build-profile default (33333 debug, 8765 release)
    pub fn load() -> Self {
        let config_path = Self::config_path();

        if config_path.exists() {
            match std::fs::read_to_string(&config_path) {
                Ok(contents) => match toml::from_str::<Config>(&contents) {
                    Ok(config) => {
                        let mut server_config = config.server;
                        // Top-level server_port takes precedence over [server].port
                        if let Some(port) = config.server_port {
                            server_config.port = port;
                        }
                        return server_config;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse config: {}. Using defaults.", e);
                    }
                },
                Err(e) => {
                    tracing::warn!("Failed to read config: {}. Using defaults.", e);
                }
            }
        }

        Self::default()
    }

    /// Get the config file path.
    ///
    /// Uses `FLOATTY_DATA_DIR` if set, otherwise `~/.floatty`.
    pub fn config_path() -> PathBuf {
        data_dir().join("config.toml")
    }

    /// Get the API key, generating and persisting one if not set
    pub fn get_or_generate_api_key(&self) -> String {
        if let Some(ref key) = self.api_key {
            return key.clone();
        }

        // Generate a random API key
        use std::time::{SystemTime, UNIX_EPOCH};
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let new_key = format!("floatty-{:x}", timestamp);

        // Persist to config file so it survives restarts
        Self::save_api_key(&new_key);

        new_key
    }

    /// Save just the API key to config (preserves other settings)
    fn save_api_key(api_key: &str) {
        let config_path = Self::config_path();

        // Read existing config as raw TOML to preserve unknown fields
        let mut doc: toml::Table = if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or_default()
        } else {
            toml::Table::new()
        };

        // Get or create [server] section
        let server = doc
            .entry("server")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut();

        if let Some(server) = server {
            server.insert("api_key".to_string(), toml::Value::String(api_key.to_string()));
        }

        // Ensure directory exists
        if let Some(parent) = config_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                tracing::error!("Failed to create config directory {:?}: {}", parent, e);
                return; // Don't attempt write if directory creation failed
            }
        }

        // Write back
        let toml_str = match toml::to_string_pretty(&doc) {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("Failed to serialize config: {}", e);
                return;
            }
        };
        if let Err(e) = std::fs::write(&config_path, toml_str) {
            tracing::warn!("Failed to persist API key: {}", e);
        } else {
            tracing::info!("Persisted API key to {:?}", config_path);
        }
    }
}
