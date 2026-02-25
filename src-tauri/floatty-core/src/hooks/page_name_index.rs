//! PageNameIndex - Fast autocomplete index for [[wikilinks]].
//!
//! Tracks two sets:
//! - **Existing pages**: Direct children of `pages::` container
//! - **Referenced pages**: Extracted from `metadata.outlinks` across all blocks
//!
//! Stubs are pages that are referenced but don't exist yet.
//!
//! # Priority
//!
//! This hook runs at priority 20 (after MetadataExtractionHook at 10).
//! Depends on `metadata.outlinks` being populated first.
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
use tracing::{debug, instrument, trace};

const PAGES_PREFIX: &str = "pages::";

/// A page suggestion for autocomplete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSuggestion {
    /// The page name (without heading prefix)
    pub name: String,
    /// True if this page is referenced but doesn't exist yet
    pub is_stub: bool,
}

impl PageSuggestion {
    pub fn existing(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            is_stub: false,
        }
    }

    pub fn stub(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            is_stub: true,
        }
    }
}

/// Fast index for page name autocomplete.
///
/// Tracks existing pages (blocks under `pages::`) and referenced pages
/// (from `metadata.outlinks`). Used for `[[` autocomplete.
///
/// # Thread Safety
///
/// Uses RwLock for concurrent read access during autocomplete.
pub struct PageNameIndex {
    /// Names of blocks that are direct children of `pages::`.
    /// Normalized (lowercase, heading prefix stripped).
    existing: HashSet<String>,

    /// Names referenced via `[[wikilink]]` across all blocks.
    /// Maps normalized name → set of block IDs that reference it.
    referenced: HashMap<String, HashSet<String>>,

    /// ID of the `pages::` container block (cached for efficiency).
    pages_container_id: Option<String>,
}

impl PageNameIndex {
    pub fn new() -> Self {
        Self {
            existing: HashSet::new(),
            referenced: HashMap::new(),
            pages_container_id: None,
        }
    }

    /// Search for pages matching a prefix.
    ///
    /// Returns suggestions sorted by:
    /// 1. Existing pages first
    /// 2. Stubs (referenced but not existing) second
    /// 3. Alphabetically within each group
    ///
    /// Case-insensitive prefix matching.
    pub fn search(&self, prefix: &str) -> Vec<PageSuggestion> {
        let normalized_prefix = prefix.to_lowercase();

        let mut existing_matches: Vec<_> = self
            .existing
            .iter()
            .filter(|name| name.starts_with(&normalized_prefix))
            .map(|name| PageSuggestion::existing(name.clone()))
            .collect();

        let mut stub_matches: Vec<_> = self
            .referenced
            .keys()
            .filter(|name| {
                name.starts_with(&normalized_prefix) && !self.existing.contains(*name)
            })
            .map(|name| PageSuggestion::stub(name.clone()))
            .collect();

        // Sort alphabetically within each group
        existing_matches.sort_by(|a, b| a.name.cmp(&b.name));
        stub_matches.sort_by(|a, b| a.name.cmp(&b.name));

        // Combine: existing first, then stubs
        existing_matches.extend(stub_matches);
        existing_matches
    }

    /// Check if a page exists (not a stub).
    pub fn page_exists(&self, name: &str) -> bool {
        self.existing.contains(&name.to_lowercase())
    }

    /// Get all existing page names.
    pub fn existing_pages(&self) -> Vec<String> {
        self.existing.iter().cloned().collect()
    }

    /// Get all stub (referenced but not existing) page names.
    pub fn stub_pages(&self) -> Vec<String> {
        self.referenced
            .keys()
            .filter(|name| !self.existing.contains(*name))
            .cloned()
            .collect()
    }

    /// Get the count of blocks referencing a page.
    pub fn reference_count(&self, name: &str) -> usize {
        self.referenced
            .get(&name.to_lowercase())
            .map_or(0, |refs| refs.len())
    }

    /// Get all block IDs that reference a given page name.
    pub fn referencing_blocks(&self, name: &str) -> Option<&HashSet<String>> {
        self.referenced.get(&name.to_lowercase())
    }

    /// Get all referenced page names (keys of the referenced map).
    pub fn all_referenced_names(&self) -> Vec<String> {
        self.referenced.keys().cloned().collect()
    }

    // ═══════════════════════════════════════════════════════════════
    // INDEX MUTATION METHODS (called by PageNameIndexHook)
    // ═══════════════════════════════════════════════════════════════

    /// Add an existing page to the index.
    ///
    /// `name` should be the page title with heading prefix stripped.
    pub fn add_existing_page(&mut self, name: &str) {
        let normalized = name.to_lowercase();
        if self.existing.insert(normalized.clone()) {
            trace!("Added existing page: {}", name);
        }
    }

