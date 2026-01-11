//! Batched change collector with deduplication.
//!
//! Wraps `ChangeEmitter` to provide:
//! - Time-based batching (configurable flush interval)
//! - Deduplication by block ID (keeps latest change per block)
//! - Threshold-based flushing (prevents unbounded memory)
//!
//! # Architecture
//!
//! ```text
//! BlockChange ─────▶ BatchedChangeCollector ─────▶ ChangeEmitter
//!                    ├── collect                   ├── broadcast
//!                    ├── dedupe (by block_id)      └── to subscribers
//!                    └── flush (interval/threshold)
//! ```
//!
//! # Deduplication Strategy
//!
//! Changes to the same block are merged:
//! - Multiple `ContentChanged`: keep first `old_content`, last `new_content`
//! - `Created` then `ContentChanged`: update `Created` content
//! - `Created` then `Deleted`: cancel out (block never existed to observers)
//! - `Deleted` supersedes all prior changes for that block
//!
//! # Usage
//!
//! ```rust,ignore
//! let emitter = ChangeEmitter::new();
//! let batcher = BatchedChangeCollector::new(emitter.clone());
//!
//! // Subscribe to batched changes
//! let mut rx = batcher.subscribe();
//!
//! // Submit changes (will be batched and deduped)
//! batcher.submit(BlockChange::ContentChanged { ... });
//!
//! // Start background flush task
//! let flush_handle = batcher.start_flush_task();
//! ```

use crate::emitter::ChangeEmitter;
use crate::events::{BlockChange, BlockChangeBatch};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, Mutex};
use tokio::task::JoinHandle;

/// Default flush interval in milliseconds.
const DEFAULT_FLUSH_INTERVAL_MS: u64 = 1000;

/// Default threshold for triggering immediate flush.
const DEFAULT_THRESHOLD: usize = 50;

/// Collects block changes, deduplicates by block ID, and emits batches periodically.
#[derive(Clone)]
pub struct BatchedChangeCollector {
    emitter: ChangeEmitter,
    pending: Arc<Mutex<PendingChanges>>,
    flush_interval: Duration,
    threshold: usize,
}

/// Internal state for pending changes with deduplication.
#[derive(Default)]
struct PendingChanges {
    /// Map from block_id to accumulated change state.
    changes: HashMap<String, ChangeState>,
    /// Order of first occurrence (for deterministic emit order).
    order: Vec<String>,
}

/// Accumulated state for a single block's changes.
///
/// Tracks enough info to merge consecutive changes.
#[derive(Clone, Debug)]
enum ChangeState {
    /// Block was created (not yet deleted).
    Created {
        content: String,
        parent_id: Option<String>,
        origin: crate::Origin,
    },

    /// Block content was changed (may have been created earlier).
    ContentChanged {
        old_content: String,
        new_content: String,
        origin: crate::Origin,
    },

    /// Block metadata was changed.
    MetadataChanged {
        old_metadata: Option<serde_json::Value>,
        new_metadata: Option<serde_json::Value>,
        origin: crate::Origin,
    },

    /// Block was moved.
    Moved {
        old_parent_id: Option<String>,
        new_parent_id: Option<String>,
        origin: crate::Origin,
    },

    /// Block was deleted.
    Deleted {
        content: String,
        origin: crate::Origin,
    },

    /// Block collapsed state changed.
    CollapsedChanged {
        collapsed: bool,
        origin: crate::Origin,
    },

    /// Block was created then deleted in same batch (no-op).
    Cancelled,
}

impl BatchedChangeCollector {
    /// Create a new collector with default configuration.
    ///
    /// - Flush interval: 1000ms
    /// - Threshold: 50 changes
    pub fn new(emitter: ChangeEmitter) -> Self {
        Self::with_config(emitter, DEFAULT_FLUSH_INTERVAL_MS, DEFAULT_THRESHOLD)
    }

    /// Create a collector with custom configuration.
    pub fn with_config(emitter: ChangeEmitter, interval_ms: u64, threshold: usize) -> Self {
        Self {
            emitter,
            pending: Arc::new(Mutex::new(PendingChanges::default())),
            flush_interval: Duration::from_millis(interval_ms),
            threshold,
        }
    }

