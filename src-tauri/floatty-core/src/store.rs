//! Block store backed by Y.Doc (yrs) with SQLite persistence.
//!
//! This provides the core block operations for Floatty, independent of Tauri.
//! The frontend Y.Doc (yjs) syncs with this via update deltas.

use crate::persistence::{PersistenceError, YDocPersistence};
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use thiserror::Error;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};

/// Default doc key for the outliner.
pub const DEFAULT_DOC_KEY: &str = "default";

/// Schema version: bump when block format changes incompatibly.
/// v1: Plain JSON objects in Y.Map
/// v2: Nested Y.Map with Y.Array for childIds
const SCHEMA_VERSION: i32 = 2;

/// Compact when update count exceeds this threshold.
const COMPACT_THRESHOLD: i64 = 100;

/// Only check DB for compaction every N updates (avoid SELECT per keystroke).
const COMPACT_CHECK_INTERVAL: i64 = 10;

/// Errors that can occur in the block store.
#[derive(Error, Debug)]
pub enum StoreError {
    #[error("Persistence error: {0}")]
    Persistence(#[from] PersistenceError),

    #[error("Y.Doc update decode failed: {0}")]
    UpdateDecode(String),

    #[error("Y.Doc apply failed: {0}")]
    UpdateApply(String),

    #[error("Lock poisoned")]
    LockPoisoned,
}

/// Block store backed by Y.Doc with SQLite persistence.
///
/// Thread-safe via internal RwLock. Persistence happens on every update.
pub struct YDocStore {
    doc: Arc<RwLock<Doc>>,
    persistence: YDocPersistence,
    doc_key: String,
    /// Counter to avoid SELECT on every keystroke
    updates_since_compact_check: AtomicI64,
}

impl YDocStore {
    /// Create a new store, loading persisted state if available.
    ///
    /// Uses the default database path (~/.floatty/ctx_markers.db).
    pub fn new() -> Result<Self, StoreError> {
        Self::open(&crate::persistence::default_db_path(), DEFAULT_DOC_KEY)
    }

    /// Open a store with a specific database path and doc key.
    pub fn open(db_path: &Path, doc_key: &str) -> Result<Self, StoreError> {
        let persistence = YDocPersistence::open(db_path)?;

        // Check schema version - clear old data if incompatible
        // Version 0 = legacy data from before schema tracking (plain JSON blocks)
        // Version 2 = nested Y.Map with Y.Array childIds
        let current_version = persistence.get_schema_version()?;
        if current_version < SCHEMA_VERSION {
            // Check if there's any data to clear (version 0 could be legacy OR fresh install)
            let has_data = persistence.get_update_count(doc_key)? > 0;
            if has_data {
                log::warn!(
                    "Schema upgrade: clearing old Y.Doc data (v{} -> v{})",
                    current_version,
                    SCHEMA_VERSION
                );
                persistence.clear_updates(doc_key)?;
            }
            persistence.set_schema_version(SCHEMA_VERSION)?;
            log::info!("Schema version set to {}", SCHEMA_VERSION);
        }

        let doc = Doc::new();

        // Replay persisted updates
        let updates = persistence.get_updates(doc_key)?;
        if !updates.is_empty() {
            log::info!(
                "Replaying {} Y.Doc updates from persistence",
                updates.len()
            );
            let mut txn = doc.transact_mut();
            let mut decode_errors = 0;
            let mut apply_errors = 0;

            for update_bytes in updates {
                match Update::decode_v1(&update_bytes) {
                    Ok(u) => {
                        if let Err(e) = txn.apply_update(u) {
                            log::error!("Failed to apply Y.Doc update: {}", e);
                            apply_errors += 1;
                        }
                    }
                    Err(e) => {
                        log::error!("Corrupted Y.Doc update, cannot decode: {}", e);
                        decode_errors += 1;
                    }
                }
            }

            if decode_errors > 0 || apply_errors > 0 {
                log::warn!(
                    "Y.Doc replay completed with {} decode errors, {} apply errors",
                    decode_errors,
                    apply_errors
                );
            }
        }

        Ok(Self {
            doc: Arc::new(RwLock::new(doc)),
            persistence,
            doc_key: doc_key.to_string(),
            updates_since_compact_check: AtomicI64::new(0),
        })
    }

    /// Get a clone of the Arc<RwLock<Doc>> for shared access.
    ///
    /// This is used by systems that need direct Y.Doc access (e.g., Tauri commands).
    pub fn doc(&self) -> Arc<RwLock<Doc>> {
        Arc::clone(&self.doc)
    }

    /// Get the full document state as an update (for sync).
    pub fn get_full_state(&self) -> Result<Vec<u8>, StoreError> {
        let doc = self.doc.read().map_err(|_| StoreError::LockPoisoned)?;
        let state_vector = StateVector::default();
        let update = doc.transact().encode_state_as_update_v1(&state_vector);
        Ok(update)
    }

