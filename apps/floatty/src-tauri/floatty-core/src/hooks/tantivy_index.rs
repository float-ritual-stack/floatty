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
    hooks::{InheritanceIndex, PageNameIndex},
    projections::{walk_ancestors, StoreParentLookup},
    search::{BlockIndexData, WriterHandle},
    BlockChangeBatch, Origin, YDocStore,
};
use std::sync::{Arc, RwLock};
use tracing::{instrument, trace, warn};

use super::BlockHook;

/// Cap for `subtree_size` traversal — keeps populating cost bounded on huge
/// subtrees (a 25K-block daily note shouldn't dominate index time).
///
/// `pub` so the response-shape helpers in `floatty-server::block_service`
/// can reuse the same cap when falling back to a live BFS (singleton
/// paths that don't have a Tantivy STORED hint).
pub const SUBTREE_SIZE_CAP: u32 = 1000;

/// Top-N `inbound_block_ids` cap. Surfaces the most recent blocks that link
/// to this block's nearest page name.
pub const INBOUND_SAMPLES_CAP: usize = 5;

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
    /// Page name index — used to derive `nearest_page_name` and
    /// `inbound_count`. Optional: tests / boot-time configurations can omit
    /// it and the ancestor-context fields will simply be empty/zero.
    page_name_index: Option<Arc<RwLock<PageNameIndex>>>,
}

impl TantivyIndexHook {
    /// Create a new TantivyIndexHook with the given writer handle and inheritance index.
    pub fn new(writer: WriterHandle, inheritance_index: Arc<RwLock<InheritanceIndex>>) -> Self {
        Self {
            writer,
            inheritance_index,
            page_name_index: None,
        }
    }

