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

use crate::{events::BlockChange, hooks::BlockHook, BlockChangeBatch, Origin, YDocStore};
use nucleo_matcher::{
    pattern::{AtomKind, CaseMatching, Normalization, Pattern},
    Config, Matcher, Utf32Str,
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
    /// Block ID of the page block (None for stubs — they don't exist yet)
    pub block_id: Option<String>,
}

impl PageSuggestion {
    pub fn existing(name: impl Into<String>, block_id: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            is_stub: false,
            block_id: Some(block_id.into()),
        }
    }

    pub fn stub(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            is_stub: true,
            block_id: None,
        }
    }
}

/// Value side of the `existing` map — the block that owns a page name, plus
/// its creation time for deterministic collision resolution (oldest wins).
#[derive(Debug, Clone)]
struct ExistingPageEntry {
    block_id: String,
    /// Block createdAt (ms). `i64::MAX` when unknown, so an unknown claimant
    /// never steals a name from a block with a known age.
    created_at: i64,
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
    /// Existing pages: normalized name → owning block entry.
    /// Blocks that are direct children of `pages::` container.
    /// On name collision the OLDEST block (by createdAt) owns the name —
    /// duplicates never silently steal it (quirk-audit 2026-07-09, cluster F).
    existing: HashMap<String, ExistingPageEntry>,

    /// Reverse of `existing`: block ID → normalized page name. O(1) lookup
    /// for "what page does this block represent?" — used by hot paths
    /// (Tantivy indexing per block, search-hit shaping per hit) to avoid
    /// O(N_pages) `existing_pages().iter().find(...)` linear scans.
    /// Maintained in lockstep with `existing` via the mutator methods.
    block_id_to_page_name: HashMap<String, String>,

    /// Names referenced via `[[wikilink]]` across all blocks.
    /// Maps normalized name → set of block IDs that reference it.
    referenced: HashMap<String, HashSet<String>>,

    /// ID of the `pages::` container block (cached for efficiency).
    pages_container_id: Option<String>,

    /// Reusable nucleo Matcher — holds scratch buffers, expensive to reallocate per call.
    /// Wrapped in Mutex for interior mutability through &self.
    matcher: std::sync::Mutex<Matcher>,
}

