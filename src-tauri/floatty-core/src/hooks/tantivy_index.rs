//! Tantivy index hook.
//!
//! Maps BlockChange events to WriterHandle operations for search indexing.
//!
//! # Priority
//!
//! This hook runs at priority 50 (after MetadataExtraction at 10, PageNameIndex at 20).
//! This ensures metadata is populated before we check `has_markers`.
//!
//! # Origin Filtering
//!
//! Accepts: User, Remote, Agent, BulkImport
//! Ignores: Hook (prevents redundant re-indexing)
//!
//! Unlike MetadataExtractionHook, we DO accept Remote origin because:
//! - The local Tantivy index needs remote content for search to work
//! - Metadata comes with CRDT sync, so we can read `block.metadata`

use crate::{
    block::parse_block_type,
    events::BlockChange,
    hooks::InheritanceIndex,
    search::WriterHandle,
    BlockChangeBatch, Origin, YDocStore,
};
use std::sync::{Arc, RwLock};
use tracing::{instrument, trace, warn};

use super::BlockHook;

/// Hook that indexes blocks in Tantivy for full-text search.
///
/// Maps BlockChange events to WriterHandle operations:
/// - Created → AddOrUpdate
/// - ContentChanged → AddOrUpdate
/// - MetadataChanged → AddOrUpdate (updates has_markers)
/// - Deleted → Delete
/// - Moved, CollapsedChanged → no-op
pub struct TantivyIndexHook {
    writer: WriterHandle,
    /// Pre-computed inheritance index (populated by InheritanceIndexHook at priority 15).
    inheritance_index: Arc<RwLock<InheritanceIndex>>,
}

impl TantivyIndexHook {
    /// Create a new TantivyIndexHook with the given writer handle and inheritance index.
    pub fn new(writer: WriterHandle, inheritance_index: Arc<RwLock<InheritanceIndex>>) -> Self {
        Self { writer, inheritance_index }
    }
}

impl BlockHook for TantivyIndexHook {
    fn name(&self) -> &'static str {
        "tantivy_index"
    }

    fn priority(&self) -> i32 {
        50 // After metadata hooks (10-20)
    }

    fn is_sync(&self) -> bool {
        false // Async - don't block user input, channel send is cheap
    }

    fn accepts_origins(&self) -> Option<Vec<Origin>> {
        // Index everything except hook-generated changes
        // Includes Remote because local index needs remote content
        Some(vec![
            Origin::User,
            Origin::Remote,
            Origin::Agent,
            Origin::BulkImport,
        ])
    }

    #[instrument(skip(self, batch, store), fields(batch_size = batch.changes.len()))]
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) {
        let writer = self.writer.clone();

        // Process each change
        for change in &batch.changes {
            match change {
                BlockChange::Created { id, content, .. } => {
                    self.index_block(&writer, id, content, &store);
                }
                BlockChange::ContentChanged { id, new_content, .. } => {
                    self.index_block(&writer, id, new_content, &store);
                }
                BlockChange::MetadataChanged { id, .. } => {
                    // Re-index to update has_markers field
                    // Need to fetch current content from store
                    if let Some(block) = store.get_block(id) {
                        self.index_block(&writer, id, &block.content, &store);
                    }
                }
                BlockChange::Deleted { id, .. } => {
                    self.delete_block(&writer, id);
                }
                BlockChange::Moved { id, .. } => {
                    // Re-index to update inherited markers (parent chain changed)
                    if let Some(block) = store.get_block(id) {
                        self.index_block(&writer, id, &block.content, &store);
                    }
                }
                // CollapsedChanged doesn't affect search index
                BlockChange::CollapsedChanged { .. } => {}
            }
        }
    }
}

