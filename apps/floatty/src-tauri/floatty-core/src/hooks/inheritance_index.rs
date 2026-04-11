//! InheritanceIndex - In-memory index of inherited tag markers.
//!
//! Inheritance is ADDITIVE by marker type: a block inherits ancestor marker
//! types it doesn't have itself. Context accumulates as the tree grows.
//!
//! Example: parent has `[project::floatty]`, child has `[issue::FLO-351]`.
//! The child inherits `project::floatty` (a type it lacks) while keeping
//! its own `issue::FLO-351`. Effective markers: both.
//!
//! This index pre-computes inheritance so lookups are O(1) instead of
//! O(depth) per block. Incrementally updated per mutation batch (only
//! affected blocks + descendants). Falls back to full rebuild for cold
//! start (single-digit ms at 25K blocks in Rust).
//!
//! # Priority
//!
//! This hook runs at priority 15 (after MetadataExtractionHook at 10,
//! before PageNameIndexHook at 20).
//! Depends on `metadata.markers` being populated first.
//!
//! # Origin Filtering
//!
//! Accepts: User, Agent, BulkImport, Remote
//! Ignores: Hook (metadata writes)

use crate::{
    events::BlockChange, hooks::BlockHook, BlockChangeBatch, Origin, YDocStore,
};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};
use tracing::{debug, instrument};

/// A marker inherited from an ancestor block.
#[derive(Debug, Clone)]
pub struct InheritedMarker {
    /// The marker type: "project", "issue", etc.
    pub marker_type: String,
    /// The marker value: "floatty", "FLO-283", etc.
    pub value: String,
    /// Block ID of the ancestor this marker was inherited from.
    pub source_block_id: String,
}

/// In-memory index mapping block IDs to their inherited tag markers.
///
/// Uses additive inheritance: blocks inherit ancestor marker TYPES they
/// don't have themselves. A block with `[issue::X]` under a parent with
/// `[project::Y]` gets both — own issue + inherited project.
///
/// Rebuilt on every Y.Doc mutation batch. At 25K blocks with avg depth 6,
/// a full rebuild is ~150K HashMap lookups — single-digit ms in Rust.
///
/// # Thread Safety
///
/// Wrapped in `Arc<RwLock<>>` for concurrent reads from API handlers
/// and exclusive writes from the hook.
pub struct InheritanceIndex {
    /// block_id → inherited markers from ancestors (only types the block lacks).
    inherited: HashMap<String, Vec<InheritedMarker>>,
}

impl InheritanceIndex {
    pub fn new() -> Self {
        Self {
            inherited: HashMap::new(),
        }
    }

