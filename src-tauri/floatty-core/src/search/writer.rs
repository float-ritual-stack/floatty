//! Tantivy writer actor for async index updates.
//!
//! # Architecture
//!
//! ```text
//! TantivyWriter (actor)
//!       ↑
//!       │ mpsc channel (bounded: 1000)
//!       │
//! WriterHandle → send(AddOrUpdate | Delete | Commit)
//! ```
//!
//! # Why Actor Pattern?
//!
//! - IndexWriter is not Send/Sync - must live in one thread
//! - Bounded channel provides backpressure during bulk indexing
//! - Prevents OOM if 10k blocks pasted at once
//!
//! # Update Pattern (Delete + Add)
//!
//! Tantivy doesn't have "update" - we delete by term then add new doc:
//! ```rust,ignore
//! writer.delete_term(Term::from_field_text(block_id_field, "id123"));
//! writer.add_document(doc)?;
//! ```

use super::{IndexManager, SchemaFields, SearchError};
use regex::Regex;
use std::sync::LazyLock;
use tantivy::{DateTime, IndexWriter, Term};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, trace, warn};

/// Regex for `prefix::value` patterns (word chars before ::, anything non-whitespace after).
static COLONCOLON_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([a-zA-Z_]\w*)::(\S+)").expect("valid regex")
});

/// Regex for bare `prefix::` (word:: with nothing after, or at end of string).
static BARE_PREFIX_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"([a-zA-Z_]\w*)::(?:\s|$)").expect("valid regex")
});

/// Regex for `[[wikilinks]]` — matches `[[anything]]` including nested brackets.
static WIKILINK_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[\[([^\]]+)\]\]").expect("valid regex")
});

/// Regex for `[inline::markers]` — single square brackets around prefix::value.
static INLINE_MARKER_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[([a-zA-Z_]\w*::\S*)\]").expect("valid regex")
});

/// Preprocess block content before Tantivy indexing.
///
/// Tantivy's standard tokenizer splits on punctuation, destroying floatty's
/// native `::` and `[[]]` syntax. This function emits additional tokens so
/// both compound forms and individual words are searchable.
///
/// Transforms:
/// - `eval::https://thing` → `https thing` (prefix stripped, value parts kept)
/// - `[[Daily Page]]` → `Daily Page` (brackets stripped)
/// - `[like::this]` → `like::this` (brackets stripped)
/// - `portless::` → removed (prefix lives in markers field)
///
/// The prefix (e.g., "eval") is NOT kept in content — it lives in the
/// `markers` Tantivy field at 1.0x boost. Prose "eval" in content gets
/// 2.0x boost. This ensures prose matches outrank marker blocks.
pub fn preprocess_content_for_index(content: &str) -> String {
    let mut result = content.to_string();

    // 1. Strip [[wikilinks]] → inner text (do this first, before :: processing)
    result = WIKILINK_PATTERN.replace_all(&result, "$1").to_string();

    // 2. Strip [inline::markers] → inner content (brackets removed)
    // The standard tokenizer will split the inner "prefix::value" into parts.
    // No need to emit extra tokens — just strip the brackets.
    let inline_replacements: Vec<(String, String)> = INLINE_MARKER_PATTERN
        .captures_iter(content)
        .map(|cap| {
            let full = cap[0].to_string();
            let inner = &cap[1];
            (full, inner.to_string())
        })
        .collect();
    for (old, new) in inline_replacements {
        result = result.replace(&old, &new);
    }

    // 3. REMOVE prefix::value compounds from content entirely.
    // The prefix (e.g., "eval") lives in the `markers` field (1.0x boost).
    // Keeping it in content (2.0x boost) makes marker blocks outrank prose
    // for keyword queries like "eval loop". By stripping, prose "eval" gets
    // 2.0x content boost while marker "eval" only gets 1.0x markers boost.
    // Value parts are kept so URL components remain searchable.
    let expanded: Vec<(String, String)> = COLONCOLON_PATTERN
        .captures_iter(&result.clone())
        .map(|cap| {
            let full = cap[0].to_string();
            let value = &cap[2];
            // Split value on non-word chars for individual tokens
            let value_parts: Vec<&str> = value.split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
                .filter(|s| !s.is_empty())
                .collect();
            // Replace compound with just the value parts
            (full, value_parts.join(" "))
        })
        .collect();
    for (old, new) in expanded {
        result = result.replacen(&old, &new, 1);
    }

    // 4. REMOVE bare prefix:: → just delete it (prefix lives in markers field)
    let bare_removed: Vec<(String, String)> = BARE_PREFIX_PATTERN
        .captures_iter(&result.clone())
        .map(|cap| {
            let full = cap[0].to_string();
            (full, String::new())
        })
        .collect();
    for (old, new) in bare_removed {
        result = result.replacen(&old, &new, 1);
    }

    result
}

