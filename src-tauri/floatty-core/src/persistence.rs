//! SQLite persistence for Y.Doc updates.
//!
//! Uses an append-only update log for efficient persistence.
//! On startup, replay all updates to reconstruct state.
//! Periodically compact to a single snapshot.

use rusqlite::{params, Connection, Result as SqliteResult};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use thiserror::Error;

/// Errors that can occur during persistence operations.
#[derive(Error, Debug)]
pub enum PersistenceError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Database directory could not be created: {0}")]
    DirectoryCreation(String),
    #[error("Lock poisoned")]
    LockPoisoned,
}

/// Default database path: ~/.floatty/ctx_markers.db
/// (shares database with ctx:: system for now)
pub fn default_db_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".floatty")
        .join("ctx_markers.db")
}

/// SQLite persistence layer for Y.Doc updates.
///
/// Stores append-only update deltas that can be replayed on startup.
/// Thread-safe via internal Mutex.
pub struct YDocPersistence {
    conn: Mutex<Connection>,
}

impl YDocPersistence {
    /// Open the database at the given path.
    /// Creates the database and tables if they don't exist.
    pub fn open(path: &Path) -> Result<Self, PersistenceError> {
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                PersistenceError::DirectoryCreation(format!(
                    "Cannot create directory {:?}: {}",
                    parent, e
                ))
            })?;
        }

        let conn = Connection::open(path)?;

        // Enable WAL mode for better concurrency
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;

        let persistence = Self {
            conn: Mutex::new(conn),
        };
        persistence.init_schema()?;
        Ok(persistence)
    }

    /// Open an in-memory database for testing.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, PersistenceError> {
        let conn = Connection::open_in_memory()?;
        let persistence = Self {
            conn: Mutex::new(conn),
        };
        persistence.init_schema()?;
        Ok(persistence)
    }

    /// Initialize the database schema.
    fn init_schema(&self) -> Result<(), PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        conn.execute_batch(
            r#"
            -- Append-only Y.Doc updates for efficient persistence
            -- Each row is a delta update; replay all on load, compact periodically
            CREATE TABLE IF NOT EXISTS ydoc_updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_key TEXT NOT NULL,
                update_data BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_ydoc_doc_key ON ydoc_updates(doc_key, id);

            -- Schema version for detecting incompatible format changes
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        "#,
        )?;
        Ok(())
    }

    /// Get the current schema version (0 if not set).
    pub fn get_schema_version(&self) -> Result<i32, PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        let result: Result<String, _> = conn.query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        );
        match result {
            Ok(v) => Ok(v.parse().unwrap_or(0)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(0),
            Err(e) => Err(PersistenceError::Sqlite(e)),
        }
    }

    /// Set the schema version.
    pub fn set_schema_version(&self, version: i32) -> Result<(), PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)",
            [version.to_string()],
        )?;
        Ok(())
    }

    /// Clear all updates for a document (for schema upgrades that require fresh start).
    pub fn clear_updates(&self, doc_key: &str) -> Result<(), PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        conn.execute("DELETE FROM ydoc_updates WHERE doc_key = ?", [doc_key])?;
        log::info!("Cleared all Y.Doc updates for '{}'", doc_key);
        Ok(())
    }

    /// Append a Y.Doc update delta.
    ///
    /// This is the fast path - single row insert.
    pub fn append_update(&self, doc_key: &str, update: &[u8]) -> Result<(), PersistenceError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        conn.execute(
            "INSERT INTO ydoc_updates (doc_key, update_data, created_at) VALUES (?, ?, ?)",
            params![doc_key, update, now],
        )?;
        Ok(())
    }

    /// Get all updates for a document (for replay on load).
    ///
    /// Returns updates in order (oldest first) for correct replay.
    pub fn get_updates(&self, doc_key: &str) -> Result<Vec<Vec<u8>>, PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        let mut stmt = conn.prepare(
            "SELECT update_data FROM ydoc_updates WHERE doc_key = ? ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([doc_key], |row| row.get(0))?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(PersistenceError::from)
    }

    /// Get count of updates for a document.
    ///
    /// Use this to decide when to compact.
    pub fn get_update_count(&self, doc_key: &str) -> Result<i64, PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        conn.query_row(
            "SELECT COUNT(*) FROM ydoc_updates WHERE doc_key = ?",
            [doc_key],
            |row| row.get(0),
        )
        .map_err(PersistenceError::from)
    }

    /// Compact: delete all updates and replace with single snapshot.
    ///
    /// This is a transaction to ensure atomicity.
    pub fn compact(&self, doc_key: &str, snapshot: &[u8]) -> Result<(), PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        let tx = conn.unchecked_transaction()?;

        // Delete all existing updates for this doc
        tx.execute("DELETE FROM ydoc_updates WHERE doc_key = ?", [doc_key])?;

        // Insert the compacted snapshot as a single update
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        tx.execute(
            "INSERT INTO ydoc_updates (doc_key, update_data, created_at) VALUES (?, ?, ?)",
            params![doc_key, snapshot, now],
        )?;

        tx.commit()?;
        log::info!("Compacted Y.Doc '{}' to single snapshot", doc_key);
        Ok(())
    }

    /// Check if any updates exist for a document.
    pub fn has_updates(&self, doc_key: &str) -> Result<bool, PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM ydoc_updates WHERE doc_key = ? LIMIT 1",
            [doc_key],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_and_get_updates() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        persistence.append_update("test-doc", b"update1").unwrap();
        persistence.append_update("test-doc", b"update2").unwrap();
        persistence.append_update("test-doc", b"update3").unwrap();

        let updates = persistence.get_updates("test-doc").unwrap();
        assert_eq!(updates.len(), 3);
        assert_eq!(updates[0], b"update1");
        assert_eq!(updates[1], b"update2");
        assert_eq!(updates[2], b"update3");
    }

    #[test]
    fn test_update_count() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        assert_eq!(persistence.get_update_count("test-doc").unwrap(), 0);

        persistence.append_update("test-doc", b"update1").unwrap();
        persistence.append_update("test-doc", b"update2").unwrap();

        assert_eq!(persistence.get_update_count("test-doc").unwrap(), 2);
    }

    #[test]
    fn test_compact() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        persistence.append_update("test-doc", b"update1").unwrap();
        persistence.append_update("test-doc", b"update2").unwrap();
        persistence.append_update("test-doc", b"update3").unwrap();

        assert_eq!(persistence.get_update_count("test-doc").unwrap(), 3);

        persistence.compact("test-doc", b"snapshot").unwrap();

        assert_eq!(persistence.get_update_count("test-doc").unwrap(), 1);
        let updates = persistence.get_updates("test-doc").unwrap();
        assert_eq!(updates[0], b"snapshot");
    }

    #[test]
    fn test_separate_doc_keys() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        persistence.append_update("doc-a", b"a1").unwrap();
        persistence.append_update("doc-b", b"b1").unwrap();
        persistence.append_update("doc-a", b"a2").unwrap();

        let a_updates = persistence.get_updates("doc-a").unwrap();
        let b_updates = persistence.get_updates("doc-b").unwrap();

        assert_eq!(a_updates.len(), 2);
        assert_eq!(b_updates.len(), 1);
    }
}