    /// O(1) lookup of inherited markers for a block.
    ///
    /// Returns empty slice if no ancestor has marker types the block lacks.
    pub fn get(&self, block_id: &str) -> &[InheritedMarker] {
        self.inherited
            .get(block_id)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Number of blocks with inherited markers in the index.
    pub fn len(&self) -> usize {
        self.inherited.len()
    }

    /// Check if index is empty.
    pub fn is_empty(&self) -> bool {
        self.inherited.is_empty()
    }

    /// Full rebuild from Y.Doc store.
    ///
    /// Additive inheritance: for each block, walk up ancestors and collect
    /// tag markers whose type the block doesn't already own. Markers from
    /// different ancestor levels accumulate (project from grandparent,
    /// issue from parent, etc.).
    pub fn rebuild(&mut self, store: &YDocStore) {
        self.inherited.clear();

        let block_ids = store.get_all_block_ids();

        for block_id in &block_ids {
            if let Some(block) = store.get_block(block_id) {
                // Collect the block's own marker types
                let own_types: HashSet<String> = block
                    .metadata
                    .as_ref()
                    .map(|m| {
                        m.markers
                            .iter()
                            .filter_map(|marker| {
                                marker.value.as_ref().map(|_| marker.marker_type.clone())
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                // Walk up ancestors, collecting markers of types we lack
                let mut seen_types = own_types;
                let mut inherited = Vec::new();
                let mut current_parent = block.parent_id;
                let mut depth = 0;

                while let Some(ref pid) = current_parent {
                    depth += 1;
                    if depth > 50 {
                        break;
                    }
                    if let Some(parent) = store.get_block(pid) {
                        if let Some(ref meta) = parent.metadata {
                            for marker in &meta.markers {
                                if let Some(ref v) = marker.value {
                                    if !seen_types.contains(&marker.marker_type) {
                                        inherited.push(InheritedMarker {
                                            marker_type: marker.marker_type.clone(),
                                            value: v.clone(),
                                            source_block_id: pid.clone(),
                                        });
                                        seen_types.insert(marker.marker_type.clone());
                                    }
                                }
                            }
                        }
                        current_parent = parent.parent_id;
                    } else {
                        break;
                    }
                }

                if !inherited.is_empty() {
                    self.inherited.insert(block_id.clone(), inherited);
                }
            }
        }

        debug!(
            "InheritanceIndex rebuilt: {} blocks with inherited markers (of {} total)",
            self.inherited.len(),
            block_ids.len()
        );
    }

    /// Incrementally update the index for a set of affected block IDs.
    ///
    /// Instead of rebuilding the entire tree, this:
    /// 1. Expands the affected set to include descendants (marker changes propagate down)
    ///    and ancestors (parent marker changes affect children's inheritance)
    /// 2. Recomputes inheritance only for blocks in the expanded set
    /// 3. Removes entries for deleted blocks
    ///
    /// Falls back to full `rebuild()` if the expanded set exceeds 500 blocks
    /// (at that point incremental is slower than full rebuild).
    pub fn update_affected(
        &mut self,
        affected_ids: &HashSet<String>,
        deleted_ids: &HashSet<String>,
        store: &YDocStore,
    ) {
        // Remove deleted blocks from index
        for id in deleted_ids {
            self.inherited.remove(id);
        }

        if affected_ids.is_empty() {
            return;
        }

        // Expand affected set: for each affected block, include its descendants
        // (they may inherit new/changed markers) and ancestors (their changes
        // propagate down through the tree).
        let mut expanded = HashSet::new();
        for id in affected_ids {
            // Add the block itself
            expanded.insert(id.clone());

            // Add descendants (BFS walk via child_ids)
            let mut queue = vec![id.clone()];
            while let Some(current) = queue.pop() {
                if let Some(block) = store.get_block(&current) {
                    for child_id in &block.child_ids {
                        if expanded.insert(child_id.clone()) {
                            queue.push(child_id.clone());
                        }
                    }
                }
            }

            // Add ancestors (walk up via parent_id)
            if let Some(block) = store.get_block(id) {
                let mut parent = block.parent_id;
                let mut depth = 0;
                while let Some(ref pid) = parent {
                    depth += 1;
                    if depth > 50 || !expanded.insert(pid.clone()) {
                        break;
                    }
                    parent = store.get_block(pid).and_then(|b| b.parent_id);
                }
            }
        }

        // If expanded set is too large, full rebuild is more efficient
        if expanded.len() > 500 {
            debug!(
                "InheritanceIndex: expanded set {} blocks exceeds threshold, falling back to full rebuild",
                expanded.len()
            );
            self.rebuild(store);
            return;
        }

        debug!(
            "InheritanceIndex: incremental update for {} blocks (from {} affected)",
            expanded.len(),
            affected_ids.len()
        );

        // Recompute inheritance for each block in the expanded set
        for block_id in &expanded {
            if let Some(block) = store.get_block(block_id) {
                let own_types: HashSet<String> = block
                    .metadata
                    .as_ref()
                    .map(|m| {
                        m.markers
                            .iter()
                            .filter_map(|marker| {
                                marker.value.as_ref().map(|_| marker.marker_type.clone())
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                let mut seen_types = own_types;
                let mut inherited_markers = Vec::new();
                let mut current_parent = block.parent_id;
                let mut depth = 0;

                while let Some(ref pid) = current_parent {
                    depth += 1;
                    if depth > 50 {
                        break;
                    }
                    if let Some(parent) = store.get_block(pid) {
                        if let Some(ref meta) = parent.metadata {
                            for marker in &meta.markers {
                                if let Some(ref v) = marker.value {
                                    if !seen_types.contains(&marker.marker_type) {
                                        inherited_markers.push(InheritedMarker {
                                            marker_type: marker.marker_type.clone(),
                                            value: v.clone(),
                                            source_block_id: pid.clone(),
                                        });
                                        seen_types.insert(marker.marker_type.clone());
                                    }
                                }
                            }
                        }
                        current_parent = parent.parent_id;
                    } else {
                        break;
                    }
                }

                if inherited_markers.is_empty() {
                    self.inherited.remove(block_id);
                } else {
                    self.inherited.insert(block_id.clone(), inherited_markers);
                }
            } else {
                // Block no longer exists
                self.inherited.remove(block_id);
            }
        }
    }

    /// Clear the entire index.
    pub fn clear(&mut self) {
        self.inherited.clear();
    }
}

impl Default for InheritanceIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Hook that maintains the InheritanceIndex.
///
/// On any batch of changes, incrementally updates affected blocks.
/// Falls back to full rebuild for cold start rehydration or batches >500 blocks.
pub struct InheritanceIndexHook {
    index: Arc<RwLock<InheritanceIndex>>,
}

impl InheritanceIndexHook {
    /// Create a new hook with an empty index.
    pub fn new() -> Self {
        Self {
            index: Arc::new(RwLock::new(InheritanceIndex::new())),
        }
    }

    /// Get a reference to the shared index.
    pub fn index(&self) -> Arc<RwLock<InheritanceIndex>> {
        Arc::clone(&self.index)
    }
}

impl Default for InheritanceIndexHook {
    fn default() -> Self {
        Self::new()
    }
}

impl BlockHook for InheritanceIndexHook {
    fn name(&self) -> &'static str {
        "inheritance_index"
    }

    fn priority(&self) -> i32 {
        15 // After MetadataExtractionHook (10), before PageNameIndexHook (20)
    }

    fn is_sync(&self) -> bool {
        true // Fast rebuild, needed before TantivyIndexHook reads it
    }

    fn accepts_origins(&self) -> Option<Vec<Origin>> {
        Some(vec![Origin::User, Origin::Agent, Origin::BulkImport, Origin::Remote])
    }

    #[instrument(skip(self, batch, store), fields(batch_size = batch.changes.len()))]
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) {
        // Check if any change could affect inheritance
        // (content, metadata, structure changes — skip collapsed-only changes)
        let affects_inheritance = batch.changes.iter().any(|c| {
            !matches!(c, BlockChange::CollapsedChanged { .. })
        });

        if !affects_inheritance {
            return;
        }

        let mut index = self.index.write().expect("lock poisoned");

        // Cold start rehydration or very large batches: full rebuild
        let is_cold_start = batch
            .transaction_id
            .as_deref()
            == Some(crate::events::COLD_START_REHYDRATION_TX_ID);

        if is_cold_start {
            index.rebuild(&store);
            return;
        }

        // Extract affected IDs and deleted IDs from the batch
        let mut affected_ids = HashSet::new();
        let mut deleted_ids = HashSet::new();

        for change in &batch.changes {
            match change {
                BlockChange::Deleted { id, .. } => {
                    deleted_ids.insert(id.clone());
                }
                BlockChange::CollapsedChanged { .. } => {
                    // Already filtered above, but be explicit
                }
                _ => {
                    affected_ids.insert(change.block_id().to_string());
                }
            }
        }

        index.update_affected(&affected_ids, &deleted_ids, &store);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::should_process;
    use crate::metadata::{BlockMetadata, Marker};
    use crate::YDocStore;
    use tempfile::tempdir;
    use yrs::{ArrayPrelim, Map, Transact, WriteTxn};

    /// Helper: create a block in the YDocStore with content, parentId, and childIds.
    /// Metadata is set separately via `set_block_metadata`.
    fn insert_block(
        store: &YDocStore,
        id: &str,
        content: &str,
        parent_id: Option<&str>,
        child_ids: &[&str],
    ) {
        let doc = store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");

        // get_or_init creates a MapRef we can insert fields into
        let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, id);
        block_map.insert(&mut txn, "content", yrs::Any::String(content.into()));
        if let Some(pid) = parent_id {
            block_map.insert(&mut txn, "parentId", yrs::Any::String(pid.into()));
        }

        // Insert childIds as Y.Array (required for get_block to read them)
        let child_any: Vec<yrs::Any> = child_ids
            .iter()
            .map(|c| yrs::Any::String((*c).into()))
            .collect();
        block_map.insert(&mut txn, "childIds", ArrayPrelim::from(child_any));
    }

    /// Helper: set metadata (markers) on a block using the store's update_block_metadata.
    fn set_block_metadata(store: &YDocStore, id: &str, markers: &[(&str, &str)]) {
        let mut meta = BlockMetadata::new();
        for (mtype, mvalue) in markers {
            meta.add_marker(Marker::with_value(*mtype, *mvalue));
        }
        store
            .update_block_metadata(id, meta, crate::Origin::Hook)
            .unwrap();
    }

    #[test]
    fn test_index_new_is_empty() {
        let index = InheritanceIndex::new();
        assert!(index.is_empty());
        assert_eq!(index.len(), 0);
    }

    #[test]
    fn test_index_get_missing_returns_empty() {
        let index = InheritanceIndex::new();
        assert!(index.get("nonexistent").is_empty());
    }

    #[test]
    fn test_index_clear() {
        let mut index = InheritanceIndex::new();
        index.inherited.insert(
            "block-1".to_string(),
            vec![InheritedMarker {
                marker_type: "project".to_string(),
                value: "floatty".to_string(),
                source_block_id: "parent-1".to_string(),
            }],
        );
        assert_eq!(index.len(), 1);

        index.clear();
        assert!(index.is_empty());
    }

    #[test]
    fn test_hook_name() {
        let hook = InheritanceIndexHook::new();
        assert_eq!(hook.name(), "inheritance_index");
    }

    #[test]
    fn test_hook_priority() {
        let hook = InheritanceIndexHook::new();
        assert_eq!(hook.priority(), 15);
    }

    #[test]
    fn test_hook_is_sync() {
        let hook = InheritanceIndexHook::new();
        assert!(hook.is_sync());
    }

    #[test]
    fn test_accepts_user_origin() {
        let hook = InheritanceIndexHook::new();
        assert!(should_process(&hook, Origin::User));
    }

    #[test]
    fn test_accepts_agent_origin() {
        let hook = InheritanceIndexHook::new();
        assert!(should_process(&hook, Origin::Agent));
    }

    #[test]
    fn test_accepts_bulk_import_origin() {
        let hook = InheritanceIndexHook::new();
        assert!(should_process(&hook, Origin::BulkImport));
    }

    #[test]
    fn test_rejects_hook_origin() {
        let hook = InheritanceIndexHook::new();
        assert!(!should_process(&hook, Origin::Hook));
    }

    #[test]
    fn test_accepts_remote_origin() {
        let hook = InheritanceIndexHook::new();
        assert!(should_process(&hook, Origin::Remote));
    }

    #[test]
    fn test_index_shared_access() {
        let hook = InheritanceIndexHook::new();
        let index = hook.index();

        // Verify we can read the index
        let guard = index.read().expect("lock poisoned");
        assert!(guard.is_empty());
    }

    // =========================================================================
    // rebuild() tests — full tree inheritance
    // =========================================================================

    #[test]
    fn test_rebuild_single_root_no_inheritance() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        insert_block(&store, "root", "plain text", None, &[]);

        let mut index = InheritanceIndex::new();
        index.rebuild(&store);

        // Root block with no ancestors inherits nothing
        assert!(index.get("root").is_empty());
        assert_eq!(index.len(), 0);
    }

    #[test]
    fn test_rebuild_child_inherits_parent_marker() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        insert_block(&store, "parent", "[project::floatty]", None, &["child"]);
        insert_block(&store, "child", "plain text", Some("parent"), &[]);
        set_block_metadata(&store, "parent", &[("project", "floatty")]);

        let mut index = InheritanceIndex::new();
        index.rebuild(&store);

        let inherited = index.get("child");
        assert_eq!(inherited.len(), 1);
        assert_eq!(inherited[0].marker_type, "project");
        assert_eq!(inherited[0].value, "floatty");
        assert_eq!(inherited[0].source_block_id, "parent");
    }

    #[test]
    fn test_rebuild_additive_inheritance_across_three_levels() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // grandparent: [project::floatty]
        // parent: [issue::FLO-361]
        // child: no markers → inherits both
        insert_block(&store, "gp", "[project::floatty]", None, &["parent"]);
        insert_block(&store, "parent", "[issue::FLO-361]", Some("gp"), &["child"]);
        insert_block(&store, "child", "some work", Some("parent"), &[]);

        set_block_metadata(&store, "gp", &[("project", "floatty")]);
        set_block_metadata(&store, "parent", &[("issue", "FLO-361")]);

        let mut index = InheritanceIndex::new();
        index.rebuild(&store);

        let inherited = index.get("child");
        assert_eq!(inherited.len(), 2);
        let types: HashSet<&str> = inherited.iter().map(|m| m.marker_type.as_str()).collect();
        assert!(types.contains("project"));
        assert!(types.contains("issue"));
    }

    #[test]
    fn test_rebuild_own_type_blocks_ancestor_same_type() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // parent: [project::floatty]
        // child: [project::other] → should NOT inherit project from parent (has own)
        insert_block(&store, "parent", "[project::floatty]", None, &["child"]);
        insert_block(&store, "child", "[project::other]", Some("parent"), &[]);

        set_block_metadata(&store, "parent", &[("project", "floatty")]);
        set_block_metadata(&store, "child", &[("project", "other")]);

        let mut index = InheritanceIndex::new();
        index.rebuild(&store);

        // Child has its own project marker, so no inheritance
        assert!(index.get("child").is_empty());
    }

    // =========================================================================
    // update_affected() tests — incremental updates
    // =========================================================================

    #[test]
    fn test_update_affected_root_block_no_parent() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        insert_block(&store, "root", "[project::floatty]", None, &[]);
        set_block_metadata(&store, "root", &[("project", "floatty")]);

        let mut index = InheritanceIndex::new();
        let mut affected = HashSet::new();
        affected.insert("root".to_string());

        index.update_affected(&affected, &HashSet::new(), &store);

        // Root with no parent has nothing to inherit
        assert!(index.get("root").is_empty());
    }

    #[test]
    fn test_update_affected_propagates_to_descendants() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Tree: parent → child → grandchild
        insert_block(&store, "parent", "[project::floatty]", None, &["child"]);
        insert_block(&store, "child", "middle", Some("parent"), &["gc"]);
        insert_block(&store, "gc", "leaf", Some("child"), &[]);

        set_block_metadata(&store, "parent", &[("project", "floatty")]);

        let mut index = InheritanceIndex::new();
        let mut affected = HashSet::new();
        affected.insert("parent".to_string());

        index.update_affected(&affected, &HashSet::new(), &store);

        // Child should inherit project from parent
        let child_inherited = index.get("child");
        assert_eq!(child_inherited.len(), 1);
        assert_eq!(child_inherited[0].marker_type, "project");

        // Grandchild should also inherit project (descendant expansion)
        let gc_inherited = index.get("gc");
        assert_eq!(gc_inherited.len(), 1);
        assert_eq!(gc_inherited[0].marker_type, "project");
        assert_eq!(gc_inherited[0].source_block_id, "parent");
    }

    #[test]
    fn test_update_affected_deleted_block_removed_from_index() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Seed the index with a pre-existing entry
        let mut index = InheritanceIndex::new();
        index.inherited.insert(
            "deleted-block".to_string(),
            vec![InheritedMarker {
                marker_type: "project".to_string(),
                value: "floatty".to_string(),
                source_block_id: "some-parent".to_string(),
            }],
        );
        assert_eq!(index.len(), 1);

        let mut deleted = HashSet::new();
        deleted.insert("deleted-block".to_string());

        index.update_affected(&HashSet::new(), &deleted, &store);

        // Deleted block should be removed
        assert!(index.get("deleted-block").is_empty());
        assert_eq!(index.len(), 0);
    }

