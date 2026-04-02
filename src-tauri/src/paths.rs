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
    /// Door plugins: `{root}/doors/`
    pub doors: PathBuf,
    /// Attachments: `{root}/__attachments/`
    pub attachments: PathBuf,
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
            doors: root.join("doors"),
            attachments: root.join("__attachments"),
            root,
        }
    }

    /// Default root directory based on build profile.
    ///
    /// - Debug builds: `~/.floatty-dev`
    /// - Release builds: `~/.floatty`
    ///
    /// This prevents accidental data sharing between dev and release.
    pub fn default_root() -> PathBuf {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

        #[cfg(debug_assertions)]
        {
            home.join(".floatty-dev")
        }

        #[cfg(not(debug_assertions))]
        {
            home.join(".floatty")
        }
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
        std::fs::create_dir_all(&self.doors)?;
        std::fs::create_dir_all(&self.attachments)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::env;

    /// RAII guard for env var restoration (ensures cleanup even on panic)
    struct EnvGuard {
        key: &'static str,
        old_value: Option<String>,
    }

    impl EnvGuard {
        fn new(key: &'static str, new_value: &str) -> Self {
            let old_value = env::var(key).ok();
            env::set_var(key, new_value);
            Self { key, old_value }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.old_value {
                Some(v) => env::set_var(self.key, v),
                None => env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn test_default_root() {
        let root = DataPaths::default_root();
        // Debug builds use .floatty-dev, release uses .floatty
        #[cfg(debug_assertions)]
        assert!(root.ends_with(".floatty-dev"));

        #[cfg(not(debug_assertions))]
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
        assert_eq!(paths.doors, root.join("doors"));
        assert_eq!(paths.attachments, root.join("__attachments"));
    }

    #[test]
    #[serial]
    fn test_resolve_with_env() {
        // EnvGuard handles save/restore with RAII (panic-safe)
        let _guard = EnvGuard::new("FLOATTY_DATA_DIR", "/tmp/test-env-paths");

        let paths = DataPaths::resolve();
        assert_eq!(paths.root, PathBuf::from("/tmp/test-env-paths"));
    }

    #[test]
    fn test_shell_hooks_always_default() {
        // Shell hooks should always be at default location
        let hooks = DataPaths::shell_hooks();
        assert!(hooks.ends_with("shell-hooks.zsh"));
        assert!(hooks.to_string_lossy().contains(".floatty"));
    }

    /// FLO-317 regression: ensure no unguarded `.join(".floatty")` paths exist.
    ///
    /// Scans all .rs files in the workspace for `.join(".floatty")` or `.join(".floatty-dev")`
    /// and verifies each occurrence is either:
    /// - Inside a `#[cfg(...)` block (proper build-profile gate), OR
    /// - In an allowlisted file (paths.rs, hooks.rs, test files)
    #[test]
    fn no_unguarded_floatty_paths() {
        use std::fs;

        let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let scan_dirs = vec![
            workspace_root.join("src"),
            workspace_root.join("floatty-core/src"),
            workspace_root.join("floatty-server/src"),
        ];

        // Files where hardcoded .floatty paths are expected/allowed
        let allowlist: Vec<&str> = vec![
            "paths.rs", // canonical location for DataPaths::default_root()
            "hooks.rs", // shell hooks hardcoded to ~/.floatty (documented exception)
        ];

        let mut violations = Vec::new();

        for dir in &scan_dirs {
            if !dir.exists() {
                continue;
            }
            for entry in walkdir(dir) {
                let path = entry;
                let filename = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

                // Skip allowlisted files
                if allowlist.iter().any(|a| filename == *a) {
                    continue;
                }

                // Skip test files
                if filename.ends_with("_test.rs") || filename.contains("test") {
                    continue;
                }

                let contents = match fs::read_to_string(&path) {
                    Ok(c) => c,
                    Err(_) => continue,
                };

                for (line_num, line) in contents.lines().enumerate() {
                    // Look for .join(".floatty") or .join(".floatty-dev")
                    if (line.contains(r#".join(".floatty")"#)
                        || line.contains(r#".join(".floatty-dev")"#))
                        && !line.trim_start().starts_with("//")
                    {
                        // Check if there's a #[cfg] within the preceding 5 lines
                        let start = if line_num >= 5 { line_num - 5 } else { 0 };
                        let context: Vec<&str> = contents
                            .lines()
                            .skip(start)
                            .take(line_num - start + 1)
                            .collect();
                        let has_cfg = context.iter().any(|l| l.contains("#[cfg("));

                        if !has_cfg {
                            let rel_path = path.strip_prefix(&workspace_root).unwrap_or(&path);
                            violations.push(format!(
                                "{}:{} → {}",
                                rel_path.display(),
                                line_num + 1,
                                line.trim()
                            ));
                        }
                    }
                }
            }
        }

        assert!(
            violations.is_empty(),
            "Found unguarded .floatty path joins (need #[cfg] gate or allowlist entry):\n  {}",
            violations.join("\n  ")
        );
    }

    /// Recursively collect all .rs files in a directory
    fn walkdir(dir: &std::path::Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    files.extend(walkdir(&path));
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    files.push(path);
                }
            }
        }
        files
    }
}
