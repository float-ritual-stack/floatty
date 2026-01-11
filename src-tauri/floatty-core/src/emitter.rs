//! Change emitter for broadcasting block mutations.
//!
//! Wraps Y.Doc observation to emit typed BlockChange events.
//! Downstream hooks (search indexing, metadata extraction) subscribe to these events.
//!
//! # Architecture
//!
//! ```text
//! YDocStore.apply_update() → Y.Doc mutation → Observer fires
//!                                                   ↓
//!                                           ChangeEmitter.emit()
//!                                                   ↓
//!                                      broadcast to all subscribers
//! ```
//!
//! # Usage
//!
//! ```rust,ignore
//! let emitter = ChangeEmitter::new();
//! let mut rx = emitter.subscribe();
//!
//! // In another task:
//! while let Ok(batch) = rx.recv().await {
//!     for change in batch.changes {
//!         match change {
//!             BlockChange::ContentChanged { id, .. } => {
//!                 // Update search index
//!             }
//!             _ => {}
//!         }
//!     }
//! }
//! ```

use crate::events::{BlockChange, BlockChangeBatch};
use crate::Origin;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Default channel capacity - allows buffering during burst writes.
const CHANNEL_CAPACITY: usize = 256;

/// Error returned when emitting fails (e.g., no subscribers).
#[derive(Debug, Clone)]
pub struct EmitError {
    pub message: String,
}

impl std::fmt::Display for EmitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "EmitError: {}", self.message)
    }
}

impl std::error::Error for EmitError {}

/// Broadcasts BlockChange events to subscribers.
///
/// Uses tokio broadcast channel for multi-consumer pub/sub.
/// Subscribers that fall behind will receive `RecvError::Lagged`.
#[derive(Clone)]
pub struct ChangeEmitter {
    sender: broadcast::Sender<Arc<BlockChangeBatch>>,
}

impl Default for ChangeEmitter {
    fn default() -> Self {
        Self::new()
    }
}

impl ChangeEmitter {
    /// Create a new emitter with default channel capacity.
    pub fn new() -> Self {
        Self::with_capacity(CHANNEL_CAPACITY)
    }

    /// Create a new emitter with specified channel capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    /// Subscribe to change events.
    ///
    /// Returns a receiver that will get all future events.
    /// Call this before emitting to ensure no events are missed.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<BlockChangeBatch>> {
        self.sender.subscribe()
    }

    /// Get the current number of active subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.sender.receiver_count()
    }

    /// Emit a single change as a batch of one.
    pub fn emit(&self, change: BlockChange) -> Result<usize, EmitError> {
        let mut batch = BlockChangeBatch::new();
        batch.push(change);
        self.emit_batch(batch)
    }

    /// Emit a batch of changes.
    ///
    /// Returns the number of subscribers that received the batch.
    /// Returns Ok(0) if there are no subscribers (not an error).
    pub fn emit_batch(&self, batch: BlockChangeBatch) -> Result<usize, EmitError> {
        if batch.is_empty() {
            return Ok(0);
        }

        // Wrap in Arc for efficient cloning across subscribers
        let batch = Arc::new(batch);

        match self.sender.send(batch) {
            Ok(count) => Ok(count),
            Err(_) => {
                // No receivers - this is OK, just means no one is listening
                Ok(0)
            }
        }
    }

    /// Emit a batch with a transaction ID for correlation.
    pub fn emit_batch_with_id(
        &self,
        changes: Vec<BlockChange>,
        transaction_id: String,
    ) -> Result<usize, EmitError> {
        let mut batch = BlockChangeBatch::with_transaction_id(transaction_id);
        for change in changes {
            batch.push(change);
        }
        self.emit_batch(batch)
    }
}

/// Helper to extract Origin from a Y.Doc transaction origin string.
///
/// The TypeScript side sets origin via `doc.transact(() => {...}, 'user')`.
/// This function parses common origin strings into the Origin enum.
pub fn parse_origin(origin_str: Option<&str>) -> Origin {
    match origin_str {
        Some(s) => Origin::try_from(s).unwrap_or(Origin::User),
        None => Origin::User,
    }
}

/// Builder for constructing BlockChange events from Y.Doc observations.
///
/// This is a helper for Unit 1.2's observer integration, providing
/// a clean interface for transforming raw Y.Doc events into typed changes.
pub struct ChangeBuilder {
    changes: Vec<BlockChange>,
    origin: Origin,
}

impl ChangeBuilder {
    /// Create a new builder with the given origin.
    pub fn new(origin: Origin) -> Self {
        Self {
            changes: Vec::new(),
            origin,
        }
    }

    /// Record a block creation.
    pub fn created(mut self, id: String, content: String, parent_id: Option<String>) -> Self {
        self.changes.push(BlockChange::Created {
            id,
            content,
            parent_id,
            origin: self.origin,
        });
        self
    }

    /// Record a content change.
    pub fn content_changed(
        mut self,
        id: String,
        old_content: String,
        new_content: String,
    ) -> Self {
        self.changes.push(BlockChange::ContentChanged {
            id,
            old_content,
            new_content,
            origin: self.origin,
        });
        self
    }

