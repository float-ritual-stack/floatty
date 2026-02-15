//! Hook system for processing block changes.
//!
//! Hooks receive BlockChangeBatch events and can perform side effects
//! like metadata extraction, search indexing, etc.
//!
//! # Architecture
//!
//! ```text
//! ChangeEmitter → BatchedChangeCollector → HookRegistry → hooks
//!                       (debounce)            (dispatch)
//!                                                 ↓
//!                              MetadataHook → PageNameIndexHook → TantivyIndexHook
//!                                 (10)             (20)              (50)
//! ```
//!
//! # Priority Ordering
//!
//! Hooks are dispatched in priority order (lower = earlier):
//! - **10**: MetadataHook - extracts :: markers, [[wikilinks]] to block.metadata
//! - **20**: PageNameIndexHook - updates autocomplete index
//! - **50**: TantivyIndexHook - queues for full-text search index
//!
//! # Origin Filtering
//!
//! Hooks specify which origins they respond to via `accepts_origins()`.
//! This prevents infinite loops:
//! - MetadataHook writes with `Origin::Hook`
//! - Other hooks exclude `Origin::Hook` from their accepted origins
//!
//! # Sync vs Async
//!
//! - **Sync hooks** (`is_sync() = true`): Block until complete.
//!   Use for fast, critical operations like metadata extraction.
//! - **Async hooks** (`is_sync() = false`): Spawn and return immediately.
//!   Use for expensive operations like search indexing.

// Submodules
pub mod inheritance_index;
pub mod metadata_extraction;
pub mod page_name_index;
pub mod parsing;
pub mod system;
pub mod tantivy_index;

// Re-exports
pub use inheritance_index::{InheritanceIndex, InheritanceIndexHook, InheritedMarker};
pub use metadata_extraction::MetadataExtractionHook;
pub use page_name_index::{PageNameIndex, PageNameIndexHook, PageSuggestion};
pub use system::HookSystem;
pub use tantivy_index::TantivyIndexHook;

use crate::{BlockChangeBatch, Origin, YDocStore};
use std::sync::{Arc, RwLock};
use tracing::{debug, trace};

/// A hook that processes block changes.
///
/// Hooks are registered with the HookRegistry and dispatched
/// in priority order when changes occur.
///
/// # Object Safety
///
/// This trait is object-safe, allowing `Box<dyn BlockHook>` usage
/// in the registry. All methods either return owned types or references
/// with `'static` lifetime.
///
/// # Example
///
/// ```rust,ignore
/// struct LoggingHook;
///
/// impl BlockHook for LoggingHook {
///     fn name(&self) -> &'static str { "logging" }
///     fn priority(&self) -> i32 { 100 }
///     fn is_sync(&self) -> bool { true }
///     fn accepts_origins(&self) -> Option<Vec<Origin>> { None }
///
///     fn process(&self, batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
///         for change in &batch.changes {
///             log::info!("[{}] {:?}", self.name(), change);
///         }
///     }
/// }
/// ```
pub trait BlockHook: Send + Sync {
    /// Unique identifier for logging/debugging.
    ///
    /// Should be a short, descriptive name like "metadata", "tantivy", etc.
    fn name(&self) -> &'static str;

    /// Priority (lower = earlier). Built-in hooks use 0-100.
    ///
    /// Suggested ranges:
    /// - 0-19: Critical metadata extraction
    /// - 20-49: Index maintenance
    /// - 50-99: Search/analytics
    /// - 100+: User-defined, logging, debugging
    fn priority(&self) -> i32;

    /// Should this hook run synchronously before returning to caller?
    ///
    /// - `true`: Blocks until `process()` completes. Use for fast operations
    ///   where downstream hooks depend on the result (e.g., metadata extraction
    ///   before indexing).
    /// - `false`: `process()` is spawned as a task and returns immediately.
    ///   Use for expensive operations that shouldn't block the event loop.
    fn is_sync(&self) -> bool;

    /// Origins this hook responds to. `None` means accept all origins.
    ///
    /// Most hooks should return `Some(vec![Origin::User, Origin::Agent, Origin::BulkImport])`
    /// to exclude `Origin::Hook` (prevents infinite loops) and `Origin::Remote`
    /// (metadata already extracted at source).
    ///
    /// Exception: TantivyIndexHook includes `Origin::Remote` because local
    /// search index needs all content regardless of source.
    fn accepts_origins(&self) -> Option<Vec<Origin>>;