    /// Remove an existing page from the index.
    pub fn remove_existing_page(&mut self, name: &str) {
        let normalized = name.to_lowercase();
        if self.existing.remove(&normalized) {
            trace!("Removed existing page: {}", name);
        }
    }

    /// Add references from a block to page names.
    ///
    /// Called when metadata.outlinks is populated/updated.
    pub fn add_references(&mut self, block_id: &str, page_names: &[String]) {
        for name in page_names {
            let normalized = name.to_lowercase();
            self.referenced
                .entry(normalized)
                .or_default()
                .insert(block_id.to_string());
        }
    }

    /// Remove all references from a block.
    ///
    /// Called when block is deleted or content changes (before adding new refs).
    pub fn remove_references(&mut self, block_id: &str) {
        for refs in self.referenced.values_mut() {
            refs.remove(block_id);
        }
        // Clean up empty reference sets
        self.referenced.retain(|_, refs| !refs.is_empty());
    }

    /// Update the cached pages:: container ID.
    pub fn set_pages_container_id(&mut self, id: Option<String>) {
        self.pages_container_id = id;
    }

    /// Get the cached pages:: container ID.
    pub fn pages_container_id(&self) -> Option<&str> {
        self.pages_container_id.as_deref()
    }

    /// Clear the entire index.
    pub fn clear(&mut self) {
        self.existing.clear();
        self.referenced.clear();
        self.pages_container_id = None;
    }
}

impl Default for PageNameIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Hook that maintains the PageNameIndex.
///
/// Subscribes to block changes and updates the autocomplete index:
/// - Tracks blocks under `pages::` container → existing pages
/// - Tracks `metadata.outlinks` → referenced pages
/// - Supports stub detection (referenced but not existing)
pub struct PageNameIndexHook {
    index: Arc<RwLock<PageNameIndex>>,
}

impl PageNameIndexHook {
    /// Create a new PageNameIndexHook with an empty index.
    pub fn new() -> Self {
        Self {
            index: Arc::new(RwLock::new(PageNameIndex::new())),
        }
    }

    /// Create with a shared index (for testing or external access).
    pub fn with_index(index: Arc<RwLock<PageNameIndex>>) -> Self {
        Self { index }
    }

    /// Get a reference to the shared index.
    pub fn index(&self) -> Arc<RwLock<PageNameIndex>> {
        Arc::clone(&self.index)
    }

    /// Strip heading prefix (# ## ### etc) from content.
    fn strip_heading_prefix(content: &str) -> &str {
        let trimmed = content.trim_start_matches('#');
        trimmed.trim_start()
    }

    /// Check if content starts with `pages::` (case-insensitive).
    fn is_pages_container(content: &str) -> bool {
        content.to_lowercase().starts_with(PAGES_PREFIX)
    }

    /// Process a block change: update index based on change type.
    fn process_change(&self, change: &BlockChange, store: &YDocStore) {
        match change {
            BlockChange::Created { id, content, parent_id, .. } => {
                self.handle_block_created(id, content, parent_id.as_deref(), store);
            }
            BlockChange::ContentChanged { id, old_content, new_content, .. } => {
                self.handle_content_changed(id, old_content, new_content, store);
            }
            BlockChange::Deleted { id, content, .. } => {
                self.handle_block_deleted(id, content);
            }
            BlockChange::Moved { id, old_parent_id, new_parent_id, .. } => {
                self.handle_block_moved(id, old_parent_id.as_deref(), new_parent_id.as_deref(), store);
            }
            // Metadata and collapsed changes don't affect page name index
            BlockChange::MetadataChanged { .. } | BlockChange::CollapsedChanged { .. } => {}
        }
    }

    fn handle_block_created(&self, id: &str, content: &str, parent_id: Option<&str>, store: &YDocStore) {
        let mut index = self.index.write().expect("lock poisoned");

        // Check if this is the pages:: container
        if Self::is_pages_container(content) {
            index.set_pages_container_id(Some(id.to_string()));
            debug!("Found pages:: container: {}", id);
            return;
        }

        // Check if parent is pages:: container
        if let Some(container_id) = index.pages_container_id() {
            if parent_id == Some(container_id) {
                let page_name = Self::strip_heading_prefix(content);
                if !page_name.is_empty() {
                    index.add_existing_page(page_name);
                }
            }
        }

        // Check metadata for outlinks
        if let Some(block) = store.get_block(id) {
            if let Some(metadata) = block.metadata.as_ref() {
                if !metadata.outlinks.is_empty() {
                    index.add_references(id, &metadata.outlinks);
                }
            }
        }
    }

