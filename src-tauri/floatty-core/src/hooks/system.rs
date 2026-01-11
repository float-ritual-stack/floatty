//! Hook system initialization and runtime wiring.
//!
//! This module connects all the hook infrastructure:
//! - Creates HookRegistry with registered hooks
//! - Spawns subscriber task to dispatch changes to hooks
//! - Handles cold-start rehydration of existing blocks
//!
//! # Usage
//!
//! ```rust,ignore
//! // At server startup:
//! let store = Arc::new(YDocStore::new()?);
//! let hook_system = HookSystem::initialize(store.clone());
//!
//! // Hook system now:
//! // 1. Has MetadataExtractionHook registered
//! // 2. Listens to emitter and dispatches to hooks
//! // 3. Has rehydrated existing blocks with metadata
//! ```

use crate::emitter::ChangeEmitter;
use crate::events::{BlockChange, BlockChangeBatch};
use crate::hooks::{HookRegistry, MetadataExtractionHook, PageNameIndexHook};
use crate::store::YDocStore;
use crate::Origin;
use crate::hooks::page_name_index::PageNameIndex;
use std::sync::{Arc, RwLock};
use tokio::sync::broadcast;
use tracing::{debug, info, warn};
use yrs::{Map, ReadTxn, Transact};

/// The hook system runtime - owns registry and manages the dispatch loop.
///
/// Keep this alive for the lifetime of the server. Dropping it will
/// stop the dispatch task.
pub struct HookSystem {
    /// The registry with all registered hooks.
    registry: Arc<HookRegistry>,

    /// The change emitter for broadcasting changes.
    emitter: ChangeEmitter,

    /// Handle to the dispatch task (for graceful shutdown).
    _dispatch_handle: tokio::task::JoinHandle<()>,

    /// The page name index for [[ autocomplete.
    /// Exposed for Tauri commands to query.
    page_name_index: Arc<RwLock<PageNameIndex>>,
}

impl HookSystem {
    /// Initialize the hook system with default hooks.
    ///
    /// This:
    /// 1. Creates HookRegistry
    /// 2. Registers MetadataExtractionHook
    /// 3. Creates ChangeEmitter
    /// 4. Spawns dispatch task (emitter → registry)
    /// 5. Rehydrates existing blocks (cold start)
    ///
    /// Returns the HookSystem which should be kept alive for server lifetime.
    pub fn initialize(store: Arc<YDocStore>) -> Self {
        info!("Initializing hook system...");

        // Create registry
        let registry = Arc::new(HookRegistry::new());

        // Register hooks
        let page_name_index_hook = Arc::new(PageNameIndexHook::new());
        registry.register(Arc::new(MetadataExtractionHook));
        registry.register(page_name_index_hook.clone());
        info!(
            "Registered {} hooks: MetadataExtractionHook, PageNameIndexHook",
            registry.len()
        );

        // Create emitter
        let emitter = ChangeEmitter::new();

        // Subscribe and spawn dispatch task
        let rx = emitter.subscribe();
        let dispatch_handle = spawn_dispatch_task(rx, Arc::clone(&registry), Arc::clone(&store));

        // Rehydrate existing blocks (cold start)
        let rehydrate_count = rehydrate_existing_blocks(&emitter, &store);
        if rehydrate_count > 0 {
            info!("Rehydrated {} existing blocks", rehydrate_count);
        }

        info!("Hook system initialized");

        Self {
            registry,
            emitter,
            _dispatch_handle: dispatch_handle,
            page_name_index: page_name_index_hook.index(),
        }
    }

    /// Get a reference to the registry (for testing/inspection).
    pub fn registry(&self) -> &Arc<HookRegistry> {
        &self.registry
    }

    /// Get the page name index for autocomplete queries.
    ///
    /// Used by Tauri commands to provide [[ suggestions.
    pub fn page_name_index(&self) -> Arc<RwLock<PageNameIndex>> {
        Arc::clone(&self.page_name_index)
    }

    /// Get a reference to the emitter (for external emission).
    ///
    /// External systems can emit changes through this emitter,
    /// and they'll be dispatched to all registered hooks.
    pub fn emitter(&self) -> &ChangeEmitter {
        &self.emitter
    }

