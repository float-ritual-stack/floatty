//! Block store backed by Y.Doc (yrs) with SQLite persistence.
//!
//! This provides the core block operations for Floatty, independent of Tauri.
//! The frontend Y.Doc (yjs) syncs with this via update deltas.
//!
//! # Change Observation
//!
//! The store can emit BlockChange events when blocks are created, modified, or deleted.
//! This enables hooks (like metadata extraction) to react to all mutations.
//!
//! ## Functions That Emit BlockChange Callbacks
//!
//! Currently only `apply_update()` emits callbacks (for Y.Doc sync from frontend).
//! REST API handlers in floatty-server also emit changes via direct hook calls,
//! bypassing the callback mechanism.
//!
//! ```rust,ignore
//! let store = YDocStore::open(path, key)?;
//! store.set_change_callback(|changes| {
//!     for change in changes {
//!         hook_system.emit_change(change);
//!     }
//! });
//! ```
//!
//! `compute_changes()` receives an explicit `Origin` so callback consumers can
//! filter accurately (e.g., ignore remote-origin metadata updates).

use crate::events::BlockChange;
use crate::persistence::{PersistenceError, YDocPersistence};
use crate::Origin;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, RwLock};
use thiserror::Error;
use tracing::{debug, trace};
use yrs::{any, Doc, Map, MapPrelim, Out, ReadTxn, StateVector, Transact, Update, WriteTxn, updates::decoder::Decode, updates::encoder::Encode};

use crate::metadata::BlockMetadata;

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

