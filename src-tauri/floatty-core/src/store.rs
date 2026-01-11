//! Block store backed by Y.Doc (yrs) with SQLite persistence.
//!
//! This provides the core block operations for Floatty, independent of Tauri.
//! The frontend Y.Doc (yjs) syncs with this via update deltas.
//!
//! # Change Observation
//!
//! The store can emit BlockChange events when blocks are created, modified, or deleted.
//! This enables hooks (like metadata extraction) to react to all mutations,
//! regardless of whether they came from the REST API or Y.Doc sync.
//!
//! ```rust,ignore
//! let store = YDocStore::open(path, key)?;
//! store.set_change_callback(|changes| {
//!     for change in changes {
//!         hook_system.emit_change(change);
//!     }
//! });
//! ```

use crate::events::BlockChange;
use crate::persistence::{PersistenceError, YDocPersistence};
use crate::Origin;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use thiserror::Error;
use tracing::{debug, trace, warn};
use yrs::{Doc, Map, Out, ReadTxn, StateVector, Transact, Update, WriteTxn, updates::decoder::Decode, updates::encoder::Encode};

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

/// Callback type for change notifications.
pub type ChangeCallback = Arc<dyn Fn(Vec<BlockChange>) + Send + Sync>;

/// Minimal block snapshot for change detection.
/// Only stores fields needed for BlockChange generation.
#[derive(Clone, Debug)]
struct BlockSnapshot {
    content: String,
    parent_id: Option<String>,
    collapsed: bool,
}

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
    /// Optional callback for block change notifications.
    /// Set via `set_change_callback()` to enable hook integration.
    change_callback: RwLock<Option<ChangeCallback>>,
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
            change_callback: RwLock::new(None),
        })
    }

    /// Get a clone of the Arc<RwLock<Doc>> for shared access.
    ///
    /// This is used by systems that need direct Y.Doc access (e.g., Tauri commands).
    pub fn doc(&self) -> Arc<RwLock<Doc>> {
        Arc::clone(&self.doc)
    }

    /// Set a callback to receive block change notifications.
    ///
    /// This callback is invoked after each `apply_update()` with the list of
    /// BlockChange events detected. Use this to wire up the HookSystem for
    /// metadata extraction, search indexing, etc.
    ///
    /// The callback is called synchronously after the update is applied and persisted.
    pub fn set_change_callback<F>(&self, callback: F)
    where
        F: Fn(Vec<BlockChange>) + Send + Sync + 'static,
    {
        match self.change_callback.write() {
            Ok(mut cb) => *cb = Some(Arc::new(callback)),
            Err(e) => warn!("Failed to set change callback (lock poisoned): {}", e),
        }
    }

    /// Take a snapshot of all blocks for change detection.
    ///
    /// Returns a map of block_id -> BlockSnapshot.
    fn snapshot_blocks(&self, doc: &Doc) -> HashMap<String, BlockSnapshot> {
        let txn = doc.transact();
        let mut snapshots = HashMap::new();

        if let Some(blocks_map) = txn.get_map("blocks") {
            for (key, value) in blocks_map.iter(&txn) {
                if let Out::YMap(block_map) = value {
                    let content = block_map
                        .get(&txn, "content")
                        .and_then(|v| match v {
                            Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                            _ => None,
                        })
                        .unwrap_or_default();

                    let parent_id = block_map.get(&txn, "parentId").and_then(|v| match v {
                        Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    });

                    let collapsed = block_map
                        .get(&txn, "collapsed")
                        .and_then(|v| match v {
                            Out::Any(yrs::Any::Bool(b)) => Some(b),
                            _ => None,
                        })
                        .unwrap_or(false);

                    snapshots.insert(
                        key.to_string(),
                        BlockSnapshot {
                            content,
                            parent_id,
                            collapsed,
                        },
                    );
                }
            }
        }

        snapshots
    }

    /// Compute BlockChange events by diffing before/after snapshots.
    fn compute_changes(
        &self,
        before: &HashMap<String, BlockSnapshot>,
        after: &HashMap<String, BlockSnapshot>,
    ) -> Vec<BlockChange> {
        let mut changes = Vec::new();

        // Check for created and modified blocks
        for (id, after_snap) in after {
            match before.get(id) {
                None => {
                    // New block created
                    changes.push(BlockChange::Created {
                        id: id.clone(),
                        content: after_snap.content.clone(),
                        parent_id: after_snap.parent_id.clone(),
                        origin: Origin::User, // Updates from frontend are "remote" to server
                    });
                    trace!(block_id = %id, "Detected block created");
                }
                Some(before_snap) => {
                    // Check for content change
                    if before_snap.content != after_snap.content {
                        changes.push(BlockChange::ContentChanged {
                            id: id.clone(),
                            old_content: before_snap.content.clone(),
                            new_content: after_snap.content.clone(),
                            origin: Origin::User,
                        });
                        trace!(block_id = %id, "Detected content change");
                    }

                    // Check for parent change (move)
                    if before_snap.parent_id != after_snap.parent_id {
                        changes.push(BlockChange::Moved {
                            id: id.clone(),
                            old_parent_id: before_snap.parent_id.clone(),
                            new_parent_id: after_snap.parent_id.clone(),
                            origin: Origin::User,
                        });
                        trace!(block_id = %id, "Detected block moved");
                    }

                    // Check for collapsed change
                    if before_snap.collapsed != after_snap.collapsed {
                        changes.push(BlockChange::CollapsedChanged {
                            id: id.clone(),
                            collapsed: after_snap.collapsed,
                            origin: Origin::User,
                        });
                        trace!(block_id = %id, collapsed = after_snap.collapsed, "Detected collapsed change");
                    }
                }
            }
        }

        // Check for deleted blocks
        for (id, before_snap) in before {
            if !after.contains_key(id) {
                changes.push(BlockChange::Deleted {
                    id: id.clone(),
                    content: before_snap.content.clone(),
                    origin: Origin::User,
                });
                trace!(block_id = %id, "Detected block deleted");
            }
        }

        changes
    }

    /// Emit changes through the registered callback.
    fn emit_changes(&self, changes: Vec<BlockChange>) {
        if changes.is_empty() {
            return;
        }

        debug!(change_count = changes.len(), "Emitting block changes from Y.Doc update");

        if let Ok(cb_guard) = self.change_callback.read() {
            if let Some(callback) = cb_guard.as_ref() {
                callback(changes);
            }
        }
    }

    /// Get the full document state as an update (for sync).
    pub fn get_full_state(&self) -> Result<Vec<u8>, StoreError> {
        let doc = self.doc.read().map_err(|_| StoreError::LockPoisoned)?;
        let state_vector = StateVector::default();
        let update = doc.transact().encode_state_as_update_v1(&state_vector);
        Ok(update)
    }

    /// Get the state vector (for reconciliation without full state transfer).
    ///
    /// The state vector encodes what updates are already in the doc.
    /// Clients can use this to compute a diff (what they have that server doesn't).
    pub fn get_state_vector(&self) -> Result<Vec<u8>, StoreError> {
        let doc = self.doc.read().map_err(|_| StoreError::LockPoisoned)?;
        let sv = doc.transact().state_vector().encode_v1();
        Ok(sv)
    }

    /// Get a block by ID from the Y.Doc.
    ///
    /// Returns None if the block doesn't exist.
    /// Used by hooks to read block data (e.g., metadata, parent_id).
    pub fn get_block(&self, block_id: &str) -> Option<crate::block::Block> {
        use yrs::{Out, Array};

        let doc = self.doc.read().ok()?;
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks")?;

        let block_map = match blocks_map.get(&txn, block_id)? {
            Out::YMap(map) => map,
            _ => return None,
        };

        // Extract fields from Y.Map
        let content = match block_map.get(&txn, "content")? {
            Out::Any(yrs::Any::String(s)) => s.to_string(),
            _ => String::new(),
        };

        let parent_id = block_map
            .get(&txn, "parentId")
            .and_then(|v| match v {
                Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                _ => None,
            });

        let child_ids = block_map
            .get(&txn, "childIds")
            .and_then(|v| match v {
                Out::YArray(arr) => {
                    let ids: Vec<String> = arr
                        .iter(&txn)
                        .filter_map(|v| match v {
                            Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                            _ => None,
                        })
                        .collect();
                    Some(ids)
                }
                _ => None,
            })
            .unwrap_or_default();

        let collapsed = block_map
            .get(&txn, "collapsed")
            .and_then(|v| match v {
                Out::Any(yrs::Any::Bool(b)) => Some(b),
                _ => None,
            })
            .unwrap_or(false);

        let created_at = block_map
            .get(&txn, "createdAt")
            .and_then(|v| match v {
                Out::Any(yrs::Any::BigInt(n)) => Some(n),
                Out::Any(yrs::Any::Number(n)) => Some(n as i64),
                _ => None,
            })
            .unwrap_or(0);

        let updated_at = block_map
            .get(&txn, "updatedAt")
            .and_then(|v| match v {
                Out::Any(yrs::Any::BigInt(n)) => Some(n),
                Out::Any(yrs::Any::Number(n)) => Some(n as i64),
                _ => None,
            })
            .unwrap_or(0);

        let metadata = block_map
            .get(&txn, "metadata")
            .and_then(|v| match v {
                Out::Any(yrs::Any::String(s)) => {
                    serde_json::from_str::<crate::metadata::BlockMetadata>(&s).ok()
                }
                _ => None,
            });

        Some(crate::block::Block {
            id: block_id.to_string(),
            parent_id,
            child_ids,
            content,
            collapsed,
            created_at,
            updated_at,
            metadata,
        })
    }

    /// Apply an update from a remote client.
    ///
    /// Persists first, then applies to memory. This prevents memory/DB divergence
    /// if the DB write fails.
    ///
    /// Use this for updates received from external sources (HTTP POST /update).
    ///
    /// If a change callback is registered, this method will:
    /// 1. Snapshot current block state
    /// 2. Apply the update
    /// 3. Diff to detect changes
    /// 4. Invoke the callback with BlockChange events
    pub fn apply_update(&self, update_bytes: &[u8]) -> Result<(), StoreError> {
        // Validate update format before any mutations
        let update = Update::decode_v1(update_bytes)
            .map_err(|e| StoreError::UpdateDecode(e.to_string()))?;

        // PERSIST FIRST: Write to DB before applying to memory
        self.persistence
            .append_update(&self.doc_key, update_bytes)?;

        // Now apply to in-memory doc
        let doc = self.doc.write().map_err(|_| StoreError::LockPoisoned)?;

        // Check if we have a callback - only snapshot if needed
        let has_callback = self
            .change_callback
            .read()
            .map(|cb| cb.is_some())
            .unwrap_or(false);

        trace!(has_callback = has_callback, "apply_update: checking for change callback");

        let before_snapshot = if has_callback {
            let snap = self.snapshot_blocks(&doc);
            trace!(block_count = snap.len(), "apply_update: took before snapshot");
            Some(snap)
        } else {
            None
        };

        // Apply the update
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update)
                .map_err(|e| StoreError::UpdateApply(e.to_string()))?;
        }

        // Check for compaction (periodic, not on every update)
        self.maybe_compact(&doc)?;

        // Compute and emit changes if callback is registered
        if let Some(before) = before_snapshot {
            let after = self.snapshot_blocks(&doc);
            trace!(before_count = before.len(), after_count = after.len(), "apply_update: comparing snapshots");
            let changes = self.compute_changes(&before, &after);
            if !changes.is_empty() {
                debug!(change_count = changes.len(), "apply_update: detected changes, emitting to hooks");
            }
            drop(doc); // Release lock before callback
            self.emit_changes(changes);
        }

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

    /// Update metadata for a block.
    ///
    /// Serializes the metadata to JSON and stores it in the block's Y.Map.
    /// Used by hooks to write extracted metadata (markers, outlinks, etc.).
    ///
    /// Note: This creates a Y.Doc transaction with no origin tracking.
    /// Hooks should handle their own infinite loop prevention via `accepts_origins()`.
    pub fn update_block_metadata(
        &self,
        block_id: &str,
        metadata: crate::metadata::BlockMetadata,
    ) -> Result<(), StoreError> {
        let doc = self.doc.write().map_err(|_| StoreError::LockPoisoned)?;
        let update = {
            let mut txn = doc.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");

            // Find the block
            let block_map = match blocks.get(&txn, block_id) {
                Some(yrs::Out::YMap(map)) => map,
                _ => {
                    return Err(StoreError::UpdateApply(format!(
                        "Block not found: {}",
                        block_id
                    )));
                }
            };

            // Serialize metadata to JSON string (matches API pattern)
            let metadata_json = serde_json::to_string(&metadata)
                .map_err(|e| StoreError::UpdateApply(format!("Metadata serialization failed: {}", e)))?;

            block_map.insert(&mut txn, "metadata", metadata_json);

            txn.encode_update_v1()
        };
        drop(doc);

        // Persist the update
        self.persist_update(&update)?;

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
