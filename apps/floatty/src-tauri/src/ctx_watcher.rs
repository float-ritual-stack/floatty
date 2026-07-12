use crate::db::{FileEventInsert, FloattyDb, JsonlMetadata};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Tauri event emitted when new agent file-writes land (FLO-799).
/// The frontend re-fetches rather than trusting a pushed payload.
pub const RECENT_FILES_CHANGED_EVENT: &str = "recent-files-changed";

/// Tools whose `input.file_path` counts as "the agent wrote this file".
const WRITE_TOOLS: [&str; 3] = ["Write", "Edit", "MultiEdit"];

/// Extensions we surface. Scoped to prose on purpose — the feature answers
/// "what did the agent write that I might want to read", not "what code changed"
/// (git already answers that one).
const PROSE_EXTENSIONS: [&str; 3] = ["md", "markdown", "txt"];

/// Provenance snippet cap.
const SNIPPET_MAX_CHARS: usize = 200;

/// Shared slot for the Tauri handle.
///
/// The watcher is constructed and started during `run()`, *before* the Tauri
/// app (and therefore any `AppHandle`) exists. Rather than reorder startup, the
/// handle is installed later from `.setup()` and read lazily on each emit.
/// `None` — during the initial scan, or in tests — simply means no push; the
/// sidebar still fetches on mount and on focus.
type SharedAppHandle = Arc<Mutex<Option<AppHandle>>>;

/// Push `recent-files-changed` if a handle has been installed.
///
/// Fire-and-forget: the rows are already committed, so a failed emit is a
/// missed refresh, not a lost write.
fn emit_recent_files_changed(app_handle: &SharedAppHandle, count: usize) {
    let handle = app_handle.lock().unwrap_or_else(|e| e.into_inner()).clone();

    if let Some(handle) = handle {
        if let Err(e) = handle.emit(RECENT_FILES_CHANGED_EVENT, count) {
            tracing::warn!("Failed to emit {}: {}", RECENT_FILES_CHANGED_EVENT, e);
        }
    }
}

/// Configuration for the JSONL watcher
#[derive(Clone)]
pub struct WatcherConfig {
    pub watch_path: PathBuf,
    pub poll_interval_ms: u64,
    pub max_age_hours: u64, // Only process files modified within this window
}

impl Default for WatcherConfig {
    fn default() -> Self {
        let watch_path = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".claude")
            .join("projects");

        Self {
            watch_path,
            poll_interval_ms: 5000,
            max_age_hours: 72, // Default: last 3 days
        }
    }
}

/// JSONL file watcher for ctx:: markers and agent file-writes.
///
/// One watcher, one incremental byte-offset pass per file. The ctx:: extractor
/// and the file-write extractor (FLO-799) both feed off that single pass — a
/// second watcher would double the IO for no benefit.
pub struct CtxWatcher {
    config: WatcherConfig,
    db: Arc<FloattyDb>,
    file_positions: Arc<Mutex<HashMap<PathBuf, u64>>>,
    running: Arc<Mutex<bool>>,
    /// Handle to the watcher thread, joined on Drop
    thread_handle: Mutex<Option<thread::JoinHandle<()>>>,
    /// Emits `recent-files-changed` when new file events land (FLO-799).
    /// Installed after startup via `set_app_handle`; see `SharedAppHandle`.
    app_handle: SharedAppHandle,
}

impl CtxWatcher {
    pub fn new(db: Arc<FloattyDb>, config: WatcherConfig) -> Self {
        Self {
            config,
            db,
            file_positions: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(Mutex::new(false)),
            thread_handle: Mutex::new(None),
            app_handle: Arc::new(Mutex::new(None)),
        }
    }

    /// Install the Tauri handle so the watcher can push `recent-files-changed`.
    ///
    /// Called from `.setup()`, i.e. after `start()`. The already-running watcher
    /// thread picks it up on its next emit.
    pub fn set_app_handle(&self, app_handle: AppHandle) {
        *self.app_handle.lock().unwrap_or_else(|e| e.into_inner()) = Some(app_handle);
    }