impl PageNameIndex {
    pub fn new() -> Self {
        Self {
            existing: HashMap::new(),
            block_id_to_page_name: HashMap::new(),
            referenced: HashMap::new(),
            pages_container_id: None,
            matcher: std::sync::Mutex::new(Matcher::new(Config::DEFAULT)),
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
            .filter(|(name, _entry)| name.starts_with(&normalized_prefix))
            .map(|(name, entry)| PageSuggestion::existing(name.clone(), entry.block_id.clone()))
            .collect();

        let mut stub_matches: Vec<_> = self
            .referenced
            .keys()
            .filter(|name| {
                name.starts_with(&normalized_prefix) && !self.existing.contains_key(*name)
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

    /// Fuzzy search for pages matching a query (typo-tolerant).
    ///
    /// Uses nucleo-matcher (subsequence scoring, same algorithm as Helix/fzf).
    /// Returns all pages that score above zero, sorted by score descending.
    /// Existing pages beat stubs at equal scores.
    ///
    /// Empty query returns all pages in the same order as `search("")`.
    pub fn fuzzy_search(&self, query: &str) -> Vec<PageSuggestion> {
        if query.is_empty() {
            return self.search("");
        }

        let pattern = Pattern::new(
            query,
            CaseMatching::Ignore,
            Normalization::Smart,
            AtomKind::Fuzzy,
        );
        let mut matcher = self.matcher.lock().unwrap_or_else(|e| e.into_inner());

        // Score existing pages
        let mut scored: Vec<(u32, bool, String)> = self
            .existing
            .keys()
            .filter_map(|name| {
                let mut buf = Vec::new();
                let haystack = Utf32Str::new(name.as_str(), &mut buf);
                pattern
                    .score(haystack, &mut matcher)
                    .map(|s| (s, true, name.clone()))
            })
            .collect();

        // Score stubs (referenced but not existing)
        let stub_scores: Vec<(u32, bool, String)> = self
            .referenced
            .keys()
            .filter(|name| !self.existing.contains_key(*name))
            .filter_map(|name| {
                let mut buf = Vec::new();
                let haystack = Utf32Str::new(name.as_str(), &mut buf);
                pattern
                    .score(haystack, &mut matcher)
                    .map(|s| (s, false, name.clone()))
            })
            .collect();

        scored.extend(stub_scores);

        // Sort: highest score first; existing before stubs at equal scores; name as final tie-breaker
        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.cmp(&a.1))
                .then_with(|| a.2.cmp(&b.2))
        });

        scored
            .into_iter()
            .map(|(_, is_existing, name)| {
                if is_existing {
                    let block_id = self
                        .existing
                        .get(&name)
                        .map(|e| e.block_id.clone())
                        .unwrap_or_default();
                    PageSuggestion::existing(name, block_id)
                } else {
                    PageSuggestion::stub(name)
                }
            })
            .collect()
    }

    /// Check if a page exists (not a stub).
    pub fn page_exists(&self, name: &str) -> bool {
        self.existing.contains_key(&name.to_lowercase())
    }

    /// Get the block ID for an existing page by name.
    pub fn page_block_id(&self, name: &str) -> Option<&str> {
        self.existing
            .get(&name.to_lowercase())
            .map(|e| e.block_id.as_str())
    }

    /// Reverse lookup: given a block ID, return the page name it represents
    /// (lowercased), or `None` when the block is not registered as a page.
    ///
    /// O(1) — backed by the `block_id_to_page_name` reverse index. Replaces
    /// the O(N_pages) `existing_pages().iter().find(...)` scans on the
    /// Tantivy indexing and search-hit shaping hot paths.
    pub fn page_name_for_block(&self, block_id: &str) -> Option<&str> {
        self.block_id_to_page_name.get(block_id).map(|s| s.as_str())
    }

    /// Get all existing page names.
    pub fn existing_pages(&self) -> Vec<String> {
        self.existing.keys().cloned().collect()
    }

    /// Get all stub (referenced but not existing) page names.
    pub fn stub_pages(&self) -> Vec<String> {
        self.referenced
            .keys()
            .filter(|name| !self.existing.contains_key(*name))
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
    /// `block_id` is the Y.Doc block ID of the page block.
    /// `created_at` is the block's creation time (ms); pass `i64::MAX` when
    /// unknown.
    ///
    /// Collision contract (quirk-audit 2026-07-09, cluster F): when two
    /// DIFFERENT blocks claim the same name, the OLDEST block (by createdAt)
    /// owns it — deterministic across restarts, unlike the previous
    /// last-writer-wins insert whose winner flipped with HashMap iteration
    /// order on rebuild. The loser is logged (duplicate-page observability)
    /// and gets no index entry.
    ///
    /// Maintains the `block_id_to_page_name` reverse index in lockstep.
    pub fn add_existing_page(&mut self, name: &str, block_id: &str, created_at: i64) {
        let normalized = name.to_lowercase();

        if let Some(current) = self.existing.get(&normalized) {
            if current.block_id == block_id {
                // Same block re-registering (content refresh) — keep the
                // freshest created_at knowledge (min: a real timestamp beats
                // the i64::MAX unknown sentinel).
                let refreshed = current.created_at.min(created_at);
                self.existing.insert(
                    normalized.clone(),
                    ExistingPageEntry {
                        block_id: block_id.to_string(),
                        created_at: refreshed,
                    },
                );
                return;
            }

            // Different block claims an owned name: oldest createdAt wins.
            if created_at < current.created_at {
                log::warn!(
                    "Duplicate page name '{}': block {} (created {}) displaces newer holder {} (created {})",
                    name,
                    block_id,
                    created_at,
                    current.block_id,
                    current.created_at
                );
                self.block_id_to_page_name.remove(&current.block_id);
            } else {
                log::warn!(
                    "Duplicate page name '{}': keeping older holder {} (created {}), ignoring {} (created {})",
                    name,
                    current.block_id,
                    current.created_at,
                    block_id,
                    created_at
                );
                return;
            }
        } else {
            trace!("Added existing page: {} ({})", name, block_id);
        }

        self.existing.insert(
            normalized.clone(),
            ExistingPageEntry {
                block_id: block_id.to_string(),
                created_at,
            },
        );
        self.block_id_to_page_name
            .insert(block_id.to_string(), normalized);
    }

    /// Remove a block's page registration, id-guarded.
    ///
    /// Only removes the name entry this specific block owns (via the reverse
    /// index). The previous name-keyed removal deleted whatever block was
    /// registered under the name — so deleting ANY block whose first line
    /// matched a page name evicted the real page, and deleting one duplicate
    /// evicted the survivor (quirk-audit 2026-07-09, cluster F:
    /// "deleting one twin makes three").
    pub fn remove_existing_page_by_id(&mut self, block_id: &str) {
        if let Some(name) = self.block_id_to_page_name.remove(block_id) {
            // Only clear the forward entry if this block actually owns it.
            let owns = self
                .existing
                .get(&name)
                .is_some_and(|e| e.block_id == block_id);
            if owns {
                self.existing.remove(&name);
                trace!("Removed existing page: {} ({})", name, block_id);
            }
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
        self.block_id_to_page_name.clear();
        self.referenced.clear();
        self.pages_container_id = None;
    }
}

impl Default for PageNameIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract the page title from block content.
///
/// Mirrors the frontend's `getPageTitle()` in useBacklinkNavigation.ts:
/// - Take the first line only (multi-line pages embed markers on subsequent lines)
/// - Strip heading prefix (# ## ### etc)
/// - Trim whitespace
///
/// A "heading prefix" is one-or-more `#` followed by at least one
/// whitespace (per CommonMark). Bare `#name` (no whitespace after) is
/// NOT a heading — it's a page whose name starts with `#`, e.g.
/// `[[#2817]]` (FLO-573). Must stay in sync with the frontend
/// `getPageTitle` in `useBacklinkNavigation.ts`.
///
/// Examples:
///   "# My Page"                    → "My Page"
///   "# Summary\n[board:: recon]"   → "Summary"
///   "# #2817"                      → "#2817"
///   "#2817"                        → "#2817"  (no whitespace, not a heading)
///   "No prefix"                    → "No prefix"
///
/// Public: the server's `find_or_create_page` Y.Doc fallback scan must
/// compare names EXACTLY the way the index extracts them.
pub fn page_title_from_content(content: &str) -> &str {
    let first_line = content.lines().next().unwrap_or(content);
    let hash_count = first_line.bytes().take_while(|&b| b == b'#').count();
    if hash_count == 0 {
        return first_line.trim();
    }
    let after_hashes = &first_line[hash_count..];
    match after_hashes.chars().next() {
        Some(c) if c.is_whitespace() => after_hashes.trim(),
        _ => first_line.trim(),
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

    /// Strip heading prefix — see the free function [`page_title_from_content`].
    fn strip_heading_prefix(content: &str) -> &str {
        page_title_from_content(content)
    }

    /// Check if content starts with `pages::` (case-insensitive).
    fn is_pages_container(content: &str) -> bool {
        content.to_lowercase().starts_with(PAGES_PREFIX)
    }

    /// Process a block change: update index based on change type.
    fn process_change(&self, change: &BlockChange, store: &YDocStore) {
        match change {
            BlockChange::Created {
                id,
                content,
                parent_id,
                ..
            } => {
                self.handle_block_created(id, content, parent_id.as_deref(), store);
            }
            BlockChange::ContentChanged {
                id,
                old_content,
                new_content,
                ..
            } => {
                self.handle_content_changed(id, old_content, new_content, store);
            }
            BlockChange::Deleted { id, content, .. } => {
                self.handle_block_deleted(id, content);
            }
            BlockChange::Moved {
                id,
                old_parent_id,
                new_parent_id,
                ..
            } => {
                self.handle_block_moved(
                    id,
                    old_parent_id.as_deref(),
                    new_parent_id.as_deref(),
                    store,
                );
            }
            // Metadata and collapsed changes don't affect page name index
            BlockChange::MetadataChanged { .. } | BlockChange::CollapsedChanged { .. } => {}
        }
    }

    fn handle_block_created(
        &self,
        id: &str,
        content: &str,
        parent_id: Option<&str>,
        store: &YDocStore,
    ) {
        let mut index = self.index.write().expect("lock poisoned");

        // Check if this is the pages:: container (must be a root block — no parent)
        if Self::is_pages_container(content) && parent_id.is_none() {
            index.set_pages_container_id(Some(id.to_string()));
            debug!("Found pages:: container: {}", id);
            return;
        }

        // Check if parent is pages:: container
        if let Some(container_id) = index.pages_container_id() {
            if parent_id == Some(container_id) {
                let page_name = Self::strip_heading_prefix(content);
                if !page_name.is_empty() {
                    let created_at = store
                        .get_block(id)
                        .map(|b| b.created_at)
                        .unwrap_or(i64::MAX);
                    index.add_existing_page(page_name, id, created_at);
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

    fn handle_content_changed(
        &self,
        id: &str,
        old_content: &str,
        new_content: &str,
        store: &YDocStore,
    ) {
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
            // Became a container — only if root block (no parent)
            if let Some(block) = store.get_block(id) {
                if block.parent_id.is_none() {
                    index.set_pages_container_id(Some(id.to_string()));
                }
            }
        }

        // If this block is a page (child of pages::), update its name
        if let Some(container_id) = index.pages_container_id() {
            if let Some(block) = store.get_block(id) {
                if block.parent_id.as_deref() == Some(container_id) {
                    // Remove whatever name THIS block owned (id-guarded — a
                    // name-keyed remove could evict a different block that
                    // legitimately owns old_name)
                    let _ = old_content; // old name derivable, but ownership is by id
                    index.remove_existing_page_by_id(id);
                    // Add new page name
                    let new_name = Self::strip_heading_prefix(new_content);
                    if !new_name.is_empty() {
                        index.add_existing_page(new_name, id, block.created_at);
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
        if Self::is_pages_container(content) && index.pages_container_id() == Some(id) {
            index.set_pages_container_id(None);
        }

        // Remove this block's page registration, id-guarded. The previous
        // name-keyed removal evicted the index entry of ANY block whose first
        // line matched a page name — deleting a `# 2026-06-30` note anywhere
        // in the outline de-indexed the real 2026-06-30 page.
        index.remove_existing_page_by_id(id);

        // Remove all references from this block
        index.remove_references(id);
    }

    /// Rebuild the index from scratch by reading all blocks from the store.
    ///
    /// Used during cold-start rehydration where Y.Doc block iteration order is
    /// non-deterministic (HashMap). A single-pass sequential approach fails when
    /// `pages::` container is processed after its children — container_id is None
    /// so children never get added to `existing`. Two-pass rebuild avoids this.
    fn rebuild_from_store(&self, store: &YDocStore) {
        let mut index = self.index.write().expect("lock poisoned");
        index.clear();

        let all_ids = store.get_all_block_ids();

        // Pass 1: find pages:: container (root block with pages:: content)
        let mut container_id: Option<String> = None;
        for id in &all_ids {
            if let Some(block) = store.get_block(id) {
                if !block.content.is_empty()
                    && Self::is_pages_container(&block.content)
                    && block.parent_id.is_none()
                {
                    container_id = Some(id.clone());
                    index.set_pages_container_id(Some(id.clone()));
                    debug!("Cold-start rebuild: found pages:: container: {}", id);
                    break;
                }
            }
        }

        // Pass 2: index page names (children of container) + outlink references
        for id in &all_ids {
            if let Some(block) = store.get_block(id) {
                // Register child of pages:: container as existing page (only for non-empty content)
                if !block.content.is_empty() {
                    if let Some(ref cid) = container_id {
                        if block.parent_id.as_deref() == Some(cid.as_str()) {
                            let page_name = Self::strip_heading_prefix(&block.content);
                            if !page_name.is_empty() {
                                // Oldest-createdAt wins here too: rebuild order is
                                // HashMap iteration (non-deterministic), and this
                                // tie-break is what keeps the winner stable
                                // across restarts when duplicates exist.
                                index.add_existing_page(page_name, id, block.created_at);
                            }
                        }
                    }
                }

                // Register outlink references from metadata (always, even for empty-content blocks)
                if let Some(metadata) = block.metadata.as_ref() {
                    if !metadata.outlinks.is_empty() {
                        index.add_references(id, &metadata.outlinks);
                    }
                }
            }
        }

        debug!(
            "Cold-start rebuild complete: {} existing pages, {} referenced names",
            index.existing_pages().len(),
            index.all_referenced_names().len()
        );
    }

    fn handle_block_moved(
        &self,
        id: &str,
        old_parent_id: Option<&str>,
        new_parent_id: Option<&str>,
        store: &YDocStore,
    ) {
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

        // Check if moved out of pages:: (id-guarded — only this block's entry)
        if let Some(ref cid) = container_id {
            if old_parent_id == Some(cid.as_str()) && new_parent_id != Some(cid.as_str()) {
                index.remove_existing_page_by_id(id);
            }
        }

        // Check if moved into pages::
        if let Some(ref cid) = container_id {
            if new_parent_id == Some(cid.as_str()) && old_parent_id != Some(cid.as_str()) {
                let created_at = store
                    .get_block(id)
                    .map(|b| b.created_at)
                    .unwrap_or(i64::MAX);
                index.add_existing_page(page_name, id, created_at);
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
        Some(vec![
            Origin::User,
            Origin::Agent,
            Origin::BulkImport,
            Origin::Remote,
        ])
    }

    #[instrument(skip(self, batch, store), fields(batch_size = batch.changes.len()))]
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) {
        // Cold start: rehydration batch has non-deterministic order (Y.Doc HashMap).
        // pages:: container may appear after its children → container_id is None
        // when children are processed → they're never added to existing.
        // Two-pass rebuild avoids the ordering dependency.
        if batch.transaction_id.as_deref() == Some(crate::events::COLD_START_REHYDRATION_TX_ID) {
            self.rebuild_from_store(&store);
            return;
        }

        for change in &batch.changes {
            self.process_change(change, &store);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::YDocStore;
    use tempfile::tempdir;
    use yrs::{ArrayPrelim, Map, Transact, WriteTxn};

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
        index.add_existing_page("My Page", "page-1", 100);

        assert!(index.page_exists("My Page"));
        assert!(index.page_exists("my page")); // Case-insensitive
        assert!(!index.page_exists("Other"));
    }

    #[test]
    fn test_remove_existing_page() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("My Page", "page-1", 100);
        index.remove_existing_page_by_id("page-1");

        assert!(!index.page_exists("My Page"));
    }

    #[test]
    fn test_page_name_for_block_reverse_lookup() {
        // Reverse index parity: page_name_for_block returns the lowercased
        // name registered for a given block_id, and stays in sync through
        // add → remove → re-add cycles.
        let mut index = PageNameIndex::new();
        index.add_existing_page("My Page", "page-1", 100);
        index.add_existing_page("Other Page", "page-2", 100);

        assert_eq!(index.page_name_for_block("page-1"), Some("my page"));
        assert_eq!(index.page_name_for_block("page-2"), Some("other page"));
        assert_eq!(index.page_name_for_block("page-missing"), None);

        // Remove drops the reverse entry.
        index.remove_existing_page_by_id("page-1");
        assert_eq!(index.page_name_for_block("page-1"), None);
        // Other entry survives.
        assert_eq!(index.page_name_for_block("page-2"), Some("other page"));

        // Re-add under same block_id with new name.
        index.add_existing_page("Brand New", "page-1", 100);
        assert_eq!(index.page_name_for_block("page-1"), Some("brand new"));
    }

    #[test]
    fn test_name_collision_oldest_created_at_wins() {
        // Two DIFFERENT blocks claim the same name: the older block (by
        // createdAt) owns it, regardless of registration order. This is what
        // keeps the winner stable across restarts (rebuild iterates a HashMap
        // in arbitrary order) — quirk-audit 2026-07-09 cluster F.
        let mut index = PageNameIndex::new();

        // Newer registered first; older claimant displaces it.
        index.add_existing_page("Same Name", "block-newer", 200);
        index.add_existing_page("Same Name", "block-older", 100);
        assert_eq!(index.page_block_id("Same Name"), Some("block-older"));
        assert_eq!(index.page_name_for_block("block-older"), Some("same name"));
        assert_eq!(
            index.page_name_for_block("block-newer"),
            None,
            "displaced holder must lose its reverse entry"
        );

        // Older registered first; newer claimant is ignored (with a warn).
        let mut index2 = PageNameIndex::new();
        index2.add_existing_page("Same Name", "block-older", 100);
        index2.add_existing_page("Same Name", "block-newer", 200);
        assert_eq!(index2.page_block_id("Same Name"), Some("block-older"));
        assert_eq!(
            index2.page_name_for_block("block-newer"),
            None,
            "losing claimant must not gain a reverse entry"
        );
    }

    #[test]
    fn test_unknown_created_at_never_steals() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("Page", "block-known", 100);
        index.add_existing_page("Page", "block-unknown", i64::MAX);
        assert_eq!(index.page_block_id("Page"), Some("block-known"));
    }

    #[test]
    fn test_deleting_a_non_owner_does_not_evict_the_page() {
        // Regression for "deleting one twin makes three": the loser of a name
        // collision gets deleted — the survivor's index entry must stay.
        let mut index = PageNameIndex::new();
        index.add_existing_page("2026-06-30", "block-original", 100);
        index.add_existing_page("2026-06-30", "block-duplicate", 200); // loses

        // Deleting the duplicate (which does NOT own the name) is a no-op
        // for the forward entry.
        index.remove_existing_page_by_id("block-duplicate");
        assert_eq!(index.page_block_id("2026-06-30"), Some("block-original"));

        // Deleting an unrelated block whose first line merely MATCHES a page
        // name must not evict the page either (id-guard, not name-guard).
        index.remove_existing_page_by_id("some-random-note-block");
        assert_eq!(index.page_block_id("2026-06-30"), Some("block-original"));

        // Deleting the actual owner removes the entry.
        index.remove_existing_page_by_id("block-original");
        assert_eq!(index.page_block_id("2026-06-30"), None);
    }

    #[test]
    fn test_same_block_reregistration_refreshes_created_at() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("Page", "block-1", i64::MAX); // unknown at first
        index.add_existing_page("Page", "block-1", 100); // now known
                                                         // A newer different block still loses against the refreshed age.
        index.add_existing_page("Page", "block-2", 150);
        assert_eq!(index.page_block_id("Page"), Some("block-1"));
    }

    #[test]
    fn test_clear_resets_reverse_index() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("Page A", "block-a", 100);
        index.clear();
        assert_eq!(index.page_name_for_block("block-a"), None);
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
        index.add_existing_page("Alpha", "alpha-id", 100);
        index.add_existing_page("Bravo", "bravo-id", 100);
        index.add_references("b1", &["Able".to_string()]); // Stub

        let results = index.search("a");

        assert_eq!(results.len(), 2);
        assert_eq!(results[0], PageSuggestion::existing("alpha", "alpha-id"));
        assert_eq!(results[1], PageSuggestion::stub("able"));
    }

    #[test]
    fn test_search_case_insensitive() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("MyPage", "mypage-id", 100);

        assert_eq!(index.search("my").len(), 1);
        assert_eq!(index.search("MY").len(), 1);
        assert_eq!(index.search("mY").len(), 1);
    }

    #[test]
    fn test_search_prefix_match() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("JavaScript", "js-id", 100);
        index.add_existing_page("Java", "java-id", 100);
        index.add_existing_page("Python", "python-id", 100);

        let results = index.search("jav");
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|s| s.name == "java"));
        assert!(results.iter().any(|s| s.name == "javascript"));
    }

    #[test]
    fn test_stub_pages_excludes_existing() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("Real Page", "real-page-id", 100);
        index.add_references("b1", &["Real Page".to_string(), "Ghost Page".to_string()]);

        let stubs = index.stub_pages();
        assert_eq!(stubs.len(), 1);
        assert_eq!(stubs[0], "ghost page");
    }

    #[test]
    fn test_clear() {
        let mut index = PageNameIndex::new();
        index.add_existing_page("Page", "page-id", 100);
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
        assert_eq!(
            PageNameIndexHook::strip_heading_prefix("# My Page"),
            "My Page"
        );
        assert_eq!(
            PageNameIndexHook::strip_heading_prefix("## Nested"),
            "Nested"
        );
        assert_eq!(PageNameIndexHook::strip_heading_prefix("### Deep"), "Deep");
        assert_eq!(
            PageNameIndexHook::strip_heading_prefix("No prefix"),
            "No prefix"
        );

        // FLO-573: bare "#name" (no whitespace) is a page name, not a heading.
        // Without this, [[#2817]] normalizes to "2817" on lookup but stored
        // pages (content "# #2817") normalize to "#2817" — mismatch creates a
        // fresh page on every click.
        assert_eq!(PageNameIndexHook::strip_heading_prefix("#Tag"), "#Tag");
        assert_eq!(PageNameIndexHook::strip_heading_prefix("#2817"), "#2817");
        assert_eq!(PageNameIndexHook::strip_heading_prefix("# #2817"), "#2817");
        assert_eq!(PageNameIndexHook::strip_heading_prefix("## #2817"), "#2817");
    }

    #[test]
    fn test_is_pages_container() {
        assert!(PageNameIndexHook::is_pages_container("pages::"));
        assert!(PageNameIndexHook::is_pages_container(
            "pages:: with content"
        ));
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

    // ═══════════════════════════════════════════════════════════════
    // COLD-START REBUILD TESTS
    // ═══════════════════════════════════════════════════════════════

    /// Insert a block directly into a YDocStore (mirrors inheritance_index test helper).
    fn insert_block(store: &YDocStore, id: &str, content: &str, parent_id: Option<&str>) {
        let doc = store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, id);
        block_map.insert(&mut txn, "content", yrs::Any::String(content.into()));
        if let Some(pid) = parent_id {
            block_map.insert(&mut txn, "parentId", yrs::Any::String(pid.into()));
        }
        let empty: Vec<yrs::Any> = vec![];
        block_map.insert(&mut txn, "childIds", ArrayPrelim::from(empty));
    }

    fn open_test_store() -> (Arc<YDocStore>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let store = Arc::new(YDocStore::open(&db_path, "test").unwrap());
        (store, dir)
    }

    #[test]
    fn test_cold_start_ordering_container_before_children() {
        // Standard order: container created before children
        let (store, _dir) = open_test_store();
        insert_block(&store, "container-1", "pages::", None);
        insert_block(&store, "page-a", "# Home", Some("container-1"));
        insert_block(&store, "page-b", "# Notes", Some("container-1"));

        let hook = PageNameIndexHook::new();
        let batch = BlockChangeBatch::with_transaction_id(
            crate::events::COLD_START_REHYDRATION_TX_ID.to_string(),
        );
        hook.process(&batch, store);

        let index = hook.index.read().unwrap();
        assert!(index.page_exists("home"), "page 'home' should exist");
        assert!(index.page_exists("notes"), "page 'notes' should exist");
        assert_eq!(index.page_block_id("home"), Some("page-a"));
        assert_eq!(index.page_block_id("notes"), Some("page-b"));
    }

    #[test]
    fn test_cold_start_ordering_children_before_container() {
        // Bug scenario: children inserted into store before the container.
        // Without rebuild_from_store, container_id would be None when children
        // are processed → both pages appear as stubs.
        let (store, _dir) = open_test_store();
        // Insert children first (simulates HashMap ordering where children come before container)
        insert_block(&store, "page-a", "# Home", Some("container-1"));
        insert_block(&store, "page-b", "# Notes", Some("container-1"));
        // Container inserted last — may still be iterated last by get_all_block_ids
        insert_block(&store, "container-1", "pages::", None);

        let hook = PageNameIndexHook::new();
        let batch = BlockChangeBatch::with_transaction_id(
            crate::events::COLD_START_REHYDRATION_TX_ID.to_string(),
        );
        hook.process(&batch, store);

        let index = hook.index.read().unwrap();
        assert!(
            index.page_exists("home"),
            "page 'home' should exist even when container inserted last"
        );
        assert!(
            index.page_exists("notes"),
            "page 'notes' should exist even when container inserted last"
        );
        assert_eq!(index.page_block_id("home"), Some("page-a"));
        assert_eq!(index.page_block_id("notes"), Some("page-b"));
    }

    #[test]
    fn test_cold_start_no_pages_container() {
        // Outlines without a pages:: container should still work (no crash, empty existing)
        let (store, _dir) = open_test_store();
        insert_block(&store, "block-1", "# Some Heading", None);
        insert_block(&store, "block-2", "Regular content [[Some Heading]]", None);

        let hook = PageNameIndexHook::new();
        let batch = BlockChangeBatch::with_transaction_id(
            crate::events::COLD_START_REHYDRATION_TX_ID.to_string(),
        );
        hook.process(&batch, store);

        let index = hook.index.read().unwrap();
        assert!(
            index.existing_pages().is_empty(),
            "no pages:: container → no existing pages"
        );
        assert!(index.pages_container_id().is_none());
    }

    #[test]
    fn test_cold_start_does_not_treat_non_root_pages_container_as_container() {
        // A pages:: block nested inside another block should NOT become the container
        let (store, _dir) = open_test_store();
        insert_block(&store, "parent-1", "Some parent", None);
        insert_block(&store, "nested-pages", "pages::", Some("parent-1")); // nested, has a parent
        insert_block(&store, "child-of-nested", "# Home", Some("nested-pages"));

        let hook = PageNameIndexHook::new();
        let batch = BlockChangeBatch::with_transaction_id(
            crate::events::COLD_START_REHYDRATION_TX_ID.to_string(),
        );
        hook.process(&batch, store);

        let index = hook.index.read().unwrap();
        assert!(
            index.pages_container_id().is_none(),
            "nested pages:: should not become container"
        );
        assert!(index.existing_pages().is_empty());
    }
}