    #[test]
    fn test_update_affected_deleted_block_with_descendants() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Parent exists in store, child was deleted (not in store)
        insert_block(&store, "parent", "[project::floatty]", None, &["child"]);
        set_block_metadata(&store, "parent", &[("project", "floatty")]);
        // "child" is NOT inserted — simulates already-deleted block

        let mut index = InheritanceIndex::new();
        // Pre-seed index entries for both
        index.inherited.insert(
            "child".to_string(),
            vec![InheritedMarker {
                marker_type: "project".to_string(),
                value: "floatty".to_string(),
                source_block_id: "parent".to_string(),
            }],
        );

        let mut deleted = HashSet::new();
        deleted.insert("child".to_string());

        // Also mark parent as affected (its childIds changed)
        let mut affected = HashSet::new();
        affected.insert("parent".to_string());

        index.update_affected(&affected, &deleted, &store);

        // Deleted child removed
        assert!(index.get("child").is_empty());
        // Parent has no ancestors, so no inheritance for it
        assert!(index.get("parent").is_empty());
    }

    #[test]
    fn test_update_affected_depth_limit_50() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Build a chain deeper than 50: block-0 → block-1 → ... → block-55
        // Only block-0 has a marker
        let depth = 55;
        for i in 0..=depth {
            let id = format!("block-{}", i);
            let parent = if i == 0 { None } else { Some(format!("block-{}", i - 1)) };
            let child = if i == depth { vec![] } else { vec![format!("block-{}", i + 1)] };
            let child_refs: Vec<&str> = child.iter().map(|s| s.as_str()).collect();

            insert_block(
                &store,
                &id,
                if i == 0 { "[project::deep]" } else { "text" },
                parent.as_deref(),
                &child_refs,
            );
        }
        set_block_metadata(&store, "block-0", &[("project", "deep")]);

        let mut index = InheritanceIndex::new();
        index.rebuild(&store);

        // Block at depth 50 should inherit (depth limit is 50 ancestor hops)
        let at_50 = index.get("block-50");
        assert_eq!(at_50.len(), 1, "block-50 should inherit from block-0");
        assert_eq!(at_50[0].marker_type, "project");

        // Block at depth 51+ should NOT inherit (beyond depth limit)
        let at_51 = index.get("block-51");
        assert!(at_51.is_empty(), "block-51 should be beyond depth limit");
    }

    #[test]
    fn test_update_affected_empty_affected_set() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        let mut index = InheritanceIndex::new();
        // Pre-seed with some data
        index.inherited.insert(
            "existing".to_string(),
            vec![InheritedMarker {
                marker_type: "project".to_string(),
                value: "floatty".to_string(),
                source_block_id: "parent".to_string(),
            }],
        );

        // Empty affected + empty deleted = no change
        index.update_affected(&HashSet::new(), &HashSet::new(), &store);

        // Pre-existing data should be untouched
        assert_eq!(index.len(), 1);
        assert_eq!(index.get("existing").len(), 1);
    }

    #[test]
    fn test_update_affected_removes_stale_inheritance() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Parent has marker, child inherits
        insert_block(&store, "parent", "[project::floatty]", None, &["child"]);
        insert_block(&store, "child", "text", Some("parent"), &[]);
        set_block_metadata(&store, "parent", &[("project", "floatty")]);

        let mut index = InheritanceIndex::new();
        index.rebuild(&store);
        assert_eq!(index.get("child").len(), 1);

        // Now child gets its own project marker → should no longer inherit
        set_block_metadata(&store, "child", &[("project", "other")]);

        let mut affected = HashSet::new();
        affected.insert("child".to_string());
        index.update_affected(&affected, &HashSet::new(), &store);

        // Child now has own project type, inheritance cleared
        assert!(index.get("child").is_empty());
    }

    #[test]
    fn test_update_affected_block_not_in_store() {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("test.db"), "test").unwrap();

        // Pre-seed index with a block that no longer exists in store
        let mut index = InheritanceIndex::new();
        index.inherited.insert(
            "ghost".to_string(),
            vec![InheritedMarker {
                marker_type: "project".to_string(),
                value: "floatty".to_string(),
                source_block_id: "parent".to_string(),
            }],
        );

        let mut affected = HashSet::new();
        affected.insert("ghost".to_string());

        index.update_affected(&affected, &HashSet::new(), &store);

        // Ghost block should be cleaned up since it's not in store
        assert!(index.get("ghost").is_empty());
        assert_eq!(index.len(), 0);
    }
}
