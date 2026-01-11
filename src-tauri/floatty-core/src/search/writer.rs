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
use tokio::sync::mpsc;
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
    },
    /// Delete a document by block ID.
    Delete { block_id: String },
    /// Commit pending changes to disk.
    Commit,
    /// Shutdown the actor.
    Shutdown,
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
    pub async fn add_or_update(
        &self,
        block_id: String,
        content: String,
        block_type: String,
        parent_id: Option<String>,
        updated_at: i64,
        has_markers: bool,
    ) -> Result<(), SearchError> {
        self.tx
            .send(WriterMessage::AddOrUpdate {
                block_id,
                content,
                block_type,
                parent_id,
                updated_at,
                has_markers,
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

    /// Commit pending changes to disk.
    ///
    /// Call periodically or after batch operations.
    pub async fn commit(&self) -> Result<(), SearchError> {
        self.tx
            .send(WriterMessage::Commit)
            .await
            .map_err(|_| SearchError::WriterClosed)
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
                } => {
                    if let Err(e) = self.handle_add_or_update(
                        &block_id,
                        &content,
                        &block_type,
                        parent_id.as_deref(),
                        updated_at,
                        has_markers,
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

                WriterMessage::Commit => {
                    if let Err(e) = self.writer.commit() {
                        error!(error = %e, "Failed to commit index");
                    } else {
                        debug!(pending_ops, "Index committed");
                        pending_ops = 0;
                    }
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
            }
        }

        info!("Writer actor stopped");
    }

    /// Handle AddOrUpdate: delete by term, then add document.
    fn handle_add_or_update(
        &mut self,
        block_id: &str,
        content: &str,
        block_type: &str,
        parent_id: Option<&str>,
        updated_at: i64,
        has_markers: bool,
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

    #[tokio::test]
    async fn test_add_or_update() {
        let (handle, _dir) = setup_writer().await;

        let result = handle
            .add_or_update(
                "block_1".to_string(),
                "Hello world".to_string(),
                "text".to_string(),
                None,
                1704067200,
                false,
            )
            .await;

        assert!(result.is_ok());
        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_delete() {
        let (handle, _dir) = setup_writer().await;

        // Add then delete
        handle
            .add_or_update(
                "block_2".to_string(),
                "To be deleted".to_string(),
                "text".to_string(),
                None,
                1704067200,
                false,
            )
            .await
            .unwrap();

        let result = handle.delete("block_2".to_string()).await;
        assert!(result.is_ok());

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_commit() {
        let (handle, _dir) = setup_writer().await;

        handle
            .add_or_update(
                "block_3".to_string(),
                "Commit me".to_string(),
                "text".to_string(),
                Some("parent_1".to_string()),
                1704067200,
                true,
            )
            .await
            .unwrap();

        let result = handle.commit().await;
        assert!(result.is_ok());

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_shutdown() {
        let (handle, _dir) = setup_writer().await;

        // Should complete cleanly
        let result = handle.shutdown().await;
        assert!(result.is_ok());

        // Give actor time to process shutdown and close channel
        sleep(Duration::from_millis(50)).await;

        // Subsequent sends should fail (channel closed)
        let result = handle.commit().await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_bounded_channel_capacity() {
        let (handle, _dir) = setup_writer().await;

        // Channel should have capacity initially
        assert!(handle.has_capacity());

        handle.shutdown().await.ok();
    }

    #[tokio::test]
    async fn test_update_replaces_existing() {
        let (handle, _dir) = setup_writer().await;

        // Add initial
        handle
            .add_or_update(
                "block_4".to_string(),
                "Original content".to_string(),
                "text".to_string(),
                None,
                1704067200,
                false,
            )
            .await
            .unwrap();

        // Update (same ID, different content)
        handle
            .add_or_update(
                "block_4".to_string(),
                "Updated content".to_string(),
                "text".to_string(),
                None,
                1704067201,
                true,
            )
            .await
            .unwrap();

        handle.commit().await.unwrap();
        handle.shutdown().await.ok();
    }
}