    /// Start the watcher in a background thread
    pub fn start(&self) {
        let db = Arc::clone(&self.db);
        let config = self.config.clone();
        let file_positions = Arc::clone(&self.file_positions);
        let running = Arc::clone(&self.running);
        let app_handle = Arc::clone(&self.app_handle);

        // Mark as running (tolerant of poison from other threads)
        *running.lock().unwrap_or_else(|e| e.into_inner()) = true;

        let handle = thread::spawn(move || {
            tracing::info!(
                "Starting ctx:: watcher on {:?} (max age: {} hours)",
                config.watch_path,
                config.max_age_hours
            );

            // Initial scan of existing files (only recent ones)
            if let Err(e) = scan_directory(
                &config.watch_path,
                &db,
                &file_positions,
                config.max_age_hours,
                &app_handle,
            ) {
                tracing::error!("Initial scan failed: {}", e);
            }

            // Set up file watcher
            let (tx, rx) = mpsc::channel();
            let mut watcher: RecommendedWatcher = match Watcher::new(
                move |res: Result<Event, notify::Error>| match res {
                    Ok(event) => {
                        if let Err(e) = tx.send(event) {
                            tracing::error!("File watcher channel disconnected: {}", e);
                        }
                    }
                    Err(e) => {
                        tracing::error!("File watcher error: {:?}", e);
                    }
                },
                notify::Config::default()
                    .with_poll_interval(Duration::from_millis(config.poll_interval_ms)),
            ) {
                Ok(w) => w,
                Err(e) => {
                    tracing::error!("Failed to create watcher: {}", e);
                    return;
                }
            };

            // Start watching
            if let Err(e) = watcher.watch(&config.watch_path, RecursiveMode::Recursive) {
                tracing::error!("Failed to watch directory: {}", e);
                return;
            }

            // Process events
            loop {
                if !*running.lock().unwrap_or_else(|e| e.into_inner()) {
                    break;
                }

                match rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(event) => {
                        for path in event.paths {
                            if path.extension().is_some_and(|ext| ext == "jsonl") {
                                if let Err(e) =
                                    process_file(&path, &db, &file_positions, &app_handle)
                                {
                                    tracing::error!("Failed to process {:?}: {}", path, e);
                                }
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }

            tracing::info!("ctx:: watcher stopped");
        });

        // Store handle for join on Drop
        *self.thread_handle.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    /// Stop the watcher
    #[allow(dead_code)]
    pub fn stop(&self) {
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}

impl Drop for CtxWatcher {
    fn drop(&mut self) {
        // Signal thread to stop
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = false;

        // Join the thread if it's running (thread checks running flag every ~1 second)
        if let Some(handle) = self
            .thread_handle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            tracing::info!("[CtxWatcher] Joining watcher thread on drop...");
            if handle.join().is_err() {
                tracing::warn!("[CtxWatcher] Watcher thread panicked during join");
            }
        }
    }
}

/// Scan directory for all JSONL files modified within max_age_hours
fn scan_directory(
    dir: &Path,
    db: &Arc<FloattyDb>,
    file_positions: &Arc<Mutex<HashMap<PathBuf, u64>>>,
    max_age_hours: u64,
    app_handle: &SharedAppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    if !dir.exists() {
        tracing::error!("Watch directory does not exist: {:?}", dir);
        tracing::error!("Check 'watch_path' in ~/.floatty/config.toml");
        return Err(format!("Watch directory {:?} does not exist", dir).into());
    }

    let cutoff = std::time::SystemTime::now()
        .checked_sub(Duration::from_secs(max_age_hours * 3600))
        .unwrap_or(std::time::UNIX_EPOCH);

    let mut processed = 0;
    let mut skipped = 0;

    for entry in walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "jsonl") {
            // Check file modification time
            if let Ok(metadata) = path.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if modified < cutoff {
                        skipped += 1;
                        continue; // Skip old files
                    }
                }
            }
            process_file(path, db, file_positions, app_handle)?;
            processed += 1;
        }
    }

    tracing::info!(
        "Scanned {} recent files, skipped {} old files (>{} hours)",
        processed,
        skipped,
        max_age_hours
    );

    Ok(())
}