    /// Process a batch of changes.
    ///
    /// For sync hooks, this blocks the caller. For async hooks, the registry
    /// spawns this as a task.
    ///
    /// The store is provided for hooks that need to read/write blocks
    /// (e.g., MetadataHook writing to block.metadata).
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>);
}

/// Check if a hook should process changes with the given origin.
///
/// This is a convenience function for the registry's dispatch loop.
///
/// # Example
///
/// ```rust,ignore
/// for hook in &self.hooks {
///     if should_process(hook.as_ref(), origin) {
///         hook.process(batch, store.clone());
///     }
/// }
/// ```
pub fn should_process(hook: &dyn BlockHook, origin: Origin) -> bool {
    match hook.accepts_origins() {
        None => true, // Accept all origins
        Some(accepted) => accepted.contains(&origin),
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// HOOK REGISTRY
// ═══════════════════════════════════════════════════════════════════════════

/// A registry that stores and dispatches hooks in priority order.
///
/// # Thread Safety
///
/// HookRegistry uses `RwLock` for interior mutability, allowing registration
/// and dispatch from multiple threads. Hooks are stored as `Arc<dyn BlockHook>`
/// to support async spawning (tasks need owned references that outlive the
/// read guard).
///
/// # Usage Pattern
///
/// ```rust,ignore
/// let registry = HookRegistry::new();
///
/// // Register hooks at startup (before dispatching)
/// registry.register(Arc::new(MetadataHook));
/// registry.register(Arc::new(TantivyIndexHook));
///
/// // Dispatch during operation
/// registry.dispatch(&batch, store.clone());
/// ```
///
/// # Priority Ordering
///
/// Hooks are dispatched in priority order (lower = earlier). Register hooks
/// in any order; the registry maintains sorted order internally.
///
/// # Origin Filtering
///
/// Each hook specifies which origins it responds to. The registry filters
/// the batch per-hook, so hooks only receive changes they care about.
pub struct HookRegistry {
    /// Hooks stored in priority order (lower priority first).
    /// Arc enables cloning for async spawn.
    hooks: RwLock<Vec<Arc<dyn BlockHook>>>,
}

impl HookRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            hooks: RwLock::new(Vec::new()),
        }
    }

    /// Register a hook. Hooks are kept sorted by priority (lower = earlier).
    ///
    /// # Panics
    ///
    /// Panics if the internal lock is poisoned.
    pub fn register(&self, hook: Arc<dyn BlockHook>) {
        let priority = hook.priority();
        let mut hooks = self.hooks.write().expect("lock poisoned");

        // Find insertion point to maintain sorted order
        let pos = hooks
            .iter()
            .position(|h| h.priority() > priority)
            .unwrap_or(hooks.len());

        hooks.insert(pos, hook);
    }

    /// Get the number of registered hooks.
    pub fn len(&self) -> usize {
        self.hooks.read().expect("lock poisoned").len()
    }

    /// Check if the registry has no hooks.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Dispatch a batch of changes to all registered hooks.
    ///
    /// For each hook:
    /// 1. Filter changes by origin (using `should_process`)
    /// 2. If filtered batch is non-empty:
    ///    - Sync hooks: call `process()` directly
    ///    - Async hooks: spawn a task via tokio
    ///
    /// # Panics
    ///
    /// Panics if the internal lock is poisoned.
    pub fn dispatch(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) {
        let hooks = self.hooks.read().expect("lock poisoned");

        trace!(
            batch_size = batch.changes.len(),
            hook_count = hooks.len(),
            "Dispatching batch to hooks"
        );

        for hook in hooks.iter() {
            // Filter changes by origin for this hook
            let accepted_changes: Vec<_> = batch
                .changes
                .iter()
                .filter(|c| should_process(hook.as_ref(), c.origin()))
                .cloned()
                .collect();

            if accepted_changes.is_empty() {
                trace!(hook = hook.name(), "Hook skipped - no matching changes");
                continue;
            }

            debug!(
                hook = hook.name(),
                priority = hook.priority(),
                changes = accepted_changes.len(),
                sync = hook.is_sync(),
                "Hook processing"
            );

            // Create filtered batch preserving metadata
            let filtered_batch = BlockChangeBatch {
                changes: accepted_changes,
                timestamp: batch.timestamp,
                transaction_id: batch.transaction_id.clone(),
            };

            if hook.is_sync() {
                // Sync hook: call directly
                hook.process(&filtered_batch, store.clone());
                trace!(hook = hook.name(), "Sync hook completed");
            } else {
                // Async hook: spawn task
                let hook = Arc::clone(hook);
                let store = Arc::clone(&store);
                let hook_name = hook.name().to_string();
                tokio::spawn(async move {
                    hook.process(&filtered_batch, store);
                    trace!(hook = %hook_name, "Async hook completed");
                });
            }
        }
    }
}

