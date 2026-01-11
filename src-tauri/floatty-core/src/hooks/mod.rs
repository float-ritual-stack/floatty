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

use crate::{BlockChangeBatch, Origin, YDocStore};
use std::sync::Arc;

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

#[cfg(test)]
mod tests {
    use super::*;
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
}
