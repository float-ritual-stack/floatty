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
use yrs::{any, Array, Doc, Map, MapPrelim, Out, ReadTxn, StateVector, Transact, Update, WriteTxn, updates::decoder::Decode, updates::encoder::Encode};

use crate::metadata::BlockMetadata;

/// Default doc key for the outliner.
pub const DEFAULT_DOC_KEY: &str = "default";

/// Schema version: bump when block format changes incompatibly.
/// v1: Plain JSON objects in Y.Map
/// v2: Nested Y.Map with Y.Array for childIds
const SCHEMA_VERSION: i32 = 2;

/// Compact when update count exceeds this threshold.
const COMPACT_THRESHOLD: i64 = 100;

/// Parse block metadata from a Y.Doc value.
///
/// Handles three formats:
/// - `Out::Any(yrs::Any::String(s))` — legacy JSON string (pre-hook blocks)
/// - `Out::Any(yrs::Any::Map(map))` — Any::Map (frontend JS object → yrs serialization)
/// - `Out::YMap(map)` — nested Y.Map (if metadata stored as collaborative type)
fn parse_metadata_from_out<T: ReadTxn>(value: Out, txn: &T) -> Option<BlockMetadata> {
    match value {
        Out::Any(yrs::Any::String(s)) => {
            serde_json::from_str::<BlockMetadata>(&s)
                .map_err(|e| tracing::warn!("parse_metadata_from_out: Any::String failed: {e}"))
                .ok()
        }
        Out::Any(yrs::Any::Map(map)) => {
            // Convert Any::Map to JSON, then deserialize
            let json = yrs_any_map_to_json(&map);
            let key_count = map.len();
            serde_json::from_value::<BlockMetadata>(json)
                .map_err(|e| tracing::warn!("parse_metadata_from_out: Any::Map failed: {e}, keys={key_count}"))
                .ok()
        }
        Out::YMap(map) => {
            // Convert Y.Map to JSON, then deserialize
            let json = yrs_ymap_to_json(&map, txn);
            let key_count = map.len(txn);
            serde_json::from_value::<BlockMetadata>(json)
                .map_err(|e| tracing::warn!("parse_metadata_from_out: YMap failed: {e}, keys={key_count}"))
                .ok()
        }
        Out::Any(yrs::Any::Undefined | yrs::Any::Null) => None,
        other => {
            tracing::warn!("parse_metadata_from_out: unhandled Out variant: {other:?}");
            None
        }
    }
}

/// Convert a yrs::Any::Map (HashMap<String, Any>) to serde_json::Value.
fn yrs_any_map_to_json(map: &std::sync::Arc<HashMap<String, yrs::Any>>) -> serde_json::Value {
    let json_map: serde_json::Map<String, serde_json::Value> = map
        .iter()
        .map(|(k, v)| (k.clone(), yrs_any_to_json(v)))
        .collect();
    serde_json::Value::Object(json_map)
}

/// Convert a Y.Map to serde_json::Value.
fn yrs_ymap_to_json<T: ReadTxn>(map: &yrs::MapRef, txn: &T) -> serde_json::Value {
    let mut json_map = serde_json::Map::new();
    for (key, val) in map.iter(txn) {
        json_map.insert(key.to_string(), yrs_out_to_json(val, txn));
    }
    serde_json::Value::Object(json_map)
}

/// Convert yrs::Out to serde_json::Value (recursive).
fn yrs_out_to_json<T: ReadTxn>(out: Out, txn: &T) -> serde_json::Value {
    match out {
        Out::YMap(map) => yrs_ymap_to_json(&map, txn),
        Out::YArray(arr) => {
            let items: Vec<serde_json::Value> = arr.iter(txn).map(|v| yrs_out_to_json(v, txn)).collect();
            serde_json::Value::Array(items)
        }
        Out::Any(any) => yrs_any_to_json(&any),
        _ => serde_json::Value::Null,
    }
}

