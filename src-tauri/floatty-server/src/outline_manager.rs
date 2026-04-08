//! Outline manager — lazy-loaded store cache for multi-outline support.
//!
//! Each outline gets its own SQLite file in `{data_dir}/outlines/`.
//! The "default" outline maps to the legacy `ctx_markers.db`.
//!
//! Phase 1 limitations:
//! - Grow-only cache: opened outlines stay in memory until server restart.
//!   max_loaded logs a warning at 20 but does not evict. Phase 2 adds LRU.
//! - Delete race: in-flight requests may hold Arc<YDocStore> when file is deleted.
//!   Acceptable for Phase 1 (single user, curl testing).
//! - No rename. Deferred to Phase 2.
//! - macOS/Linux only — Windows-reserved names not checked.

use floatty_core::hooks::HookSystem;
use floatty_core::outline::{OutlineError, OutlineInfo, OutlineName};
use floatty_core::YDocStore;
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, OnceLock, RwLock};
use tracing::{info, warn};

use crate::backup::{backup_dir_for, BackupDaemon};
use crate::config::BackupConfig;
use crate::WsBroadcaster;

/// Maximum number of loaded outlines before logging a warning.
const MAX_LOADED_WARNING: usize = 20;
/// Maximum loaded outlines before eviction kicks in. "default" is never evicted.
const MAX_LOADED_OUTLINES: usize = 16;

/// Per-outline runtime context: store + lazy hooks + broadcaster + backup daemon.
///
/// For "default": hooks are pre-initialized from main.rs.
/// For non-default: hooks initialize lazily on first mutation via OnceLock.
pub struct OutlineContext {
    pub name: String,
    pub store: Arc<YDocStore>,
    hook_system: OnceLock<Arc<HookSystem>>,
    pub broadcaster: Arc<WsBroadcaster>,
    pub active_connections: AtomicUsize,
    search_index_path: Option<PathBuf>,
    callbacks_wired: AtomicBool,
    /// Hourly backup daemon. None if backups are disabled in config.
    pub backup_daemon: Option<Arc<BackupDaemon>>,
}

