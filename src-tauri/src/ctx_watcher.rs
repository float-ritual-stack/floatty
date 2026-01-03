use crate::db::{CtxDatabase, JsonlMetadata};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Configuration for the JSONL watcher
#[derive(Clone)]
pub struct WatcherConfig {
    pub watch_path: PathBuf,
    pub poll_interval_ms: u64,
    pub max_age_hours: u64,  // Only process files modified within this window
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
            max_age_hours: 72,  // Default: last 3 days
        }
    }
}

/// JSONL file watcher for ctx:: markers
pub struct CtxWatcher {
    config: WatcherConfig,
    db: Arc<CtxDatabase>,
    file_positions: Arc<Mutex<HashMap<PathBuf, u64>>>,
    running: Arc<Mutex<bool>>,
    /// Handle to the watcher thread, joined on Drop
    thread_handle: Mutex<Option<thread::JoinHandle<()>>>,
}

impl CtxWatcher {
    pub fn new(db: Arc<CtxDatabase>, config: WatcherConfig) -> Self {
        Self {
            config,
            db,
            file_positions: Arc::new(Mutex::new(HashMap::new())),
            running: Arc::new(Mutex::new(false)),
            thread_handle: Mutex::new(None),
        }
    }

    /// Start the watcher in a background thread
    pub fn start(&self) {
        let db = Arc::clone(&self.db);
        let config = self.config.clone();
        let file_positions = Arc::clone(&self.file_positions);
        let running = Arc::clone(&self.running);

        // Mark as running (tolerant of poison from other threads)
        *running.lock().unwrap_or_else(|e| e.into_inner()) = true;

        let handle = thread::spawn(move || {
            log::info!("Starting ctx:: watcher on {:?} (max age: {} hours)",
                       config.watch_path, config.max_age_hours);

            // Initial scan of existing files (only recent ones)
            if let Err(e) = scan_directory(&config.watch_path, &db, &file_positions, config.max_age_hours) {
                log::error!("Initial scan failed: {}", e);
            }

            // Set up file watcher
            let (tx, rx) = mpsc::channel();
            let mut watcher: RecommendedWatcher = match Watcher::new(
                move |res: Result<Event, notify::Error>| {
                    match res {
                        Ok(event) => {
                            if let Err(e) = tx.send(event) {
                                log::error!("File watcher channel disconnected: {}", e);
                            }
                        }
                        Err(e) => {
                            log::error!("File watcher error: {:?}", e);
                        }
                    }
                },
                notify::Config::default().with_poll_interval(Duration::from_millis(config.poll_interval_ms)),
            ) {
                Ok(w) => w,
                Err(e) => {
                    log::error!("Failed to create watcher: {}", e);
                    return;
                }
            };

            // Start watching
            if let Err(e) = watcher.watch(&config.watch_path, RecursiveMode::Recursive) {
                log::error!("Failed to watch directory: {}", e);
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
                            if path.extension().map_or(false, |ext| ext == "jsonl") {
                                if let Err(e) = process_file(&path, &db, &file_positions) {
                                    log::error!("Failed to process {:?}: {}", path, e);
                                }
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }

            log::info!("ctx:: watcher stopped");
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
        if let Some(handle) = self.thread_handle.lock().unwrap_or_else(|e| e.into_inner()).take() {
            log::info!("[CtxWatcher] Joining watcher thread on drop...");
            if handle.join().is_err() {
                log::warn!("[CtxWatcher] Watcher thread panicked during join");
            }
        }
    }
}

/// Scan directory for all JSONL files modified within max_age_hours
fn scan_directory(
    dir: &Path,
    db: &Arc<CtxDatabase>,
    file_positions: &Arc<Mutex<HashMap<PathBuf, u64>>>,
    max_age_hours: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    if !dir.exists() {
        log::error!("Watch directory does not exist: {:?}", dir);
        log::error!("Check 'watch_path' in ~/.floatty/config.toml");
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
        if path.extension().map_or(false, |ext| ext == "jsonl") {
            // Check file modification time
            if let Ok(metadata) = path.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if modified < cutoff {
                        skipped += 1;
                        continue;  // Skip old files
                    }
                }
            }
            process_file(path, db, file_positions)?;
            processed += 1;
        }
    }

    log::info!("Scanned {} recent files, skipped {} old files (>{} hours)",
               processed, skipped, max_age_hours);

    Ok(())
}

/// Process a single JSONL file for ctx:: markers
fn process_file(
    path: &Path,
    db: &Arc<CtxDatabase>,
    file_positions: &Arc<Mutex<HashMap<PathBuf, u64>>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let path_str = path.to_string_lossy().to_string();

    // Get last known position
    let last_pos = {
        let positions = file_positions.lock().unwrap_or_else(|e| e.into_inner());
        positions.get(path).copied().unwrap_or_else(|| {
            db.get_file_position(&path_str).unwrap_or(0) as u64
        })
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

    // Read new lines and collect markers
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
    }

    // Insert all markers and update position atomically
    if !markers_to_insert.is_empty() || current_pos != last_pos {
        let new_markers = db.insert_markers_with_position(
            &path_str,
            &markers_to_insert,
            current_pos as i64,
        )?;

        // Only update in-memory position AFTER database commit succeeds
        {
            let mut positions = file_positions.lock().unwrap_or_else(|e| e.into_inner());
            positions.insert(path.to_path_buf(), current_pos);
        }

        if new_markers > 0 {
            log::info!("Found {} new ctx:: markers in {:?}", new_markers, path);
        }
    }

    Ok(())
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
        sort_key: json.get("timestamp")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        cwd: json.get("cwd")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        git_branch: json.get("gitBranch")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        session_id: json.get("sessionId")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
        msg_type: json.get("type")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string()),
    };

    // Extract text content from various JSONL structures
    let content = json.get("message")
        .and_then(|m| m.get("content"))
        .or_else(|| json.get("content"));

    let text = match content? {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => {
            arr.iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        }
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
        let boundary = text.char_indices()
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
