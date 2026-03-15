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
//! All hooks accept Remote — the server is the sole metadata extractor.
//! Remote content needs indexing for search, and metadata is populated
//! by MetadataExtractionHook (priority 10) before this hook runs.

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
        use crate::hooks::parsing::extract_ctx_datetime;

        // Extract block type from content
        let block_type = parse_block_type(content).as_str().to_string();

        // Get all indexable data from block metadata
        let block_data = store.get_block(id);

        let parent_id = block_data.as_ref().and_then(|b| b.parent_id.clone());
        // created_at is stored in Y.Doc as milliseconds, convert to seconds for Tantivy
        // (consistent with updated_at and ctx_at which use epoch seconds)
        let created_at = block_data
            .as_ref()
            .map(|b| b.created_at / 1000)
            .unwrap_or(0);

        // Extract marker data and outlinks from metadata
        let (has_markers, markers, outlinks, marker_types, marker_values) = block_data
            .as_ref()
            .map(|b| {
                let own_markers = b
                    .metadata
                    .as_ref()
                    .map(|m| &m.markers[..])
                    .unwrap_or(&[]);

                // Format own markers for full-text search
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

                // Include inherited markers
                if let Ok(index) = self.inheritance_index.read() {
                    for marker in index.get(id) {
                        formatted_parts.push(format!("{}::{}", marker.marker_type, marker.value));
                    }
                }

                let has_markers = !formatted_parts.is_empty();
                let markers_str = formatted_parts.join(" ");

                // Extract distinct marker types and "type::value" pairs
                let mut m_types: Vec<String> = own_markers
                    .iter()
                    .map(|m| m.marker_type.clone())
                    .collect();
                m_types.sort();
                m_types.dedup();

                let m_values: Vec<String> = own_markers
                    .iter()
                    .filter_map(|m| {
                        m.value
                            .as_ref()
                            .map(|v| format!("{}::{}", m.marker_type, v))
                    })
                    .collect();

                // Outlinks from metadata
                let outlinks = b
                    .metadata
                    .as_ref()
                    .map(|m| m.outlinks.clone())
                    .unwrap_or_default();

                (has_markers, markers_str, outlinks, m_types, m_values)
            })
            .unwrap_or((false, String::new(), vec![], vec![], vec![]));

        // Extract ctx_at from content (uses dedicated datetime parser)
        let ctx_at = extract_ctx_datetime(content)
            .and_then(|dt_str| {
                // Parse ISO datetime to epoch. Handles "2026-03-11" and "2026-03-11T16:42:00"
                chrono::NaiveDateTime::parse_from_str(&dt_str, "%Y-%m-%dT%H:%M:%S")
                    .or_else(|_| {
                        chrono::NaiveDate::parse_from_str(&dt_str, "%Y-%m-%d")
                            .map(|d| d.and_hms_opt(0, 0, 0).unwrap())
                    })
                    .ok()
                    .map(|ndt| ndt.and_utc().timestamp())
            })
            .unwrap_or(0);

        let updated_at = chrono::Utc::now().timestamp();

        trace!(
            block_id = %id,
            block_type = %block_type,
            has_markers = has_markers,
            markers = %markers,
            outlinks = ?outlinks,
            ctx_at = ctx_at,
            "Indexing block"
        );

        // Send to writer (async)
        let writer = writer.clone();
        let id = id.to_string();
        let content = content.to_string();
        tokio::spawn(async move {
            if let Err(e) = writer
                .add_or_update(
                    id.clone(),
                    content,
                    block_type,
                    parent_id,
                    updated_at,
                    has_markers,
                    markers,
                    outlinks,
                    marker_types,
                    marker_values,
                    created_at,
                    ctx_at,
                )
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