/// Convert BlockMetadata to a Y.Map structure for CRDT storage.
///
/// This enables frontend to read metadata directly without JSON parsing.
/// The structure is:
/// ```json
/// {
///   "markers": [{ "markerType": "project", "value": "floatty" }, ...],
///   "outlinks": ["Page Name", ...],
///   "isStub": false,
///   "extractedAt": 1234567890
/// }
/// ```
fn metadata_to_ymap(metadata: &BlockMetadata) -> MapPrelim {
    // Convert markers Vec<Marker> to array of yrs::Any maps
    let markers_array: Vec<yrs::Any> = metadata
        .markers
        .iter()
        .map(|m| {
            let mut marker_map = std::collections::HashMap::new();
            marker_map.insert("markerType".to_string(), any!(m.marker_type.clone()));
            if let Some(ref v) = m.value {
                marker_map.insert("value".to_string(), any!(v.clone()));
            }
            yrs::Any::Map(marker_map.into())
        })
        .collect();

    // Convert outlinks Vec<String> to array of strings
    let outlinks_array: Vec<yrs::Any> = metadata
        .outlinks
        .iter()
        .map(|s| any!(s.clone()))
        .collect();

    // extractedAt: include as f64 or null
    let extracted_at: yrs::Any = match metadata.extracted_at {
        Some(ts) => any!(ts as f64),
        None => yrs::Any::Null,
    };

    // Build the metadata map with fixed-size array
    MapPrelim::from([
        ("markers".to_owned(), yrs::Any::Array(markers_array.into())),
        ("outlinks".to_owned(), yrs::Any::Array(outlinks_array.into())),
        ("isStub".to_owned(), any!(metadata.is_stub)),
        ("extractedAt".to_owned(), extracted_at),
    ])
}

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
    ///
    /// # Errors
    /// Returns an error if the internal lock is poisoned.
    pub fn set_change_callback<F>(&self, callback: F) -> Result<(), String>
    where
        F: Fn(Vec<BlockChange>) + Send + Sync + 'static,
    {
        match self.change_callback.write() {
            Ok(mut cb) => {
                *cb = Some(Arc::new(callback));
                Ok(())
            }
            Err(e) => Err(format!("Failed to set change callback (lock poisoned): {}", e)),
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
        origin: Origin,
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
                        origin,
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
                            origin,
                        });
                        trace!(block_id = %id, "Detected content change");
                    }

                    // Check for parent change (move)
                    if before_snap.parent_id != after_snap.parent_id {
                        changes.push(BlockChange::Moved {
                            id: id.clone(),
                            old_parent_id: before_snap.parent_id.clone(),
                            new_parent_id: after_snap.parent_id.clone(),
                            origin,
                        });
                        trace!(block_id = %id, "Detected block moved");
                    }

                    // Check for collapsed change
                    if before_snap.collapsed != after_snap.collapsed {
                        changes.push(BlockChange::CollapsedChanged {
                            id: id.clone(),
                            collapsed: after_snap.collapsed,
                            origin,
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
                    origin,
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
        // Content defaults to empty string if key missing (don't fail the whole get_block)
        let content = block_map
            .get(&txn, "content")
            .and_then(|v| match v {
                Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                _ => None,
            })
            .unwrap_or_default();

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
    /// Returns the sequence number assigned to this update in the persistence layer.
    /// This can be used for gap detection and incremental sync.
    ///
    /// If a change callback is registered, this method will:
    /// 1. Snapshot current block state
    /// 2. Apply the update
    /// 3. Diff to detect changes
    /// 4. Invoke the callback with BlockChange events
    pub fn apply_update(&self, update_bytes: &[u8]) -> Result<i64, StoreError> {
        // Validate update format before any mutations
        let update = Update::decode_v1(update_bytes)
            .map_err(|e| StoreError::UpdateDecode(e.to_string()))?;

        // PERSIST FIRST: Write to DB before applying to memory
        // Returns the sequence number assigned to this update
        let seq = self.persistence
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
            // apply_update() consumes updates sent from external clients over sync APIs.
            // Tag emitted changes as Remote so hook origin filters behave correctly.
            let changes = self.compute_changes(&before, &after, Origin::Remote);
            if !changes.is_empty() {
                debug!(change_count = changes.len(), "apply_update: detected changes, emitting to hooks");
            }
            drop(doc); // Release lock before callback
            self.emit_changes(changes);
        }

        Ok(seq)
    }

    /// Persist an update that was already applied to the in-memory doc.
    ///
    /// Use this when you've already mutated the Y.Doc via transact_mut() and
    /// just need to persist the encoded update. Avoids double-application.
    ///
    /// Returns the sequence number assigned to this update.
    pub fn persist_update(&self, update_bytes: &[u8]) -> Result<i64, StoreError> {
        // Validate update format
        let _ = Update::decode_v1(update_bytes)
            .map_err(|e| StoreError::UpdateDecode(e.to_string()))?;

        // Persist only - memory already has the changes
        let seq = self.persistence
            .append_update(&self.doc_key, update_bytes)?;

        // Check for compaction using current doc state
        let doc = self.doc.read().map_err(|_| StoreError::LockPoisoned)?;
        self.maybe_compact(&doc)?;

        Ok(seq)
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

    // =========================================================================
    // Sequence-based sync methods (FLO-SEQ)
    // =========================================================================

    /// Get updates since a given sequence number.
    ///
    /// Returns tuples of (seq, update_data, created_at) for updates with id > since_seq.
    /// Used for incremental sync - clients track lastSeenSeq and fetch only what they missed.
    pub fn get_updates_since(
        &self,
        since_seq: i64,
        limit: usize,
    ) -> Result<Vec<(i64, Vec<u8>, i64)>, StoreError> {
        self.persistence
            .get_updates_since(&self.doc_key, since_seq, limit)
            .map_err(StoreError::from)
    }

    /// Get the latest sequence number.
    ///
    /// Returns None if no updates exist.
    pub fn get_latest_seq(&self) -> Result<Option<i64>, StoreError> {
        self.persistence
            .get_latest_seq(&self.doc_key)
            .map_err(StoreError::from)
    }

    /// Get the compaction boundary.
    ///
    /// Returns the highest sequence number that was compacted away.
    /// Clients requesting since < compacted_through are too far behind
    /// and should do a full state resync instead of incremental.
    pub fn get_compacted_through(&self) -> Result<Option<i64>, StoreError> {
        self.persistence
            .get_compacted_through(&self.doc_key)
            .map_err(StoreError::from)
    }

    /// Reset the Y.Doc to a new state from a binary backup.
    ///
    /// This is a **destructive operation** that:
    /// 1. Clears all persisted Y.Doc updates
    /// 2. Creates a fresh Y.Doc
    /// 3. Applies the provided state as the new baseline
    /// 4. Persists the new state
    ///
    /// Use this for restore-from-backup scenarios where you want to completely
    /// replace the server's state, not merge with it.
    ///
    /// # Arguments
    /// * `state_bytes` - Raw Y.Doc state (from `Y.encodeStateAsUpdate()`)
    ///
    /// # Returns
    /// * `Ok(block_count)` - Number of blocks in the restored state
    /// * `Err(StoreError)` - If decode/apply fails
    pub fn reset_from_state(&self, state_bytes: &[u8]) -> Result<usize, StoreError> {
        // 1. Decode and validate first (before any destructive ops)
        let update = Update::decode_v1(state_bytes)
            .map_err(|e| StoreError::UpdateDecode(e.to_string()))?;

        // 2. Create a fresh Y.Doc and apply the state
        let new_doc = Doc::new();
        {
            let mut txn = new_doc.transact_mut();
            txn.apply_update(update)
                .map_err(|e| StoreError::UpdateApply(e.to_string()))?;
        }

        // 3. Count blocks in the new state (verify we have data before clearing)
        let block_count = {
            let txn = new_doc.transact();
            txn.get_map("blocks")
                .map(|m| m.len(&txn) as usize)
                .unwrap_or(0)
        };

        // 4. Encode the full state BEFORE clearing (ensures we have valid data)
        let full_state = new_doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());

        // 5. NOW clear persisted state (only after successful decode + apply + encode)
        self.persistence.clear_updates(&self.doc_key)?;

        // 6. Persist the new state
        self.persistence.append_update(&self.doc_key, &full_state)?;

        // 7. Replace the in-memory doc (under write lock for thread safety)
        {
            let mut doc_guard = self.doc.write().map_err(|_| StoreError::LockPoisoned)?;
            *doc_guard = new_doc;
        }

        log::info!(
            "Y.Doc reset complete: {} blocks restored from {} bytes",
            block_count,
            state_bytes.len()
        );

        Ok(block_count)
    }

    /// Get block metadata as JSON Value (for change events).
    ///
    /// Used to capture the old metadata state before mutations.
    fn get_block_metadata_json(&self, block_id: &str) -> Option<serde_json::Value> {
        let doc = self.doc.read().ok()?;
        let txn = doc.transact();
        let blocks_map = txn.get_map("blocks")?;

        let block_map = match blocks_map.get(&txn, block_id)? {
            Out::YMap(map) => map,
            _ => return None,
        };

        block_map
            .get(&txn, "metadata")
            .and_then(|v| match v {
                Out::Any(yrs::Any::String(s)) => {
                    serde_json::from_str::<serde_json::Value>(&s).ok()
                }
                _ => None,
            })
    }

    /// Update metadata for a block.
    ///
    /// Writes metadata as native Y.Doc structure (nested Y.Map with Y.Array).
    /// Used by hooks to write extracted metadata (markers, outlinks, etc.).
    ///
    /// The origin parameter tags the Y.Doc transaction so downstream observers
    /// can filter by source. Hooks should pass `Origin::Hook` to prevent
    /// infinite loops (hook writes triggering the same hook).
    ///
    /// After persisting, emits a `MetadataChanged` event so downstream hooks
    /// (like TantivyIndexHook) can react to the metadata update.
    pub fn update_block_metadata(
        &self,
        block_id: &str,
        metadata: crate::metadata::BlockMetadata,
        origin: crate::Origin,
    ) -> Result<(), StoreError> {
        // Capture old metadata before mutation (for change event)
        let old_metadata = self.get_block_metadata_json(block_id);

        let doc = self.doc.write().map_err(|_| StoreError::LockPoisoned)?;
        let origin_str = origin.to_string();
        let update = {
            let mut txn = doc.transact_mut_with(origin_str.as_str());
            let blocks = txn.get_or_insert_map("blocks");

            // Find the block
            let block_map = match blocks.get(&txn, block_id) {
                Some(Out::YMap(map)) => map,
                _ => {
                    return Err(StoreError::UpdateApply(format!(
                        "Block not found: {}",
                        block_id
                    )));
                }
            };

            // Write metadata as native Y.Doc structure (not JSON string)
            // This enables frontend to read it directly without parsing
            let metadata_map = metadata_to_ymap(&metadata);
            block_map.insert(&mut txn, "metadata", metadata_map);

            txn.encode_update_v1()
        };
        drop(doc);

        // Persist the update
        self.persist_update(&update)?;

        // Emit MetadataChanged event so downstream hooks (TantivyIndexHook) are notified
        let new_metadata = serde_json::to_value(&metadata).ok();
        self.emit_changes(vec![BlockChange::MetadataChanged {
            id: block_id.to_string(),
            old_metadata,
            new_metadata,
            origin,
        }]);

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

    // =========================================================================
    // Change-Observation Flow Tests
    // =========================================================================

    #[test]
    fn test_set_change_callback_receives_changes() {
        use std::sync::Mutex;
        use yrs::{Doc, MapPrelim, Transact};

        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Capture changes via callback
        let captured: Arc<Mutex<Vec<BlockChange>>> = Arc::new(Mutex::new(Vec::new()));
        let captured_clone = Arc::clone(&captured);
        store
            .set_change_callback(move |changes| {
                captured_clone.lock().unwrap().extend(changes);
            })
            .expect("Failed to set change callback");

        // Create a Y.Doc update from a SEPARATE doc (simulates receiving from another client)
        // This is critical: if we mutate the store's own doc, the change is already there
        // when apply_update takes its "before" snapshot.
        let update = {
            let external_doc = Doc::new();
            let mut txn = external_doc.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");
            let block_prelim: MapPrelim = MapPrelim::from([("content", "hello".to_string())]);
            blocks.insert(&mut txn, "block-1", block_prelim);
            txn.encode_update_v1()
        };

        // Apply update (should trigger callback)
        store.apply_update(&update).unwrap();

        // Verify callback received the Created event
        let changes = captured.lock().unwrap();
        assert_eq!(changes.len(), 1);
        assert!(matches!(
            &changes[0],
            BlockChange::Created { id, content, origin, .. }
                if id == "block-1" && content == "hello" && *origin == Origin::Remote
        ));
    }

    #[test]
    fn test_snapshot_blocks_captures_fields() {
        use yrs::MapPrelim;

        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Add a block with content, parentId, and collapsed
        {
            let doc = store.doc();
            let doc_guard = doc.write().unwrap();
            let mut txn = doc_guard.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");
            let block_prelim: MapPrelim = MapPrelim::from([
                ("content", yrs::Any::String("test content".into())),
                ("parentId", yrs::Any::String("parent-1".into())),
                ("collapsed", yrs::Any::Bool(true)),
            ]);
            blocks.insert(&mut txn, "block-1", block_prelim);
        }

        // Snapshot and verify
        let doc = store.doc();
        let doc_guard = doc.read().unwrap();
        let snapshots = store.snapshot_blocks(&doc_guard);

        assert!(snapshots.contains_key("block-1"));
        let snap = &snapshots["block-1"];
        assert_eq!(snap.content, "test content");
        assert_eq!(snap.parent_id, Some("parent-1".to_string()));
        assert!(snap.collapsed);
    }

    #[test]
    fn test_compute_changes_created() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let before: HashMap<String, BlockSnapshot> = HashMap::new();
        let mut after: HashMap<String, BlockSnapshot> = HashMap::new();
        after.insert(
            "b1".to_string(),
            BlockSnapshot {
                content: "new block".to_string(),
                parent_id: Some("root".to_string()),
                collapsed: false,
            },
        );

        let changes = store.compute_changes(&before, &after, Origin::User);

        assert_eq!(changes.len(), 1);
        assert!(matches!(
            &changes[0],
            BlockChange::Created { id, content, parent_id, .. }
                if id == "b1" && content == "new block" && parent_id == &Some("root".to_string())
        ));
    }

    #[test]
    fn test_compute_changes_content_changed() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let mut before: HashMap<String, BlockSnapshot> = HashMap::new();
        before.insert(
            "b1".to_string(),
            BlockSnapshot {
                content: "old".to_string(),
                parent_id: None,
                collapsed: false,
            },
        );

        let mut after: HashMap<String, BlockSnapshot> = HashMap::new();
        after.insert(
            "b1".to_string(),
            BlockSnapshot {
                content: "new".to_string(),
                parent_id: None,
                collapsed: false,
            },
        );

        let changes = store.compute_changes(&before, &after, Origin::User);

        assert_eq!(changes.len(), 1);
        assert!(matches!(
            &changes[0],
            BlockChange::ContentChanged { id, old_content, new_content, .. }
                if id == "b1" && old_content == "old" && new_content == "new"
        ));
    }

    #[test]
    fn test_compute_changes_moved() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let mut before: HashMap<String, BlockSnapshot> = HashMap::new();
        before.insert(
            "b1".to_string(),
            BlockSnapshot {
                content: "block".to_string(),
                parent_id: Some("parent-A".to_string()),
                collapsed: false,
            },
        );

        let mut after: HashMap<String, BlockSnapshot> = HashMap::new();
        after.insert(
            "b1".to_string(),
            BlockSnapshot {
                content: "block".to_string(),
                parent_id: Some("parent-B".to_string()),
                collapsed: false,
            },
        );

        let changes = store.compute_changes(&before, &after, Origin::User);

        assert_eq!(changes.len(), 1);
        assert!(matches!(
            &changes[0],
            BlockChange::Moved { id, old_parent_id, new_parent_id, .. }
                if id == "b1"
                    && old_parent_id == &Some("parent-A".to_string())
                    && new_parent_id == &Some("parent-B".to_string())
        ));
    }

    #[test]
    fn test_compute_changes_collapsed_changed() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let mut before: HashMap<String, BlockSnapshot> = HashMap::new();
        before.insert(
            "b1".to_string(),
            BlockSnapshot {
                content: "block".to_string(),
                parent_id: None,
                collapsed: false,
            },
        );

        let mut after: HashMap<String, BlockSnapshot> = HashMap::new();
        after.insert(
            "b1".to_string(),
            BlockSnapshot {
                content: "block".to_string(),
                parent_id: None,
                collapsed: true,
            },
        );

        let changes = store.compute_changes(&before, &after, Origin::User);

        assert_eq!(changes.len(), 1);
        assert!(matches!(
            &changes[0],
            BlockChange::CollapsedChanged { id, collapsed, .. }
                if id == "b1" && *collapsed == true
        ));
    }

    #[test]
    fn test_compute_changes_deleted() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let mut before: HashMap<String, BlockSnapshot> = HashMap::new();
        before.insert(
            "b1".to_string(),
            BlockSnapshot {
                content: "deleted block".to_string(),
                parent_id: None,
                collapsed: false,
            },
        );

        let after: HashMap<String, BlockSnapshot> = HashMap::new();

        let changes = store.compute_changes(&before, &after, Origin::User);

        assert_eq!(changes.len(), 1);
        assert!(matches!(
            &changes[0],
            BlockChange::Deleted { id, content, .. }
                if id == "b1" && content == "deleted block"
        ));
    }

    #[test]
    fn test_emit_changes_no_callback() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Don't set a callback - should not panic
        store.emit_changes(vec![BlockChange::Created {
            id: "b1".to_string(),
            content: "test".to_string(),
            parent_id: None,
            origin: Origin::User,
        }]);

        // Test passes if no panic occurred
    }

    #[test]
    fn test_emit_changes_empty_vec() {
        use std::sync::Mutex;

        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let call_count = Arc::new(Mutex::new(0));
        let call_count_clone = Arc::clone(&call_count);
        store
            .set_change_callback(move |_| {
                *call_count_clone.lock().unwrap() += 1;
            })
            .expect("Failed to set change callback");

        // Emit empty vec - callback should NOT be invoked
        store.emit_changes(vec![]);

        assert_eq!(*call_count.lock().unwrap(), 0);
    }
}