/// Channel capacity - provides backpressure during bulk operations.
const CHANNEL_CAPACITY: usize = 1000;

/// Heap size for IndexWriter (50MB).
const WRITER_HEAP_SIZE: usize = 50_000_000;

/// All data needed to index a block in Tantivy.
///
/// # Marker field semantics
/// - `markers`: Space-separated formatted pairs for full-text search (own + inherited)
/// - `marker_types` / `marker_values`: Combined own + inherited (default filter target)
/// - `marker_types_own` / `marker_values_own`: Own only (for `inherited=false` queries)
///
/// All marker fields are derived from `block.metadata.markers` + `InheritanceIndex`
/// by the TantivyIndexHook. They must be kept in sync.
#[derive(Debug, Clone)]
pub struct BlockIndexData {
    pub block_id: String,
    pub content: String,
    pub block_type: String,
    pub parent_id: Option<String>,
    pub updated_at: i64,
    pub has_markers: bool,
    /// Space-separated marker values for full-text search (e.g., "project::floatty mode::dev").
    pub markers: String,
    /// [[wikilink]] targets from block.metadata.outlinks.
    pub outlinks: Vec<String>,
    /// Distinct marker types — own + inherited (e.g., ["project", "mode"]).
    pub marker_types: Vec<String>,
    /// "type::value" pairs — own + inherited (e.g., ["project::floatty"]).
    pub marker_values: Vec<String>,
    /// Distinct marker types — own only (excludes inherited).
    pub marker_types_own: Vec<String>,
    /// "type::value" pairs — own only (excludes inherited).
    pub marker_values_own: Vec<String>,
    /// Block creation timestamp (epoch seconds). 0 if unknown.
    pub created_at: i64,
    /// ctx:: event timestamp (epoch seconds). 0 if no ctx datetime.
    pub ctx_at: i64,
    /// Block depth in tree (0 = root/page, 1 = direct child, etc.).
    pub depth: u32,
}

/// Messages that can be sent to the writer actor.
#[derive(Debug)]
pub enum WriterMessage {
    /// Add or update a document (delete by ID first, then add).
    AddOrUpdate(BlockIndexData),
    /// Delete a document by block ID.
    Delete { block_id: String },
    /// Delete all documents from the index (fire-and-forget).
    ClearAll,
    /// Delete all documents and notify when complete.
    ClearAllSync { response: oneshot::Sender<()> },
    /// Commit pending changes to disk (fire-and-forget).
    Commit,
    /// Commit and notify when complete.
    CommitSync { response: oneshot::Sender<()> },
    /// Shutdown the actor.
    Shutdown,
    /// Health check ping (no-op, just verifies channel is open).
    Ping,
}

/// Handle for sending messages to the writer actor.
#[derive(Clone)]
pub struct WriterHandle {
    tx: mpsc::Sender<WriterMessage>,
}

impl WriterHandle {
    /// Create a WriterHandle from a channel sender.
    ///
    /// Mainly for testing - production code should use `TantivyWriter::spawn()`.
    #[cfg(test)]
    pub fn from_sender(tx: mpsc::Sender<WriterMessage>) -> Self {
        Self { tx }
    }