/// Convert a yrs::Any to serde_json::Value.
fn yrs_any_to_json(any: &yrs::Any) -> serde_json::Value {
    match any {
        yrs::Any::Null | yrs::Any::Undefined => serde_json::Value::Null,
        yrs::Any::Bool(b) => serde_json::Value::Bool(*b),
        yrs::Any::Number(n) => serde_json::json!(*n),
        yrs::Any::BigInt(n) => serde_json::json!(*n),
        yrs::Any::String(s) => serde_json::Value::String(s.to_string()),
        yrs::Any::Array(arr) => {
            let items: Vec<serde_json::Value> = arr.iter().map(yrs_any_to_json).collect();
            serde_json::Value::Array(items)
        }
        yrs::Any::Map(map) => yrs_any_map_to_json(map),
        yrs::Any::Buffer(_) => serde_json::Value::Null,
    }
}

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

    // extractedAt: store as BigInt (i64) — NOT f64.
    // yrs::Any::Number is f64 which serde rejects for Option<i64> on read-back.
    let extracted_at: yrs::Any = match metadata.extracted_at {
        Some(ts) => yrs::Any::BigInt(ts),
        None => yrs::Any::Null,
    };

    // Build the metadata map — optional fields use Null when absent
    let summary: yrs::Any = match &metadata.summary {
        Some(s) => any!(s.clone()),
        None => yrs::Any::Null,
    };
    let rendered_markdown: yrs::Any = match &metadata.rendered_markdown {
        Some(rm) => any!(rm.clone()),
        None => yrs::Any::Null,
    };
    MapPrelim::from([
        ("markers".to_owned(), yrs::Any::Array(markers_array.into())),
        ("outlinks".to_owned(), yrs::Any::Array(outlinks_array.into())),
        ("isStub".to_owned(), any!(metadata.is_stub)),
        ("extractedAt".to_owned(), extracted_at),
        ("summary".to_owned(), summary),
        ("renderedMarkdown".to_owned(), rendered_markdown),
    ])
}

/// Callback type for change notifications.
pub type ChangeCallback = Arc<dyn Fn(Vec<BlockChange>) + Send + Sync>;

