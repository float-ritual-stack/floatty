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
///
/// Uses `batch_update_metadata()` to write all metadata in a single Y.Doc
/// transaction, reducing lock acquisitions from N to 1 (FLO-361).
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
        // Phase 1: Extract metadata for all blocks (pure computation, no locks)
        let mut extractions: Vec<(String, BlockMetadata)> = Vec::new();

        for change in &batch.changes {
            match change {
                BlockChange::Created { id, content, .. }
                | BlockChange::ContentChanged {
                    id,
                    new_content: content,
                    ..
                } => {
                    if let Some(metadata) = Self::extract_metadata(id, content) {
                        extractions.push((id.clone(), metadata));
                    }
                }
                _ => {}
            }
        }

        if extractions.is_empty() {
            return;
        }

        debug!(
            "MetadataExtractionHook: writing {} metadata entries in single transaction",
            extractions.len()
        );

        // Phase 2: Batch write all metadata in one Y.Doc transaction (FLO-361)
        let updates: Vec<(&str, BlockMetadata)> = extractions
            .iter()
            .map(|(id, meta)| (id.as_str(), meta.clone()))
            .collect();

        if let Err(e) = store.batch_update_metadata(&updates, Origin::Hook) {
            warn!(
                batch_size = updates.len(),
                "Failed to batch update metadata (all {} blocks in batch lost metadata): {}",
                updates.len(), e
            );
        }
    }
}

impl MetadataExtractionHook {
    /// Extract metadata from content (pure computation, no store access).
    fn extract_metadata(id: &str, content: &str) -> Option<BlockMetadata> {
        let preview: String = content.chars().take(50).collect();
        debug!("MetadataExtractionHook: processing block {} with content: {}", id, preview);

        let markers = parsing::extract_all_markers(content);

        let outlinks = if parsing::has_wikilink_patterns(content) {
            parsing::extract_wikilink_targets(content)
        } else {
            Vec::new()
        };

        let metadata = BlockMetadata {
            markers,
            outlinks,
            is_stub: false,
            extracted_at: Some(chrono::Utc::now().timestamp()),
            summary: None,
        };

        if metadata.is_empty() {
            debug!("No metadata to extract for block {}", id);
            return None;
        }

        debug!(
            markers = metadata.markers.len(),
            outlinks = metadata.outlinks.len(),
            "Extracted metadata for block {}",
            id
        );

        Some(metadata)
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