/// Process a single JSONL file for ctx:: markers and agent file-writes.
///
/// One pass, two extractors. Each line gets cheap substring prescreens before
/// any `serde_json` parse — a line that is neither a ctx:: marker, a file-write
/// tool_use, nor narration is never deserialized, which is what keeps this on
/// the same throughput budget as the ctx:: pass it grew out of.
fn process_file(
    path: &Path,
    db: &Arc<FloattyDb>,
    file_positions: &Arc<Mutex<HashMap<PathBuf, u64>>>,
    app_handle: &SharedAppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    let path_str = path.to_string_lossy().to_string();

    // Get last known position
    let last_pos = {
        let positions = file_positions.lock().unwrap_or_else(|e| e.into_inner());
        positions
            .get(path)
            .copied()
            .unwrap_or_else(|| db.get_file_position(&path_str).unwrap_or(0) as u64)
    };

    // Open file and seek to last position
    let file = File::open(path)?;
    let file_len = file.metadata()?.len();

    // If file hasn't grown, skip
    if file_len <= last_pos {
        return Ok(());
    }

    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::Start(last_pos))?;

    let mut current_pos = last_pos;
    let mut markers_to_insert: Vec<(String, String, crate::db::JsonlMetadata)> = Vec::new();
    let mut file_events_to_insert: Vec<FileEventInsert> = Vec::new();

    // Rolling provenance. Claude Code never puts a text block and a tool_use
    // block in the same message, so the narration explaining a write always
    // lives on an *earlier* line. We carry the most recent one forward.
    //
    // Known edge: when an incremental tail begins mid-turn (the narration line
    // was consumed by a previous pass), the first write in the chunk gets no
    // snippet. Cheap to live with; the alternative is persisting per-file
    // narration state across passes for a field that is decoration, not data.
    let mut last_narration: Option<String> = None;

    // Read new lines and collect markers + file events
    for line in reader.lines() {
        let line = line?;
        current_pos += line.len() as u64 + 1; // +1 for newline

        // Look for ctx:: in the line
        if line.contains("ctx::") {
            // Extract the content blob + JSONL metadata
            if let Some((content, metadata)) = extract_ctx_content(&line) {
                // Generate deterministic ID from the content
                let id = generate_marker_id(path, &content);
                markers_to_insert.push((id, content, metadata));
            }
        }

        // FLO-799: agent file-writes. A line is virtually never both a ctx::
        // marker and a tool_use, so these two branches don't double-parse in
        // practice.
        let events = extract_file_events(&line, last_narration.as_deref());
        if events.is_empty() {
            // Not a write — it may be the narration that explains the next one.
            if let Some(text) = extract_narration(&line) {
                last_narration = Some(text);
            }
        } else {
            file_events_to_insert.extend(events);
        }
    }

    // Insert markers + file events and update position atomically
    if !markers_to_insert.is_empty() || !file_events_to_insert.is_empty() || current_pos != last_pos
    {
        let inserted = db.insert_scan_with_position(
            &path_str,
            &markers_to_insert,
            &file_events_to_insert,
            current_pos as i64,
        )?;

        // Only update in-memory position AFTER database commit succeeds
        {
            let mut positions = file_positions.lock().unwrap_or_else(|e| e.into_inner());
            positions.insert(path.to_path_buf(), current_pos);
        }

        if inserted.markers > 0 {
            tracing::info!("Found {} new ctx:: markers in {:?}", inserted.markers, path);
        }

        if inserted.file_events > 0 {
            tracing::info!(
                "Found {} new agent file-writes in {:?}",
                inserted.file_events,
                path
            );

            emit_recent_files_changed(app_handle, inserted.file_events);
        }
    }

    Ok(())
}

/// True when `path` names a prose file we want to surface.
fn is_prose_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| PROSE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Truncate to `SNIPPET_MAX_CHARS` on a UTF-8 char boundary.
fn truncate_snippet(text: &str) -> String {
    let trimmed = text.trim();
    match trimmed.char_indices().nth(SNIPPET_MAX_CHARS) {
        None => trimmed.to_string(),
        Some((byte_idx, _)) => format!("{}…", &trimmed[..byte_idx]),
    }
}