    /// Emit a batch of changes to be processed by hooks.
    ///
    /// This is the main entry point for triggering hook processing.
    pub fn emit(&self, batch: BlockChangeBatch) -> Result<usize, crate::emitter::EmitError> {
        self.emitter.emit_batch(batch)
    }

    /// Emit a single change to be processed by hooks.
    pub fn emit_change(&self, change: BlockChange) -> Result<usize, crate::emitter::EmitError> {
        self.emitter.emit(change)
    }
}

/// Spawn the dispatch task that listens to emitter and dispatches to hooks.
fn spawn_dispatch_task(
    mut rx: broadcast::Receiver<Arc<BlockChangeBatch>>,
    registry: Arc<HookRegistry>,
    store: Arc<YDocStore>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        debug!("Hook dispatch task started");

        loop {
            match rx.recv().await {
                Ok(batch) => {
                    debug!(
                        "Dispatching batch with {} changes to {} hooks",
                        batch.len(),
                        registry.len()
                    );
                    // Dispatch to all hooks (sync hooks block, async hooks spawn)
                    registry.dispatch(&batch, Arc::clone(&store));
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!("Hook dispatch lagged by {} messages - some changes may have been skipped", n);
                    // Continue processing - lagged messages are lost but we can still process future ones
                }
                Err(broadcast::error::RecvError::Closed) => {
                    info!("Hook dispatch task shutting down (emitter closed)");
                    break;
                }
            }
        }
    })
}

