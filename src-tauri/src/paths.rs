//! Centralized data path resolution for floatty.
//!
//! All file paths are derived from a single root directory. This enables:
//! - Test isolation via `FLOATTY_DATA_DIR=/tmp/test-floatty`
//! - Workspace switching for multi-environment setups
//! - Consistent path handling across main app and server subprocess
//!
//! # Path Resolution Precedence
//!
//! 1. `FLOATTY_DATA_DIR` environment variable (if set)
//! 2. Default: `~/.floatty`
//!
//! # Exception
//!
//! Shell hooks (`shell-hooks.zsh`) always stay at `~/.floatty` since
//! user's `.zshrc` references this fixed path.

use std::path::PathBuf;

/// All data paths derived from a single root directory.
///
/// Create via `DataPaths::resolve()` which reads `FLOATTY_DATA_DIR`
/// or falls back to `~/.floatty`.
#[derive(Debug, Clone)]
pub struct DataPaths {
    /// Root directory (e.g., `~/.floatty` or custom path)
    pub root: PathBuf,
    /// Config file: `{root}/config.toml`
    pub config: PathBuf,
    /// SQLite database: `{root}/ctx_markers.db`
    pub database: PathBuf,
    /// Log directory: `{root}/logs/`
    pub logs: PathBuf,
    /// Search index: `{root}/search_index/`
    pub search_index: PathBuf,
    /// Server PID file: `{root}/server.pid`
    pub pid_file: PathBuf,
}

impl DataPaths {
    /// Resolve paths from environment or default.
    ///
    /// Checks `FLOATTY_DATA_DIR` first, falls back to `~/.floatty`.
    pub fn resolve() -> Self {
        let root = std::env::var("FLOATTY_DATA_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(Self::default_root);

        Self::from_root(root)
    }

    /// Create paths from a specific root directory.
    ///
    /// Use this for testing or when you know the exact root.
    pub fn from_root(root: PathBuf) -> Self {
        Self {
            config: root.join("config.toml"),
            database: root.join("ctx_markers.db"),
            logs: root.join("logs"),
            search_index: root.join("search_index"),
            pid_file: root.join("server.pid"),
            root,
        }
    }

    /// Default root directory: `~/.floatty`
    pub fn default_root() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".floatty")
    }

    /// Shell hooks path (always at `~/.floatty/shell-hooks.zsh`).
    ///
    /// This is NOT relative to the data directory because user's
    /// `.zshrc` has a hardcoded `source ~/.floatty/shell-hooks.zsh`.
    #[allow(dead_code)]
    pub fn shell_hooks() -> PathBuf {
        Self::default_root().join("shell-hooks.zsh")
    }

    /// Ensure all required directories exist.
    ///
    /// Creates `root`, `logs`, and `search_index` if missing.
    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.root)?;
        std::fs::create_dir_all(&self.logs)?;
        std::fs::create_dir_all(&self.search_index)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn test_default_root() {
        let root = DataPaths::default_root();
        assert!(root.ends_with(".floatty"));
    }

    #[test]
    fn test_from_root() {
        let root = PathBuf::from("/tmp/test-floatty");
        let paths = DataPaths::from_root(root.clone());

        assert_eq!(paths.root, root);
        assert_eq!(paths.config, root.join("config.toml"));
        assert_eq!(paths.database, root.join("ctx_markers.db"));
        assert_eq!(paths.logs, root.join("logs"));
        assert_eq!(paths.search_index, root.join("search_index"));
        assert_eq!(paths.pid_file, root.join("server.pid"));
    }

    #[test]
    fn test_resolve_with_env() {
        // Save and set env
        let key = "FLOATTY_DATA_DIR";
        let old = env::var(key).ok();
        env::set_var(key, "/tmp/test-env-paths");

        let paths = DataPaths::resolve();
        assert_eq!(paths.root, PathBuf::from("/tmp/test-env-paths"));

        // Restore
        match old {
            Some(v) => env::set_var(key, v),
            None => env::remove_var(key),
        }
    }

    #[test]
    fn test_shell_hooks_always_default() {
        // Shell hooks should always be at default location
        let hooks = DataPaths::shell_hooks();
        assert!(hooks.ends_with("shell-hooks.zsh"));
        assert!(hooks.to_string_lossy().contains(".floatty"));
    }
}