impl OutlineContext {
    /// Initialize hook system if not yet initialized. First call triggers cold-start rehydration.
    ///
    /// Use this for operations that NEED hooks (writes, reads needing inheritance/search).
    /// Uses `catch_unwind` to prevent OnceLock poisoning if init panics.
    pub fn ensure_hook_system(&self) -> &Arc<HookSystem> {
        let hs = self.hook_system.get_or_init(|| {
            info!("Initializing hook system for outline '{}'", self.name);
            let store = Arc::clone(&self.store);
            let path = self.search_index_path.clone();
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                HookSystem::initialize_at(store, path)
            })) {
                Ok(hs) => Arc::new(hs),
                Err(e) => {
                    warn!("HookSystem init panicked for '{}': {:?}", self.name, e);
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        HookSystem::initialize_at(Arc::clone(&self.store), None)
                    })) {
                        Ok(hs) => Arc::new(hs),
                        Err(e2) => {
                            panic!("Cannot initialize HookSystem for outline '{}': primary {:?}, fallback {:?}", self.name, e, e2);
                        }
                    }
                }
            }
        });

        // Wire store callbacks on first hook_system init (change_callback + broadcast_callback).
        // Flag is set AFTER registration completes to prevent race where another thread
        // sees callbacks_wired=true before callbacks are actually installed.
        if !self.callbacks_wired.load(std::sync::atomic::Ordering::Acquire) {
            let hs_clone = Arc::clone(hs);
            let bc_clone = Arc::clone(&self.broadcaster);
            let change_ok = self.store.set_change_callback(move |changes| {
                for change in changes {
                    if let Err(e) = hs_clone.emit_change(change) {
                        tracing::error!("Hook emission failed: {}", e);
                    }
                }
            }).is_ok();
            self.store.set_broadcast_callback(move |update, seq| {
                bc_clone.broadcast(update, None, Some(seq));
            });
            self.callbacks_wired.store(true, std::sync::atomic::Ordering::Release);
            if change_ok {
                info!("Wired callbacks for outline '{}'", self.name);
            } else {
                warn!("Wired broadcast_callback for '{}' but change_callback failed", self.name);
            }
        }

        hs
    }

    /// Check if hook system is already initialized without triggering bootstrap.
    ///
    /// Use this for cheap paths (flush, eviction checks) that shouldn't accidentally cold-start.
    pub fn hook_system_if_initialized(&self) -> Option<&Arc<HookSystem>> {
        self.hook_system.get()
    }

    /// Best-effort flush before eviction. No-op if hooks never initialized.
    pub fn flush(&self) {
        if let Some(hs) = self.hook_system_if_initialized() {
            if let Some(writer) = hs.writer_handle() {
                if let Err(e) = writer.try_send_commit() {
                    warn!("Flush failed for outline '{}': {:?}", self.name, e);
                }
            }
        }
    }

    /// Create a context for the default outline with pre-initialized hooks.
    pub fn new_default(store: Arc<YDocStore>, hook_system: Arc<HookSystem>, broadcaster: Arc<WsBroadcaster>, search_index_path: Option<PathBuf>, backup_daemon: Option<Arc<BackupDaemon>>) -> Self {
        let lock = OnceLock::new();
        let _ = lock.set(hook_system);
        Self {
            name: "default".to_string(),
            store,
            hook_system: lock,
            broadcaster,
            active_connections: AtomicUsize::new(0),
            search_index_path,
            callbacks_wired: AtomicBool::new(true), // Default wires callbacks in main.rs
            backup_daemon,
        }
    }

    /// Create a context for a non-default outline with lazy hooks and a fresh backup daemon.
    fn new_outline(name: &str, store: Arc<YDocStore>, search_index_path: Option<PathBuf>, backup_config: &BackupConfig) -> Self {
        let backup_daemon = if backup_config.enabled {
            let backup_dir = backup_dir_for(name);
            if let Err(e) = std::fs::create_dir_all(&backup_dir) {
                warn!("Failed to create backup dir for outline '{}': {}", name, e);
                None
            } else {
                let daemon = Arc::new(BackupDaemon::new(
                    Arc::clone(&store),
                    backup_config.clone(),
                    backup_dir,
                ));
                let _handle = Arc::clone(&daemon).start();
                info!("Backup daemon started for outline '{}'", name);
                Some(daemon)
            }
        } else {
            None
        };

        Self {
            name: name.to_string(),
            store,
            hook_system: OnceLock::new(),
            broadcaster: Arc::new(WsBroadcaster::new(256)),
            active_connections: AtomicUsize::new(0),
            search_index_path,
            callbacks_wired: AtomicBool::new(false),
            backup_daemon,
        }
    }
}

/// Manages a cache of OutlineContext instances, one per outline.
pub struct OutlineManager {
    /// Cached contexts keyed by outline name. "default" is pre-populated.
    contexts: RwLock<HashMap<String, Arc<OutlineContext>>>,
    /// Directory for outline `.sqlite` files.
    outlines_dir: PathBuf,
    /// The default context (shared with legacy routes).
    default_context: Arc<OutlineContext>,
    /// Path to legacy default DB (for OutlineInfo).
    default_db_path: PathBuf,
    /// Backup config passed to new outline contexts on creation.
    backup_config: BackupConfig,
}

impl OutlineManager {
    /// Create a new manager with a pre-initialized default context and backup config.
    pub fn new_with_default(data_dir: &Path, default_context: Arc<OutlineContext>, backup_config: BackupConfig) -> Self {
        let outlines_dir = data_dir.join("outlines");
        let default_db_path = data_dir.join("ctx_markers.db");

        let mut contexts = HashMap::new();
        contexts.insert("default".to_string(), Arc::clone(&default_context));

        Self {
            contexts: RwLock::new(contexts),
            outlines_dir,
            default_context,
            default_db_path,
            backup_config,
        }
    }

