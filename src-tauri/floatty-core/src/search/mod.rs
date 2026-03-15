//! Full-text search infrastructure using Tantivy.
//!
//! This module provides the search index for floatty's block content.
//! The index enables fast content search across all blocks.
//!
//! # Architecture
//!
//! ```text
//! IndexManager (owns Index + Schema)
//!      │
//!      ├── schema.rs     → Schema definition (block_id, content, etc.)
//!      └── index_manager  → Open/create index, get fields
//!
//! Usage by other modules:
//!   - TantivyIndexHook (Unit 3.3) → writes to index
//!   - SearchService (Unit 3.4) → reads from index
//! ```
//!
//! # Index Location
//!
//! The index is stored at `~/.floatty/search_index/`.
//!
//! # Example
//!
//! ```rust,ignore
//! use floatty_core::search::IndexManager;
//!
//! let manager = IndexManager::open_or_create()?;
//! let fields = manager.fields();
//!
//! // Create a document
//! let mut doc = tantivy::TantivyDocument::new();
//! doc.add_text(fields.block_id, "block_123");
//! doc.add_text(fields.content, "Hello world");
//! ```

mod index_manager;
mod schema;
mod service;
mod writer;

pub use index_manager::{IndexManager, SchemaFields};
pub use schema::build_schema;
pub use service::{SearchFilters, SearchHit, SearchService};
pub use writer::{BlockIndexData, TantivyWriter, WriterHandle, WriterMessage};

/// Errors that can occur during search operations.
#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    /// Failed to create the index directory.
    #[error("Failed to create index directory: {0}")]
    CreateDir(#[from] std::io::Error),

    /// Tantivy operation failed.
    #[error("Tantivy error: {0}")]
    Tantivy(#[from] tantivy::TantivyError),

    /// Failed to open directory.
    #[error("Failed to open directory: {0}")]
    OpenDir(#[from] tantivy::directory::error::OpenDirectoryError),

    /// Failed to parse query.
    #[error("Query parse error: {0}")]
    QueryParse(#[from] tantivy::query::QueryParserError),

    /// Failed to open index.
    /// Reserved for future use when index migration/versioning is added.
    /// Currently index creation always succeeds or returns Tantivy error.
    #[error("Failed to open index: {0}")]
    OpenIndex(String),

    /// Index directory could not be determined.
    #[error("Could not determine index directory")]
    NoIndexDir,

    /// Writer actor channel closed.
    #[error("Writer actor channel closed")]
    WriterClosed,
}