impl TantivyIndexHook {
    /// Index a block, extracting all necessary fields.
    fn index_block(&self, writer: &WriterHandle, id: &str, content: &str, store: &YDocStore) {
        // Extract block type from content
        let block_type = parse_block_type(content).as_str().to_string();

        // Get parent_id, has_markers, and formatted markers string from store
        // Includes inherited markers from ancestors for search coverage
        let (parent_id, has_markers, markers) = store
            .get_block(id)
            .map(|b| {
                let own_markers = b
                    .metadata
                    .as_ref()
                    .map(|m| &m.markers[..])
                    .unwrap_or(&[]);

                // Format own markers
                let mut formatted_parts: Vec<String> = own_markers
                    .iter()
                    .map(|marker| {
                        if let Some(ref v) = marker.value {
                            format!("{}::{}", marker.marker_type, v)
                        } else {
                            marker.marker_type.clone()
                        }
                    })
                    .collect();

                // Include inherited markers (InheritanceIndex already filters per-type —
                // only includes marker types the block doesn't own)
                if let Ok(index) = self.inheritance_index.read() {
                    for marker in index.get(id) {
                        formatted_parts.push(format!("{}::{}", marker.marker_type, marker.value));
                    }
                }

                let has_markers = !formatted_parts.is_empty();
                let markers_str = formatted_parts.join(" ");
                (b.parent_id, has_markers, markers_str)
            })
            .unwrap_or((None, false, String::new()));

        // Get timestamp
        let updated_at = chrono::Utc::now().timestamp();

        trace!(
            block_id = %id,
            block_type = %block_type,
            has_markers = has_markers,
            markers = %markers,
            "Indexing block"
        );

        // Send to writer (async, but we use spawn to not block)
        let writer = writer.clone();
        let id = id.to_string();
        let content = content.to_string();
        tokio::spawn(async move {
            if let Err(e) = writer
                .add_or_update(id.clone(), content, block_type, parent_id, updated_at, has_markers, markers)
                .await
            {
                warn!(block_id = %id, error = %e, "Failed to index block");
            }
        });
    }

    /// Delete a block from the index.
    fn delete_block(&self, writer: &WriterHandle, id: &str) {
        trace!(block_id = %id, "Deleting block from index");

        let writer = writer.clone();
        let id = id.to_string();
        tokio::spawn(async move {
            if let Err(e) = writer.delete(id.clone()).await {
                warn!(block_id = %id, error = %e, "Failed to delete block from index");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::should_process;

    #[test]
    fn test_hook_name() {
        let hook = create_test_hook();
        assert_eq!(hook.name(), "tantivy_index");
    }

    #[test]
    fn test_hook_priority() {
        let hook = create_test_hook();
        assert_eq!(hook.priority(), 50);
    }

    #[test]
    fn test_hook_is_async() {
        let hook = create_test_hook();
        assert!(!hook.is_sync());
    }

    #[test]
    fn test_accepts_user_origin() {
        let hook = create_test_hook();
        assert!(should_process(&hook, Origin::User));
    }

    #[test]
    fn test_accepts_remote_origin() {
        let hook = create_test_hook();
        assert!(should_process(&hook, Origin::Remote));
    }

    #[test]
    fn test_accepts_agent_origin() {
        let hook = create_test_hook();
        assert!(should_process(&hook, Origin::Agent));
    }

    #[test]
    fn test_accepts_bulk_import_origin() {
        let hook = create_test_hook();
        assert!(should_process(&hook, Origin::BulkImport));
    }

    #[test]
    fn test_rejects_hook_origin() {
        let hook = create_test_hook();
        assert!(!should_process(&hook, Origin::Hook));
    }

    /// Create a mock WriterHandle for testing.
    /// Uses a closed channel so sends will error, but that's fine for unit tests.
    fn create_mock_writer_handle() -> WriterHandle {
        use tokio::sync::mpsc;
        let (tx, _rx) = mpsc::channel(1);
        WriterHandle::from_sender(tx)
    }

    /// Create a TantivyIndexHook with a mock writer and empty inheritance index.
    fn create_test_hook() -> TantivyIndexHook {
        let writer = create_mock_writer_handle();
        let index = Arc::new(RwLock::new(InheritanceIndex::new()));
        TantivyIndexHook::new(writer, index)
    }
}
