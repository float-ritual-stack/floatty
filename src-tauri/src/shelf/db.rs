//! SQLite storage for shelf metadata

use crate::shelf::{Shelf, ShelfItem};
use rusqlite::{params, Connection, Result};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

pub struct ShelfDatabase {
    conn: Mutex<Connection>,
}

/// Helper to convert mutex poison errors to rusqlite errors
fn lock_conn(mutex: &Mutex<Connection>) -> Result<MutexGuard<'_, Connection>> {
    mutex.lock().map_err(|e: PoisonError<_>| {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(1),
            Some(format!("Database mutex poisoned: {}", e)),
        )
    })
}

impl ShelfDatabase {
    /// Open or create the shelf database at ~/.floatty/shelves.db
    pub fn open() -> Result<Self> {
        let db_path = Self::db_path();

        // Ensure parent directory exists - propagate error instead of ignoring
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(14), // SQLITE_CANTOPEN
                    Some(format!("Failed to create database directory {:?}: {}", parent, e)),
                )
            })?;
        }

        let conn = Connection::open(&db_path)?;

        // Enable WAL mode for better concurrency
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;

        // Create tables
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS shelves (
                id TEXT PRIMARY KEY,
                name TEXT,
                position_x REAL NOT NULL DEFAULT 100.0,
                position_y REAL NOT NULL DEFAULT 100.0,
                width REAL NOT NULL DEFAULT 280.0,
                height REAL NOT NULL DEFAULT 400.0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS shelf_items (
                id TEXT PRIMARY KEY,
                shelf_id TEXT NOT NULL,
                original_path TEXT NOT NULL,
                stored_path TEXT NOT NULL,
                filename TEXT NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                is_directory INTEGER NOT NULL DEFAULT 0,
                added_at INTEGER NOT NULL,
                FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_shelf_items_shelf_id ON shelf_items(shelf_id);
            "#,
        )?;

        log::info!("Shelf database opened at {:?}", db_path);
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn db_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".floatty")
            .join("shelves.db")
    }

    /// Create a new shelf
    pub fn create_shelf(&self, shelf: &Shelf) -> Result<()> {
        let conn = lock_conn(&self.conn)?;
        conn.execute(
            r#"
            INSERT INTO shelves (id, name, position_x, position_y, width, height, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                shelf.id,
                shelf.name,
                shelf.position_x,
                shelf.position_y,
                shelf.width,
                shelf.height,
                shelf.created_at,
                shelf.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Get all shelves
    pub fn get_all_shelves(&self) -> Result<Vec<Shelf>> {
        let conn = lock_conn(&self.conn)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, position_x, position_y, width, height, created_at, updated_at FROM shelves ORDER BY created_at DESC",
        )?;

        let shelves = stmt
            .query_map([], |row| {
                Ok(Shelf {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    position_x: row.get(2)?,
                    position_y: row.get(3)?,
                    width: row.get(4)?,
                    height: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;

        Ok(shelves)
    }

    /// Get a shelf by ID
    pub fn get_shelf(&self, id: &str) -> Result<Option<Shelf>> {
        let conn = lock_conn(&self.conn)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, position_x, position_y, width, height, created_at, updated_at FROM shelves WHERE id = ?1",
        )?;

        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Shelf {
                id: row.get(0)?,
                name: row.get(1)?,
                position_x: row.get(2)?,
                position_y: row.get(3)?,
                width: row.get(4)?,
                height: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Update shelf position
    pub fn update_shelf_position(&self, id: &str, x: f64, y: f64) -> Result<()> {
        let conn = lock_conn(&self.conn)?;
        let now = crate::shelf::chrono_timestamp();
        conn.execute(
            "UPDATE shelves SET position_x = ?1, position_y = ?2, updated_at = ?3 WHERE id = ?4",
            params![x, y, now, id],
        )?;
        Ok(())
    }

    /// Update shelf size
    pub fn update_shelf_size(&self, id: &str, width: f64, height: f64) -> Result<()> {
        let conn = lock_conn(&self.conn)?;
        let now = crate::shelf::chrono_timestamp();
        conn.execute(
            "UPDATE shelves SET width = ?1, height = ?2, updated_at = ?3 WHERE id = ?4",
            params![width, height, now, id],
        )?;
        Ok(())
    }

    /// Delete a shelf and all its items
    pub fn delete_shelf(&self, id: &str) -> Result<()> {
        let conn = lock_conn(&self.conn)?;
        // Items are deleted via CASCADE
        conn.execute("DELETE FROM shelves WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Add an item to a shelf
    pub fn add_item(&self, item: &ShelfItem) -> Result<()> {
        let conn = lock_conn(&self.conn)?;
        conn.execute(
            r#"
            INSERT INTO shelf_items (id, shelf_id, original_path, stored_path, filename, size_bytes, is_directory, added_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![
                item.id,
                item.shelf_id,
                item.original_path.to_string_lossy(),
                item.stored_path.to_string_lossy(),
                item.filename,
                item.size_bytes,
                item.is_directory as i32,
                item.added_at,
            ],
        )?;
        Ok(())
    }

    /// Get all items in a shelf
    pub fn get_shelf_items(&self, shelf_id: &str) -> Result<Vec<ShelfItem>> {
        let conn = lock_conn(&self.conn)?;
        let mut stmt = conn.prepare(
            "SELECT id, shelf_id, original_path, stored_path, filename, size_bytes, is_directory, added_at
             FROM shelf_items WHERE shelf_id = ?1 ORDER BY added_at DESC",
        )?;

        let items = stmt
            .query_map(params![shelf_id], |row| {
                let original: String = row.get(2)?;
                let stored: String = row.get(3)?;
                Ok(ShelfItem {
                    id: row.get(0)?,
                    shelf_id: row.get(1)?,
                    original_path: PathBuf::from(original),
                    stored_path: PathBuf::from(stored),
                    filename: row.get(4)?,
                    size_bytes: row.get(5)?,
                    is_directory: row.get::<_, i32>(6)? != 0,
                    added_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;

        Ok(items)
    }

    /// Get item count for a shelf
    pub fn get_item_count(&self, shelf_id: &str) -> Result<i32> {
        let conn = lock_conn(&self.conn)?;
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM shelf_items WHERE shelf_id = ?1",
            params![shelf_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Delete an item
    pub fn delete_item(&self, id: &str) -> Result<()> {
        let conn = lock_conn(&self.conn)?;
        conn.execute("DELETE FROM shelf_items WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Get an item by ID
    pub fn get_item(&self, id: &str) -> Result<Option<ShelfItem>> {
        let conn = lock_conn(&self.conn)?;
        let mut stmt = conn.prepare(
            "SELECT id, shelf_id, original_path, stored_path, filename, size_bytes, is_directory, added_at
             FROM shelf_items WHERE id = ?1",
        )?;

        let mut rows = stmt.query(params![id])?;
        if let Some(row) = rows.next()? {
            let original: String = row.get(2)?;
            let stored: String = row.get(3)?;
            Ok(Some(ShelfItem {
                id: row.get(0)?,
                shelf_id: row.get(1)?,
                original_path: PathBuf::from(original),
                stored_path: PathBuf::from(stored),
                filename: row.get(4)?,
                size_bytes: row.get(5)?,
                is_directory: row.get::<_, i32>(6)? != 0,
                added_at: row.get(7)?,
            }))
        } else {
            Ok(None)
        }
    }
}
