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

    /// API key for authentication (required)
    pub api_key: Option<String>,

    /// Bind address (default: 127.0.0.1 for local only)
    #[serde(default = "default_bind")]
    pub bind: String,
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

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled(),
            port: default_port(),
            api_key: None,
            bind: default_bind(),
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

    /// Get the API key, generating one if not set
    pub fn get_or_generate_api_key(&self) -> String {
        self.api_key.clone().unwrap_or_else(|| {
            // Generate a random API key
            use std::time::{SystemTime, UNIX_EPOCH};
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            format!("floatty-{:x}", timestamp)
        })
    }
}
