//! Drop Shelf system - floating panels for temporary file collection
//!
//! Provides Dropover-style functionality with floating NSPanel windows (macOS)
//! that can hold dragged files temporarily.

mod db;
mod storage;

#[cfg(target_os = "macos")]
pub mod panel;

pub use db::ShelfDatabase;
pub use storage::ShelfStorage;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// A shelf is a floating container for temporarily collecting files
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Shelf {
    pub id: String,
    pub name: Option<String>,
    pub position_x: f64,
    pub position_y: f64,
    pub width: f64,
    pub height: f64,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Shelf {
    pub fn new(id: String, position: Option<(f64, f64)>) -> Self {
        let now = chrono_timestamp();
        let (x, y) = position.unwrap_or((100.0, 100.0));
        Self {
            id,
            name: None,
            position_x: x,
            position_y: y,
            width: 280.0,
            height: 400.0,
            created_at: now,
            updated_at: now,
        }
    }
}

/// An item stored in a shelf
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShelfItem {
    pub id: String,
    pub shelf_id: String,
    pub original_path: PathBuf,
    pub stored_path: PathBuf,
    pub filename: String,
    pub size_bytes: u64,
    pub is_directory: bool,
    pub added_at: i64,
}

/// Get current unix timestamp in seconds
/// Returns 0 and logs an error if system time is before Unix epoch (should never happen)
pub(crate) fn chrono_timestamp() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_else(|e| {
            log::error!("System time is before Unix epoch: {}", e);
            0
        })
}
