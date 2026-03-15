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
use tantivy::{DateTime, IndexWriter, Term};
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, trace, warn};

/// Channel capacity - provides backpressure during bulk operations.
const CHANNEL_CAPACITY: usize = 1000;

/// Heap size for IndexWriter (50MB).
const WRITER_HEAP_SIZE: usize = 50_000_000;

/// Messages that can be sent to the writer actor.
#[derive(Debug)]
pub enum WriterMessage {
    /// Add or update a document (delete by ID first, then add).
    AddOrUpdate {
        block_id: String,
        content: String,
        block_type: String,
        parent_id: Option<String>,
        updated_at: i64,
        has_markers: bool,
        /// Space-separated marker values for full-text search (e.g., "project::floatty mode::dev").
        markers: String,
        /// [[wikilink]] targets from block.metadata.outlinks.
        outlinks: Vec<String>,
        /// Distinct marker types (e.g., ["project", "mode"]).
        marker_types: Vec<String>,
        /// "type::value" formatted marker pairs (e.g., ["project::floatty"]).
        marker_values: Vec<String>,
        /// Block creation timestamp (epoch seconds). 0 if unknown.
        created_at: i64,
        /// ctx:: event timestamp (epoch seconds). 0 if no ctx datetime.
        ctx_at: i64,
    },
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
    #[allow(clippy::too_many_arguments)]
    pub async fn add_or_update(
        &self,
        block_id: String,
        content: String,
        block_type: String,
        parent_id: Option<String>,
        updated_at: i64,
        has_markers: bool,
        markers: String,
        outlinks: Vec<String>,
        marker_types: Vec<String>,
        marker_values: Vec<String>,
        created_at: i64,
        ctx_at: i64,
    ) -> Result<(), SearchError> {
        self.tx
            .send(WriterMessage::AddOrUpdate {
                block_id,
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
            })
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
                WriterMessage::AddOrUpdate {
                    block_id,
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
                } => {
                    if let Err(e) = self.handle_add_or_update(
                        &block_id,
                        &content,
                        &block_type,
                        parent_id.as_deref(),
                        updated_at,
                        has_markers,
                        &markers,
                        &outlinks,
                        &marker_types,
                        &marker_values,
                        created_at,
                        ctx_at,
                    ) {
                        error!(block_id = %block_id, error = %e, "Failed to index block");
                    } else {
                        pending_ops += 1;
                        trace!(block_id = %block_id, pending_ops, "Block indexed");
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
    #[allow(clippy::too_many_arguments)]
    fn handle_add_or_update(
        &mut self,
        block_id: &str,
        content: &str,
        block_type: &str,
        parent_id: Option<&str>,
        updated_at: i64,
        has_markers: bool,
        markers: &str,
        outlinks: &[String],
        marker_types: &[String],
        marker_values: &[String],
        created_at: i64,
        ctx_at: i64,
    ) -> Result<(), SearchError> {
        // Delete any existing document with this ID
        let term = Term::from_field_text(self.fields.block_id, block_id);
        self.writer.delete_term(term);

        // Build new document
        let mut doc = tantivy::TantivyDocument::new();
        doc.add_text(self.fields.block_id, block_id);
        doc.add_text(self.fields.content, content);
        doc.add_text(self.fields.block_type, block_type);
        doc.add_text(
            self.fields.parent_id,
            parent_id.unwrap_or(""),
        );
        doc.add_date(
            self.fields.updated_at,
            DateTime::from_timestamp_secs(updated_at),
        );
        doc.add_text(
            self.fields.has_markers,
            if has_markers { "true" } else { "false" },
        );
        // Full-text searchable marker values (e.g., "project::floatty mode::dev")
        doc.add_text(self.fields.markers, markers);

        // Multi-value fields: each value added separately
        for outlink in outlinks {
            doc.add_text(self.fields.outlinks, outlink);
        }
        for mt in marker_types {
            doc.add_text(self.fields.marker_types, mt);
        }
        for mv in marker_values {
            doc.add_text(self.fields.marker_values, mv);
        }

        // Temporal fields (0 = not set)
        if created_at > 0 {
            doc.add_i64(self.fields.created_at, created_at);
        }
        if ctx_at > 0 {
            doc.add_i64(self.fields.ctx_at, ctx_at);
        }

        self.writer
            .add_document(doc)
            .map_err(SearchError::Tantivy)?;

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

    /// Helper: add_or_update with default empty values for new fields.
    async fn add_simple(
        handle: &WriterHandle,
        block_id: &str,
        content: &str,
        block_type: &str,
        parent_id: Option<String>,
        updated_at: i64,
        has_markers: bool,
        markers: String,
    ) -> Result<(), SearchError> {
        handle
            .add_or_update(
                block_id.to_string(),
                content.to_string(),
                block_type.to_string(),
                parent_id,
                updated_at,
                has_markers,
                markers,
                vec![],
                vec![],
                vec![],
                0,
                0,
            )
            .await
    }

    #[tokio::test]
    async fn test_add_or_update() {
        let (handle, _dir) = setup_writer().await;
        let result = add_simple(&handle, "block_1", "Hello world", "text", None, 1704067200, false, String::new()).await;
        assert!(result.is_ok());
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_delete() {
        let (handle, _dir) = setup_writer().await;
        add_simple(&handle, "block_2", "To be deleted", "text", None, 1704067200, false, String::new()).await.unwrap();
        let result = handle.delete("block_2".to_string()).await;
        assert!(result.is_ok());
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_commit() {
        let (handle, _dir) = setup_writer().await;
        add_simple(&handle, "block_3", "Commit me", "text", Some("parent_1".to_string()), 1704067200, true, "project::test".to_string()).await.unwrap();
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
        add_simple(&handle, "block_4", "Original content", "text", None, 1704067200, false, String::new()).await.unwrap();
        add_simple(&handle, "block_4", "Updated content", "text", None, 1704067201, true, "project::floatty mode::dev".to_string()).await.unwrap();
        handle.commit().await.unwrap();
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_add_with_enriched_fields() {
        let (handle, _dir) = setup_writer().await;
        let result = handle
            .add_or_update(
                "block_5".to_string(),
                "ctx::2026-03-11 project::floatty".to_string(),
                "ctx".to_string(),
                None,
                1704067200,
                true,
                "ctx project::floatty".to_string(),
                vec!["Page A".to_string(), "Page B".to_string()],
                vec!["ctx".to_string(), "project".to_string()],
                vec!["project::floatty".to_string()],
                1704067200,
                1773379200,
            )
            .await;
        assert!(result.is_ok());
        handle.commit().await.unwrap();
        handle.shutdown().await.ok();
    }
}
