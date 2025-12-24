use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Status of a ctx:: marker parsing
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum MarkerStatus {
    Pending,
    Parsed,
    Error,
}

impl MarkerStatus {
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

/// Database wrapper with connection pool
pub struct CtxDatabase {
    conn: Mutex<Connection>,
}

impl CtxDatabase {
    /// Open or create database at ~/.floatty/ctx_markers.db
    pub fn open() -> Result<Self> {
        let db_path = Self::db_path();

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

        let conn = Connection::open(&db_path)?;

        // Enable WAL mode for better concurrency
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;

        let db = Self { conn: Mutex::new(conn) };
        db.init_schema()?;
        Ok(db)
    }

    /// Open an in-memory database for testing
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self { conn: Mutex::new(conn) };
        db.init_schema()?;
        Ok(db)
    }

    /// Get the database file path
    fn db_path() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".floatty")
            .join("ctx_markers.db")
    }

    /// Initialize database schema
    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();

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

            -- Serialized Yjs document state
            CREATE TABLE IF NOT EXISTS system_state (
                key TEXT PRIMARY KEY,
                value BLOB NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        "#)?;

        // Migrations: add columns if they don't exist (for existing DBs)
        // Expected error: "duplicate column name" when column already exists
        Self::migrate_add_column(&conn, "sort_key TEXT")?;
        Self::migrate_add_column(&conn, "cwd TEXT")?;
        Self::migrate_add_column(&conn, "git_branch TEXT")?;
        Self::migrate_add_column(&conn, "session_id TEXT")?;
        Self::migrate_add_column(&conn, "msg_type TEXT")?;

        // Create indexes (after columns definitely exist)
        Self::migrate_create_index(&conn, "idx_sort_key", "ctx_markers(sort_key DESC)")?;
        Self::migrate_create_index(&conn, "idx_session_id", "ctx_markers(session_id)")?;

        Ok(())
    }

    /// Add a column to ctx_markers, ignoring "duplicate column" errors
    fn migrate_add_column(conn: &Connection, column_def: &str) -> Result<()> {
        let sql = format!("ALTER TABLE ctx_markers ADD COLUMN {}", column_def);
        match conn.execute(&sql, []) {
            Ok(_) => {
                log::info!("Migration: added column {}", column_def);
                Ok(())
            }
            Err(rusqlite::Error::SqliteFailure(_, Some(ref msg)))
                if msg.contains("duplicate column") => {
                // Expected for existing databases - column already exists
                Ok(())
            }
            Err(e) => {
                log::error!("Migration failed for column {}: {}", column_def, e);
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
    pub fn marker_exists(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let count: i32 = conn.query_row(
            "SELECT COUNT(*) FROM ctx_markers WHERE id = ?",
            [id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// Insert a new raw marker (status = pending)
    /// Metadata comes from JSONL fields - authoritative source of truth
    pub fn insert_raw(&self, id: &str, session_file: &str, raw_line: &str, meta: &JsonlMetadata) -> Result<()> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE ctx_markers SET status = 'parsed', parsed_json = ? WHERE id = ?",
            params![parsed_json, id],
        )?;
        Ok(())
    }

    /// Mark marker as error, increment retry count
    pub fn mark_error(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE ctx_markers SET status = 'error', retry_count = retry_count + 1 WHERE id = ?",
            [id],
        )?;
        Ok(())
    }

    /// Reset error markers to pending for retry (if retry_count < max)
    pub fn reset_errors_for_retry(&self, max_retries: i32) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let updated = conn.execute(
            "UPDATE ctx_markers SET status = 'pending' WHERE status = 'error' AND retry_count < ?",
            [max_retries],
        )?;
        Ok(updated)
    }

    /// Get all pending markers for parsing
    pub fn get_pending(&self, limit: i32) -> Result<Vec<CtxMarker>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        let pos: Result<i64, _> = conn.query_row(
            "SELECT last_position FROM file_positions WHERE file_path = ?",
            [file_path],
            |row| row.get(0),
        );
        Ok(pos.unwrap_or(0))
    }

    /// Update file position after reading
    pub fn set_file_position(&self, file_path: &str, position: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO file_positions (file_path, last_position, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)",
            params![file_path, position],
        )?;
        Ok(())
    }

    /// Get count of markers by status
    pub fn get_counts(&self) -> Result<(i32, i32, i32)> {
        let conn = self.conn.lock().unwrap();
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
        let mut conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM ctx_markers", [])?;
        conn.execute("DELETE FROM file_positions", [])?;
        // We do not delete system_state (Yjs doc) on clear_all unless explicitly requested, 
        // as that destroys user notes. 
        // If we want to support clearing notes, we should add a separate method.
        Ok(())
    }

    /// Get serialized Yjs state
    pub fn get_system_state(&self, key: &str) -> Result<Option<Vec<u8>>> {
        let conn = self.conn.lock().unwrap();
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
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO system_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)",
            params![key, value],
        )?;
        Ok(())
    }
}