/// Extract every agent file-write from one JSONL line.
///
/// A single assistant message can carry several `tool_use` blocks, so this
/// returns a Vec. Non-write tools, non-prose paths, and malformed lines all
/// yield an empty Vec rather than an error — a corrupt line must not stall the
/// byte offset for the rest of the file.
fn extract_file_events(jsonl_line: &str, snippet: Option<&str>) -> Vec<FileEventInsert> {
    // Cheap prescreen before the parse.
    if !jsonl_line.contains("\"tool_use\"") || !jsonl_line.contains("\"file_path\"") {
        return Vec::new();
    }

    let Ok(json) = serde_json::from_str::<serde_json::Value>(jsonl_line) else {
        return Vec::new(); // Malformed line — skip, don't stall the scan.
    };

    let str_field = |key: &str| -> Option<String> {
        json.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    let event_time = str_field("timestamp");
    let cwd = str_field("cwd");
    let git_branch = str_field("gitBranch");
    let session_id = str_field("sessionId");

    let Some(blocks) = json
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    else {
        return Vec::new();
    };

    blocks
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        .filter_map(|block| {
            let tool_name = block.get("name")?.as_str()?;
            if !WRITE_TOOLS.contains(&tool_name) {
                return None;
            }

            let file_path = block.get("input")?.get("file_path")?.as_str()?;
            if !is_prose_file(file_path) {
                return None;
            }

            // The Anthropic tool_use id is stable across re-scans of the same
            // JSONL, which is exactly what makes INSERT OR IGNORE idempotent.
            let tool_use_id = block.get("id")?.as_str()?;

            Some(FileEventInsert {
                id: format!("file-{}", tool_use_id),
                file_path: file_path.to_string(),
                tool_name: tool_name.to_string(),
                session_id: session_id.clone(),
                cwd: cwd.clone(),
                git_branch: git_branch.clone(),
                snippet: snippet.map(str::to_string),
                event_time: event_time.clone(),
            })
        })
        .collect()
}

/// Pull user/assistant prose out of a line, for use as write provenance.
///
/// Returns None for anything that isn't a top-level text block — thinking
/// blocks, tool_use blocks, and tool_result payloads all decline.
fn extract_narration(jsonl_line: &str) -> Option<String> {
    // Prescreens before the parse. The tool_result guard matters: those
    // payloads carry whole file contents and can run to megabytes — parsing
    // one just to discover it holds no narration is the expensive mistake.
    if !jsonl_line.contains("\"type\":\"text\"") || jsonl_line.contains("\"tool_result\"") {
        return None;
    }

    let json = serde_json::from_str::<serde_json::Value>(jsonl_line).ok()?;

    let text = json
        .get("message")?
        .get("content")?
        .as_array()?
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");

    if text.trim().is_empty() {
        return None;
    }

    Some(truncate_snippet(&text))
}

/// Extract content with ctx:: marker from a JSONL record
/// Returns (content_text, metadata) - metadata from JSONL fields
fn extract_ctx_content(jsonl_line: &str) -> Option<(String, JsonlMetadata)> {
    // Quick check before parsing
    if !jsonl_line.contains("ctx::") {
        return None;
    }

    // Parse as JSON
    let json: serde_json::Value = serde_json::from_str(jsonl_line).ok()?;

    // Extract all JSONL metadata
    let metadata = JsonlMetadata {
        sort_key: json
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        cwd: json
            .get("cwd")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        git_branch: json
            .get("gitBranch")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        session_id: json
            .get("sessionId")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        msg_type: json
            .get("type")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
    };

    // Extract text content from various JSONL structures
    let content = json
        .get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| json.get("content"));

    let text = match content? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };

    // Check that there's an actual ctx:: marker line (not just mention of ctx::)
    let has_marker = text.lines().any(|line| {
        let t = line.trim();
        (t.starts_with("ctx::") || t.starts_with("- ctx::")) && t.contains("@")
    });

    if !has_marker {
        return None;
    }

    // Cap content size but keep enough for context summary
    // Truncate to ~2000 chars for Ollama (enough for summary + markers)
    // Use char_indices to find safe UTF-8 boundary
    let truncated = if text.len() > 2000 {
        let boundary = text
            .char_indices()
            .take_while(|(i, _)| *i < 2000)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        format!("{}...[truncated]", &text[..boundary])
    } else {
        text
    };

    Some((truncated, metadata))
}

/// Generate a deterministic ID for a ctx:: marker
fn generate_marker_id(path: &Path, line: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.update(b":");
    hasher.update(line.as_bytes());
    let result = hasher.finalize();

    // Use first 12 chars of hex for shorter ID
    let hex_str = hex::encode(result);
    format!("ctx-{}", &hex_str[..12])
}

#[cfg(test)]
mod file_event_tests {
    use super::*;
    use std::io::Write as _;

    /// Fully synthetic session log — see .claude/rules/test-fixtures-no-pii.md.
    /// Paths are `/path/to/...`, ids are synthetic, names are `Demo *`.
    const SAMPLE_JSONL: &str = include_str!("../tests/fixtures/agent-writes-sample.jsonl");