    /// Subscribe to batched change events.
    ///
    /// Delegates to the underlying emitter.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<BlockChangeBatch>> {
        self.emitter.subscribe()
    }

    /// Submit a single change to be batched.
    ///
    /// Returns true if threshold was reached and flush occurred.
    pub async fn submit(&self, change: BlockChange) -> bool {
        let mut pending = self.pending.lock().await;
        let block_id = change.block_id().to_string();

        Self::merge_change(&mut pending, block_id, change);

        // Check threshold
        if pending.changes.len() >= self.threshold {
            let batch = Self::take_batch(&mut pending);
            drop(pending);
            if !batch.is_empty() {
                let _ = self.emitter.emit_batch(batch);
            }
            return true;
        }

        false
    }

    /// Submit multiple changes to be batched.
    pub async fn submit_batch(&self, changes: Vec<BlockChange>) {
        let mut pending = self.pending.lock().await;

        for change in changes {
            let block_id = change.block_id().to_string();
            Self::merge_change(&mut pending, block_id, change);
        }

        // Check threshold
        if pending.changes.len() >= self.threshold {
            let batch = Self::take_batch(&mut pending);
            drop(pending);
            if !batch.is_empty() {
                let _ = self.emitter.emit_batch(batch);
            }
        }
    }

    /// Force flush pending changes immediately.
    pub async fn flush(&self) {
        let mut pending = self.pending.lock().await;
        let batch = Self::take_batch(&mut pending);
        drop(pending);

        if !batch.is_empty() {
            let _ = self.emitter.emit_batch(batch);
        }
    }

    /// Check if there are pending changes.
    pub async fn has_pending(&self) -> bool {
        let pending = self.pending.lock().await;
        !pending.changes.is_empty()
    }

    /// Get count of pending changes.
    pub async fn pending_count(&self) -> usize {
        let pending = self.pending.lock().await;
        pending.changes.len()
    }

    /// Start the background flush task.
    ///
    /// This task periodically flushes pending changes at the configured interval.
    /// Returns a handle that can be used to abort the task.
    pub fn start_flush_task(self: &Arc<Self>) -> JoinHandle<()> {
        let collector = Arc::clone(self);
        let interval = self.flush_interval;

        tokio::spawn(async move {
            let mut interval_timer = tokio::time::interval(interval);
            loop {
                interval_timer.tick().await;
                collector.flush().await;
            }
        })
    }

    /// Merge a change into pending state.
    fn merge_change(pending: &mut PendingChanges, block_id: String, change: BlockChange) {
        let new_state = match pending.changes.get(&block_id) {
            None => {
                // First change for this block
                pending.order.push(block_id.clone());
                Self::change_to_state(change)
            }

            Some(existing) => {
                // Merge with existing state
                Self::merge_states(existing.clone(), change)
            }
        };

        pending.changes.insert(block_id, new_state);
    }

    /// Convert a BlockChange to initial ChangeState.
    fn change_to_state(change: BlockChange) -> ChangeState {
        match change {
            BlockChange::Created {
                content,
                parent_id,
                origin,
                ..
            } => ChangeState::Created {
                content,
                parent_id,
                origin,
            },

            BlockChange::ContentChanged {
                old_content,
                new_content,
                origin,
                ..
            } => ChangeState::ContentChanged {
                old_content,
                new_content,
                origin,
            },

            BlockChange::MetadataChanged {
                old_metadata,
                new_metadata,
                origin,
                ..
            } => ChangeState::MetadataChanged {
                old_metadata,
                new_metadata,
                origin,
            },

            BlockChange::Moved {
                old_parent_id,
                new_parent_id,
                origin,
                ..
            } => ChangeState::Moved {
                old_parent_id,
                new_parent_id,
                origin,
            },

            BlockChange::Deleted {
                content, origin, ..
            } => ChangeState::Deleted { content, origin },

            BlockChange::CollapsedChanged {
                collapsed, origin, ..
            } => ChangeState::CollapsedChanged { collapsed, origin },
        }
    }

    /// Merge a new change into existing state.
    fn merge_states(existing: ChangeState, new_change: BlockChange) -> ChangeState {
        use ChangeState::*;

        match (existing, new_change) {
            // Created + Deleted = Cancelled (block never existed to observers)
            (Created { .. }, BlockChange::Deleted { .. }) => Cancelled,

            // Created + ContentChanged = Created with new content
            (
                Created {
                    parent_id, origin, ..
                },
                BlockChange::ContentChanged { new_content, .. },
            ) => Created {
                content: new_content,
                parent_id,
                origin,
            },

            // ContentChanged + ContentChanged = merge (keep original old, use latest new)
            (
                ContentChanged {
                    old_content,
                    origin,
                    ..
                },
                BlockChange::ContentChanged { new_content, .. },
            ) => ContentChanged {
                old_content,
                new_content,
                origin,
            },

            // Anything + Deleted = Deleted (supersedes prior changes)
            (_, BlockChange::Deleted { content, origin, .. }) => Deleted { content, origin },

            // Cancelled stays cancelled
            (Cancelled, _) => Cancelled,

            // Default: replace with new state
            (_, change) => Self::change_to_state(change),
        }
    }

    /// Take all pending changes as a batch, clearing the pending state.
    fn take_batch(pending: &mut PendingChanges) -> BlockChangeBatch {
        let mut batch = BlockChangeBatch::new();

        for block_id in pending.order.drain(..) {
            if let Some(state) = pending.changes.remove(&block_id) {
                if let Some(change) = Self::state_to_change(block_id, state) {
                    batch.push(change);
                }
            }
        }

        batch
    }

    /// Convert accumulated state back to a BlockChange for emission.
    fn state_to_change(id: String, state: ChangeState) -> Option<BlockChange> {
        match state {
            ChangeState::Created {
                content,
                parent_id,
                origin,
            } => Some(BlockChange::Created {
                id,
                content,
                parent_id,
                origin,
            }),

            ChangeState::ContentChanged {
                old_content,
                new_content,
                origin,
            } => Some(BlockChange::ContentChanged {
                id,
                old_content,
                new_content,
                origin,
            }),

            ChangeState::MetadataChanged {
                old_metadata,
                new_metadata,
                origin,
            } => Some(BlockChange::MetadataChanged {
                id,
                old_metadata,
                new_metadata,
                origin,
            }),

            ChangeState::Moved {
                old_parent_id,
                new_parent_id,
                origin,
            } => Some(BlockChange::Moved {
                id,
                old_parent_id,
                new_parent_id,
                origin,
            }),

            ChangeState::Deleted { content, origin } => Some(BlockChange::Deleted {
                id,
                content,
                origin,
            }),

            ChangeState::CollapsedChanged { collapsed, origin } => {
                Some(BlockChange::CollapsedChanged {
                    id,
                    collapsed,
                    origin,
                })
            }

            ChangeState::Cancelled => None, // No-op
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Origin;

    #[tokio::test]
    async fn test_single_change_collects() {
        let emitter = ChangeEmitter::new();
        let batcher = BatchedChangeCollector::new(emitter);

        let change = BlockChange::Created {
            id: "block-1".to_string(),
            content: "hello".to_string(),
            parent_id: None,
            origin: Origin::User,
        };

        batcher.submit(change).await;

        assert!(batcher.has_pending().await);
        assert_eq!(batcher.pending_count().await, 1);
    }

    #[tokio::test]
    async fn test_flush_emits_and_clears() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();
        let batcher = BatchedChangeCollector::new(emitter);

        batcher
            .submit(BlockChange::Created {
                id: "block-1".to_string(),
                content: "hello".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;

        batcher.flush().await;

        assert!(!batcher.has_pending().await);

        // Should have received the batch
        let batch = rx.try_recv().unwrap();
        assert_eq!(batch.changes.len(), 1);
    }

    #[tokio::test]
    async fn test_dedupe_content_changes() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();
        let batcher = BatchedChangeCollector::new(emitter);

        // Submit two content changes to same block
        batcher
            .submit(BlockChange::ContentChanged {
                id: "block-1".to_string(),
                old_content: "a".to_string(),
                new_content: "b".to_string(),
                origin: Origin::User,
            })
            .await;

        batcher
            .submit(BlockChange::ContentChanged {
                id: "block-1".to_string(),
                old_content: "b".to_string(),
                new_content: "c".to_string(),
                origin: Origin::User,
            })
            .await;

        // Only one pending (deduped)
        assert_eq!(batcher.pending_count().await, 1);

        batcher.flush().await;

        let batch = rx.try_recv().unwrap();
        assert_eq!(batch.changes.len(), 1);

        // Should have merged: old="a", new="c"
        match &batch.changes[0] {
            BlockChange::ContentChanged {
                old_content,
                new_content,
                ..
            } => {
                assert_eq!(old_content, "a");
                assert_eq!(new_content, "c");
            }
            _ => panic!("Expected ContentChanged"),
        }
    }

    #[tokio::test]
    async fn test_created_then_deleted_cancels() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();
        let batcher = BatchedChangeCollector::new(emitter);

        // Create then delete same block
        batcher
            .submit(BlockChange::Created {
                id: "block-1".to_string(),
                content: "temp".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;

        batcher
            .submit(BlockChange::Deleted {
                id: "block-1".to_string(),
                content: "temp".to_string(),
                origin: Origin::User,
            })
            .await;

        // Still one pending (the Cancelled state)
        assert_eq!(batcher.pending_count().await, 1);

        batcher.flush().await;

        // Should emit empty batch (cancelled)
        let result = rx.try_recv();
        // Either no batch or empty batch
        match result {
            Ok(batch) => assert!(batch.changes.is_empty()),
            Err(_) => {} // No batch emitted is also valid
        }
    }

    #[tokio::test]
    async fn test_created_then_content_changed() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();
        let batcher = BatchedChangeCollector::new(emitter);

        // Create then modify same block
        batcher
            .submit(BlockChange::Created {
                id: "block-1".to_string(),
                content: "initial".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;

        batcher
            .submit(BlockChange::ContentChanged {
                id: "block-1".to_string(),
                old_content: "initial".to_string(),
                new_content: "updated".to_string(),
                origin: Origin::User,
            })
            .await;

        batcher.flush().await;

        let batch = rx.try_recv().unwrap();
        assert_eq!(batch.changes.len(), 1);

        // Should emit Created with updated content
        match &batch.changes[0] {
            BlockChange::Created { content, .. } => {
                assert_eq!(content, "updated");
            }
            _ => panic!("Expected Created"),
        }
    }

    #[tokio::test]
    async fn test_threshold_triggers_flush() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();

        // Small threshold for testing
        let batcher = BatchedChangeCollector::with_config(emitter, 1000, 3);

        // Submit 3 changes (hits threshold)
        let flushed = batcher
            .submit(BlockChange::Created {
                id: "b1".to_string(),
                content: "1".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;
        assert!(!flushed);

        let flushed = batcher
            .submit(BlockChange::Created {
                id: "b2".to_string(),
                content: "2".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;
        assert!(!flushed);

        let flushed = batcher
            .submit(BlockChange::Created {
                id: "b3".to_string(),
                content: "3".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;
        assert!(flushed); // Threshold hit

        // Should have received batch
        let batch = rx.try_recv().unwrap();
        assert_eq!(batch.changes.len(), 3);

        // Pending should be empty
        assert!(!batcher.has_pending().await);
    }

    #[tokio::test]
    async fn test_preserves_order() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();
        let batcher = BatchedChangeCollector::new(emitter);

        // Submit changes to different blocks
        batcher
            .submit(BlockChange::Created {
                id: "b1".to_string(),
                content: "first".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;

        batcher
            .submit(BlockChange::Created {
                id: "b2".to_string(),
                content: "second".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;

        batcher
            .submit(BlockChange::Created {
                id: "b3".to_string(),
                content: "third".to_string(),
                parent_id: None,
                origin: Origin::User,
            })
            .await;

        batcher.flush().await;

        let batch = rx.try_recv().unwrap();
        assert_eq!(batch.changes.len(), 3);

        // Order should be preserved
        assert_eq!(batch.changes[0].block_id(), "b1");
        assert_eq!(batch.changes[1].block_id(), "b2");
        assert_eq!(batch.changes[2].block_id(), "b3");
    }

    #[tokio::test]
    async fn test_multiple_blocks_independent() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();
        let batcher = BatchedChangeCollector::new(emitter);

        // Changes to different blocks should not interfere
        batcher
            .submit(BlockChange::ContentChanged {
                id: "b1".to_string(),
                old_content: "a1".to_string(),
                new_content: "b1".to_string(),
                origin: Origin::User,
            })
            .await;

        batcher
            .submit(BlockChange::ContentChanged {
                id: "b2".to_string(),
                old_content: "a2".to_string(),
                new_content: "b2".to_string(),
                origin: Origin::User,
            })
            .await;

        assert_eq!(batcher.pending_count().await, 2);

        batcher.flush().await;

        let batch = rx.try_recv().unwrap();
        assert_eq!(batch.changes.len(), 2);
    }

    #[tokio::test]
    async fn test_submit_batch() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();
        let batcher = BatchedChangeCollector::new(emitter);

        let changes = vec![
            BlockChange::Created {
                id: "b1".to_string(),
                content: "1".to_string(),
                parent_id: None,
                origin: Origin::Agent,
            },
            BlockChange::Created {
                id: "b2".to_string(),
                content: "2".to_string(),
                parent_id: Some("b1".to_string()),
                origin: Origin::Agent,
            },
        ];

        batcher.submit_batch(changes).await;

        assert_eq!(batcher.pending_count().await, 2);

        batcher.flush().await;

        let batch = rx.try_recv().unwrap();
        assert_eq!(batch.changes.len(), 2);
    }

    #[tokio::test]
    async fn test_deleted_supersedes_content_change() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();
        let batcher = BatchedChangeCollector::new(emitter);

        // Content change then delete
        batcher
            .submit(BlockChange::ContentChanged {
                id: "block-1".to_string(),
                old_content: "old".to_string(),
                new_content: "new".to_string(),
                origin: Origin::User,
            })
            .await;

        batcher
            .submit(BlockChange::Deleted {
                id: "block-1".to_string(),
                content: "new".to_string(),
                origin: Origin::User,
            })
            .await;

        batcher.flush().await;

        let batch = rx.try_recv().unwrap();
        assert_eq!(batch.changes.len(), 1);

        // Should emit Deleted, not ContentChanged
        match &batch.changes[0] {
            BlockChange::Deleted { .. } => {}
            _ => panic!("Expected Deleted"),
        }
    }
}