impl Default for HookRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use tempfile::tempdir;

    /// Helper to create a YDocStore for tests.
    fn create_test_store() -> Arc<YDocStore> {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        Arc::new(YDocStore::open(&db_path, "test").unwrap())
    }

    // ═══════════════════════════════════════════════════════════════
    // OBJECT SAFETY TESTS
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn test_trait_object_safety() {
        struct TestHook;

        impl BlockHook for TestHook {
            fn name(&self) -> &'static str {
                "test"
            }
            fn priority(&self) -> i32 {
                0
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {}
        }

        // This compiles = trait is object-safe
        let _hook: Box<dyn BlockHook> = Box::new(TestHook);
    }

    #[test]
    fn test_boxed_hook_methods() {
        struct NamedHook;

        impl BlockHook for NamedHook {
            fn name(&self) -> &'static str {
                "named"
            }
            fn priority(&self) -> i32 {
                42
            }
            fn is_sync(&self) -> bool {
                false
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                Some(vec![Origin::User])
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {}
        }

        let hook: Box<dyn BlockHook> = Box::new(NamedHook);

        // Methods work through trait object
        assert_eq!(hook.name(), "named");
        assert_eq!(hook.priority(), 42);
        assert!(!hook.is_sync());
        assert_eq!(hook.accepts_origins(), Some(vec![Origin::User]));
    }

    // ═══════════════════════════════════════════════════════════════
    // ORIGIN FILTERING TESTS
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn test_should_process_with_filter() {
        struct FilteredHook;

        impl BlockHook for FilteredHook {
            fn name(&self) -> &'static str {
                "filtered"
            }
            fn priority(&self) -> i32 {
                10
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                Some(vec![Origin::User, Origin::Agent])
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {}
        }

        let hook = FilteredHook;

        // Should accept User and Agent
        assert!(should_process(&hook, Origin::User));
        assert!(should_process(&hook, Origin::Agent));

        // Should reject Hook and Remote
        assert!(!should_process(&hook, Origin::Hook));
        assert!(!should_process(&hook, Origin::Remote));
        assert!(!should_process(&hook, Origin::BulkImport));
    }

    #[test]
    fn test_should_process_accepts_all() {
        struct AllHook;

        impl BlockHook for AllHook {
            fn name(&self) -> &'static str {
                "all"
            }
            fn priority(&self) -> i32 {
                50
            }
            fn is_sync(&self) -> bool {
                false
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {}
        }

        let hook = AllHook;

        // None means accept all
        assert!(should_process(&hook, Origin::User));
        assert!(should_process(&hook, Origin::Hook));
        assert!(should_process(&hook, Origin::Remote));
        assert!(should_process(&hook, Origin::Agent));
        assert!(should_process(&hook, Origin::BulkImport));
    }

    #[test]
    fn test_metadata_hook_pattern() {
        // MetadataHook should accept User, Agent, BulkImport but NOT Hook or Remote
        struct MetadataHookPattern;

        impl BlockHook for MetadataHookPattern {
            fn name(&self) -> &'static str {
                "metadata"
            }
            fn priority(&self) -> i32 {
                10
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                Some(vec![Origin::User, Origin::Agent, Origin::BulkImport])
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {}
        }

        let hook = MetadataHookPattern;

        assert!(should_process(&hook, Origin::User));
        assert!(should_process(&hook, Origin::Agent));
        assert!(should_process(&hook, Origin::BulkImport));
        assert!(!should_process(&hook, Origin::Hook)); // Prevents loops
        assert!(!should_process(&hook, Origin::Remote)); // Already extracted
    }

    #[test]
    fn test_tantivy_hook_pattern() {
        // TantivyIndexHook should accept all except Hook (needs Remote for local index)
        struct TantivyHookPattern;

        impl BlockHook for TantivyHookPattern {
            fn name(&self) -> &'static str {
                "tantivy"
            }
            fn priority(&self) -> i32 {
                50
            }
            fn is_sync(&self) -> bool {
                false
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                Some(vec![
                    Origin::User,
                    Origin::Remote,
                    Origin::Agent,
                    Origin::BulkImport,
                ])
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {}
        }

        let hook = TantivyHookPattern;

        assert!(should_process(&hook, Origin::User));
        assert!(should_process(&hook, Origin::Remote)); // Needs local indexing
        assert!(should_process(&hook, Origin::Agent));
        assert!(should_process(&hook, Origin::BulkImport));
        assert!(!should_process(&hook, Origin::Hook)); // Metadata writes don't need re-indexing
    }

    // ═══════════════════════════════════════════════════════════════
    // PROCESS INVOCATION TESTS
    // ═══════════════════════════════════════════════════════════════

    #[test]
    #[serial]
    fn test_process_receives_batch() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        static CALL_COUNT: AtomicUsize = AtomicUsize::new(0);
        static CHANGE_COUNT: AtomicUsize = AtomicUsize::new(0);

        struct CountingHook;

        impl BlockHook for CountingHook {
            fn name(&self) -> &'static str {
                "counting"
            }
            fn priority(&self) -> i32 {
                0
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                CALL_COUNT.fetch_add(1, Ordering::SeqCst);
                CHANGE_COUNT.fetch_add(batch.len(), Ordering::SeqCst);
            }
        }

        let hook = CountingHook;
        let store = create_test_store();

        // Create a batch with 3 changes
        let mut batch = BlockChangeBatch::new();
        batch.push(crate::BlockChange::Created {
            id: "b1".to_string(),
            content: "".to_string(),
            parent_id: None,
            origin: Origin::User,
        });
        batch.push(crate::BlockChange::ContentChanged {
            id: "b1".to_string(),
            old_content: "".to_string(),
            new_content: "hello".to_string(),
            origin: Origin::User,
        });
        batch.push(crate::BlockChange::Deleted {
            id: "b2".to_string(),
            content: "gone".to_string(),
            origin: Origin::User,
        });

        hook.process(&batch, store);

        assert_eq!(CALL_COUNT.load(Ordering::SeqCst), 1);
        assert_eq!(CHANGE_COUNT.load(Ordering::SeqCst), 3);
    }

    // ═══════════════════════════════════════════════════════════════
    // HOOK REGISTRY TESTS
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn test_registry_empty() {
        let registry = HookRegistry::new();
        assert!(registry.is_empty());
        assert_eq!(registry.len(), 0);
    }

    #[test]
    fn test_register_single() {
        struct SimpleHook;
        impl BlockHook for SimpleHook {
            fn name(&self) -> &'static str {
                "simple"
            }
            fn priority(&self) -> i32 {
                10
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {}
        }

        let registry = HookRegistry::new();
        registry.register(Arc::new(SimpleHook));

        assert!(!registry.is_empty());
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn test_register_priority_order() {
        // Create hooks with different priorities
        struct PriorityHook {
            prio: i32,
            name: &'static str,
        }

        impl BlockHook for PriorityHook {
            fn name(&self) -> &'static str {
                self.name
            }
            fn priority(&self) -> i32 {
                self.prio
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {}
        }

        let registry = HookRegistry::new();

        // Register in non-sorted order
        registry.register(Arc::new(PriorityHook {
            prio: 50,
            name: "middle",
        }));
        registry.register(Arc::new(PriorityHook {
            prio: 10,
            name: "first",
        }));
        registry.register(Arc::new(PriorityHook {
            prio: 100,
            name: "last",
        }));

        // Verify sorted order
        let hooks = registry.hooks.read().unwrap();
        assert_eq!(hooks[0].name(), "first");
        assert_eq!(hooks[1].name(), "middle");
        assert_eq!(hooks[2].name(), "last");
    }

    #[test]
    #[serial]
    fn test_dispatch_calls_process() {
        use std::sync::atomic::{AtomicBool, Ordering};

        static CALLED: AtomicBool = AtomicBool::new(false);

        struct TrackingHook;
        impl BlockHook for TrackingHook {
            fn name(&self) -> &'static str {
                "tracking"
            }
            fn priority(&self) -> i32 {
                0
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                CALLED.store(true, Ordering::SeqCst);
            }
        }

        let registry = HookRegistry::new();
        registry.register(Arc::new(TrackingHook));

        let store = create_test_store();
        let mut batch = BlockChangeBatch::new();
        batch.push(crate::BlockChange::Created {
            id: "b1".to_string(),
            content: "test".to_string(),
            parent_id: None,
            origin: Origin::User,
        });

        registry.dispatch(&batch, store);

        assert!(CALLED.load(Ordering::SeqCst));
    }

    #[test]
    #[serial]
    fn test_dispatch_origin_filtering() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        static CHANGES_RECEIVED: AtomicUsize = AtomicUsize::new(0);

        struct UserOnlyHook;
        impl BlockHook for UserOnlyHook {
            fn name(&self) -> &'static str {
                "user_only"
            }
            fn priority(&self) -> i32 {
                0
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                Some(vec![Origin::User]) // Only accept User origin
            }
            fn process(&self, batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                CHANGES_RECEIVED.fetch_add(batch.len(), Ordering::SeqCst);
            }
        }

        // Reset for this test
        CHANGES_RECEIVED.store(0, Ordering::SeqCst);

        let registry = HookRegistry::new();
        registry.register(Arc::new(UserOnlyHook));

        let store = create_test_store();
        let mut batch = BlockChangeBatch::new();

        // Add one User change and one Hook change
        batch.push(crate::BlockChange::Created {
            id: "b1".to_string(),
            content: "user change".to_string(),
            parent_id: None,
            origin: Origin::User,
        });
        batch.push(crate::BlockChange::Created {
            id: "b2".to_string(),
            content: "hook change".to_string(),
            parent_id: None,
            origin: Origin::Hook,
        });

        registry.dispatch(&batch, store);

        // Only the User change should have been received
        assert_eq!(CHANGES_RECEIVED.load(Ordering::SeqCst), 1);
    }

    #[test]
    #[serial]
    fn test_dispatch_sync_blocks() {
        use std::sync::atomic::{AtomicBool, Ordering};

        static COMPLETED: AtomicBool = AtomicBool::new(false);

        struct SlowSyncHook;
        impl BlockHook for SlowSyncHook {
            fn name(&self) -> &'static str {
                "slow_sync"
            }
            fn priority(&self) -> i32 {
                0
            }
            fn is_sync(&self) -> bool {
                true // Sync hook
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                // Simulate some work
                std::thread::sleep(std::time::Duration::from_millis(10));
                COMPLETED.store(true, Ordering::SeqCst);
            }
        }

        // Reset for this test
        COMPLETED.store(false, Ordering::SeqCst);

        let registry = HookRegistry::new();
        registry.register(Arc::new(SlowSyncHook));

        let store = create_test_store();
        let mut batch = BlockChangeBatch::new();
        batch.push(crate::BlockChange::Created {
            id: "b1".to_string(),
            content: "test".to_string(),
            parent_id: None,
            origin: Origin::User,
        });

        registry.dispatch(&batch, store);

        // After dispatch returns, sync hook should have completed
        assert!(COMPLETED.load(Ordering::SeqCst));
    }

    #[tokio::test]
    #[serial]
    async fn test_dispatch_async_spawns() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::time::Duration;

        static ASYNC_STARTED: AtomicBool = AtomicBool::new(false);

        struct AsyncHook;
        impl BlockHook for AsyncHook {
            fn name(&self) -> &'static str {
                "async"
            }
            fn priority(&self) -> i32 {
                0
            }
            fn is_sync(&self) -> bool {
                false // Async hook
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                ASYNC_STARTED.store(true, Ordering::SeqCst);
            }
        }

        // Reset for this test
        ASYNC_STARTED.store(false, Ordering::SeqCst);

        let registry = HookRegistry::new();
        registry.register(Arc::new(AsyncHook));

        let store = create_test_store();
        let mut batch = BlockChangeBatch::new();
        batch.push(crate::BlockChange::Created {
            id: "b1".to_string(),
            content: "test".to_string(),
            parent_id: None,
            origin: Origin::User,
        });

        registry.dispatch(&batch, store);

        // Dispatch returns immediately for async hooks
        // Give the spawned task time to run
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Now it should have started
        assert!(ASYNC_STARTED.load(Ordering::SeqCst));
    }

    #[test]
    #[serial]
    fn test_dispatch_empty_batch_no_call() {
        use std::sync::atomic::{AtomicBool, Ordering};

        static CALLED: AtomicBool = AtomicBool::new(false);

        struct NeverCalledHook;
        impl BlockHook for NeverCalledHook {
            fn name(&self) -> &'static str {
                "never_called"
            }
            fn priority(&self) -> i32 {
                0
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                CALLED.store(true, Ordering::SeqCst);
            }
        }

        // Reset for this test
        CALLED.store(false, Ordering::SeqCst);

        let registry = HookRegistry::new();
        registry.register(Arc::new(NeverCalledHook));

        let store = create_test_store();
        let batch = BlockChangeBatch::new(); // Empty batch

        registry.dispatch(&batch, store);

        // Hook should not be called for empty batch
        assert!(!CALLED.load(Ordering::SeqCst));
    }

    #[test]
    #[serial]
    fn test_dispatch_priority_order_execution() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        // Use atomic counters to track execution order
        static FIRST_ORDER: AtomicUsize = AtomicUsize::new(0);
        static SECOND_ORDER: AtomicUsize = AtomicUsize::new(0);
        static THIRD_ORDER: AtomicUsize = AtomicUsize::new(0);
        static COUNTER: AtomicUsize = AtomicUsize::new(0);

        struct FirstHook;
        impl BlockHook for FirstHook {
            fn name(&self) -> &'static str {
                "first"
            }
            fn priority(&self) -> i32 {
                10
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                FIRST_ORDER.store(COUNTER.fetch_add(1, Ordering::SeqCst), Ordering::SeqCst);
            }
        }

        struct SecondHook;
        impl BlockHook for SecondHook {
            fn name(&self) -> &'static str {
                "second"
            }
            fn priority(&self) -> i32 {
                50
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                SECOND_ORDER.store(COUNTER.fetch_add(1, Ordering::SeqCst), Ordering::SeqCst);
            }
        }

        struct ThirdHook;
        impl BlockHook for ThirdHook {
            fn name(&self) -> &'static str {
                "third"
            }
            fn priority(&self) -> i32 {
                100
            }
            fn is_sync(&self) -> bool {
                true
            }
            fn accepts_origins(&self) -> Option<Vec<Origin>> {
                None
            }
            fn process(&self, _batch: &BlockChangeBatch, _store: Arc<YDocStore>) {
                THIRD_ORDER.store(COUNTER.fetch_add(1, Ordering::SeqCst), Ordering::SeqCst);
            }
        }

        // Reset counters for this test
        FIRST_ORDER.store(0, Ordering::SeqCst);
        SECOND_ORDER.store(0, Ordering::SeqCst);
        THIRD_ORDER.store(0, Ordering::SeqCst);
        COUNTER.store(0, Ordering::SeqCst);

        let registry = HookRegistry::new();

        // Register in random order
        registry.register(Arc::new(ThirdHook)); // priority 100
        registry.register(Arc::new(FirstHook)); // priority 10
        registry.register(Arc::new(SecondHook)); // priority 50

        let store = create_test_store();
        let mut batch = BlockChangeBatch::new();
        batch.push(crate::BlockChange::Created {
            id: "b1".to_string(),
            content: "test".to_string(),
            parent_id: None,
            origin: Origin::User,
        });

        registry.dispatch(&batch, store);

        // Verify execution order: first(10) < second(50) < third(100)
        assert_eq!(FIRST_ORDER.load(Ordering::SeqCst), 0, "first should execute 0th");
        assert_eq!(SECOND_ORDER.load(Ordering::SeqCst), 1, "second should execute 1st");
        assert_eq!(THIRD_ORDER.load(Ordering::SeqCst), 2, "third should execute 2nd");
    }
}