/// Callback type for broadcasting hook-generated updates via WebSocket.
/// Parameters: (update_bytes, seq_number)
pub type BroadcastCallback = Box<dyn Fn(Vec<u8>, i64) + Send + Sync>;

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
    /// Optional callback to broadcast hook-generated updates via WebSocket.
    /// Set via `set_broadcast_callback()`. Called by hook metadata methods
    /// (batch_update_metadata, update_block_metadata) so their seq numbers
    /// appear in the WS stream instead of creating invisible gaps (FLO-391).
    broadcast_callback: std::sync::Mutex<Option<BroadcastCallback>>,
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
        let open_start = std::time::Instant::now();

        let db_open_start = std::time::Instant::now();
        let persistence = YDocPersistence::open(db_path)?;
        log::info!(
            "[startup] db_open elapsed_ms={} path={}",
            db_open_start.elapsed().as_millis(),
            db_path.display()
        );

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
        let update_count = updates.len();
        let total_bytes: usize = updates.iter().map(|u| u.len()).sum();

        if !updates.is_empty() {
            log::info!(
                "[startup] ydoc_replay_start update_count={} total_bytes={}",
                update_count,
                total_bytes
            );
            let replay_start = std::time::Instant::now();
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
            log::info!(
                "[startup] ydoc_replay_complete elapsed_ms={} update_count={} total_bytes={}",
                replay_start.elapsed().as_millis(),
                update_count,
                total_bytes
            );
        }

        log::info!(
            "[startup] ydoc_store_open_complete elapsed_ms={}",
            open_start.elapsed().as_millis()
        );

        Ok(Self {
            doc: Arc::new(RwLock::new(doc)),
            persistence,
            doc_key: doc_key.to_string(),
            updates_since_compact_check: AtomicI64::new(0),
            change_callback: RwLock::new(None),
            broadcast_callback: std::sync::Mutex::new(None),
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

    /// Set a callback to broadcast hook-generated updates via WebSocket (FLO-391).
    ///
    /// Hook methods (`batch_update_metadata`, `update_block_metadata`) call `persist_update()`
    /// which consumes real seq numbers but doesn't broadcast. Without this callback, those
    /// seqs become invisible gaps that trigger client-side gap-fill request storms.
    ///
    /// The callback receives `(update_bytes, seq)` and should broadcast via WebSocket
    /// with no txId (so clients treat hook updates as external messages).
    pub fn set_broadcast_callback(&self, cb: impl Fn(Vec<u8>, i64) + Send + Sync + 'static) {
        *self.broadcast_callback.lock().unwrap() = Some(Box::new(cb));
    }

    /// Fire the broadcast callback if set.
    /// Called after hook metadata methods persist their updates.
    fn fire_broadcast(&self, update: &[u8], seq: i64) {
        if let Ok(guard) = self.broadcast_callback.lock() {
            if let Some(ref cb) = *guard {
                cb(update.to_vec(), seq);
            }
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

    /// Get all block IDs from the Y.Doc blocks map.
    ///
    /// Returns empty vec if the blocks map doesn't exist or lock fails.
    /// Used by InheritanceIndexHook to do a full rebuild.
    pub fn get_all_block_ids(&self) -> Vec<String> {
        let doc = match self.doc.read() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let txn = doc.transact();
        match txn.get_map("blocks") {
            Some(blocks_map) => blocks_map.keys(&txn).map(|k| k.to_string()).collect(),
            None => Vec::new(),
        }
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
            .and_then(|v| parse_metadata_from_out(v, &txn));

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
                    serde_json::from_str::<serde_json::Value>(&s)
                        .map_err(|e| tracing::warn!("get_block_metadata_json: parse failed: {e}"))
                        .ok()
                }
                Out::Any(yrs::Any::Map(map)) => {
                    Some(yrs_any_map_to_json(&map))
                }
                Out::YMap(map) => {
                    Some(yrs_ymap_to_json(&map, &txn))
                }
                Out::Any(yrs::Any::Undefined | yrs::Any::Null) => None,
                other => {
                    tracing::warn!("get_block_metadata_json: unhandled variant: {other:?}");
                    None
                }
            })
    }

    /// Update metadata for multiple blocks in a single Y.Doc transaction.
    ///
    /// Same semantics as `update_block_metadata()` but batches all writes into
    /// one `transact_mut_with()` → one persist → one emit. This reduces write lock
    /// acquisitions from N to 1 (reads still needed per-block for old metadata),
    /// preventing thread starvation when processing
    /// large batches (FLO-361).
    ///
    /// Missing blocks are skipped and logged at debug level (concurrent deletes are expected).
    pub fn batch_update_metadata(
        &self,
        updates: &[(&str, BlockMetadata)],
        origin: Origin,
    ) -> Result<(), StoreError> {
        if updates.is_empty() {
            return Ok(());
        }

        // Capture old metadata for change events (single read lock for all blocks)
        let old_metadata: Vec<(String, Option<serde_json::Value>)> = {
            let doc = self.doc.read().map_err(|_| StoreError::LockPoisoned)?;
            let txn = doc.transact();
            let blocks_map = txn.get_map("blocks");
            updates
                .iter()
                .map(|(id, _)| {
                    let old = blocks_map
                        .as_ref()
                        .and_then(|bm| bm.get(&txn, *id))
                        .and_then(|v| match v {
                            Out::YMap(block_map) => block_map.get(&txn, "metadata"),
                            _ => None,
                        })
                        .and_then(|v| parse_metadata_from_out(v, &txn))
                        .and_then(|m| serde_json::to_value(m).ok());
                    (id.to_string(), old)
                })
                .collect()
        };

        let doc = self.doc.write().map_err(|_| StoreError::LockPoisoned)?;
        let origin_str = origin.to_string();
        let mut written_ids: Vec<(String, BlockMetadata)> = Vec::new();

        let update = {
            let mut txn = doc.transact_mut_with(origin_str.as_str());
            let blocks = txn.get_or_insert_map("blocks");

            for (block_id, metadata) in updates {
                match blocks.get(&txn, *block_id) {
                    Some(Out::YMap(block_map)) => {
                        let metadata_map = metadata_to_ymap(metadata);
                        block_map.insert(&mut txn, "metadata", metadata_map);
                        written_ids.push((block_id.to_string(), metadata.clone()));
                    }
                    _ => {
                        debug!("batch_update_metadata: block {} not found, skipping", block_id);
                    }
                }
            }

            txn.encode_update_v1()
        };
        drop(doc);

        if written_ids.is_empty() {
            return Ok(());
        }

        // Persist the single combined update and broadcast via WS (FLO-391)
        let seq = self.persist_update(&update)?;
        self.fire_broadcast(&update, seq);

        // Emit MetadataChanged events for all written blocks
        let old_map: std::collections::HashMap<&str, Option<serde_json::Value>> = old_metadata
            .iter()
            .map(|(id, m)| (id.as_str(), m.clone()))
            .collect();

        let changes: Vec<BlockChange> = written_ids
            .iter()
            .map(|(id, metadata)| {
                let old = old_map.get(id.as_str()).and_then(|m| m.clone());
                BlockChange::MetadataChanged {
                    id: id.clone(),
                    old_metadata: old,
                    new_metadata: serde_json::to_value(metadata).ok(),
                    origin,
                }
            })
            .collect();

        self.emit_changes(changes);

        Ok(())
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

        // Persist the update and broadcast via WS (FLO-391)
        let seq = self.persist_update(&update)?;
        self.fire_broadcast(&update, seq);

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

    // ═══════════════════════════════════════════════════════════════════════════
    // ENUMERATION / VOCABULARY DISCOVERY
    // ═══════════════════════════════════════════════════════════════════════════

    /// Get distinct marker types with counts across all blocks.
    ///
    /// Returns a sorted vec of (marker_type, count) pairs.
    /// Scans all blocks' metadata — O(n) where n = total blocks.
    pub fn enumerate_marker_types(&self) -> Vec<(String, usize)> {
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

        let doc = match self.doc.read() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let txn = doc.transact();
        let Some(blocks_map) = txn.get_map("blocks") else {
            return Vec::new();
        };

        for (_key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                if let Some(metadata_val) = block_map.get(&txn, "metadata") {
                    if let Some(meta) = parse_metadata_from_out(metadata_val, &txn) {
                        for marker in &meta.markers {
                            *counts.entry(marker.marker_type.clone()).or_default() += 1;
                        }
                    }
                }
            }
        }

        let mut result: Vec<_> = counts.into_iter().collect();
        result.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        result
    }

    /// Get distinct values for a specific marker type.
    ///
    /// Returns a sorted vec of (value, count) pairs.
    /// Only includes markers with non-None values.
    pub fn enumerate_marker_values(&self, marker_type: &str) -> Vec<(String, usize)> {
        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();

        let doc = match self.doc.read() {
            Ok(d) => d,
            Err(_) => return Vec::new(),
        };
        let txn = doc.transact();
        let Some(blocks_map) = txn.get_map("blocks") else {
            return Vec::new();
        };

        for (_key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                if let Some(metadata_val) = block_map.get(&txn, "metadata") {
                    if let Some(meta) = parse_metadata_from_out(metadata_val, &txn) {
                        for marker in &meta.markers {
                            if marker.marker_type == marker_type {
                                if let Some(ref v) = marker.value {
                                    *counts.entry(v.clone()).or_default() += 1;
                                }
                            }
                        }
                    }
                }
            }
        }

        let mut result: Vec<_> = counts.into_iter().collect();
        result.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        result
    }

    /// Get block statistics: total count, root count, block type distribution.
    pub fn get_stats(&self) -> BlockStats {
        use crate::block::parse_block_type;

        let doc = match self.doc.read() {
            Ok(d) => d,
            Err(_) => return BlockStats::default(),
        };
        let txn = doc.transact();

        let blocks_map = match txn.get_map("blocks") {
            Some(m) => m,
            None => return BlockStats::default(),
        };
        let root_ids = txn.get_array("rootIds");

        let total = blocks_map.len(&txn);
        let root_count = root_ids.map(|r| r.len(&txn)).unwrap_or(0);

        let mut type_counts: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        let mut with_markers = 0usize;
        let mut with_outlinks = 0usize;

        for (_key, value) in blocks_map.iter(&txn) {
            if let yrs::Out::YMap(block_map) = value {
                // Block type from content
                if let Some(yrs::Out::Any(yrs::Any::String(content))) =
                    block_map.get(&txn, "content")
                {
                    let bt = parse_block_type(&content).as_str().to_string();
                    *type_counts.entry(bt).or_default() += 1;
                }

                // Metadata stats
                if let Some(metadata_val) = block_map.get(&txn, "metadata") {
                    if let Some(meta) = parse_metadata_from_out(metadata_val, &txn) {
                        if !meta.markers.is_empty() {
                            with_markers += 1;
                        }
                        if !meta.outlinks.is_empty() {
                            with_outlinks += 1;
                        }
                    }
                }
            }
        }

        let mut type_distribution: Vec<_> = type_counts.into_iter().collect();
        type_distribution.sort_by(|a, b| b.1.cmp(&a.1));

        BlockStats {
            total_blocks: total as usize,
            root_count: root_count as usize,
            with_markers,
            with_outlinks,
            type_distribution,
        }
    }
}