    fn handle_content_changed(&self, id: &str, old_content: &str, new_content: &str, store: &YDocStore) {
        let mut index = self.index.write().expect("lock poisoned");

        // Check if this became or stopped being pages:: container
        let was_container = Self::is_pages_container(old_content);
        let is_container = Self::is_pages_container(new_content);

        if was_container && !is_container {
            // No longer a container
            if index.pages_container_id() == Some(id) {
                index.set_pages_container_id(None);
            }
        } else if !was_container && is_container {
            // Became a container
            index.set_pages_container_id(Some(id.to_string()));
        }

        // If this block is a page (child of pages::), update its name
        if let Some(container_id) = index.pages_container_id() {
            if let Some(block) = store.get_block(id) {
                if block.parent_id.as_deref() == Some(container_id) {
                    // Remove old page name
                    let old_name = Self::strip_heading_prefix(old_content);
                    if !old_name.is_empty() {
                        index.remove_existing_page(old_name);
                    }
                    // Add new page name
                    let new_name = Self::strip_heading_prefix(new_content);
                    if !new_name.is_empty() {
                        index.add_existing_page(new_name);
                    }
                }
            }
        }

        // Update references from this block's metadata
        index.remove_references(id);
        if let Some(block) = store.get_block(id) {
            if let Some(metadata) = block.metadata.as_ref() {
                if !metadata.outlinks.is_empty() {
                    index.add_references(id, &metadata.outlinks);
                }
            }
        }
    }

    fn handle_block_deleted(&self, id: &str, content: &str) {
        let mut index = self.index.write().expect("lock poisoned");

        // If this was the pages:: container, clear it
        if Self::is_pages_container(content) {
            if index.pages_container_id() == Some(id) {
                index.set_pages_container_id(None);
            }
        }

        // Remove from existing pages if it was one
        let page_name = Self::strip_heading_prefix(content);
        if !page_name.is_empty() {
            index.remove_existing_page(page_name);
        }

        // Remove all references from this block
        index.remove_references(id);
    }

    fn handle_block_moved(&self, id: &str, old_parent_id: Option<&str>, new_parent_id: Option<&str>, store: &YDocStore) {
        let mut index = self.index.write().expect("lock poisoned");

        let container_id = index.pages_container_id().map(String::from);

        // Get block content
        let content = store
            .get_block(id)
            .map(|b| b.content.clone())
            .unwrap_or_default();

        let page_name = Self::strip_heading_prefix(&content);
        if page_name.is_empty() {
            return;
        }

        // Check if moved out of pages::
        if let Some(ref cid) = container_id {
            if old_parent_id == Some(cid.as_str()) && new_parent_id != Some(cid.as_str()) {
                index.remove_existing_page(page_name);
            }
        }

        // Check if moved into pages::
        if let Some(ref cid) = container_id {
            if new_parent_id == Some(cid.as_str()) && old_parent_id != Some(cid.as_str()) {
                index.add_existing_page(page_name);
            }
        }
    }
}

impl Default for PageNameIndexHook {
    fn default() -> Self {
        Self::new()
    }
}