    /// Add or update a block in the index.
    ///
    /// This is atomic: deletes any existing doc with the ID, then adds new.
    pub async fn add_or_update(&self, data: BlockIndexData) -> Result<(), SearchError> {
        self.tx
            .send(WriterMessage::AddOrUpdate(data))
            .await
            .map_err(|_| SearchError::WriterClosed)
    }

    /// Delete a block from the index.
    pub async fn delete(&self, block_id: String) -> Result<(), SearchError> {
        self.tx
            .send(WriterMessage::Delete { block_id })
            .await
            .map_err(|_| SearchError::WriterClosed)
    }

    /// Clear all documents from the index.
    ///
    /// Use when Y.Doc is reset/cleared to avoid stale index entries.
    pub async fn clear_all(&self) -> Result<(), SearchError> {
        self.tx
            .send(WriterMessage::ClearAll)
            .await
            .map_err(|_| SearchError::WriterClosed)
    }

    /// Commit pending changes to disk.
    ///
    /// Call periodically or after batch operations.
    pub async fn commit(&self) -> Result<(), SearchError> {
        self.tx
            .send(WriterMessage::Commit)
            .await
            .map_err(|_| SearchError::WriterClosed)
    }

    /// Clear all documents and WAIT for completion.
    ///
    /// Unlike `clear_all()`, this blocks until the actor processes the request.
    /// Use for operations that need guaranteed completion before proceeding.
    pub async fn clear_all_sync(&self) -> Result<(), SearchError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(WriterMessage::ClearAllSync { response: tx })
            .await
            .map_err(|_| SearchError::WriterClosed)?;
        rx.await.map_err(|_| SearchError::WriterClosed)
    }

    /// Commit and WAIT for completion.
    ///
    /// Unlike `commit()`, this blocks until the actor finishes the commit.
    /// Use for operations that need guaranteed visibility before proceeding.
    pub async fn commit_sync(&self) -> Result<(), SearchError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(WriterMessage::CommitSync { response: tx })
            .await
            .map_err(|_| SearchError::WriterClosed)?;
        rx.await.map_err(|_| SearchError::WriterClosed)
    }

    /// Shutdown the writer actor gracefully.
    pub async fn shutdown(&self) -> Result<(), SearchError> {
        self.tx
            .send(WriterMessage::Shutdown)
            .await
            .map_err(|_| SearchError::WriterClosed)
    }

    /// Check if channel has capacity (non-blocking).
    pub fn has_capacity(&self) -> bool {
        self.tx.capacity() > 0
    }

    /// Non-blocking health check - verifies writer actor is alive.
    ///
    /// Returns Ok if the message was queued, Err if channel is closed.
    /// Use this after spawn() to verify the actor is accepting messages.
    pub fn try_send_ping(&self) -> Result<(), SearchError> {
        self.tx
            .try_send(WriterMessage::Ping)
            .map_err(|_| SearchError::WriterClosed)
    }
}

/// The writer actor - owns IndexWriter and processes messages.
pub struct TantivyWriter {
    writer: IndexWriter,
    fields: SchemaFields,
    rx: mpsc::Receiver<WriterMessage>,
}

impl TantivyWriter {
    /// Spawn the writer actor, returning a handle for sending messages.
    ///
    /// The actor runs in a tokio task until shutdown.
    pub fn spawn(index_manager: &IndexManager) -> Result<WriterHandle, SearchError> {
        let (tx, rx) = mpsc::channel(CHANNEL_CAPACITY);
        let fields = index_manager.fields();

        let writer = index_manager
            .index()
            .writer(WRITER_HEAP_SIZE)
            .map_err(SearchError::Tantivy)?;

        info!(
            heap_size = WRITER_HEAP_SIZE,
            channel_capacity = CHANNEL_CAPACITY,
            "Tantivy writer actor spawned"
        );

        let actor = TantivyWriter { writer, fields, rx };

        tokio::spawn(async move {
            actor.run().await;
        });

        Ok(WriterHandle { tx })
    }

