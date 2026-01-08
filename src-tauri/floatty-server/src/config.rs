//! Server configuration loaded from ~/.floatty/config.toml

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Default port for the floatty-server
pub const DEFAULT_PORT: u16 = 8765;

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
}

fn default_enabled() -> bool {
    true
}

fn default_port() -> u16 {
    DEFAULT_PORT
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
        }
    }
}

/// Full config file structure (matches floatty's config.toml)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub server: ServerConfig,
}

impl ServerConfig {
    /// Load config from ~/.floatty/config.toml
    pub fn load() -> Self {
        let config_path = Self::config_path();

        if config_path.exists() {
            match std::fs::read_to_string(&config_path) {
                Ok(contents) => match toml::from_str::<Config>(&contents) {
                    Ok(config) => return config.server,
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

    /// Get the config file path
    pub fn config_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".floatty")
            .join("config.toml")
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
        let toml_str = toml::to_string_pretty(&doc).unwrap_or_default();
        if let Err(e) = std::fs::write(&config_path, toml_str) {
            tracing::warn!("Failed to persist API key: {}", e);
        } else {
            tracing::info!("Persisted API key to {:?}", config_path);
        }
    }
}
