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
    /// Load backup config from file, with env var overrides for testing.
    ///
    /// Intentionally fail-OPEN (defaults on parse error), unlike
    /// `ServerConfig::load` (FLO-921): backup defaults only affect retention,
    /// not which outline is authoritative, so a malformed file here is not a
    /// split-brain risk. In practice `ServerConfig::load` reads the same file
    /// earlier in boot (main.rs) and already fails fast, so a malformed config
    /// never reaches this path anyway.
    pub fn load() -> Self {
        let config_path = ServerConfig::config_path();

        // Note: FLOATTY_BACKUP_INTERVAL_SECS env var is handled in backup.rs run() method
        // for testing/development. The config.interval_hours value is always in hours.

        if config_path.exists() {
            std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|contents| toml::from_str::<Config>(&contents).ok())
                .map(|c| c.backup)
                .unwrap_or_default()
        } else {
            Self::default()
        }
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
        Self::load_from(&Self::config_path())
    }

    /// Load from an explicit path — the testable core of `load()`.
    fn load_from(config_path: &std::path::Path) -> Self {
        if config_path.exists() {
            match std::fs::read_to_string(config_path) {
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
                        // FLO-921: an EXISTING-but-unparseable config is FATAL, not
                        // fail-open. Falling through to Self::default() drops
                        // remote_server_url et al. and can boot against a different
                        // outline (split-brain) — the exact class the desktop loader
                        // was hardened against in PR #349. Mirrors that panic; the
                        // "invalid TOML" wording is asserted by the test.
                        panic!(
                            "config.toml at {:?} is invalid TOML: {} — refusing to boot with \
                             defaults (would drop remote_server_url and risk split-brain). \
                             Fix or delete the file.",
                            config_path, e
                        );
                    }
                },
                Err(e) => {
                    panic!(
                        "config.toml at {:?} exists but cannot be read: {} — refusing to boot \
                         with defaults (split-brain risk). Check permissions.",
                        config_path, e
                    );
                }
            }
        }

        // No file → legitimate first launch → defaults.
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

        let new_key = Self::generate_api_key();

        // Persist to config file so it survives restarts
        Self::save_api_key(&new_key);

        new_key
    }

    /// Generate a fresh API key from a CSPRNG (FLO-921).
    ///
    /// NOT the clock: a timestamp-derived key is low-entropy and guessable from
    /// log/mtime/deploy timing, and this key is the SOLE auth boundary once the
    /// server binds a tailnet IP (FLO-762 remote-authority mode is the daily
    /// driver). `uuid::Uuid::new_v4` draws from getrandom (OS CSPRNG);
    /// `.simple()` yields 32 hex chars → `floatty-<32hex>`.
    fn generate_api_key() -> String {
        format!("floatty-{}", uuid::Uuid::new_v4().simple())
    }

    /// Save just the API key to config (preserves other settings).
    fn save_api_key(api_key: &str) {
        Self::save_api_key_to(&Self::config_path(), api_key);
    }

    /// Persist the API key to an explicit path — the testable core of
    /// `save_api_key`. Refuses to write over an unparseable existing file.
    fn save_api_key_to(config_path: &std::path::Path, api_key: &str) {
        // Read existing config as raw TOML to preserve unknown fields.
        // FLO-921: if an existing file cannot be read or parsed, REFUSE to write
        // rather than `.unwrap_or_default()` — that turned a malformed-but-
        // recoverable file into an empty Table and then overwrote it with only
        // `[server].api_key`, permanently destroying remote_server_url and the
        // rest. (With the fail-fast load() above this is belt-and-braces, but the
        // clobber must not exist as a reachable path.)
        let mut doc: toml::Table = if config_path.exists() {
            match std::fs::read_to_string(config_path) {
                Ok(contents) => match contents.parse::<toml::Table>() {
                    Ok(table) => table,
                    Err(e) => {
                        tracing::error!(
                            "Refusing to persist API key: existing config.toml is unparseable \
                             ({}). Not overwriting — fix the file and restart.",
                            e
                        );
                        return;
                    }
                },
                Err(e) => {
                    tracing::error!(
                        "Refusing to persist API key: existing config.toml is unreadable ({}). \
                         Not overwriting.",
                        e
                    );
                    return;
                }
            }
        } else {
            toml::Table::new()
        };

        // Get or create [server] section
        let server = doc
            .entry("server")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut();

        if let Some(server) = server {
            server.insert(
                "api_key".to_string(),
                toml::Value::String(api_key.to_string()),
            );
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
        if let Err(e) = std::fs::write(config_path, toml_str) {
            tracing::warn!("Failed to persist API key: {}", e);
        } else {
            tracing::info!("Persisted API key to {:?}", config_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // FLO-921: floatty-server config hardening — the first test module in this
    // file. Uses explicit paths (load_from / save_api_key_to) so no test touches
    // FLOATTY_DATA_DIR and there is no env race.

    #[test]
    fn missing_file_uses_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // No file written.
        let cfg = ServerConfig::load_from(&path);
        assert_eq!(cfg.port, default_port());
        assert!(cfg.api_key.is_none());
    }

    #[test]
    fn valid_file_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "server_port = 9999\n[server]\napi_key = \"k\"\n").unwrap();
        let cfg = ServerConfig::load_from(&path);
        assert_eq!(cfg.port, 9999);
        assert_eq!(cfg.api_key.as_deref(), Some("k"));
    }

    #[test]
    #[should_panic(expected = "invalid TOML")]
    fn malformed_file_is_fatal_not_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // Existing but syntactically invalid → must panic, never silently default.
        fs::write(&path, "server_port = [this is not toml").unwrap();
        let _ = ServerConfig::load_from(&path);
    }

    #[test]
    fn generated_key_is_csprng_shaped_and_unique() {
        let a = ServerConfig::generate_api_key();
        let b = ServerConfig::generate_api_key();
        // floatty- + 32 lowercase hex (uuid v4 simple), and two draws differ.
        assert!(a.starts_with("floatty-"), "prefix: {a}");
        let hex = a.strip_prefix("floatty-").unwrap();
        assert_eq!(
            hex.len(),
            32,
            "expected 32 hex chars, got {}: {a}",
            hex.len()
        );
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()), "non-hex in {a}");
        assert_ne!(a, b, "two generated keys must differ");
        // Not the old timestamp shape (floatty-<hex-nanos>, which was shorter/odd-length).
        assert!(!a.contains(' '));
    }

    #[test]
    fn save_api_key_refuses_to_clobber_unparseable_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // A malformed-but-recoverable file the user could still hand-fix.
        let original = "remote_server_url = \"http://float-box:8765\"\nthis is broken toml [[[";
        fs::write(&path, original).unwrap();

        // The old code did `.unwrap_or_default()` → empty Table → overwrote the
        // file with only [server].api_key, destroying remote_server_url. The fix
        // refuses to write.
        ServerConfig::save_api_key_to(&path, "floatty-newkey");

        let after = fs::read_to_string(&path).unwrap();
        assert_eq!(
            after, original,
            "malformed config must be left byte-for-byte unchanged"
        );
    }

    #[test]
    fn save_api_key_preserves_unknown_fields_in_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        fs::write(&path, "remote_server_url = \"http://float-box:8765\"\n").unwrap();

        ServerConfig::save_api_key_to(&path, "floatty-abc123");

        let after = fs::read_to_string(&path).unwrap();
        assert!(
            after.contains("remote_server_url"),
            "must preserve existing keys: {after}"
        );
        assert!(
            after.contains("floatty-abc123"),
            "must write the key: {after}"
        );
    }
}