    /// Run the actor loop until shutdown.
    async fn run(mut self) {
        let mut pending_ops = 0u64;

        while let Some(msg) = self.rx.recv().await {
            match msg {
                WriterMessage::AddOrUpdate(data) => {
                    if let Err(e) = self.handle_add_or_update(&data) {
                        error!(block_id = %data.block_id, error = %e, "Failed to index block");
                    } else {
                        pending_ops += 1;
                        trace!(block_id = %data.block_id, pending_ops, "Block indexed");
                    }
                }

                WriterMessage::Delete { block_id } => {
                    self.handle_delete(&block_id);
                    pending_ops += 1;
                    trace!(block_id = %block_id, pending_ops, "Block deleted from index");
                }

                WriterMessage::ClearAll => {
                    if let Err(e) = self.writer.delete_all_documents() {
                        error!(error = %e, "Failed to clear all documents");
                    } else {
                        info!("All documents cleared from index");
                        pending_ops += 1; // Mark that we need a commit
                    }
                }

                WriterMessage::ClearAllSync { response } => {
                    if let Err(e) = self.writer.delete_all_documents() {
                        error!(error = %e, "Failed to clear all documents");
                    } else {
                        info!("All documents cleared from index (sync)");
                        pending_ops += 1;
                    }
                    // Notify caller regardless of success (they'll see logs if failed)
                    let _ = response.send(());
                }

                WriterMessage::Commit => {
                    if let Err(e) = self.writer.commit() {
                        error!(error = %e, "Failed to commit index");
                    } else {
                        debug!(pending_ops, "Index committed");
                        pending_ops = 0;
                    }
                }

                WriterMessage::CommitSync { response } => {
                    if let Err(e) = self.writer.commit() {
                        error!(error = %e, "Failed to commit index");
                    } else {
                        debug!(pending_ops, "Index committed (sync)");
                        pending_ops = 0;
                    }
                    let _ = response.send(());
                }

                WriterMessage::Shutdown => {
                    info!(pending_ops, "Writer actor shutting down");
                    // Final commit before shutdown
                    if pending_ops > 0 {
                        if let Err(e) = self.writer.commit() {
                            warn!(error = %e, "Failed to commit on shutdown");
                        }
                    }
                    break;
                }

                WriterMessage::Ping => {
                    // Health check - no-op, just proves channel is open
                    trace!("Writer actor received ping");
                }
            }
        }

        info!("Writer actor stopped");
    }

    /// Handle AddOrUpdate: delete by term, then add document.
    fn handle_add_or_update(&mut self, d: &BlockIndexData) -> Result<(), SearchError> {
        // Delete any existing document with this ID
        let term = Term::from_field_text(self.fields.block_id, &d.block_id);
        self.writer.delete_term(term);

        // Build new document
        let mut doc = tantivy::TantivyDocument::new();
        doc.add_text(self.fields.block_id, &d.block_id);
        let preprocessed = preprocess_content_for_index(&d.content);
        doc.add_text(self.fields.content, &preprocessed);
        doc.add_text(self.fields.block_type, &d.block_type);
        doc.add_text(self.fields.parent_id, d.parent_id.as_deref().unwrap_or(""));
        doc.add_date(self.fields.updated_at, DateTime::from_timestamp_secs(d.updated_at));
        doc.add_text(self.fields.has_markers, if d.has_markers { "true" } else { "false" });
        doc.add_text(self.fields.markers, &d.markers);

        // Multi-value fields: each value added separately
        for outlink in &d.outlinks {
            doc.add_text(self.fields.outlinks, outlink);
        }
        for mt in &d.marker_types {
            doc.add_text(self.fields.marker_types, mt);
        }
        for mv in &d.marker_values {
            doc.add_text(self.fields.marker_values, mv);
        }
        // Own-only marker fields (for inherited=false queries)
        for mt in &d.marker_types_own {
            doc.add_text(self.fields.marker_types_own, mt);
        }
        for mv in &d.marker_values_own {
            doc.add_text(self.fields.marker_values_own, mv);
        }

        // Temporal fields (0 = not set)
        if d.created_at > 0 {
            doc.add_i64(self.fields.created_at, d.created_at);
        }
        if d.ctx_at > 0 {
            doc.add_i64(self.fields.ctx_at, d.ctx_at);
        }

        // Depth field (always set)
        doc.add_i64(self.fields.depth, d.depth as i64);

        self.writer.add_document(doc).map_err(SearchError::Tantivy)?;
        Ok(())
    }

