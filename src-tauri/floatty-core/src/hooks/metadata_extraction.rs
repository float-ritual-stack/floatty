//! Metadata extraction hook.
//!
//! Extracts :: markers and [[wikilinks]] from block content,
//! populating `block.metadata` for downstream hooks to use.
//!
//! # Priority
//!
//! This hook runs at priority 10 (before PageNameIndex and Tantivy).
//! It's synchronous so metadata is available before indexing.
//!
//! # Origin Filtering
//!
//! Accepts: User, Agent, BulkImport, Remote
//! Ignores: Hook (prevents infinite loops)

use crate::{
    events::BlockChange, hooks::parsing, metadata::BlockMetadata, BlockChangeBatch, Origin,
    YDocStore,
};
use std::sync::Arc;
use tracing::{debug, instrument, warn};

use super::BlockHook;

/// Hook that extracts metadata from block content.
///
/// Extracts:
/// - Prefix markers: `sh::`, `ctx::`, `ai::`, etc.
/// - Tag markers: `[project::floatty]`, `[mode::dev]`, etc.
/// - Wikilinks: `[[Page Name]]`, `[[Target|Alias]]`, nested `[[outer [[inner]]]]`
///
/// Writes extracted data to `block.metadata` with `Origin::Hook`.
pub struct MetadataExtractionHook;

impl BlockHook for MetadataExtractionHook {
    fn name(&self) -> &'static str {
        "metadata_extraction"
    }

    fn priority(&self) -> i32 {
        10 // Run before PageNameIndex (20) and Tantivy (50)
    }

    fn is_sync(&self) -> bool {
        true // Block until complete - downstream hooks need metadata
    }

    fn accepts_origins(&self) -> Option<Vec<Origin>> {
        // Accept user actions, agent writes, bulk imports, and remote (GUI edits via WS).
        // Exclude Hook only (prevents infinite loops).
        // Remote is included because the server is the sole metadata extractor —
        // the frontend does NOT extract markers before syncing.
        Some(vec![Origin::User, Origin::Agent, Origin::BulkImport, Origin::Remote])
    }

    #[instrument(skip(self, batch, store), fields(batch_size = batch.changes.len()))]
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) {
        for change in &batch.changes {
            match change {
                BlockChange::Created { id, content, .. }
                | BlockChange::ContentChanged {
                    id,
                    new_content: content,
                    ..
                } => {
                    self.extract_and_store(id, content, &store);
                }
                // Ignore other change types - they don't affect content
                _ => {}
            }
        }
    }
}

impl MetadataExtractionHook {
    /// Extract metadata from content and store it on the block.
    #[instrument(skip(self, store), fields(block_id = %id))]
    fn extract_and_store(&self, id: &str, content: &str, store: &YDocStore) {
        let preview: String = content.chars().take(50).collect();
        debug!("MetadataExtractionHook: processing block {} with content: {}", id, preview);

        // Extract markers
        let markers = parsing::extract_all_markers(content);

        // Extract wikilink targets
        let outlinks = if parsing::has_wikilink_patterns(content) {
            parsing::extract_wikilink_targets(content)
        } else {
            Vec::new()
        };

        // Build metadata
        let metadata = BlockMetadata {
            markers,
            outlinks,
            is_stub: false, // Determined by PageNameIndex, not here
            extracted_at: Some(chrono::Utc::now().timestamp()),
        };

        // Skip if nothing to store
        if metadata.is_empty() {
            debug!("No metadata to extract for block {}", id);
            return;
        }

        debug!(
            markers = metadata.markers.len(),
            outlinks = metadata.outlinks.len(),
            "Extracted metadata for block {}",
            id
        );

        // Write metadata to store with Origin::Hook to prevent infinite loops
        match store.update_block_metadata(id, metadata.clone(), Origin::Hook) {
            Ok(_) => {
                debug!("MetadataExtractionHook: wrote metadata for block {} - {} markers, {} outlinks",
                    id, metadata.markers.len(), metadata.outlinks.len());
            }
            Err(e) => {
                warn!("Failed to update metadata for block {}: {}", id, e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::should_process;

    #[test]
    fn test_hook_name() {
        let hook = MetadataExtractionHook;
        assert_eq!(hook.name(), "metadata_extraction");
    }

    #[test]
    fn test_hook_priority() {
        let hook = MetadataExtractionHook;
        assert_eq!(hook.priority(), 10);
    }

    #[test]
    fn test_hook_is_sync() {
        let hook = MetadataExtractionHook;
        assert!(hook.is_sync());
    }

    #[test]
    fn test_accepts_user_origin() {
        let hook = MetadataExtractionHook;
        assert!(should_process(&hook, Origin::User));
    }

    #[test]
    fn test_accepts_agent_origin() {
        let hook = MetadataExtractionHook;
        assert!(should_process(&hook, Origin::Agent));
    }

    #[test]
    fn test_accepts_bulk_import_origin() {
        let hook = MetadataExtractionHook;
        assert!(should_process(&hook, Origin::BulkImport));
    }

    #[test]
    fn test_rejects_hook_origin() {
        let hook = MetadataExtractionHook;
        assert!(!should_process(&hook, Origin::Hook));
    }

    #[test]
    fn test_accepts_remote_origin() {
        let hook = MetadataExtractionHook;
        assert!(should_process(&hook, Origin::Remote));
    }
}
