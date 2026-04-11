//! Block change events for the hook/emitter system.
//!
//! These types represent mutations to blocks that downstream systems
//! (search indexing, metadata extraction, etc.) can subscribe to.
//!
//! # Architecture
//!
//! ```text
//! Y.Doc mutation → Observer fires → BlockChange created → Emitter broadcasts
//!                                                              ↓
//!                                         Hook 1 (metadata) ←──┼──→ Hook 2 (search index)
//! ```
//!
//! The Change Emitter (Unit 1.2) wraps the Y.Doc observer and transforms
//! raw CRDT events into these typed BlockChange events.

use crate::Origin;
use serde::{Deserialize, Serialize};

/// Transaction ID used for cold-start rehydration batches.
///
/// Hooks that need two-pass rebuild logic (e.g., page name index, inheritance
/// index) match against this constant to detect the initial load batch.
/// Using a shared constant prevents silent failures from typos in any copy.
pub const COLD_START_REHYDRATION_TX_ID: &str = "cold_start_rehydration";

/// A single block mutation event.
///
/// Each variant captures the minimal context needed for downstream processing.
/// Origin is always included for hook filtering (prevents infinite loops).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BlockChange {
    /// A new block was created.
    Created {
        id: String,
        content: String,
        parent_id: Option<String>,
        origin: Origin,
    },

    /// Block content was modified.
    ContentChanged {
        id: String,
        old_content: String,
        new_content: String,
        origin: Origin,
    },

    /// Block metadata was modified.
    ///
    /// Metadata changes are separate from content changes because:
    /// - Hooks write metadata (with Origin::Hook) without triggering content hooks
    /// - Search indexing may handle metadata differently than content
    MetadataChanged {
        id: String,
        old_metadata: Option<serde_json::Value>,
        new_metadata: Option<serde_json::Value>,
        origin: Origin,
    },

    /// Block was moved to a different parent.
    Moved {
        id: String,
        old_parent_id: Option<String>,
        new_parent_id: Option<String>,
        origin: Origin,
    },

    /// Block was deleted.
    Deleted {
        id: String,
        /// Content at time of deletion (for undo, search cleanup, etc.)
        content: String,
        origin: Origin,
    },

    /// Block collapsed state changed.
    CollapsedChanged {
        id: String,
        collapsed: bool,
        origin: Origin,
    },
}

impl BlockChange {
    /// Get the block ID this change applies to.
    pub fn block_id(&self) -> &str {
        match self {
            BlockChange::Created { id, .. } => id,
            BlockChange::ContentChanged { id, .. } => id,
            BlockChange::MetadataChanged { id, .. } => id,
            BlockChange::Moved { id, .. } => id,
            BlockChange::Deleted { id, .. } => id,
            BlockChange::CollapsedChanged { id, .. } => id,
        }
    }

    /// Get the origin of this change.
    pub fn origin(&self) -> Origin {
        match self {
            BlockChange::Created { origin, .. } => *origin,
            BlockChange::ContentChanged { origin, .. } => *origin,
            BlockChange::MetadataChanged { origin, .. } => *origin,
            BlockChange::Moved { origin, .. } => *origin,
            BlockChange::Deleted { origin, .. } => *origin,
            BlockChange::CollapsedChanged { origin, .. } => *origin,
        }
    }

    /// Check if this change should trigger metadata extraction hooks.
    ///
    /// Returns false only for Hook origin (prevents infinite loops).
    /// Remote is included — the server is the sole metadata extractor.
    pub fn triggers_metadata_hooks(&self) -> bool {
        self.origin().triggers_metadata_hooks()
    }

    /// Check if this change should trigger search index updates.
    ///
    /// Returns false only for Hook origin (Remote changes need local indexing).
    pub fn triggers_index_hooks(&self) -> bool {
        self.origin().triggers_index_hooks()
    }
}

/// A batch of block changes from a single Y.Doc transaction.
///
/// Batching allows hooks to:
/// - Process related changes together (e.g., parent + children)
/// - Debounce expensive operations
/// - Maintain consistency during bulk operations
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BlockChangeBatch {
    /// The changes in this batch, in order of occurrence.
    pub changes: Vec<BlockChange>,

    /// Timestamp when this batch was created (milliseconds since epoch).
    pub timestamp: i64,

    /// Optional transaction ID for correlation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_id: Option<String>,
}