    fn line(n: usize) -> &'static str {
        SAMPLE_JSONL.lines().nth(n).expect("fixture line exists")
    }

    // ── is_prose_file ────────────────────────────────────────────────────

    #[test]
    fn prose_extensions_are_recognized_case_insensitively() {
        assert!(is_prose_file("/path/to/notes.md"));
        assert!(is_prose_file("/path/to/notes.MD"));
        assert!(is_prose_file("/path/to/notes.markdown"));
        assert!(is_prose_file("/path/to/notes.txt"));

        assert!(!is_prose_file("/path/to/main.rs"));
        assert!(!is_prose_file("/path/to/script.sh"));
        assert!(!is_prose_file("/path/to/no_extension"));
        // ".md" as a bare dotfile name has no extension — not prose.
        assert!(!is_prose_file("/path/to/.md"));
    }

    // ── extract_file_events ──────────────────────────────────────────────

    #[test]
    fn happy_path_captures_a_write_with_full_provenance() {
        let events = extract_file_events(line(3), Some("Writing the design doc."));
        assert_eq!(events.len(), 1);

        let ev = &events[0];
        assert_eq!(ev.file_path, "/path/to/project/docs/design.md");
        assert_eq!(ev.tool_name, "Write");
        assert_eq!(ev.id, "file-toolu_00000000000000000000001");
        assert_eq!(ev.cwd.as_deref(), Some("/path/to/project"));
        assert_eq!(ev.git_branch.as_deref(), Some("feat/demo-branch"));
        assert_eq!(
            ev.session_id.as_deref(),
            Some("00000000-0000-4000-8000-000000000001")
        );
        assert_eq!(ev.event_time.as_deref(), Some("2026-07-12T10:00:11.000Z"));
        assert_eq!(ev.snippet.as_deref(), Some("Writing the design doc."));
    }

    #[test]
    fn non_write_tools_are_ignored() {
        // Read carries a .md file_path but never *wrote* anything.
        assert!(extract_file_events(line(5), None).is_empty());
        // Bash has no file_path at all.
        assert!(extract_file_events(line(7), None).is_empty());
    }

    #[test]
    fn non_prose_paths_are_filtered() {
        // A genuine Write, but to source code — git already tracks that.
        assert!(extract_file_events(line(6), None).is_empty());
    }

    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        assert!(extract_file_events(line(8), None).is_empty());
        assert!(extract_file_events("", None).is_empty());
        assert!(extract_file_events("{ not json", None).is_empty());
        // Prescreen hits, parse fails — must still degrade to empty.
        assert!(extract_file_events(r#"{"tool_use" "file_path" BROKEN"#, None).is_empty());
    }

    #[test]
    fn tool_result_echoing_a_path_is_not_a_write() {
        // Regression guard: a tool_result line contains BOTH the substring
        // "tool_use" (inside "tool_use_id") and "file_path" (echoed in the
        // result text), so it sails past the cheap prescreen. Only the parsed
        // block type can reject it — and it must.
        let raw = line(4);
        assert!(raw.contains("tool_use"), "prescreen substring present");
        assert!(raw.contains("file_path"), "prescreen substring present");
        assert!(extract_file_events(raw, None).is_empty());
    }

    #[test]
    fn one_message_can_carry_several_writes() {
        let events = extract_file_events(line(10), None);
        assert_eq!(events.len(), 2, "Edit + MultiEdit in one assistant message");
        assert_eq!(events[0].tool_name, "Edit");
        assert_eq!(events[0].file_path, "/path/to/project/docs/design.md");
        assert_eq!(events[1].tool_name, "MultiEdit");
        assert_eq!(events[1].file_path, "/path/to/project/notes/todo.txt");
    }

    // ── extract_narration ────────────────────────────────────────────────

    #[test]
    fn narration_comes_from_text_blocks_only() {
        assert_eq!(
            extract_narration(line(2)).as_deref(),
            Some("Writing the widget pipeline design doc now.")
        );
        // Thinking blocks are not narration.
        assert!(extract_narration(line(1)).is_none());
        // Neither are tool_use lines...
        assert!(extract_narration(line(3)).is_none());
        // ...nor tool_result payloads (which can run to megabytes).
        assert!(extract_narration(line(4)).is_none());
    }

    #[test]
    fn narration_is_truncated_on_a_char_boundary() {
        // Multi-byte chars must not be sliced mid-codepoint.
        let long = "é".repeat(SNIPPET_MAX_CHARS + 50);
        let truncated = truncate_snippet(&long);
        assert!(truncated.ends_with('…'));
        assert_eq!(truncated.chars().count(), SNIPPET_MAX_CHARS + 1);

        let short = truncate_snippet("  brief  ");
        assert_eq!(short, "brief", "trimmed, and no ellipsis when under cap");
    }

    // ── process_file (streaming: provenance + offsets + dedupe) ───────────

    /// Run the real streaming path over the synthetic fixture.
    fn process_fixture(contents: &str) -> (Arc<FloattyDb>, tempfile::TempDir, PathBuf) {
        let dir = tempfile::TempDir::new().expect("temp dir");
        let jsonl = dir.path().join("session.jsonl");
        let mut f = File::create(&jsonl).expect("create fixture");
        f.write_all(contents.as_bytes()).expect("write fixture");
        f.sync_all().expect("flush fixture");

        let db = Arc::new(FloattyDb::open_in_memory().expect("in-memory db"));
        let positions = Arc::new(Mutex::new(HashMap::new()));
        let no_handle: SharedAppHandle = Arc::new(Mutex::new(None));

        process_file(&jsonl, &db, &positions, &no_handle).expect("process fixture");

        (db, dir, jsonl)
    }

    #[test]
    fn full_scan_captures_only_prose_writes_and_threads_provenance() {
        let (db, _dir, _path) = process_fixture(SAMPLE_JSONL);

        let recent = db.get_recent_files(50).expect("query");
        let paths: Vec<_> = recent.iter().map(|e| e.file_path.as_str()).collect();

        // design.md (twice — collapsed), todo.txt. Never main.rs, never the
        // Read/Bash tools, and the malformed line didn't stall the scan.
        assert_eq!(
            paths,
            vec![
                "/path/to/project/notes/todo.txt",
                "/path/to/project/docs/design.md",
            ],
            "newest first, one row per path"
        );

        // design.md was Written then Edited — the Edit is what survives.
        let design = recent
            .iter()
            .find(|e| e.file_path.ends_with("design.md"))
            .expect("design.md present");
        assert_eq!(design.tool_name, "Edit");
        assert_eq!(
            design.event_time.as_deref(),
            Some("2026-07-12T10:01:10.000Z")
        );

        // Provenance threaded from the *preceding* narration line, since Claude
        // Code never puts text and tool_use in the same message.
        assert_eq!(
            design.snippet.as_deref(),
            Some("Revising the design doc and adding a scratch note.")
        );
    }

    #[test]
    fn rescanning_an_unchanged_file_is_a_no_op() {
        let (db, _dir, jsonl) = process_fixture(SAMPLE_JSONL);
        let before = db.get_recent_files(50).expect("query").len();

        // Fresh position map = the cold-start path (offset comes from SQLite).
        let positions = Arc::new(Mutex::new(HashMap::new()));
        let no_handle: SharedAppHandle = Arc::new(Mutex::new(None));
        process_file(&jsonl, &db, &positions, &no_handle).expect("re-process");

        assert_eq!(
            db.get_recent_files(50).expect("query").len(),
            before,
            "byte offset resumed; no duplicate rows"
        );
    }

    #[test]
    fn appended_lines_are_picked_up_incrementally() {
        let (db, dir, jsonl) = process_fixture(SAMPLE_JSONL);
        let positions = Arc::new(Mutex::new(HashMap::new()));
        let no_handle: SharedAppHandle = Arc::new(Mutex::new(None));

        // Simulate the agent writing one more file into a live session.
        // r##..##: the JSON payload contains `"#`, which would close an r#"..."# literal.
        let appended = r##"{"type":"assistant","timestamp":"2026-07-12T11:00:00.000Z","cwd":"/path/to/project","sessionId":"00000000-0000-4000-8000-000000000001","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_00000000000000000000007","name":"Write","input":{"file_path":"/path/to/project/docs/later.md","content":"# Later"}}]}}"##;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&jsonl)
            .expect("reopen fixture");
        writeln!(f, "{}", appended).expect("append");
        f.sync_all().expect("flush");

        process_file(&jsonl, &db, &positions, &no_handle).expect("incremental scan");

        let recent = db.get_recent_files(50).expect("query");
        assert_eq!(
            recent.first().map(|e| e.file_path.as_str()),
            Some("/path/to/project/docs/later.md"),
            "newest write surfaces at the top"
        );
        assert_eq!(recent.len(), 3, "the two earlier files are still there");

        drop(dir);
    }
}
