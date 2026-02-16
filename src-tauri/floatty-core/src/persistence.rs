//! SQLite persistence for Y.Doc updates.
//!
//! Uses an append-only update log for efficient persistence.
//! On startup, replay all updates to reconstruct state.
//! Periodically compact to a single snapshot.

use rusqlite::{params, Connection, OptionalExtension, Result as SqliteResult};
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

/// Default database path: {data_dir}/ctx_markers.db
/// (shares database with ctx:: system for now)
///
/// Uses `FLOATTY_DATA_DIR` if set, otherwise build-profile-aware default.
pub fn default_db_path() -> PathBuf {
    crate::data_dir().join("ctx_markers.db")
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

            -- Sync metadata for sequence tracking.
            -- Separate from schema_meta (which tracks schema versions) because sync state
            -- is runtime data that changes during normal operation, while schema_meta is
            -- migration infrastructure that changes only on upgrades.
            -- Namespaced by doc_key so each document has its own sync state.
            CREATE TABLE IF NOT EXISTS sync_meta (
                doc_key TEXT NOT NULL,
                key TEXT NOT NULL,
                value INTEGER NOT NULL,
                PRIMARY KEY (doc_key, key)
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
    /// Returns the sequence number (rowid) assigned to this update.
    /// The sequence number is monotonically increasing and can be used for
    /// gap detection and incremental sync.
    ///
    /// This is the fast path - single row insert wrapped in transaction
    /// to ensure last_insert_rowid returns our insert's id.
    pub fn append_update(&self, doc_key: &str, update: &[u8]) -> Result<i64, PersistenceError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;

        // Use transaction to guarantee last_insert_rowid returns our insert
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO ydoc_updates (doc_key, update_data, created_at) VALUES (?, ?, ?)",
            params![doc_key, update, now],
        )?;
        let seq = tx.last_insert_rowid();
        tx.commit()?;

        Ok(seq)
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
    /// This is a transaction to ensure atomicity. Also records the compaction
    /// boundary in sync_meta so clients know when they've fallen too far behind.
    ///
    /// Returns the sequence number of the snapshot row.
    pub fn compact(&self, doc_key: &str, snapshot: &[u8]) -> Result<i64, PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        let tx = conn.unchecked_transaction()?;

        // Get the max seq before deletion (this is what we're compacting away)
        // Use .optional()? to properly propagate DB errors while handling empty result
        let max_seq_before: Option<i64> = tx
            .query_row(
                "SELECT MAX(id) FROM ydoc_updates WHERE doc_key = ?",
                [doc_key],
                |row| row.get(0),
            )
            .optional()?;

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
        let snapshot_seq = tx.last_insert_rowid();

        // Record compaction boundary: the last seq that was compacted away
        // Clients requesting since < compacted_through should do full resync
        if let Some(old_max) = max_seq_before {
            tx.execute(
                "INSERT OR REPLACE INTO sync_meta (doc_key, key, value) VALUES (?, 'compacted_through', ?)",
                params![doc_key, old_max],
            )?;
        }

        tx.commit()?;
        log::info!(
            "Compacted Y.Doc '{}' to single snapshot (seq {}), compacted_through: {:?}",
            doc_key,
            snapshot_seq,
            max_seq_before
        );
        Ok(snapshot_seq)
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

    // =========================================================================
    // Sequence-based sync methods (FLO-SEQ)
    // =========================================================================

    /// Get updates since a given sequence number.
    ///
    /// Returns tuples of (seq, update_data, created_at) for updates with id > since_seq.
    /// Used for incremental sync - clients track lastSeenSeq and fetch only what they missed.
    pub fn get_updates_since(
        &self,
        doc_key: &str,
        since_seq: i64,
        limit: usize,
    ) -> Result<Vec<(i64, Vec<u8>, i64)>, PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        let mut stmt = conn.prepare(
            "SELECT id, update_data, created_at FROM ydoc_updates \
             WHERE doc_key = ? AND id > ? ORDER BY id ASC LIMIT ?",
        )?;
        let rows = stmt.query_map(params![doc_key, since_seq, limit as i64], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, i64>(2)?))
        })?;
        rows.collect::<SqliteResult<Vec<_>>>()
            .map_err(PersistenceError::from)
    }

    /// Get the latest sequence number for a document.
    ///
    /// Returns None if no updates exist.
    pub fn get_latest_seq(&self, doc_key: &str) -> Result<Option<i64>, PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        // MAX(id) returns NULL when table is empty (still returns a row, just with NULL value)
        // Use Option<i64> in the row mapper to handle NULL, then flatten
        let result: Option<Option<i64>> = conn
            .query_row(
                "SELECT MAX(id) FROM ydoc_updates WHERE doc_key = ?",
                [doc_key],
                |row| row.get(0),
            )
            .optional()?;
        // Flatten: Some(Some(x)) -> Some(x), Some(None) -> None, None -> None
        Ok(result.flatten())
    }

    /// Get the compaction boundary for a document.
    ///
    /// Returns the highest sequence number that was compacted away.
    /// Clients requesting since < compacted_through are too far behind
    /// and should do a full state resync instead of incremental.
    pub fn get_compacted_through(&self, doc_key: &str) -> Result<Option<i64>, PersistenceError> {
        let conn = self.conn.lock().map_err(|_| PersistenceError::LockPoisoned)?;
        let result: Result<i64, _> = conn.query_row(
            "SELECT value FROM sync_meta WHERE doc_key = ? AND key = 'compacted_through'",
            [doc_key],
            |row| row.get(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(PersistenceError::Sqlite(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_and_get_updates() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        let seq1 = persistence.append_update("test-doc", b"update1").unwrap();
        let seq2 = persistence.append_update("test-doc", b"update2").unwrap();
        let seq3 = persistence.append_update("test-doc", b"update3").unwrap();

        // Verify monotonically increasing sequence numbers
        assert!(seq2 > seq1);
        assert!(seq3 > seq2);

        let updates = persistence.get_updates("test-doc").unwrap();
        assert_eq!(updates.len(), 3);
        assert_eq!(updates[0], b"update1");
        assert_eq!(updates[1], b"update2");
        assert_eq!(updates[2], b"update3");
    }

    #[test]
    fn test_append_returns_monotonic_seq() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        let seq1 = persistence.append_update("test-doc", b"update1").unwrap();
        let seq2 = persistence.append_update("test-doc", b"update2").unwrap();
        let seq3 = persistence.append_update("test-doc", b"update3").unwrap();

        // Sequences must be strictly increasing (don't rely on exact +1 increment)
        assert!(seq2 > seq1, "seq2 ({}) should be > seq1 ({})", seq2, seq1);
        assert!(seq3 > seq2, "seq3 ({}) should be > seq2 ({})", seq3, seq2);
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
        let seq3 = persistence.append_update("test-doc", b"update3").unwrap();

        assert_eq!(persistence.get_update_count("test-doc").unwrap(), 3);

        let snapshot_seq = persistence.compact("test-doc", b"snapshot").unwrap();

        // Snapshot gets a new seq after the old ones
        assert!(snapshot_seq > seq3);

        assert_eq!(persistence.get_update_count("test-doc").unwrap(), 1);
        let updates = persistence.get_updates("test-doc").unwrap();
        assert_eq!(updates[0], b"snapshot");
    }

    #[test]
    fn test_compact_sets_boundary() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        let seq1 = persistence.append_update("test-doc", b"update1").unwrap();
        let _seq2 = persistence.append_update("test-doc", b"update2").unwrap();
        let seq3 = persistence.append_update("test-doc", b"update3").unwrap();

        // Before compaction, no boundary
        assert_eq!(persistence.get_compacted_through("test-doc").unwrap(), None);

        persistence.compact("test-doc", b"snapshot").unwrap();

        // After compaction, boundary is the max seq that was deleted
        let boundary = persistence.get_compacted_through("test-doc").unwrap();
        assert_eq!(boundary, Some(seq3));

        // Verify old seqs are gone
        let updates_since_0 = persistence.get_updates_since("test-doc", 0, 100).unwrap();
        assert_eq!(updates_since_0.len(), 1); // Just the snapshot
        assert!(updates_since_0[0].0 > seq3); // Snapshot seq is higher

        // Requesting since seq1 should also just return the snapshot
        let updates_since_1 = persistence.get_updates_since("test-doc", seq1, 100).unwrap();
        assert_eq!(updates_since_1.len(), 1);
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

    // =========================================================================
    // Sequence-based sync tests
    // =========================================================================

    #[test]
    fn test_get_updates_since() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        let seq1 = persistence.append_update("test-doc", b"update1").unwrap();
        let seq2 = persistence.append_update("test-doc", b"update2").unwrap();
        let seq3 = persistence.append_update("test-doc", b"update3").unwrap();
        let _seq4 = persistence.append_update("test-doc", b"update4").unwrap();
        let seq5 = persistence.append_update("test-doc", b"update5").unwrap();

        // Get all updates (since 0)
        let all = persistence.get_updates_since("test-doc", 0, 100).unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].0, seq1);
        assert_eq!(all[4].0, seq5);

        // Get updates since seq2 (should return 3, 4, 5)
        let since_2 = persistence.get_updates_since("test-doc", seq2, 100).unwrap();
        assert_eq!(since_2.len(), 3);
        assert_eq!(since_2[0].0, seq3);
        assert_eq!(since_2[0].1, b"update3".to_vec());

        // Get updates since seq5 (should return empty)
        let since_5 = persistence.get_updates_since("test-doc", seq5, 100).unwrap();
        assert_eq!(since_5.len(), 0);

        // Test limit
        let limited = persistence.get_updates_since("test-doc", 0, 2).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].0, seq1);
        assert_eq!(limited[1].0, seq2);
    }

    #[test]
    fn test_get_latest_seq() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        // No updates yet
        assert_eq!(persistence.get_latest_seq("test-doc").unwrap(), None);

        let seq1 = persistence.append_update("test-doc", b"update1").unwrap();
        assert_eq!(persistence.get_latest_seq("test-doc").unwrap(), Some(seq1));

        let seq2 = persistence.append_update("test-doc", b"update2").unwrap();
        assert_eq!(persistence.get_latest_seq("test-doc").unwrap(), Some(seq2));

        let seq3 = persistence.append_update("test-doc", b"update3").unwrap();
        assert_eq!(persistence.get_latest_seq("test-doc").unwrap(), Some(seq3));
    }

    #[test]
    fn test_get_compacted_through() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        // No compaction yet
        assert_eq!(persistence.get_compacted_through("test-doc").unwrap(), None);

        persistence.append_update("test-doc", b"update1").unwrap();
        persistence.append_update("test-doc", b"update2").unwrap();
        let seq3 = persistence.append_update("test-doc", b"update3").unwrap();

        // Still no compaction
        assert_eq!(persistence.get_compacted_through("test-doc").unwrap(), None);

        // Compact
        persistence.compact("test-doc", b"snapshot").unwrap();

        // Now we have a boundary
        assert_eq!(persistence.get_compacted_through("test-doc").unwrap(), Some(seq3));

        // Different doc has no boundary
        assert_eq!(persistence.get_compacted_through("other-doc").unwrap(), None);
    }

    #[test]
    fn test_updates_since_respects_doc_key() {
        let persistence = YDocPersistence::open_in_memory().unwrap();

        persistence.append_update("doc-a", b"a1").unwrap();
        persistence.append_update("doc-a", b"a2").unwrap();
        persistence.append_update("doc-b", b"b1").unwrap();

        let a_updates = persistence.get_updates_since("doc-a", 0, 100).unwrap();
        let b_updates = persistence.get_updates_since("doc-b", 0, 100).unwrap();

        assert_eq!(a_updates.len(), 2);
        assert_eq!(b_updates.len(), 1);
    }
}
