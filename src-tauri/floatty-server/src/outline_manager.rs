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

use floatty_core::outline::{OutlineError, OutlineInfo, OutlineName};
use floatty_core::YDocStore;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tracing::{info, warn};

/// Maximum number of loaded outlines before logging a warning.
const MAX_LOADED_WARNING: usize = 20;

/// Manages a cache of YDocStore instances, one per outline.
pub struct OutlineManager {
    /// Cached stores keyed by outline name. "default" is pre-populated.
    stores: RwLock<HashMap<String, Arc<YDocStore>>>,
    /// Directory for outline `.sqlite` files.
    outlines_dir: PathBuf,
    /// The legacy default store, shared with AppState.store.
    default_store: Arc<YDocStore>,
    /// Path to legacy default DB (for OutlineInfo).
    default_db_path: PathBuf,
}

impl OutlineManager {
    /// Create a new manager. The default_store is the same Arc used by legacy routes.
    pub fn new_with_default(data_dir: &Path, default_store: Arc<YDocStore>) -> Self {
        let outlines_dir = data_dir.join("outlines");
        let default_db_path = data_dir.join("ctx_markers.db");

        let mut stores = HashMap::new();
        stores.insert("default".to_string(), Arc::clone(&default_store));

        Self {
            stores: RwLock::new(stores),
            outlines_dir,
            default_store,
            default_db_path,
        }
    }

    /// Get the store for the default outline.
    pub fn default_store(&self) -> Arc<YDocStore> {
        Arc::clone(&self.default_store)
    }

    /// Resolve a store by name. "default" returns the legacy store.
    /// Non-default outlines are lazily opened on first access.
    pub fn get_or_default(&self, name: &str) -> Result<Arc<YDocStore>, OutlineError> {
        if name == "default" {
            return Ok(self.default_store());
        }
        let validated = OutlineName::new(name)?;
        self.get_store(&validated)
    }