/// Rehydrate existing blocks by emitting BulkImport changes.
///
/// On cold start, Y.Doc loads from persistence but no mutations occur,
/// so hooks don't fire. This function iterates all existing blocks and
/// emits ContentChanged events with BulkImport origin to populate metadata.
///
/// Returns the number of blocks rehydrated.
fn rehydrate_existing_blocks(emitter: &ChangeEmitter, store: &YDocStore) -> usize {
    let doc = store.doc();
    let doc_guard = match doc.read() {
        Ok(g) => g,
        Err(e) => {
            warn!("Failed to acquire Y.Doc read lock for rehydration: {}", e);
            return 0;
        }
    };

    let txn = doc_guard.transact();
    let blocks_map = match txn.get_map("blocks") {
        Some(m) => m,
        None => {
            debug!("No blocks map found - empty store, skipping rehydration");
            return 0;
        }
    };

    // Collect block IDs and content
    let mut changes = Vec::new();

    for (key, value) in blocks_map.iter(&txn) {
        let block_id = key.to_string();

        // Extract content from block Y.Map
        let content = if let yrs::Out::YMap(block_map) = value {
            block_map
                .get(&txn, "content")
                .and_then(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
                .unwrap_or_default()
        } else {
            String::new()
        };

        // Only emit for non-empty content (avoids processing empty blocks)
        if !content.is_empty() {
            changes.push(BlockChange::ContentChanged {
                id: block_id,
                old_content: String::new(), // Treat as if created fresh
                new_content: content,
                origin: Origin::BulkImport,
            });
        }
    }

    let count = changes.len();

    if count > 0 {
        // Emit as a single batch for efficiency
        let mut batch = BlockChangeBatch::with_transaction_id("cold_start_rehydration".to_string());
        for change in changes {
            batch.push(change);
        }

        if let Err(e) = emitter.emit_batch(batch) {
            warn!("Failed to emit rehydration batch: {}", e);
            return 0;
        }
    }

    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use yrs::{Map, MapPrelim, Transact, WriteTxn};

    /// Helper to create a YDocStore with some test blocks.
    /// Returns (TempDir, Arc<YDocStore>) - caller must hold TempDir to keep DB alive.
    fn create_store_with_blocks(blocks: &[(&str, &str)]) -> (tempfile::TempDir, Arc<YDocStore>) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = YDocStore::open(&db_path, "test").unwrap();

        // Add blocks to Y.Doc
        {
            let doc = store.doc();
            let doc_guard = doc.write().unwrap();
            let update = {
                let mut txn = doc_guard.transact_mut();
                let blocks_map = txn.get_or_insert_map("blocks");

                for (id, content) in blocks {
                    // Create a MapPrelim with content field using array syntax
                    let block_prelim: MapPrelim = MapPrelim::from([
                        ("content", (*content).to_string()),
                    ]);
                    let _ = blocks_map.insert(&mut txn, *id, block_prelim);
                }

                txn.encode_update_v1()
            };
            drop(doc_guard);
            store.persist_update(&update).unwrap();
        }

        (dir, Arc::new(store))
    }

    #[tokio::test]
    async fn test_hook_system_initialize() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());

        let system = HookSystem::initialize(store);

        // Registry should have MetadataExtractionHook + PageNameIndexHook
        assert_eq!(system.registry().len(), 2);
    }

    #[tokio::test]
    async fn test_rehydration_emits_changes() {
        // Create store with existing blocks
        let (_dir, store) = create_store_with_blocks(&[
            ("b1", "ctx:: test marker"),
            ("b2", "[[Wiki Link]]"),
            ("b3", "plain text"),
        ]);

        // Create emitter and subscribe BEFORE rehydration
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();

        // Rehydrate
        let count = rehydrate_existing_blocks(&emitter, &store);
        assert_eq!(count, 3);

        // Should receive batch with 3 changes
        let batch = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            rx.recv()
        ).await.expect("timeout").expect("recv error");

        assert_eq!(batch.len(), 3);

        // All should be BulkImport origin
        for change in &batch.changes {
            assert_eq!(change.origin(), Origin::BulkImport);
        }
    }

    #[tokio::test]
    async fn test_rehydration_skips_empty_content() {
        // Create store with one empty block
        let (_dir, store) = create_store_with_blocks(&[
            ("b1", "has content"),
            ("b2", ""), // Empty content
        ]);

        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();

        let count = rehydrate_existing_blocks(&emitter, &store);
        assert_eq!(count, 1); // Only non-empty block

        let batch = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            rx.recv()
        ).await.expect("timeout").expect("recv error");

        assert_eq!(batch.len(), 1);
    }

    #[tokio::test]
    async fn test_dispatch_task_receives_changes() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::time::Duration;

        static DISPATCH_COUNT: AtomicUsize = AtomicUsize::new(0);

        // Create a counting hook
        struct CountingHook;
        impl crate::hooks::BlockHook for CountingHook {
            fn name(&self) -> &'static str { "counting" }
            fn priority(&self) -> i32 { 0 }
            fn is_sync(&self) -> bool { true }
            fn accepts_origins(&self) -> Option<Vec<Origin>> { None }
            fn process(&self, batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                DISPATCH_COUNT.fetch_add(batch.len(), Ordering::SeqCst);
            }
        }

        // Reset counter
        DISPATCH_COUNT.store(0, Ordering::SeqCst);

        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());

        // Create system with custom hook
        let registry = Arc::new(HookRegistry::new());
        registry.register(Arc::new(CountingHook));

        let emitter = ChangeEmitter::new();
        let rx = emitter.subscribe();
        let _handle = spawn_dispatch_task(rx, Arc::clone(&registry), Arc::clone(&store));

        // Emit some changes
        emitter.emit(BlockChange::Created {
            id: "b1".to_string(),
            content: "test".to_string(),
            parent_id: None,
            origin: Origin::User,
        }).unwrap();

        // Give dispatch task time to process
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert_eq!(DISPATCH_COUNT.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_full_integration_metadata_populated() {
        // Create store with a block that has markers
        let (_dir, store) = create_store_with_blocks(&[
            ("b1", "ctx:: test block [project::floatty]"),
        ]);

        // Initialize hook system (will rehydrate)
        let _system = HookSystem::initialize(Arc::clone(&store));

        // Give hooks time to process
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Check that metadata was populated
        let doc = store.doc();
        let doc_guard = doc.read().unwrap();
        let txn = doc_guard.transact();
        let blocks_map = txn.get_map("blocks").unwrap();

        if let Some(yrs::Out::YMap(block_map)) = blocks_map.get(&txn, "b1") {
            let metadata = block_map.get(&txn, "metadata");
            // Metadata should exist (was written by MetadataExtractionHook)
            assert!(metadata.is_some(), "metadata should be populated by hook");
        } else {
            panic!("Block b1 not found");
        }
    }
}
