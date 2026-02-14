use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use parking_lot::Mutex;

/// Status of a ctx:: marker parsing
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MarkerStatus {
    Pending,
    Parsed,
    Error,
}

impl MarkerStatus {
    #[allow(dead_code)]
    pub fn as_str(&self) -> &'static str {
        match self {
            MarkerStatus::Pending => "pending",
            MarkerStatus::Parsed => "parsed",
            MarkerStatus::Error => "error",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "parsed" => MarkerStatus::Parsed,
            "error" => MarkerStatus::Error,
            _ => MarkerStatus::Pending,
        }
    }
}

/// Parsed ctx:: marker data (from Ollama)
/// Simplified schema - dedicated fields instead of generic tags array
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedCtx {
    pub timestamp: Option<String>,
    pub time: Option<String>,
    pub project: Option<String>,
    pub mode: Option<String>,
    pub meeting: Option<String>,
    pub issue: Option<String>,
    pub summary: Option<String>,
    pub message: Option<String>,
}

/// JSONL metadata extracted at insert time (no Ollama needed)
#[derive(Debug, Clone, Default)]
pub struct JsonlMetadata {
    pub sort_key: Option<String>,      // JSONL timestamp
    pub cwd: Option<String>,           // Working directory
    pub git_branch: Option<String>,    // Git branch
    pub session_id: Option<String>,    // Session ID
    pub msg_type: Option<String>,      // user/assistant
}

/// Full ctx:: marker record from database
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CtxMarker {
    pub id: String,
    pub session_file: String,
    pub raw_line: String,
    pub status: MarkerStatus,
    pub parsed: Option<ParsedCtx>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub session_id: Option<String>,
    pub msg_type: Option<String>,
    pub created_at: String,
    pub retry_count: i32,
}

/// Persisted workspace state record from SQLite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStateRecord {
    pub state_json: String,
    pub save_seq: i64,
}

/// Main application database.
///
/// Manages all persistent state for floatty:
/// - ctx:: markers from JSONL session logs
/// - Y.Doc append-only updates (CRDT persistence)
/// - Workspace state (layout, tabs, etc.)
/// - File watcher positions (resume support)
///
/// Location: ~/.floatty/ctx_markers.db (name kept for backwards compatibility)
pub struct FloattyDb {
    conn: Mutex<Connection>,
}