/// Block statistics returned by `get_stats()`.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockStats {
    pub total_blocks: usize,
    pub root_count: usize,
    pub with_markers: usize,
    pub with_outlinks: usize,
    pub type_distribution: Vec<(String, usize)>,
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

    // =========================================================================
    // Metadata Parsing Tests (Y.Map / JSON string / Any::Map)
    // =========================================================================

    /// Helper: create a block in the store's Y.Doc with metadata as a JSON string (legacy format).
    fn insert_block_with_json_metadata(
        store: &YDocStore,
        block_id: &str,
        content: &str,
        parent_id: Option<&str>,
        metadata: &crate::metadata::BlockMetadata,
    ) {
        let doc = store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, block_id);

        block_map.insert(&mut txn, "content", yrs::Any::String(content.into()));
        if let Some(pid) = parent_id {
            block_map.insert(&mut txn, "parentId", yrs::Any::String(pid.into()));
        }
        let meta_json = serde_json::to_string(metadata).unwrap();
        block_map.insert(&mut txn, "metadata", yrs::Any::String(meta_json.into()));
    }

    /// Helper: create a block with metadata as Any::Map (simulates frontend hook writes).
    fn insert_block_with_map_metadata(
        store: &YDocStore,
        block_id: &str,
        content: &str,
        parent_id: Option<&str>,
        metadata: &crate::metadata::BlockMetadata,
    ) {
        let doc = store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, block_id);

        block_map.insert(&mut txn, "content", yrs::Any::String(content.into()));
        if let Some(pid) = parent_id {
            block_map.insert(&mut txn, "parentId", yrs::Any::String(pid.into()));
        }

        // Build metadata as Any::Map (how yjs serializes plain JS objects)
        let markers_any: Box<[yrs::Any]> = metadata.markers.iter().map(|m| {
            let mut map = HashMap::new();
            map.insert("markerType".to_string(), yrs::Any::String(m.marker_type.clone().into()));
            if let Some(ref v) = m.value {
                map.insert("value".to_string(), yrs::Any::String(v.clone().into()));
            }
            yrs::Any::Map(std::sync::Arc::new(map))
        }).collect::<Vec<_>>().into_boxed_slice();

        let outlinks_any: Box<[yrs::Any]> = metadata.outlinks.iter().map(|o| {
            yrs::Any::String(o.clone().into())
        }).collect::<Vec<_>>().into_boxed_slice();

        let mut meta_map = HashMap::new();
        meta_map.insert("markers".to_string(), yrs::Any::Array(std::sync::Arc::from(markers_any)));
        meta_map.insert("outlinks".to_string(), yrs::Any::Array(std::sync::Arc::from(outlinks_any)));

        block_map.insert(&mut txn, "metadata", yrs::Any::Map(std::sync::Arc::new(meta_map)));
    }

    #[test]
    fn test_get_block_reads_json_string_metadata() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let mut meta = crate::metadata::BlockMetadata::new();
        meta.add_marker(crate::metadata::Marker::with_value("project", "floatty"));

        insert_block_with_json_metadata(&store, "b1", "ctx:: test", None, &meta);

        let block = store.get_block("b1").unwrap();
        assert!(block.metadata.is_some());
        let m = block.metadata.unwrap();
        assert_eq!(m.markers.len(), 1);
        assert_eq!(m.markers[0].marker_type, "project");
        assert_eq!(m.markers[0].value.as_deref(), Some("floatty"));
    }

    #[test]
    fn test_get_block_reads_any_map_metadata() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let mut meta = crate::metadata::BlockMetadata::new();
        meta.add_marker(crate::metadata::Marker::with_value("project", "floatty"));
        meta.add_marker(crate::metadata::Marker::new("ctx"));

        insert_block_with_map_metadata(&store, "b1", "ctx:: [project::floatty]", None, &meta);

        let block = store.get_block("b1").unwrap();
        assert!(block.metadata.is_some(), "metadata should be parsed from Any::Map");
        let m = block.metadata.unwrap();
        assert_eq!(m.markers.len(), 2);
        assert!(m.markers.iter().any(|mk| mk.marker_type == "project" && mk.value.as_deref() == Some("floatty")));
        assert!(m.markers.iter().any(|mk| mk.marker_type == "ctx"));
    }

    #[test]
    fn test_get_block_no_metadata_returns_none() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Block with no metadata field at all
        {
            let doc = store.doc();
            let doc_guard = doc.write().unwrap();
            let mut txn = doc_guard.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");
            let block_prelim: MapPrelim = MapPrelim::from([
                ("content", yrs::Any::String("plain text".into())),
            ]);
            blocks.insert(&mut txn, "b1", block_prelim);
        }

        let block = store.get_block("b1").unwrap();
        assert!(block.metadata.is_none());
    }

    // =========================================================================
    // get_all_block_ids Tests
    // =========================================================================

    #[test]
    fn test_get_all_block_ids_empty_store() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();
        assert!(store.get_all_block_ids().is_empty());
    }

    #[test]
    fn test_get_all_block_ids_returns_all() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        {
            let doc = store.doc();
            let doc_guard = doc.write().unwrap();
            let mut txn = doc_guard.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");
            blocks.insert(&mut txn, "b1", MapPrelim::from([("content", yrs::Any::String("one".into()))]));
            blocks.insert(&mut txn, "b2", MapPrelim::from([("content", yrs::Any::String("two".into()))]));
            blocks.insert(&mut txn, "b3", MapPrelim::from([("content", yrs::Any::String("three".into()))]));
        }

        let mut ids = store.get_all_block_ids();
        ids.sort();
        assert_eq!(ids, vec!["b1", "b2", "b3"]);
    }

    // =========================================================================
    // Broadcast Callback Tests (FLO-391)
    // =========================================================================

    /// Helper: insert a block into the store for metadata update tests.
    fn insert_test_block(store: &YDocStore, block_id: &str, content: &str) {
        let doc = store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block_prelim: MapPrelim = MapPrelim::from([
            ("content", yrs::Any::String(content.into())),
        ]);
        blocks.insert(&mut txn, block_id, block_prelim);
    }

    #[test]
    fn test_broadcast_callback_fires_on_batch_update_metadata() {
        use std::sync::Mutex;

        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let calls: Arc<Mutex<Vec<(usize, i64)>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_clone = Arc::clone(&calls);
        store.set_broadcast_callback(move |bytes, seq| {
            calls_clone.lock().unwrap().push((bytes.len(), seq));
        });

        insert_test_block(&store, "b1", "hello");
        insert_test_block(&store, "b2", "world");

        let meta = crate::metadata::BlockMetadata::new();
        store.batch_update_metadata(
            &[("b1", meta.clone()), ("b2", meta)],
            crate::Origin::Hook,
        ).unwrap();

        let recorded = calls.lock().unwrap();
        assert_eq!(recorded.len(), 1, "batch_update_metadata should fire broadcast once");
        assert!(recorded[0].0 > 0, "broadcast bytes should be non-empty");
        assert!(recorded[0].1 > 0, "broadcast seq should be positive");
    }

    #[test]
    fn test_broadcast_callback_fires_on_update_block_metadata() {
        use std::sync::Mutex;

        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let calls: Arc<Mutex<Vec<(usize, i64)>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_clone = Arc::clone(&calls);
        store.set_broadcast_callback(move |bytes, seq| {
            calls_clone.lock().unwrap().push((bytes.len(), seq));
        });

        insert_test_block(&store, "b1", "ctx:: test");

        let meta = crate::metadata::BlockMetadata::new();
        store.update_block_metadata("b1", meta, crate::Origin::Hook).unwrap();

        let recorded = calls.lock().unwrap();
        assert_eq!(recorded.len(), 1, "update_block_metadata should fire broadcast once");
        assert!(recorded[0].0 > 0);
        assert!(recorded[0].1 > 0);
    }

    #[test]
    fn test_persist_update_does_not_fire_broadcast_callback() {
        use std::sync::Mutex;

        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let calls: Arc<Mutex<Vec<(usize, i64)>>> = Arc::new(Mutex::new(Vec::new()));
        let calls_clone = Arc::clone(&calls);
        store.set_broadcast_callback(move |bytes, seq| {
            calls_clone.lock().unwrap().push((bytes.len(), seq));
        });

        // Create an update via the doc and persist directly (CRUD path)
        let update = {
            let doc = store.doc();
            let doc_guard = doc.write().unwrap();
            let mut txn = doc_guard.transact_mut();
            let blocks = txn.get_or_insert_map("blocks");
            blocks.insert(&mut txn, "b1", "content");
            txn.encode_update_v1()
        };
        store.persist_update(&update).unwrap();

        let recorded = calls.lock().unwrap();
        assert!(recorded.is_empty(), "persist_update should NOT fire broadcast callback");
    }
}