impl BlockHook for PageNameIndexHook {
    fn name(&self) -> &'static str {
        "page_name_index"
    }

    fn priority(&self) -> i32 {
        20 // After MetadataExtractionHook (10), before TantivyIndexHook (50)
    }

    fn is_sync(&self) -> bool {
        true // Fast index updates, needed for autocomplete responsiveness
    }

    fn accepts_origins(&self) -> Option<Vec<Origin>> {
        // Same as MetadataExtractionHook - exclude Hook only
        Some(vec![Origin::User, Origin::Agent, Origin::BulkImport, Origin::Remote])
    }

    #[instrument(skip(self, batch, store), fields(batch_size = batch.changes.len()))]
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) {
        for change in &batch.changes {
            self.process_change(change, &store);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ═══════════════════════════════════════════════════════════════
    // PageNameIndex UNIT TESTS
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn test_new_index_is_empty() {
        let index = PageNameIndex::new();
        assert!(index.existing_pages().is_empty());
        assert!(index.stub_pages().is_empty());
    }

    #[test]
    fn test_add_existing_page() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("My Page");

        assert!(index.page_exists("My Page"));
        assert!(index.page_exists("my page")); // Case-insensitive
        assert!(!index.page_exists("Other"));
    }

    #[test]
    fn test_remove_existing_page() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("My Page");
        index.remove_existing_page("my page"); // Case-insensitive

        assert!(!index.page_exists("My Page"));
    }

    #[test]
    fn test_add_references() {
        let mut index = PageNameIndex::new();
        index.add_references("block1", &["Page A".to_string(), "Page B".to_string()]);
        index.add_references("block2", &["Page A".to_string()]);

        assert_eq!(index.reference_count("Page A"), 2);
        assert_eq!(index.reference_count("page a"), 2); // Case-insensitive
        assert_eq!(index.reference_count("Page B"), 1);
        assert_eq!(index.reference_count("Page C"), 0);
    }

    #[test]
    fn test_remove_references() {
        let mut index = PageNameIndex::new();
        index.add_references("block1", &["Page A".to_string()]);
        index.add_references("block2", &["Page A".to_string()]);

        index.remove_references("block1");

        assert_eq!(index.reference_count("Page A"), 1);

        index.remove_references("block2");
        assert_eq!(index.reference_count("Page A"), 0);
    }

    #[test]
    fn test_search_existing_first() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("Alpha");
        index.add_existing_page("Bravo");
        index.add_references("b1", &["Able".to_string()]); // Stub

        let results = index.search("a");

        assert_eq!(results.len(), 2);
        assert_eq!(results[0], PageSuggestion::existing("alpha"));
        assert_eq!(results[1], PageSuggestion::stub("able"));
    }

    #[test]
    fn test_search_case_insensitive() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("MyPage");

        assert_eq!(index.search("my").len(), 1);
        assert_eq!(index.search("MY").len(), 1);
        assert_eq!(index.search("mY").len(), 1);
    }

    #[test]
    fn test_search_prefix_match() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("JavaScript");
        index.add_existing_page("Java");
        index.add_existing_page("Python");

        let results = index.search("jav");
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|s| s.name == "java"));
        assert!(results.iter().any(|s| s.name == "javascript"));
    }

    #[test]
    fn test_stub_pages_excludes_existing() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("Real Page");
        index.add_references("b1", &["Real Page".to_string(), "Ghost Page".to_string()]);

        let stubs = index.stub_pages();
        assert_eq!(stubs.len(), 1);
        assert_eq!(stubs[0], "ghost page");
    }

    #[test]
    fn test_clear() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("Page");
        index.add_references("b1", &["Ref".to_string()]);
        index.set_pages_container_id(Some("container".to_string()));

        index.clear();

        assert!(index.existing_pages().is_empty());
        assert!(index.stub_pages().is_empty());
        assert!(index.pages_container_id().is_none());
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPER FUNCTION TESTS
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn test_strip_heading_prefix() {
        assert_eq!(PageNameIndexHook::strip_heading_prefix("# My Page"), "My Page");
        assert_eq!(PageNameIndexHook::strip_heading_prefix("## Nested"), "Nested");
        assert_eq!(PageNameIndexHook::strip_heading_prefix("### Deep"), "Deep");
        assert_eq!(PageNameIndexHook::strip_heading_prefix("No prefix"), "No prefix");
        assert_eq!(PageNameIndexHook::strip_heading_prefix("#Tag"), "Tag"); // No space
    }

    #[test]
    fn test_is_pages_container() {
        assert!(PageNameIndexHook::is_pages_container("pages::"));
        assert!(PageNameIndexHook::is_pages_container("pages:: with content"));
        assert!(PageNameIndexHook::is_pages_container("PAGES::")); // Case-insensitive
        assert!(!PageNameIndexHook::is_pages_container("page::"));
        assert!(!PageNameIndexHook::is_pages_container("# pages::"));
    }

    // ═══════════════════════════════════════════════════════════════
    // HOOK TRAIT TESTS
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn test_hook_name() {
        let hook = PageNameIndexHook::new();
        assert_eq!(hook.name(), "page_name_index");
    }

    #[test]
    fn test_hook_priority() {
        let hook = PageNameIndexHook::new();
        assert_eq!(hook.priority(), 20);
    }

    #[test]
    fn test_hook_is_sync() {
        let hook = PageNameIndexHook::new();
        assert!(hook.is_sync());
    }

    #[test]
    fn test_accepts_user_origin() {
        use crate::hooks::should_process;
        let hook = PageNameIndexHook::new();
        assert!(should_process(&hook, Origin::User));
    }

    #[test]
    fn test_rejects_hook_origin() {
        use crate::hooks::should_process;
        let hook = PageNameIndexHook::new();
        assert!(!should_process(&hook, Origin::Hook));
    }

    #[test]
    fn test_accepts_remote_origin() {
        use crate::hooks::should_process;
        let hook = PageNameIndexHook::new();
        assert!(should_process(&hook, Origin::Remote));
    }
}
