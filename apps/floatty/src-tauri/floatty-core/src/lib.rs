//! Floatty Core - Block storage and persistence for Floatty's executable outliner.
//!
//! This crate provides the core block operations independent of Tauri,
//! enabling headless servers, CLI tools, and agents to work with the same
//! block substrate.
//!
//! # Architecture
//!
//! - **Block**: The fundamental unit - text with optional `::` prefixes that
//!   determine behavior (e.g., `sh::` for shell, `ctx::` for context).
//!
//! - **Y.Doc**: CRDT-based state using yrs (Rust port of Yjs). Enables
//!   real-time sync between multiple clients.
//!
//! - **Persistence**: Append-only SQLite storage of Y.Doc update deltas.
//!   Replays on startup, compacts periodically.
//!
//! # Example
//!
//! ```no_run
//! use floatty_core::YDocStore;
//!
//! let store = YDocStore::new().expect("Failed to create store");
//! let full_state = store.get_full_state().expect("Failed to get state");
//! ```

pub mod batcher;
pub mod block;
pub mod emitter;
pub mod events;
pub mod hooks;
pub mod metadata;
pub mod origin;
pub mod persistence;
pub mod projections;
pub mod search;
pub mod store;

use std::path::PathBuf;

/// Resolve the floatty data directory.
///
/// Checks `FLOATTY_DATA_DIR` env first, then falls back to build-profile default:
/// - Debug: `~/.floatty-dev`
/// - Release: `~/.floatty`
///
/// This is the single canonical implementation. All crates should use this
/// instead of duplicating the logic (FLO-317 hardening).
pub fn data_dir() -> PathBuf {
    std::env::var("FLOATTY_DATA_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));

            #[cfg(debug_assertions)]
            {
                home.join(".floatty-dev")
            }

            #[cfg(not(debug_assertions))]
            {
                home.join(".floatty")
            }
        })
}

// Re-exports for convenience
pub use batcher::BatchedChangeCollector;
pub use block::{parse_block_type, Block, BlockType};
pub use emitter::{parse_origin, ChangeBuilder, ChangeEmitter};
pub use events::{BlockChange, BlockChangeBatch};
pub use hooks::{
    parsing, should_process, BlockHook, HookRegistry, HookSystem, InheritanceIndex,
    InheritanceIndexHook, InheritedMarker, MetadataExtractionHook, PageNameIndex,
    PageNameIndexHook, PageSuggestion,
};
pub use metadata::{BlockMetadata, Marker};
pub use origin::Origin;
pub use persistence::{default_db_path, PersistenceError, YDocPersistence};
pub use search::{
    IndexManager, SchemaFields, SearchError, SearchFilters, SearchHit, SearchService,
    TantivyWriter, WriterHandle, WriterMessage,
};
pub use store::{ChangeCallback, StoreError, YDocStore, DEFAULT_DOC_KEY};