    /// Variant that takes the PageNameIndex used to derive ancestor-context
    /// page fields. Production callers should use this — the `new`
    /// constructor is kept for legacy / boot-time paths that wire the page
    /// index in later.
    pub fn with_page_index(
        writer: WriterHandle,
        inheritance_index: Arc<RwLock<InheritanceIndex>>,
        page_name_index: Arc<RwLock<PageNameIndex>>,
    ) -> Self {
        Self {
            writer,
            inheritance_index,
            page_name_index: Some(page_name_index),
        }
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
                BlockChange::ContentChanged {
                    id, new_content, ..
                } => {
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
        let own_markers: Vec<_> = block_data
            .as_ref()
            .and_then(|b| b.metadata.as_ref())
            .map(|m| m.markers.clone())
            .unwrap_or_default();

        let outlinks = block_data
            .as_ref()
            .and_then(|b| b.metadata.as_ref())
            .map(|m| m.outlinks.clone())
            .unwrap_or_default();

        // Own marker types and values
        let mut m_types_own: Vec<String> =
            own_markers.iter().map(|m| m.marker_type.clone()).collect();
        m_types_own.sort();
        m_types_own.dedup();

        let m_values_own: Vec<String> = own_markers
            .iter()
            .filter_map(|m| {
                m.value
                    .as_ref()
                    .map(|v| format!("{}::{}", m.marker_type, v))
            })
            .collect();

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

        // Combined types/values start from own, add inherited
        let mut m_types = m_types_own.clone();
        let mut m_values = m_values_own.clone();

        // Include inherited markers (single lock acquisition)
        if let Ok(index) = self.inheritance_index.read() {
            for marker in index.get(id) {
                let formatted = format!("{}::{}", marker.marker_type, marker.value);
                formatted_parts.push(formatted.clone());
                m_types.push(marker.marker_type.clone());
                m_values.push(formatted);
            }
        }

        let has_markers = !formatted_parts.is_empty();
        let markers = formatted_parts.join(" ");

        // Dedup combined types (own + inherited may overlap)
        m_types.sort();
        m_types.dedup();

        // Extract ctx_at from content
        let ctx_at = extract_ctx_datetime(content)
            .and_then(|dt_str| {
                chrono::NaiveDateTime::parse_from_str(&dt_str, "%Y-%m-%dT%H:%M:%S")
                    .or_else(|_| {
                        chrono::NaiveDate::parse_from_str(&dt_str, "%Y-%m-%d")
                            .map(|d| d.and_hms_opt(0, 0, 0).unwrap())
                    })
                    .ok()
                    .map(|ndt| ndt.and_utc().timestamp())
            })
            .unwrap_or(0);

        // FLO-684: read the block's actual updatedAt instead of stamping with
        // index time. Block.updated_at is ms since epoch (frontend `Date.now()`
        // / Rust `timestamp_millis()`); Tantivy's `updated_at` field is the
        // i64 seconds-resolution column declared in `search/schema.rs` —
        // hence `/ 1000` to align units. Same conversion as `created_at`
        // above; if a future writer changes one source's units, BOTH lines
        // here need to update or the recency-sort key drifts silently.
        // Falls back to `created_at` when block_data is unavailable (rare
        // race; created_at is already 0 in that case so the field stays
        // self-consistent).
        //
        // Without this fix, every reindex (incl. full rebuild on app start
        // since the index is ephemeral) overrode the real edit time with
        // wall-clock NOW — kills recency sort across restarts.
        let updated_at = block_data
            .as_ref()
            .map(|b| b.updated_at / 1000)
            .unwrap_or(created_at);

        trace!(
            block_id = %id,
            block_type = %block_type,
            has_markers = has_markers,
            markers = %markers,
            outlinks = ?outlinks,
            ctx_at = ctx_at,
            "Indexing block"
        );

        // Single walker call populates depth, ancestor IDs, and (when a
        // PageNameIndex is wired) nearest_page_*. Walk to depth=50 (the
        // documented indexing cap) so `walk.depth` matches the pre-PR2
        // 50-cap value; slice `walk.ids[..10]` for `ancestor_block_ids`
        // (the `AncestorContext` wire-surface cap). Page-name lookup
        // short-circuits at first match, so the deeper walk doesn't add
        // cost when a page-ancestor sits near the block.
        //
        // Lock-poisoning policy: indexing is best-effort, so a poisoned
        // PageNameIndex degrades to "no nearest_page_* fields + zero
        // inbound_count/inbound_block_ids" rather than aborting the
        // index. We `warn!` so the degradation is visible — silently
        // dropping search-quality fields would let a single upstream
        // panic invisibly corrupt every subsequent index entry.
        //
        // Lock acquisition: hoisted to a single `read()` per indexed
        // block (PR #282 review — Greptile P2). Both the walk and the
        // inbound-derivation step share the same guard, dropping it at
        // the end of the indexing pass for this block. Read-read is
        // safe; single acquisition halves the syscall-level lock cost
        // at indexing throughput.
        let page_index_guard = self.page_name_index.as_ref().and_then(|p| match p.read() {
            Ok(g) => Some(g),
            Err(e) => {
                warn!(
                    block_id = %id,
                    error = %e,
                    "PageNameIndex lock poisoned during indexing — \
                     nearest_page_* fields and inbound_count will be \
                     empty/zero for this block"
                );
                None
            }
        });

        let walk_full = {
            let lookup = StoreParentLookup::new(store);
            walk_ancestors(&lookup, id, 50, page_index_guard.as_deref())
        };

        let depth = walk_full.depth;
        let ancestor_block_ids: Vec<String> = walk_full.ids.iter().take(10).cloned().collect();
        let (nearest_page_block_id, nearest_page_name) = match walk_full.nearest_page {
            Some((bid, name)) => (Some(bid), Some(name)),
            None => (None, None),
        };

        // Subtree size: count descendants up to SUBTREE_SIZE_CAP via the
        // store's child-pointer traversal. Cheap; bounded by the cap.
        let subtree_size = compute_subtree_size(store, id, SUBTREE_SIZE_CAP);

        // Inbound count + samples: derived from PageNameIndex if available.
        // Inbound = blocks whose `outlinks` reference this block's nearest
        // page name (or this block itself if it IS a registered page).
        // Single read-guard scope (hoisted above), single reverse-index
        // lookup — no linear scans (Fix 3 + Fix 9 in the simplify pass).
        let (inbound_count, inbound_block_ids) = page_index_guard
            .as_ref()
            .and_then(|g| {
                // If THIS block IS a registered page, use its own name; else
                // fall back to the nearest ancestor page from the walk.
                let target_name = g
                    .page_name_for_block(id)
                    .map(String::from)
                    .or_else(|| nearest_page_name.clone())?;
                let refs = g.referencing_blocks(&target_name)?;
                let count = refs.len() as u32;
                let mut samples: Vec<String> = refs.iter().cloned().collect();
                samples.sort();
                samples.truncate(INBOUND_SAMPLES_CAP);
                Some((count, samples))
            })
            .unwrap_or((0, vec![]));

        // Drop the read guard explicitly — pedantic, but documents that
        // we're done with PageNameIndex before sending the index payload
        // to the (potentially blocking) writer task.
        drop(page_index_guard);

        // Build BlockIndexData and send to writer
        let data = BlockIndexData {
            block_id: id.to_string(),
            content: content.to_string(),
            block_type,
            parent_id,
            updated_at,
            has_markers,
            markers,
            outlinks,
            marker_types: m_types,
            marker_values: m_values,
            marker_types_own: m_types_own,
            marker_values_own: m_values_own,
            created_at,
            ctx_at,
            depth,
            nearest_page_block_id,
            nearest_page_name,
            ancestor_block_ids,
            subtree_size,
            inbound_count,
            inbound_block_ids,
        };

        let writer = writer.clone();
        let block_id = data.block_id.clone();
        tokio::spawn(async move {
            if let Err(e) = writer.add_or_update(data).await {
                warn!(block_id = %block_id, error = %e, "Failed to index block");
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

/// BFS the descendants of `root_id` via `Store::get_block` until either the
/// tree is exhausted or `cap` is reached. Used to populate `subtree_size`.
///
/// Returns the count INCLUSIVE of `root_id` (1 for a leaf, 0 if root missing).
/// Saturates at `cap` — large subtrees report exactly `cap` and stop the walk.
fn compute_subtree_size(store: &YDocStore, root_id: &str, cap: u32) -> u32 {
    if cap == 0 {
        return 0;
    }
    let mut count: u32 = 0;
    let mut stack: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    seen.insert(root_id.to_string());
    stack.push(root_id.to_string());

    while let Some(id) = stack.pop() {
        // Only count if the block actually exists in the store.
        let Some(block) = store.get_block(&id) else {
            continue;
        };
        count = count.saturating_add(1);
        if count >= cap {
            return cap;
        }
        for child_id in block.child_ids {
            if seen.insert(child_id.clone()) {
                stack.push(child_id);
            }
        }
    }

    count
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

    // ---------------------------------------------------------------------
    // FLO-679 PR 1 (commit 6) — depth-computation behaviour preservation.
    //
    // The depth value previously came from an inline `while let` loop with a
    // 50-cap; it now comes from `walk_ancestors(&StoreParentLookup, id, 50,
    // None).depth`. These tests exercise the `StoreParentLookup` adapter
    // through the same `YDocStore::get_block` path the production hook uses,
    // and assert depth values match what the pre-migration loop would have
    // produced.
    // ---------------------------------------------------------------------

    use crate::projections::{walk_ancestors, StoreParentLookup};
    use yrs::{ArrayPrelim, Map, Transact, WriteTxn};

    /// Insert a block directly into a YDocStore — mirrors the helper used by
    /// `inheritance_index` and `page_name_index` test modules.
    fn insert_block(store: &YDocStore, id: &str, parent_id: Option<&str>) {
        let doc = store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, id);
        block_map.insert(&mut txn, "content", yrs::Any::String("".into()));
        if let Some(pid) = parent_id {
            block_map.insert(&mut txn, "parentId", yrs::Any::String(pid.into()));
        }
        let empty: Vec<yrs::Any> = vec![];
        block_map.insert(&mut txn, "childIds", ArrayPrelim::from(empty));
    }

    fn depth_of(store: &YDocStore, id: &str) -> u32 {
        let lookup = StoreParentLookup::new(store);
        walk_ancestors(&lookup, id, 50, None).depth
    }

    #[test]
    fn depth_zero_for_root_block() {
        let store = YDocStore::new().unwrap();
        insert_block(&store, "r", None);
        assert_eq!(depth_of(&store, "r"), 0);
    }

    #[test]
    fn depth_counts_each_ancestor() {
        // root → a → b → c (c has 3 ancestors).
        let store = YDocStore::new().unwrap();
        insert_block(&store, "root", None);
        insert_block(&store, "a", Some("root"));
        insert_block(&store, "b", Some("a"));
        insert_block(&store, "c", Some("b"));
        assert_eq!(depth_of(&store, "c"), 3);
        assert_eq!(depth_of(&store, "b"), 2);
        assert_eq!(depth_of(&store, "a"), 1);
        assert_eq!(depth_of(&store, "root"), 0);
    }

    #[test]
    fn depth_caps_at_fifty() {
        // Build a 60-deep chain. Cap is 50 → depth saturates at 50.
        let store = YDocStore::new().unwrap();
        insert_block(&store, "b0", None);
        for i in 1..=60 {
            insert_block(&store, &format!("b{}", i), Some(&format!("b{}", i - 1)));
        }
        assert_eq!(
            depth_of(&store, "b60"),
            50,
            "depth saturates at the 50-cap (matches pre-migration loop's `if d >= 50 break`)"
        );
    }

    #[test]
    fn depth_terminates_on_cycle() {
        // Synthetic A ↔ B cycle. Pre-migration this would have walked until d
        // hit 50; the new walker terminates on the visited-set in 1 step.
        let store = YDocStore::new().unwrap();
        insert_block(&store, "a", Some("b"));
        insert_block(&store, "b", Some("a"));
        // a's only collected ancestor is b; the next step (back to a) is blocked.
        assert_eq!(depth_of(&store, "a"), 1);
        assert_eq!(depth_of(&store, "b"), 1);
    }

    #[test]
    fn depth_handles_missing_parent_block() {
        // Block points at a parent that doesn't exist. Pre-migration: the
        // `store.get_block(pid)` returned None, exiting the loop after
        // counting one increment. The walker behaves identically (parent_id
        // returns None on the missing block, terminating the chain).
        let store = YDocStore::new().unwrap();
        insert_block(&store, "child", Some("ghost"));
        assert_eq!(
            depth_of(&store, "child"),
            1,
            "ghost parent counted as one ancestor (matches pre-migration)"
        );
    }
}