    /// Apply an update from a remote client.
    ///
    /// Persists first, then applies to memory. This prevents memory/DB divergence
    /// if the DB write fails.
    ///
    /// Use this for updates received from external sources (HTTP POST /update).
    pub fn apply_update(&self, update_bytes: &[u8]) -> Result<(), StoreError> {
        // Validate update format before any mutations
        let update = Update::decode_v1(update_bytes)
            .map_err(|e| StoreError::UpdateDecode(e.to_string()))?;

        // PERSIST FIRST: Write to DB before applying to memory
        self.persistence
            .append_update(&self.doc_key, update_bytes)?;

        // Now apply to in-memory doc
        let doc = self.doc.write().map_err(|_| StoreError::LockPoisoned)?;
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update)
                .map_err(|e| StoreError::UpdateApply(e.to_string()))?;
        }

        // Check for compaction (periodic, not on every update)
        self.maybe_compact(&doc)?;

        Ok(())
    }

    /// Persist an update that was already applied to the in-memory doc.
    ///
    /// Use this when you've already mutated the Y.Doc via transact_mut() and
    /// just need to persist the encoded update. Avoids double-application.
    pub fn persist_update(&self, update_bytes: &[u8]) -> Result<(), StoreError> {
        // Validate update format
        let _ = Update::decode_v1(update_bytes)
            .map_err(|e| StoreError::UpdateDecode(e.to_string()))?;

        // Persist only - memory already has the changes
        self.persistence
            .append_update(&self.doc_key, update_bytes)?;

        // Check for compaction using current doc state
        let doc = self.doc.read().map_err(|_| StoreError::LockPoisoned)?;
        self.maybe_compact(&doc)?;

        Ok(())
    }

    /// Check if compaction is needed and perform it.
    fn maybe_compact(&self, doc: &Doc) -> Result<(), StoreError> {
        let updates_since_check = self
            .updates_since_compact_check
            .fetch_add(1, Ordering::Relaxed)
            + 1;

        if updates_since_check >= COMPACT_CHECK_INTERVAL {
            self.updates_since_compact_check.store(0, Ordering::Relaxed);

            let update_count = self.persistence.get_update_count(&self.doc_key)?;
            if update_count > COMPACT_THRESHOLD {
                let full_state = doc
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default());
                if let Err(e) = self.persistence.compact(&self.doc_key, &full_state) {
                    log::warn!(
                        "Y.Doc compaction failed (will retry later): {}. Update count: {}",
                        e,
                        update_count
                    );
                }
            }
        }

        Ok(())
    }

    /// Force compaction now (useful for testing or explicit cleanup).
    pub fn force_compact(&self) -> Result<(), StoreError> {
        let doc = self.doc.read().map_err(|_| StoreError::LockPoisoned)?;
        let full_state = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        self.persistence.compact(&self.doc_key, &full_state)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use yrs::{Map, Transact, WriteTxn};

    #[test]
    fn test_store_creation() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = YDocStore::open(&db_path, "test").unwrap();

        // Should start empty
        let state = store.get_full_state().unwrap();
        assert!(!state.is_empty()); // Y.Doc always has some state
    }

    #[test]
    fn test_apply_update_persists() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        // Create store and apply an update
        {
            let store = YDocStore::open(&db_path, "test").unwrap();
            let doc = store.doc();
            let doc_guard = doc.write().unwrap();

            // Create a test update
            let update = {
                let mut txn = doc_guard.transact_mut();
                let blocks = txn.get_or_insert_map("blocks");
                blocks.insert(&mut txn, "test-id", "test-content");
                txn.encode_update_v1()
            };

            drop(doc_guard);
            store.apply_update(&update).unwrap();
        }

        // Reopen store and verify data persisted
        {
            let store = YDocStore::open(&db_path, "test").unwrap();
            let doc = store.doc();
            let doc_guard = doc.read().unwrap();
            let txn = doc_guard.transact();
            let blocks = txn.get_map("blocks").unwrap();
            let value = blocks.get(&txn, "test-id").map(|v| v.to_string(&txn));
            assert_eq!(value, Some("test-content".to_string()));
        }
    }

    #[test]
    fn test_force_compact() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = YDocStore::open(&db_path, "test").unwrap();

        // Apply several updates
        let doc = store.doc();
        for i in 0..10 {
            let doc_guard = doc.write().unwrap();
            let key = format!("key-{}", i);
            let value = format!("value-{}", i);
            let update = {
                let mut txn = doc_guard.transact_mut();
                let blocks = txn.get_or_insert_map("blocks");
                blocks.insert(&mut txn, key.as_str(), value.as_str());
                txn.encode_update_v1()
            };
            drop(doc_guard);
            store.apply_update(&update).unwrap();
        }

        // Force compact
        store.force_compact().unwrap();

        // Verify we can still read all data
        let doc_guard = doc.read().unwrap();
        let txn = doc_guard.transact();
        let blocks = txn.get_map("blocks").unwrap();
        for i in 0..10 {
            let key = format!("key-{}", i);
            let value = blocks.get(&txn, key.as_str()).map(|v| v.to_string(&txn));
            assert_eq!(value, Some(format!("value-{}", i)));
        }
    }
}