    /// Get the default context (convenience for legacy routes).
    pub fn default_context(&self) -> Arc<OutlineContext> {
        Arc::clone(&self.default_context)
    }

    /// Get the default store (convenience for code that only needs YDocStore).
    pub fn default_store(&self) -> Arc<YDocStore> {
        Arc::clone(&self.default_context.store)
    }

    /// Resolve a context by name. "default" returns the legacy context.
    pub fn get_context(&self, name: &str) -> Result<Arc<OutlineContext>, OutlineError> {
        if name == "default" {
            return Ok(self.default_context());
        }
        let validated = OutlineName::new(name)?;
        self.get_outline_context(&validated)
    }

    /// Get or open a context for a validated outline name.
    fn get_outline_context(&self, name: &OutlineName) -> Result<Arc<OutlineContext>, OutlineError> {
        // Fast path: read lock cache hit
        {
            let contexts = self.contexts.read().map_err(|_| {
                OutlineError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "lock poisoned",
                ))
            })?;
            if let Some(ctx) = contexts.get(name.as_str()) {
                return Ok(Arc::clone(ctx));
            }
        }

        // Slow path: write lock, double-check, open
        let mut contexts = self.contexts.write().map_err(|_| {
            OutlineError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "lock poisoned",
            ))
        })?;

        if let Some(ctx) = contexts.get(name.as_str()) {
            return Ok(Arc::clone(ctx));
        }

        let db_path = self.outline_path(name);
        if !db_path.exists() {
            return Err(OutlineError::NotFound(name.to_string()));
        }

        let store = Arc::new(YDocStore::open(&db_path, name.as_str())?);
        let search_path = self.search_index_path(&name);
        let ctx = Arc::new(OutlineContext::new_outline(name.as_str(), store, Some(search_path), &self.backup_config));
        contexts.insert(name.as_str().to_string(), Arc::clone(&ctx));

        // Evict idle outlines when cache exceeds limit. Not true LRU — evicts
        // first idle found. "default" and the just-opened outline are exempt.
        // active_connections only tracks WS subscribers, not HTTP requests.
        if contexts.len() > MAX_LOADED_OUTLINES {
            let slots_to_free = contexts.len() - MAX_LOADED_OUTLINES;
            let evictable: Vec<String> = contexts.iter()
                .filter(|(k, ctx)| {
                    *k != "default"
                        && k.as_str() != name.as_str()
                        && ctx.active_connections.load(Ordering::Relaxed) == 0
                })
                .map(|(k, _)| k.clone())
                .take(slots_to_free)
                .collect();

            for evict_name in evictable {
                if let Some(evicted) = contexts.remove(&evict_name) {
                    evicted.flush();
                    info!("Evicted idle outline '{}' (cache size: {})", evict_name, contexts.len());
                }
            }

            if contexts.len() > MAX_LOADED_OUTLINES {
                warn!("Cache still at {} after eviction — all non-default outlines have active connections",
                    contexts.len());
            }
        }

        if contexts.len() > MAX_LOADED_WARNING {
            warn!(
                "OutlineManager: {} outlines loaded (exceeds {} warning threshold)",
                contexts.len(), MAX_LOADED_WARNING
            );
        }
        info!("Opened outline '{}' from {:?}", name, db_path);

        Ok(ctx)
    }

    /// Backward-compat: resolve a store by name (for Phase 1 sync handlers).
    pub fn get_or_default(&self, name: &str) -> Result<Arc<YDocStore>, OutlineError> {
        Ok(Arc::clone(&self.get_context(name)?.store))
    }

    /// List all available outlines.
    pub fn list_outlines(&self) -> Result<Vec<OutlineInfo>, OutlineError> {
        let mut outlines = Vec::new();

        // Include "default" if its DB file exists (fresh installs may not have it yet)
        if self.default_db_path.exists() {
            match OutlineInfo::from_path("default", &self.default_db_path) {
                Ok(info) => outlines.push(info),
                Err(e) => warn!("Failed to stat default outline: {}", e),
            }
        }

        // Scan outlines directory
        if self.outlines_dir.exists() {
            let entries = std::fs::read_dir(&self.outlines_dir)?;
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("sqlite") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if OutlineName::new(stem).is_err() {
                            warn!("Skipping non-conforming outline file: {:?}", path);
                            continue;
                        }
                        match OutlineInfo::from_path(stem, &path) {
                            Ok(info) => outlines.push(info),
                            Err(e) => warn!("Failed to stat outline '{}': {}", stem, e),
                        }
                    }
                }
            }
        }

        outlines.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(outlines)
    }

    /// Create a new empty outline.
    pub fn create_outline(&self, name: &OutlineName) -> Result<OutlineInfo, OutlineError> {
        std::fs::create_dir_all(&self.outlines_dir)?;

        let db_path = self.outline_path(name);

        let mut contexts = self.contexts.write().map_err(|_| {
            OutlineError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "lock poisoned",
            ))
        })?;

        if contexts.contains_key(name.as_str()) || db_path.exists() {
            return Err(OutlineError::AlreadyExists(name.to_string()));
        }

        let store = Arc::new(YDocStore::open(&db_path, name.as_str()).map_err(|e| {
            // Clean up partial .sqlite file if SQLite created it before failing
            let _ = std::fs::remove_file(&db_path);
            e
        })?);
        let search_path = self.search_index_path(&name);
        let ctx = Arc::new(OutlineContext::new_outline(name.as_str(), store, Some(search_path), &self.backup_config));
        contexts.insert(name.as_str().to_string(), ctx);

        info!("Created outline '{}' at {:?}", name, db_path);
        drop(contexts);
        OutlineInfo::from_path(name.as_str(), &db_path).map_err(OutlineError::Io)
    }

    /// Delete an outline. Flushes pending writes, deletes files, then removes from cache.
    pub fn delete_outline(&self, name: &OutlineName) -> Result<(), OutlineError> {
        let db_path = self.outline_path(name);
        if !db_path.exists() {
            return Err(OutlineError::NotFound(name.to_string()));
        }

        // Flush pending search writes before deletion
        if let Ok(contexts) = self.contexts.read() {
            if let Some(ctx) = contexts.get(name.as_str()) {
                ctx.flush();
            }
        }

        std::fs::remove_file(&db_path)?;
        let wal = db_path.with_extension("sqlite-wal");
        let shm = db_path.with_extension("sqlite-shm");
        if wal.exists() {
            if let Err(e) = std::fs::remove_file(&wal) {
                warn!("Failed to remove WAL file {:?}: {}", wal, e);
            }
        }
        if shm.exists() {
            if let Err(e) = std::fs::remove_file(&shm) {
                warn!("Failed to remove SHM file {:?}: {}", shm, e);
            }
        }

        // Remove Tantivy index directory if present
        let tantivy_dir = self.search_index_path(name);
        if tantivy_dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&tantivy_dir) {
                warn!("Failed to remove Tantivy index {:?}: {}", tantivy_dir, e);
            }
        }

        {
            let mut contexts = self.contexts.write().map_err(|_| {
                OutlineError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "lock poisoned",
                ))
            })?;
            contexts.remove(name.as_str());
        }

        info!("Deleted outline '{}' at {:?}", name, db_path);
        Ok(())
    }

    fn outline_path(&self, name: &OutlineName) -> PathBuf {
        self.outlines_dir.join(format!("{}.sqlite", name))
    }

    fn search_index_path(&self, name: &OutlineName) -> PathBuf {
        self.outlines_dir.join(format!("{}.tantivy", name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test helper: creates OutlineManager with minimal default context (no Tokio runtime needed).
    fn setup_mgr() -> (tempfile::TempDir, OutlineManager) {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("ctx_markers.db");
        let store = Arc::new(YDocStore::open(&db_path, "default").unwrap());
        let broadcaster = Arc::new(WsBroadcaster::new(64));

        // Create default context WITHOUT HookSystem (avoids Tokio runtime requirement).
        // Manager lifecycle tests only need store + cache behavior, not hooks.
        let default_context = Arc::new(OutlineContext {
            name: "default".to_string(),
            store,
            hook_system: OnceLock::new(), // Not initialized — tests don't trigger hooks
            broadcaster,
            active_connections: AtomicUsize::new(0),
            search_index_path: None,
            callbacks_wired: AtomicBool::new(false),
            backup_daemon: None, // Tests don't need backup
        });

        let mut contexts = HashMap::new();
        contexts.insert("default".to_string(), Arc::clone(&default_context));

        let mgr = OutlineManager {
            contexts: RwLock::new(contexts),
            outlines_dir: dir.path().join("outlines"),
            default_context,
            default_db_path: db_path,
            backup_config: BackupConfig { enabled: false, ..BackupConfig::default() },
        };
        (dir, mgr)
    }

    #[test]
    fn list_shows_default() {
        let (_dir, mgr) = setup_mgr();
        let list = mgr.list_outlines().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "default");
    }

    #[test]
    fn create_and_list() {
        let (_dir, mgr) = setup_mgr();
        let name = OutlineName::new("travel-plans").unwrap();
        mgr.create_outline(&name).unwrap();

        let list = mgr.list_outlines().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|o| o.name == "default"));
        assert!(list.iter().any(|o| o.name == "travel-plans"));
    }

    #[test]
    fn create_duplicate_fails() {
        let (_dir, mgr) = setup_mgr();
        let name = OutlineName::new("test").unwrap();
        mgr.create_outline(&name).unwrap();
        let result = mgr.create_outline(&name);
        assert!(matches!(result, Err(OutlineError::AlreadyExists(_))));
    }

    #[test]
    fn get_context_cached() {
        let (_dir, mgr) = setup_mgr();
        let name = OutlineName::new("cached-test").unwrap();
        mgr.create_outline(&name).unwrap();

        let c1 = mgr.get_outline_context(&name).unwrap();
        let c2 = mgr.get_outline_context(&name).unwrap();
        assert!(Arc::ptr_eq(&c1, &c2));
    }

    #[test]
    fn get_context_default() {
        let (_dir, mgr) = setup_mgr();
        let ctx = mgr.get_context("default").unwrap();
        assert_eq!(ctx.name, "default");
        // Same Arc as default_context
        assert!(Arc::ptr_eq(&ctx, &mgr.default_context()));
    }

    #[test]
    fn get_nonexistent_fails() {
        let (_dir, mgr) = setup_mgr();
        let name = OutlineName::new("nope").unwrap();
        let result = mgr.get_outline_context(&name);
        assert!(matches!(result, Err(OutlineError::NotFound(_))));
    }

    #[test]
    fn delete_removes_file_and_cache() {
        let (dir, mgr) = setup_mgr();
        let name = OutlineName::new("to-delete").unwrap();
        mgr.create_outline(&name).unwrap();
        assert!(dir.path().join("outlines/to-delete.sqlite").exists());

        mgr.delete_outline(&name).unwrap();
        assert!(!dir.path().join("outlines/to-delete.sqlite").exists());

        let result = mgr.get_outline_context(&name);
        assert!(matches!(result, Err(OutlineError::NotFound(_))));
    }

    #[test]
    fn delete_nonexistent_fails() {
        let (_dir, mgr) = setup_mgr();
        let name = OutlineName::new("ghost").unwrap();
        let result = mgr.delete_outline(&name);
        assert!(matches!(result, Err(OutlineError::NotFound(_))));
    }

    #[test]
    fn recreate_after_delete() {
        let (_dir, mgr) = setup_mgr();
        let name = OutlineName::new("phoenix").unwrap();
        mgr.create_outline(&name).unwrap();
        mgr.delete_outline(&name).unwrap();
        mgr.create_outline(&name).unwrap();

        let list = mgr.list_outlines().unwrap();
        assert!(list.iter().any(|o| o.name == "phoenix"));
    }
}
