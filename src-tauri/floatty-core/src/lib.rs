//! Floatty Core - Block storage and persistence for Floatty's executable outliner.
//!
//! This crate provides the core block operations independent of Tauri,
//! enabling headless servers, CLI tools, and agents to work with the same
//! block substrate.
//!
//! # Architecture
//!
//! - **Block**: The fundamental unit - text with optional `::` prefixes that
//!   determine behavior (e.g., `sh::` for shell, `ai::` for LLM).
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

pub mod block;
pub mod origin;
pub mod persistence;
pub mod store;

// Re-exports for convenience
pub use block::{Block, BlockType, parse_block_type};
pub use origin::Origin;
pub use persistence::{PersistenceError, YDocPersistence, default_db_path};
pub use store::{StoreError, YDocStore, DEFAULT_DOC_KEY};