impl FloattyDb {
    /// Open or create database at specified path.
    ///
    /// Use `DataPaths::resolve().database` to get the path based on
    /// `FLOATTY_DATA_DIR` environment variable.
    pub fn open_at(db_path: &PathBuf) -> Result<Self> {
        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                log::error!("Failed to create database directory {:?}: {}", parent, e);
                return Err(rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(14), // SQLITE_CANTOPEN
                    Some(format!("Cannot create directory {:?}: {}", parent, e))
                ));
            }
        }

        let conn = Connection::open(db_path)?;

        // Enable WAL mode for better concurrency
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;

        let db = Self { conn: Mutex::new(conn) };
        db.init_schema()?;
        Ok(db)
    }

    /// Open an in-memory database for testing
    #[allow(dead_code)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn: Mutex::new(conn) };
        db.init_schema()?;
        Ok(db)
    }

    /// Initialize database schema
    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock();

        // Create tables first (without sort_key index)
        conn.execute_batch(r#"
            CREATE TABLE IF NOT EXISTS ctx_markers (
                id TEXT PRIMARY KEY,
                session_file TEXT NOT NULL,
                raw_line TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                parsed_json TEXT,
                sort_key TEXT,
                cwd TEXT,
                git_branch TEXT,
                session_id TEXT,
                msg_type TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                retry_count INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_status ON ctx_markers(status);
            CREATE INDEX IF NOT EXISTS idx_created_at ON ctx_markers(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_session_file ON ctx_markers(session_file);

            -- Track file positions for resuming after restart
            CREATE TABLE IF NOT EXISTS file_positions (
                file_path TEXT PRIMARY KEY,
                last_position INTEGER DEFAULT 0,
                last_modified TEXT,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- Serialized Yjs document state (legacy full snapshots)
            CREATE TABLE IF NOT EXISTS system_state (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            -- Append-only Y.Doc updates for efficient persistence
            -- Each row is a delta update; replay all on load, compact periodically
            CREATE TABLE IF NOT EXISTS ydoc_updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_key TEXT NOT NULL,
                update_data BLOB NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_ydoc_doc_key ON ydoc_updates(doc_key, id);

            -- Workspace layout state (tabs, panes, splits)
            -- JSON blob for flexibility; single row per workspace key
            CREATE TABLE IF NOT EXISTS workspace_state (
                key TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                save_seq INTEGER NOT NULL DEFAULT 0
            );

            -- Agent activity log (metadata enrichment audit trail)
            -- Auto-pruned: entries older than max_age_hours deleted on insert
            CREATE TABLE IF NOT EXISTS agent_activity_log (
                id TEXT PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                block_id TEXT NOT NULL,
                action TEXT NOT NULL,
                added_markers TEXT,
                reason TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_agent_log_timestamp
                ON agent_activity_log(timestamp DESC);
        "#)?;

        // Migrations: add columns if they don't exist (for existing DBs)
        // Expected error: "duplicate column name" when column already exists
        Self::migrate_add_column(&conn, "ctx_markers", "sort_key TEXT")?;
        Self::migrate_add_column(&conn, "ctx_markers", "cwd TEXT")?;
        Self::migrate_add_column(&conn, "ctx_markers", "git_branch TEXT")?;
        Self::migrate_add_column(&conn, "ctx_markers", "session_id TEXT")?;
        Self::migrate_add_column(&conn, "ctx_markers", "msg_type TEXT")?;
        Self::migrate_add_column(&conn, "workspace_state", "save_seq INTEGER NOT NULL DEFAULT 0")?;

        // Create indexes (after columns definitely exist)
        Self::migrate_create_index(&conn, "idx_sort_key", "ctx_markers(sort_key DESC)")?;
        Self::migrate_create_index(&conn, "idx_session_id", "ctx_markers(session_id)")?;

        Ok(())
    }

    /// Add a column to a table, ignoring "duplicate column" errors.
    ///
    /// SAFETY: `column_def` must be a compile-time string literal.
    /// Never construct from user/external input — it is interpolated directly into SQL.
    fn migrate_add_column(conn: &Connection, table: &str, column_def: &str) -> Result<()> {
        // Restrict migration targets to known table identifiers.
        // This keeps SQL construction safe even if future callers change.
        let table_ident = match table {
            "ctx_markers" => "\"ctx_markers\"",
            "workspace_state" => "\"workspace_state\"",
            _ => {
                log::error!("Migration rejected for unknown table '{}'", table);
                return Err(rusqlite::Error::InvalidParameterName(format!(
                    "unsupported migration table: {}",
                    table
                )));
            }
        };

        let sql = format!("ALTER TABLE {} ADD COLUMN {}", table_ident, column_def);
        match conn.execute(&sql, []) {
            Ok(_) => {
                log::info!("Migration: added column {}.{}", table, column_def);
                Ok(())
            }
            Err(rusqlite::Error::SqliteFailure(_, Some(ref msg)))
                if msg.contains("duplicate column") => {
                // Expected for existing databases - column already exists
                Ok(())
            }
            Err(e) => {
                log::error!("Migration failed for column {}.{}: {}", table, column_def, e);
                Err(e)
            }
        }
    }

    /// Create an index, ignoring "already exists" errors
    fn migrate_create_index(conn: &Connection, name: &str, definition: &str) -> Result<()> {
        let sql = format!("CREATE INDEX IF NOT EXISTS {} ON {}", name, definition);
        match conn.execute(&sql, []) {
            Ok(_) => Ok(()),
            Err(e) => {
                log::error!("Failed to create index {}: {}", name, e);
                Err(e)
            }
        }
    }

    /// Check if a marker with this ID already exists
    #[allow(dead_code)]
    pub fn marker_exists(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM ctx_markers WHERE id = ?",
            [id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Insert a new raw marker (status = pending)
    /// Metadata comes from JSONL fields - authoritative source of truth
    #[allow(dead_code)]
    pub fn insert_raw(&self, id: &str, session_file: &str, raw_line: &str, meta: &JsonlMetadata) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR IGNORE INTO ctx_markers (id, session_file, raw_line, status, sort_key, cwd, git_branch, session_id, msg_type)
             VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
            params![
                id,
                session_file,
                raw_line,
                meta.sort_key,
                meta.cwd,
                meta.git_branch,
                meta.session_id,
                meta.msg_type
            ],
        )?;
        Ok(())
    }

    /// Update marker with parsed JSON (status = parsed)
    /// Note: sort_key is set at insert time from JSONL timestamp, not here
    pub fn update_parsed(&self, id: &str, parsed_json: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE ctx_markers SET status = 'parsed', parsed_json = ? WHERE id = ?",
            params![parsed_json, id],
        )?;
        Ok(())
    }

    /// Mark marker as error, increment retry count
    pub fn mark_error(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE ctx_markers SET status = 'error', retry_count = retry_count + 1 WHERE id = ?",
            [id],
        )?;
        Ok(())
    }

    /// Reset error markers to pending for retry (if retry_count < max)
    pub fn reset_errors_for_retry(&self, max_retries: i32) -> Result<usize> {
        let conn = self.conn.lock();
        let updated = conn.execute(
            "UPDATE ctx_markers SET status = 'pending' WHERE status = 'error' AND retry_count < ?",
            [max_retries],
        )?;
        Ok(updated)
    }

    /// Get all pending markers for parsing
    pub fn get_pending(&self, limit: i32) -> Result<Vec<CtxMarker>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, session_file, raw_line, status, parsed_json, cwd, git_branch, session_id, msg_type, created_at, retry_count
             FROM ctx_markers WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?"
        )?;

        let markers = stmt.query_map([limit], |row| {
            let status_str: String = row.get(3)?;
            let parsed_json: Option<String> = row.get(4)?;
            let parsed = parsed_json.and_then(|json| serde_json::from_str(&json).ok());

            Ok(CtxMarker {
                id: row.get(0)?,
                session_file: row.get(1)?,
                raw_line: row.get(2)?,
                status: MarkerStatus::from_str(&status_str),
                parsed,
                cwd: row.get(5)?,
                git_branch: row.get(6)?,
                session_id: row.get(7)?,
                msg_type: row.get(8)?,
                created_at: row.get(9)?,
                retry_count: row.get(10)?,
            })
        })?;

        markers.collect()
    }

    /// Get all markers for sidebar display
    /// Sorted by parsed timestamp (sort_key), falling back to created_at for unparsed entries
    pub fn get_all(&self, limit: i32, offset: i32) -> Result<Vec<CtxMarker>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, session_file, raw_line, status, parsed_json, cwd, git_branch, session_id, msg_type, created_at, retry_count
             FROM ctx_markers ORDER BY COALESCE(sort_key, created_at) DESC LIMIT ? OFFSET ?"
        )?;

        let markers = stmt.query_map([limit, offset], |row| {
            let status_str: String = row.get(3)?;
            let parsed_json: Option<String> = row.get(4)?;
            let parsed = parsed_json.and_then(|json| serde_json::from_str(&json).ok());

            Ok(CtxMarker {
                id: row.get(0)?,
                session_file: row.get(1)?,
                raw_line: row.get(2)?,
                status: MarkerStatus::from_str(&status_str),
                parsed,
                cwd: row.get(5)?,
                git_branch: row.get(6)?,
                session_id: row.get(7)?,
                msg_type: row.get(8)?,
                created_at: row.get(9)?,
                retry_count: row.get(10)?,
            })
        })?;

        markers.collect()
    }

    /// Get file position for resume after restart
    pub fn get_file_position(&self, file_path: &str) -> Result<i64> {
        let conn = self.conn.lock();
        let pos: Result<i64, _> = conn.query_row(
            "SELECT last_position FROM file_positions WHERE file_path = ?",
            [file_path],
            |row| row.get(0),
        );
        Ok(pos.unwrap_or(0))
    }

    /// Update file position after reading
    #[allow(dead_code)]
    pub fn set_file_position(&self, file_path: &str, position: i64) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO file_positions (file_path, last_position, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)",
            params![file_path, position],
        )?;
        Ok(())
    }

    /// Get count of markers by status
    pub fn get_counts(&self) -> Result<(i32, i32, i32)> {
        let conn = self.conn.lock();
        let pending: i32 = conn.query_row(
            "SELECT COUNT(*) FROM ctx_markers WHERE status = 'pending'",
            [],
            |row| row.get(0),
        )?;
        let parsed: i32 = conn.query_row(
            "SELECT COUNT(*) FROM ctx_markers WHERE status = 'parsed'",
            [],
            |row| row.get(0),
        )?;
        let error: i32 = conn.query_row(
            "SELECT COUNT(*) FROM ctx_markers WHERE status = 'error'",
            [],
            |row| row.get(0),
        )?;
        Ok((pending, parsed, error))
    }

    /// Insert markers and update file position atomically in a transaction
    /// Returns number of new markers inserted
    pub fn insert_markers_with_position(
        &self,
        session_file: &str,
        markers: &[(String, String, JsonlMetadata)], // (id, raw_line, metadata)
        new_position: i64,
    ) -> Result<usize> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        let mut inserted = 0;
        for (id, raw_line, meta) in markers {
            let changes = tx.execute(
                "INSERT OR IGNORE INTO ctx_markers (id, session_file, raw_line, status, sort_key, cwd, git_branch, session_id, msg_type)
                 VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)",
                params![
                    id,
                    session_file,
                    raw_line,
                    meta.sort_key,
                    meta.cwd,
                    meta.git_branch,
                    meta.session_id,
                    meta.msg_type
                ],
            )?;
            inserted += changes;
        }

        tx.execute(
            "INSERT OR REPLACE INTO file_positions (file_path, last_position, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)",
            params![session_file, new_position],
        )?;

        tx.commit()?;
        Ok(inserted)
    }

    /// Clear all markers and file positions (reset database)
    pub fn clear_all(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM ctx_markers", [])?;
        conn.execute("DELETE FROM file_positions", [])?;
        // We do not delete system_state (Yjs doc) on clear_all unless explicitly requested, 
        // as that destroys user notes. 
        // If we want to support clearing notes, we should add a separate method.
        Ok(())
    }

    /// Get serialized Yjs state
    pub fn get_system_state(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT value FROM system_state WHERE key = ?")?;
        let mut rows = stmt.query([key])?;
        
        if let Some(row) = rows.next()? {
            Ok(Some(row.get(0)?))
        } else {
            Ok(None)
        }
    }

    /// Set serialized Yjs state
    pub fn set_system_state(&self, key: &str, value: &[u8]) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
            params![key, value],
        )?;
        Ok(())
    }

    // =========================================================================
    // Y.Doc Append-Only Persistence (FLO-61)
    // =========================================================================

    /// Append a Y.Doc update delta (fast, single row insert)
    pub fn append_ydoc_update(&self, doc_key: &str, update: &[u8]) -> Result<()> {
        let conn = self.conn.lock();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        conn.execute(
            "INSERT INTO ydoc_updates (doc_key, update_data, created_at) VALUES (?, ?, ?)",
            params![doc_key, update, now],
        )?;
        Ok(())
    }

    /// Get all updates for a doc (replay on load)
    /// Returns updates in order (oldest first) for correct replay
    /// NOTE: Not yet wired up - will be used when Y.Doc loading from DB is implemented
    #[allow(dead_code)]
    pub fn get_ydoc_updates(&self, doc_key: &str) -> Result<Vec<Vec<u8>>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT update_data FROM ydoc_updates WHERE doc_key = ? ORDER BY id ASC"
        )?;
        let rows = stmt.query_map([doc_key], |row| row.get(0))?;
        rows.collect()
    }

    /// Get count of updates for a doc (to decide when to compact)
    pub fn get_ydoc_update_count(&self, doc_key: &str) -> Result<i64> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT COUNT(*) FROM ydoc_updates WHERE doc_key = ?",
            [doc_key],
            |row| row.get(0),
        )
    }

    /// Compact: delete all updates and replace with single snapshot
    /// This is a transaction to ensure atomicity
    /// NOTE: Not yet wired up - will be used when Y.Doc compaction is implemented
    #[allow(dead_code)]
    pub fn compact_ydoc(&self, doc_key: &str, snapshot: &[u8]) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

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

    // =========================================================================
    // Workspace State Persistence (FLO-81)
    // =========================================================================

    /// Get workspace state JSON + sequence (returns None if not found)
    pub fn get_workspace_state(&self, key: &str) -> Result<Option<WorkspaceStateRecord>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT state_json, save_seq FROM workspace_state WHERE key = ?"
        )?;
        let mut rows = stmt.query([key])?;

        if let Some(row) = rows.next()? {
            Ok(Some(WorkspaceStateRecord {
                state_json: row.get(0)?,
                save_seq: row.get(1)?,
            }))
        } else {
            Ok(None)
        }
    }

    /// Save workspace state JSON with monotonic sequence guard.
    ///
    /// Writes are accepted only if `save_seq` is newer than the stored sequence,
    /// or if it is an idempotent retry with the same payload.
    /// This prevents older async saves (or conflicting same-seq writes) from overwriting newer state.
    pub fn set_workspace_state(&self, key: &str, state_json: &str, save_seq: i64) -> Result<bool> {
        let conn = self.conn.lock();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let changed_rows = conn.execute(
            r#"
            INSERT INTO workspace_state (key, state_json, updated_at, save_seq)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = excluded.updated_at,
                save_seq = excluded.save_seq
            WHERE excluded.save_seq > workspace_state.save_seq
               OR (
                    excluded.save_seq = workspace_state.save_seq
                    AND excluded.state_json = workspace_state.state_json
               )
            "#,
            params![key, state_json, now, save_seq],
        )?;

        if changed_rows == 0 {
            log::error!(
                "Rejected stale workspace save for key '{}' (save_seq={})",
                key,
                save_seq
            );
            Ok(false)
        } else {
            Ok(true)
        }
    }

    // =========================================================================
    // Agent Activity Log
    // =========================================================================

    /// Insert an agent activity log entry and auto-prune old entries.
    ///
    /// Entries older than `max_age_hours` are deleted atomically in the same transaction.
    pub fn insert_agent_activity(
        &self,
        id: &str,
        timestamp: i64,
        block_id: &str,
        action: &str,
        added_markers: Option<&str>,
        reason: Option<&str>,
        max_age_hours: i64,
    ) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;

        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        tx.execute(
            "INSERT OR IGNORE INTO agent_activity_log (id, timestamp, block_id, action, added_markers, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![id, timestamp, block_id, action, added_markers, reason, now_ms],
        )?;

        // Auto-prune entries older than max_age_hours
        let cutoff_ms = now_ms - (max_age_hours * 3600 * 1000);
        tx.execute(
            "DELETE FROM agent_activity_log WHERE timestamp < ?",
            [cutoff_ms],
        )?;

        tx.commit()?;
        Ok(())
    }

    /// Get recent agent activity log entries, newest first.
    pub fn get_agent_activity(&self, limit: i32) -> Result<Vec<AgentActivityEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT id, timestamp, block_id, action, added_markers, reason
             FROM agent_activity_log ORDER BY timestamp DESC LIMIT ?"
        )?;

        let entries = stmt.query_map([limit], |row| {
            Ok(AgentActivityEntry {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                block_id: row.get(2)?,
                action: row.get(3)?,
                added_markers: row.get(4)?,
                reason: row.get(5)?,
            })
        })?;

        entries.collect()
    }

    /// Clear all agent activity log entries.
    pub fn clear_agent_activity(&self) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM agent_activity_log", [])?;
        Ok(())
    }
}