    /// Handle Delete: delete by term only.
    fn handle_delete(&mut self, block_id: &str) {
        let term = Term::from_field_text(self.fields.block_id, block_id);
        self.writer.delete_term(term);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::time::{sleep, Duration};

    async fn setup_writer() -> (WriterHandle, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");
        let manager = IndexManager::open_or_create_at(index_path).unwrap();
        let handle = TantivyWriter::spawn(&manager).unwrap();
        (handle, dir)
    }

    /// Helper: create a minimal BlockIndexData for tests.
    fn simple_data(block_id: &str, content: &str, block_type: &str, parent_id: Option<&str>, has_markers: bool, markers: &str) -> BlockIndexData {
        BlockIndexData {
            block_id: block_id.to_string(),
            content: content.to_string(),
            block_type: block_type.to_string(),
            parent_id: parent_id.map(String::from),
            updated_at: 1704067200,
            has_markers,
            markers: markers.to_string(),
            outlinks: vec![],
            marker_types: vec![],
            marker_values: vec![],
            marker_types_own: vec![],
            marker_values_own: vec![],
            created_at: 0,
            ctx_at: 0,
            depth: 0,
        }
    }

    // --- preprocess_content_for_index tests ---

    #[test]
    fn test_preprocess_prefix_value() {
        let result = preprocess_content_for_index("eval::https://deploy-url.com");
        // Compound REMOVED — prefix lives in markers field, not content
        assert!(!result.contains("eval::"));
        assert!(!result.contains("eval"));
        // Value parts kept for searchability
        assert!(result.contains("https"));
        assert!(result.contains("deploy-url"));
        assert!(result.contains("com"));
    }

    #[test]
    fn test_preprocess_bare_prefix() {
        let result = preprocess_content_for_index("portless:: some text");
        // Bare prefix removed — lives in markers field
        assert!(!result.contains("portless"));
        assert!(result.contains("some text"));
    }

    #[test]
    fn test_preprocess_bare_prefix_at_end() {
        let result = preprocess_content_for_index("hello floatctl::");
        // Bare prefix removed
        assert!(!result.contains("floatctl"));
        assert!(result.contains("hello"));
    }

    #[test]
    fn test_preprocess_wikilinks() {
        let result = preprocess_content_for_index("see [[Daily Page]] for details");
        assert!(result.contains("Daily Page"));
        assert!(!result.contains("[["));
        assert!(!result.contains("]]"));
    }

    #[test]
    fn test_preprocess_inline_marker() {
        let result = preprocess_content_for_index("check [issue::264] status");
        // Brackets stripped, then prefix::value removed by step 3
        // "issue" stripped (prefix), "264" kept (value)
        assert!(result.contains("264"));
        assert!(!result.contains("[issue"));
        assert!(result.contains("check"));
        assert!(result.contains("status"));
    }

    #[test]
    fn test_preprocess_mixed_content() {
        let result = preprocess_content_for_index(
            "ctx::2026-03-11 discussed [[FLO-368]] eval::https://thing.com"
        );
        // Compounds removed — prefixes live in markers field
        assert!(!result.contains("ctx::"));
        assert!(!result.contains("eval::"));
        // Value parts kept
        assert!(result.contains("2026-03-11"));
        assert!(result.contains("thing"));
        // Wikilinks stripped
        assert!(result.contains("FLO-368"));
        assert!(!result.contains("[[FLO-368]]"));
        // Prose preserved
        assert!(result.contains("discussed"));
    }

    #[test]
    fn test_preprocess_duplicate_prefix() {
        let result = preprocess_content_for_index("eval::url1 and eval::url2");
        // Compounds removed
        assert!(!result.contains("eval::"));
        assert!(!result.contains("eval"));
        // Value parts kept
        assert!(result.contains("url1"));
        assert!(result.contains("url2"));
        assert!(result.contains("and"));
    }

    #[test]
    fn test_preprocess_plain_text_unchanged() {
        let input = "just some normal text with no special patterns";
        let result = preprocess_content_for_index(input);
        assert_eq!(result, input);
    }

    #[test]
    fn test_preprocess_code_namespace_expanded() {
        // Code namespaces like std::io — prefix stripped, value parts kept
        let result = preprocess_content_for_index("use std::io::Read");
        // "std" stripped (prefix), "io::Read" is value → split to "io" + "Read"
        assert!(result.contains("io"));
        assert!(result.contains("Read"));
        assert!(result.contains("use"));
    }

    #[test]
    fn test_preprocess_project_marker() {
        let result = preprocess_content_for_index("project::floatty mode::dev");
        // Prefixes stripped — they live in markers field
        assert!(!result.contains("project::"));
        assert!(!result.contains("mode::"));
        // Values kept
        assert!(result.contains("floatty"));
        assert!(result.contains("dev"));
    }

    // --- writer actor tests ---

    #[tokio::test]
    async fn test_add_or_update() {
        let (handle, _dir) = setup_writer().await;
        let result = handle.add_or_update(simple_data("block_1", "Hello world", "text", None, false, "")).await;
        assert!(result.is_ok());
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_delete() {
        let (handle, _dir) = setup_writer().await;
        handle.add_or_update(simple_data("block_2", "To be deleted", "text", None, false, "")).await.unwrap();
        let result = handle.delete("block_2".to_string()).await;
        assert!(result.is_ok());
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_commit() {
        let (handle, _dir) = setup_writer().await;
        handle.add_or_update(simple_data("block_3", "Commit me", "text", Some("parent_1"), true, "project::test")).await.unwrap();
        let result = handle.commit().await;
        assert!(result.is_ok());
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_shutdown() {
        let (handle, _dir) = setup_writer().await;
        let result = handle.shutdown().await;
        assert!(result.is_ok());
        sleep(Duration::from_millis(50)).await;
        let result = handle.commit().await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_bounded_channel_capacity() {
        let (handle, _dir) = setup_writer().await;
        assert!(handle.has_capacity());
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_update_replaces_existing() {
        let (handle, _dir) = setup_writer().await;
        handle.add_or_update(simple_data("block_4", "Original content", "text", None, false, "")).await.unwrap();
        handle.add_or_update(simple_data("block_4", "Updated content", "text", None, true, "project::floatty mode::dev")).await.unwrap();
        handle.commit().await.unwrap();
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_add_with_enriched_fields() {
        let (handle, _dir) = setup_writer().await;
        let data = BlockIndexData {
            block_id: "block_5".to_string(),
            content: "ctx::2026-03-11 project::floatty".to_string(),
            block_type: "ctx".to_string(),
            parent_id: None,
            updated_at: 1704067200,
            has_markers: true,
            markers: "ctx project::floatty".to_string(),
            outlinks: vec!["Page A".to_string(), "Page B".to_string()],
            marker_types: vec!["ctx".to_string(), "project".to_string()],
            marker_values: vec!["project::floatty".to_string()],
            marker_types_own: vec!["ctx".to_string(), "project".to_string()],
            marker_values_own: vec!["project::floatty".to_string()],
            created_at: 1704067200,
            ctx_at: 1773379200,
            depth: 2,
        };
        let result = handle.add_or_update(data).await;
        assert!(result.is_ok());
        handle.commit().await.unwrap();
        handle.shutdown().await.ok();
    }
}