impl BlockChangeBatch {
    /// Create a new empty batch with current timestamp.
    pub fn new() -> Self {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        Self {
            changes: Vec::new(),
            timestamp,
            transaction_id: None,
        }
    }

    /// Create a batch with a specific transaction ID.
    pub fn with_transaction_id(transaction_id: String) -> Self {
        let mut batch = Self::new();
        batch.transaction_id = Some(transaction_id);
        batch
    }

    /// Add a change to this batch.
    pub fn push(&mut self, change: BlockChange) {
        self.changes.push(change);
    }

    /// Check if this batch is empty.
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// Get the number of changes in this batch.
    pub fn len(&self) -> usize {
        self.changes.len()
    }

    /// Get all unique block IDs affected by this batch.
    pub fn affected_block_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = self.changes.iter().map(|c| c.block_id()).collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// Filter changes by origin (for hook filtering).
    pub fn filter_by_origin<F>(&self, predicate: F) -> Vec<&BlockChange>
    where
        F: Fn(Origin) -> bool,
    {
        self.changes
            .iter()
            .filter(|c| predicate(c.origin()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_block_change_created() {
        let change = BlockChange::Created {
            id: "block-1".to_string(),
            content: "hello".to_string(),
            parent_id: None,
            origin: Origin::User,
        };

        assert_eq!(change.block_id(), "block-1");
        assert_eq!(change.origin(), Origin::User);
        assert!(change.triggers_metadata_hooks());
        assert!(change.triggers_index_hooks());
    }

    #[test]
    fn test_block_change_hook_origin_filtering() {
        let change = BlockChange::MetadataChanged {
            id: "block-1".to_string(),
            old_metadata: None,
            new_metadata: Some(serde_json::json!({"markers": ["ctx"]})),
            origin: Origin::Hook,
        };

        // Hook origin should NOT trigger other hooks (prevents loops)
        assert!(!change.triggers_metadata_hooks());
        assert!(!change.triggers_index_hooks());
    }

    #[test]
    fn test_block_change_remote_origin() {
        let change = BlockChange::ContentChanged {
            id: "block-1".to_string(),
            old_content: "old".to_string(),
            new_content: "new".to_string(),
            origin: Origin::Remote,
        };

        // Remote changes SHOULD trigger metadata hooks (server is sole extractor)
        // and SHOULD trigger index hooks (need local search indexing)
        assert!(change.triggers_metadata_hooks());
        assert!(change.triggers_index_hooks());
    }

    #[test]
    fn test_batch_operations() {
        let mut batch = BlockChangeBatch::new();
        assert!(batch.is_empty());

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

        assert_eq!(batch.len(), 2);
        assert!(!batch.is_empty());

        let ids = batch.affected_block_ids();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&"block-1"));
        assert!(ids.contains(&"block-2"));
    }

    #[test]
    fn test_batch_filter_by_origin() {
        let mut batch = BlockChangeBatch::new();

        batch.push(BlockChange::ContentChanged {
            id: "block-1".to_string(),
            old_content: "old".to_string(),
            new_content: "new".to_string(),
            origin: Origin::User,
        });

        batch.push(BlockChange::MetadataChanged {
            id: "block-1".to_string(),
            old_metadata: None,
            new_metadata: Some(serde_json::json!({})),
            origin: Origin::Hook,
        });

        // Filter for non-Hook origins
        let user_changes = batch.filter_by_origin(|o| o != Origin::Hook);
        assert_eq!(user_changes.len(), 1);

        // Filter for Hook origins
        let hook_changes = batch.filter_by_origin(|o| o == Origin::Hook);
        assert_eq!(hook_changes.len(), 1);
    }

    #[test]
    fn test_serde_roundtrip() {
        let change = BlockChange::Moved {
            id: "block-1".to_string(),
            old_parent_id: Some("parent-1".to_string()),
            new_parent_id: Some("parent-2".to_string()),
            origin: Origin::Agent,
        };

        let json = serde_json::to_string(&change).unwrap();
        let parsed: BlockChange = serde_json::from_str(&json).unwrap();
        assert_eq!(change, parsed);
    }

    #[test]
    fn test_serde_tag_format() {
        let change = BlockChange::Deleted {
            id: "block-1".to_string(),
            content: "deleted content".to_string(),
            origin: Origin::User,
        };

        let json = serde_json::to_string(&change).unwrap();
        // Should use snake_case tag
        assert!(json.contains("\"type\":\"deleted\""));
    }
}