/// Agent activity log entry from database.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivityEntry {
    pub id: String,
    pub timestamp: i64,
    pub block_id: String,
    pub action: String,
    pub added_markers: Option<String>,
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::FloattyDb;
    use rusqlite::Connection;

    #[test]
    fn workspace_state_rejects_stale_save_seq() {
        let db = FloattyDb::open_in_memory().expect("open in-memory db");

        assert!(db.set_workspace_state("default", r#"{"v":1}"#, 1)
            .expect("initial save"));
        assert!(db.set_workspace_state("default", r#"{"v":2}"#, 2)
            .expect("newer save"));
        assert!(!db.set_workspace_state("default", r#"{"v":1.5}"#, 1)
            .expect("stale save should return false"));

        let stored = db
            .get_workspace_state("default")
            .expect("read workspace state")
            .expect("workspace state exists");
        assert_eq!(stored.state_json, r#"{"v":2}"#);
        assert_eq!(stored.save_seq, 2);
    }

    #[test]
    fn workspace_state_allows_idempotent_same_seq_retry() {
        let db = FloattyDb::open_in_memory().expect("open in-memory db");

        assert!(db.set_workspace_state("default", r#"{"v":2}"#, 2)
            .expect("initial save"));
        assert!(db.set_workspace_state("default", r#"{"v":2}"#, 2)
            .expect("idempotent retry"));

        let stored = db
            .get_workspace_state("default")
            .expect("read workspace state")
            .expect("workspace state exists");
        assert_eq!(stored.state_json, r#"{"v":2}"#);
        assert_eq!(stored.save_seq, 2);
    }

    #[test]
    fn workspace_state_rejects_conflicting_same_seq_write() {
        let db = FloattyDb::open_in_memory().expect("open in-memory db");

        assert!(db.set_workspace_state("default", r#"{"v":2}"#, 2)
            .expect("initial save"));
        assert!(!db.set_workspace_state("default", r#"{"v":"conflict"}"#, 2)
            .expect("conflicting same-seq save should return false"));

        let stored = db
            .get_workspace_state("default")
            .expect("read workspace state")
            .expect("workspace state exists");
        assert_eq!(stored.state_json, r#"{"v":2}"#);
        assert_eq!(stored.save_seq, 2);
    }

    #[test]
    fn migrate_add_column_rejects_unknown_table() {
        let conn = Connection::open_in_memory().expect("open in-memory connection");
        let err = FloattyDb::migrate_add_column(&conn, "user_input_table", "new_col TEXT")
            .expect_err("unknown table should be rejected");

        match err {
            rusqlite::Error::InvalidParameterName(name) => {
                assert!(name.contains("unsupported migration table"));
            }
            other => panic!("unexpected error variant: {other:?}"),
        }
    }

    #[test]
    fn agent_activity_insert_and_query() {
        let db = FloattyDb::open_in_memory().expect("open in-memory db");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        db.insert_agent_activity(
            "act-1", now, "block-1", "enrich",
            Some(r#"[{"markerType":"issue","value":"123"}]"#),
            None, 72,
        ).expect("insert activity");

        db.insert_agent_activity(
            "act-2", now + 1000, "block-2", "skip",
            None, Some("no patterns found"), 72,
        ).expect("insert second activity");

        let entries = db.get_agent_activity(10).expect("query activity");
        assert_eq!(entries.len(), 2);
        // Newest first
        assert_eq!(entries[0].id, "act-2");
        assert_eq!(entries[0].action, "skip");
        assert_eq!(entries[1].id, "act-1");
        assert_eq!(entries[1].action, "enrich");
    }

    #[test]
    fn agent_activity_auto_prune() {
        let db = FloattyDb::open_in_memory().expect("open in-memory db");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        // Insert an old entry (73 hours ago)
        let old_ts = now - (73 * 3600 * 1000);
        db.insert_agent_activity(
            "old-1", old_ts, "block-old", "enrich", None, None, 72,
        ).expect("insert old activity");

        // Insert a recent entry (triggers prune of old)
        db.insert_agent_activity(
            "new-1", now, "block-new", "enrich", None, None, 72,
        ).expect("insert new activity");

        let entries = db.get_agent_activity(10).expect("query activity");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "new-1");
    }

    #[test]
    fn agent_activity_clear() {
        let db = FloattyDb::open_in_memory().expect("open in-memory db");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        db.insert_agent_activity(
            "act-1", now, "block-1", "enrich", None, None, 72,
        ).expect("insert");

        db.clear_agent_activity().expect("clear");

        let entries = db.get_agent_activity(10).expect("query");
        assert_eq!(entries.len(), 0);
    }
}