    /// Record a metadata change.
    pub fn metadata_changed(
        mut self,
        id: String,
        old_metadata: Option<serde_json::Value>,
        new_metadata: Option<serde_json::Value>,
    ) -> Self {
        self.changes.push(BlockChange::MetadataChanged {
            id,
            old_metadata,
            new_metadata,
            origin: self.origin,
        });
        self
    }

    /// Record a block move.
    pub fn moved(
        mut self,
        id: String,
        old_parent_id: Option<String>,
        new_parent_id: Option<String>,
    ) -> Self {
        self.changes.push(BlockChange::Moved {
            id,
            old_parent_id,
            new_parent_id,
            origin: self.origin,
        });
        self
    }

    /// Record a block deletion.
    pub fn deleted(mut self, id: String, content: String) -> Self {
        self.changes.push(BlockChange::Deleted {
            id,
            content,
            origin: self.origin,
        });
        self
    }

    /// Record a collapsed state change.
    pub fn collapsed_changed(mut self, id: String, collapsed: bool) -> Self {
        self.changes.push(BlockChange::CollapsedChanged {
            id,
            collapsed,
            origin: self.origin,
        });
        self
    }

    /// Build the final list of changes.
    pub fn build(self) -> Vec<BlockChange> {
        self.changes
    }

    /// Check if any changes were recorded.
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_emit_single_change() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();

        let change = BlockChange::Created {
            id: "block-1".to_string(),
            content: "hello".to_string(),
            parent_id: None,
            origin: Origin::User,
        };

        let count = emitter.emit(change.clone()).unwrap();
        assert_eq!(count, 1);

        let batch = rx.recv().await.unwrap();
        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0], change);
    }

    #[tokio::test]
    async fn test_emit_batch() {
        let emitter = ChangeEmitter::new();
        let mut rx = emitter.subscribe();

        let mut batch = BlockChangeBatch::new();
        batch.push(BlockChange::Created {
            id: "block-1".to_string(),
            content: "first".to_string(),
            parent_id: None,
            origin: Origin::User,
        });
        batch.push(BlockChange::Created {
            id: "block-2".to_string(),
            content: "second".to_string(),
            parent_id: Some("block-1".to_string()),
            origin: Origin::User,
        });

        emitter.emit_batch(batch).unwrap();

        let received = rx.recv().await.unwrap();
        assert_eq!(received.changes.len(), 2);
    }

    #[tokio::test]
    async fn test_multiple_subscribers() {
        let emitter = ChangeEmitter::new();
        let mut rx1 = emitter.subscribe();
        let mut rx2 = emitter.subscribe();

        assert_eq!(emitter.subscriber_count(), 2);

        let change = BlockChange::Deleted {
            id: "block-1".to_string(),
            content: "deleted".to_string(),
            origin: Origin::Agent,
        };

        let count = emitter.emit(change).unwrap();
        assert_eq!(count, 2);

        // Both receivers should get the same batch
        let batch1 = rx1.recv().await.unwrap();
        let batch2 = rx2.recv().await.unwrap();
        assert_eq!(batch1.changes.len(), 1);
        assert_eq!(batch2.changes.len(), 1);
    }

    #[test]
    fn test_emit_empty_batch_is_noop() {
        let emitter = ChangeEmitter::new();
        let _rx = emitter.subscribe();

        let batch = BlockChangeBatch::new();
        let count = emitter.emit_batch(batch).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_emit_no_subscribers_ok() {
        let emitter = ChangeEmitter::new();
        // No subscribers

        let change = BlockChange::Created {
            id: "block-1".to_string(),
            content: "test".to_string(),
            parent_id: None,
            origin: Origin::User,
        };

        // Should not error, just return 0
        let count = emitter.emit(change).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn test_parse_origin() {
        assert_eq!(parse_origin(Some("user")), Origin::User);
        assert_eq!(parse_origin(Some("USER")), Origin::User);
        assert_eq!(parse_origin(Some("hook")), Origin::Hook);
        assert_eq!(parse_origin(Some("agent")), Origin::Agent);
        assert_eq!(parse_origin(Some("remote")), Origin::Remote);
        assert_eq!(parse_origin(Some("bulk_import")), Origin::BulkImport);
        assert_eq!(parse_origin(Some("unknown")), Origin::User); // Default
        assert_eq!(parse_origin(None), Origin::User);
    }

    #[test]
    fn test_change_builder() {
        let changes = ChangeBuilder::new(Origin::Agent)
            .created("b1".to_string(), "content".to_string(), None)
            .content_changed("b2".to_string(), "old".to_string(), "new".to_string())
            .deleted("b3".to_string(), "gone".to_string())
            .build();

        assert_eq!(changes.len(), 3);

        // All should have Agent origin
        for change in &changes {
            assert_eq!(change.origin(), Origin::Agent);
        }
    }

    #[test]
    fn test_change_builder_empty() {
        let builder = ChangeBuilder::new(Origin::User);
        assert!(builder.is_empty());

        let changes = builder.build();
        assert!(changes.is_empty());
    }
}