    /// Get or open a store for a validated outline name.
    pub fn get_store(&self, name: &OutlineName) -> Result<Arc<YDocStore>, OutlineError> {
        // Fast path: read lock cache hit
        {
            let stores = self.stores.read().map_err(|_| {
                OutlineError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "lock poisoned",
                ))
            })?;
            if let Some(store) = stores.get(name.as_str()) {
                return Ok(Arc::clone(store));
            }
        }

        // Slow path: write lock, double-check, open
        let mut stores = self.stores.write().map_err(|_| {
            OutlineError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "lock poisoned",
            ))
        })?;

        // Double-check after acquiring write lock
        if let Some(store) = stores.get(name.as_str()) {
            return Ok(Arc::clone(store));
        }

        let db_path = self.outline_path(name);
        if !db_path.exists() {
            return Err(OutlineError::NotFound(name.to_string()));
        }

        let store = Arc::new(YDocStore::open(&db_path, name.as_str())?);
        stores.insert(name.as_str().to_string(), Arc::clone(&store));

        let count = stores.len();
        if count > MAX_LOADED_WARNING {
            warn!(
                "OutlineManager: {} outlines loaded (exceeds {} warning threshold)",
                count, MAX_LOADED_WARNING
            );
        }
        info!("Opened outline '{}' from {:?}", name, db_path);

        Ok(store)
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

        let mut stores = self.stores.write().map_err(|_| {
            OutlineError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "lock poisoned",
            ))
        })?;

        // Check both cache and filesystem inside lock (TOCTOU prevention)
        if stores.contains_key(name.as_str()) || db_path.exists() {
            return Err(OutlineError::AlreadyExists(name.to_string()));
        }

        // Open creates the SQLite file and schema
        let store = Arc::new(YDocStore::open(&db_path, name.as_str())?);
        stores.insert(name.as_str().to_string(), store);

        info!("Created outline '{}' at {:?}", name, db_path);
        drop(stores); // Release lock before filesystem stat
        OutlineInfo::from_path(name.as_str(), &db_path).map_err(OutlineError::Io)
    }

    /// Delete an outline. Removes from cache and deletes the file.
    pub fn delete_outline(&self, name: &OutlineName) -> Result<(), OutlineError> {
        let db_path = self.outline_path(name);
        if !db_path.exists() {
            return Err(OutlineError::NotFound(name.to_string()));
        }

        // Remove from cache first (prevents new requests from getting the store)
        {
            let mut stores = self.stores.write().map_err(|_| {
                OutlineError::Io(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    "lock poisoned",
                ))
            })?;
            stores.remove(name.as_str());
        }
        // Note: in-flight requests may still hold Arc<YDocStore>.
        // Phase 1 accepts this race. Phase 2 adds draining state.

        // Delete the SQLite file (and WAL/SHM if present)
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

        info!("Deleted outline '{}' at {:?}", name, db_path);
        Ok(())
    }

    fn outline_path(&self, name: &OutlineName) -> PathBuf {
        self.outlines_dir.join(format!("{}.sqlite", name))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Arc<YDocStore>) {
        let dir = tempfile::TempDir::new().unwrap();
        let db_path = dir.path().join("ctx_markers.db");
        let store = Arc::new(YDocStore::open(&db_path, "default").unwrap());
        (dir, store)
    }

    #[test]
    fn list_shows_default() {
        let (dir, store) = setup();
        let mgr = OutlineManager::new_with_default(dir.path(), store);
        let list = mgr.list_outlines().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "default");
    }

    #[test]
    fn create_and_list() {
        let (dir, store) = setup();
        let mgr = OutlineManager::new_with_default(dir.path(), store);
        let name = OutlineName::new("travel-plans").unwrap();

        mgr.create_outline(&name).unwrap();

        let list = mgr.list_outlines().unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|o| o.name == "default"));
        assert!(list.iter().any(|o| o.name == "travel-plans"));
    }

    #[test]
    fn create_duplicate_fails() {
        let (dir, store) = setup();
        let mgr = OutlineManager::new_with_default(dir.path(), store);
        let name = OutlineName::new("test").unwrap();

        mgr.create_outline(&name).unwrap();
        let result = mgr.create_outline(&name);
        assert!(matches!(result, Err(OutlineError::AlreadyExists(_))));
    }

    #[test]
    fn get_store_cached() {
        let (dir, store) = setup();
        let mgr = OutlineManager::new_with_default(dir.path(), store);
        let name = OutlineName::new("cached-test").unwrap();

        mgr.create_outline(&name).unwrap();

        let s1 = mgr.get_store(&name).unwrap();
        let s2 = mgr.get_store(&name).unwrap();
        assert!(Arc::ptr_eq(&s1, &s2));
    }

    #[test]
    fn get_or_default_returns_default() {
        let (dir, store) = setup();
        let default_ptr = Arc::as_ptr(&store);
        let mgr = OutlineManager::new_with_default(dir.path(), store);

        let resolved = mgr.get_or_default("default").unwrap();
        assert_eq!(Arc::as_ptr(&resolved), default_ptr);
    }

    #[test]
    fn get_nonexistent_fails() {
        let (dir, store) = setup();
        let mgr = OutlineManager::new_with_default(dir.path(), store);
        let name = OutlineName::new("nope").unwrap();

        let result = mgr.get_store(&name);
        assert!(matches!(result, Err(OutlineError::NotFound(_))));
    }

    #[test]
    fn delete_removes_file_and_cache() {
        let (dir, store) = setup();
        let mgr = OutlineManager::new_with_default(dir.path(), store);
        let name = OutlineName::new("to-delete").unwrap();

        mgr.create_outline(&name).unwrap();
        assert!(dir.path().join("outlines/to-delete.sqlite").exists());

        mgr.delete_outline(&name).unwrap();
        assert!(!dir.path().join("outlines/to-delete.sqlite").exists());

        // Should be gone from cache
        let result = mgr.get_store(&name);
        assert!(matches!(result, Err(OutlineError::NotFound(_))));
    }

    #[test]
    fn delete_nonexistent_fails() {
        let (dir, store) = setup();
        let mgr = OutlineManager::new_with_default(dir.path(), store);
        let name = OutlineName::new("ghost").unwrap();

        let result = mgr.delete_outline(&name);
        assert!(matches!(result, Err(OutlineError::NotFound(_))));
    }

    #[test]
    fn recreate_after_delete() {
        let (dir, store) = setup();
        let mgr = OutlineManager::new_with_default(dir.path(), store);
        let name = OutlineName::new("phoenix").unwrap();

        mgr.create_outline(&name).unwrap();
        mgr.delete_outline(&name).unwrap();
        mgr.create_outline(&name).unwrap();

        let list = mgr.list_outlines().unwrap();
        assert!(list.iter().any(|o| o.name == "phoenix"));
    }
}
