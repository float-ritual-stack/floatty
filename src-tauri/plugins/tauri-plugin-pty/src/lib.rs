use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc::{self, TryRecvError},
        Arc, Condvar, Mutex as StdMutex,
    },
    thread,
    time::Duration,
};

use base64::{engine::general_purpose, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, PtyPair, PtySize};
use serde::Serialize;
use tauri::{
    async_runtime::{Mutex, RwLock},
    ipc::Channel,
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

/// Exit event sent via on_exit channel when PTY closes
#[derive(Clone, Serialize)]
pub struct PtyExitEvent {
    /// Exit code from the child process
    pub exit_code: u32,
    /// Captured output (cleaned) when capture_output=true, None otherwise
    pub output: Option<String>,
}

/// Max size for capture buffer (2MB). For long-running TUIs, we keep only the tail
/// since selection/output appears after exit alternate screen marker at the end.
const CAPTURE_BUFFER_CAP: usize = 2 * 1024 * 1024;

/// Extract selection from captured PTY output.
///
/// TV and similar pickers output escape codes for TUI, then the selection.
/// The selection appears AFTER the "Exit Alternate Screen" sequence (\x1b[?1049l).
///
/// Algorithm:
/// 1. Find the last occurrence of \x1b[?1049l (exit alternate screen marker)
/// 2. Extract content after that marker
/// 3. Strip remaining ANSI escape codes
/// 4. Trim whitespace and return
fn extract_selection(data: &[u8]) -> String {
    // Exit Alternate Screen sequence
    const MARKER: &[u8] = b"\x1b[?1049l";

    // Find last occurrence of marker (there might be multiple alternate screen entries)
    let relevant = data
        .windows(MARKER.len())
        .rposition(|w| w == MARKER)
        .map(|idx| &data[idx + MARKER.len()..])
        .unwrap_or(data);

    // Strip ANSI codes using the dedicated crate
    let clean = strip_ansi_escapes::strip(relevant);

    String::from_utf8_lossy(&clean).trim().to_string()
}

#[derive(Default)]
struct PluginState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<PtyHandler, Arc<Session>>>,
}

struct Session {
    pair: Mutex<PtyPair>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
}

type PtyHandler = u32;

#[tauri::command]
async fn spawn(
    file: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    on_data: Channel<String>,
    on_exit: Channel<PtyExitEvent>,
    capture_output: Option<bool>,
    state: tauri::State<'_, PluginState>,
) -> Result<PtyHandler, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(file);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.cwd(OsString::from(cwd));
    }
    for (k, v) in env.iter() {
        cmd.env(OsString::from(k), OsString::from(v));
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_killer = child.clone_killer();
    let handler = state.session_id.fetch_add(1, Ordering::Relaxed);

    // Create internal channels for reader -> batcher communication
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    // Separate channel for captured output (reader -> batcher owns buffer, sends on close)
    let (capture_tx, capture_rx) = mpsc::channel::<Option<String>>();

    // Shared exit code with condvar for efficient cross-thread signaling
    // None = not yet exited, Some(code) = exit code available
    let exit_state = Arc::new((StdMutex::new(None::<i32>), Condvar::new()));
    let exit_state_for_reader = Arc::clone(&exit_state);

    // WAITER THREAD: Waits for child to exit and signals via condvar
    thread::spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.exit_code() as i32,
            Err(e) => {
                eprintln!("[PTY Waiter] Wait error: {}", e);
                -1 // Indicate error
            }
        };
        let (lock, cvar) = &*exit_state;
        let mut exit_code = lock.lock().unwrap();
        *exit_code = Some(code);
        cvar.notify_all();
    });

    // READER THREAD: Reads from PTY and pushes to internal channel
    // Notifies on_exit when PTY closes (EOF or error)
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF - shell exited
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // Channel closed
                    }
                }
                Err(e) => {
                    eprintln!("[PTY Reader] Read error: {}", e);
                    break;
                }
            }
        }
        // Drop tx to signal batcher that no more data is coming
        // This unblocks batcher's rx.recv() so it can send captured output
        drop(tx);

        // Wait for batcher to send captured output (if capturing)
        let captured = capture_rx.recv().unwrap_or(None);

        // Wait for exit code from waiter thread using condvar (no busy-wait)
        let (lock, cvar) = &*exit_state_for_reader;
        let code = {
            let guard = lock.lock().unwrap();
            // Wait up to 2s for exit code (should be near-instant after EOF)
            let (guard, timeout_result) = cvar
                .wait_timeout_while(guard, Duration::from_secs(2), |exit_code| {
                    exit_code.is_none()
                })
                .unwrap();

            if timeout_result.timed_out() {
                eprintln!("[PTY Reader] Exit code timeout - assuming 0");
                0u32
            } else {
                guard.map(|c| if c < 0 { 0 } else { c as u32 }).unwrap_or(0)
            }
        };

        // PTY closed - notify frontend with exit event
        let exit_event = PtyExitEvent {
            exit_code: code,
            output: captured,
        };
        if let Err(e) = on_exit.send(exit_event) {
            eprintln!("[PTY Reader] Failed to send exit notification: {}", e);
        }
    });

    // BATCHER THREAD: Greedy slurp pattern - collects data and sends via IPC Channel
    // Also accumulates output buffer when capture_output=true
    thread::spawn(move || {
        let mut pending_data: Vec<u8> = Vec::with_capacity(65536);
        // Output capture buffer (only used when capture_output=true)
        let mut capture_buffer: Option<Vec<u8>> = if capture_output.unwrap_or(false) {
            Some(Vec::with_capacity(65536))
        } else {
            None
        };

        loop {
            // 1. Blocking wait for first chunk (0 CPU when idle)
            let first_chunk = match rx.recv() {
                Ok(d) => d,
                Err(_) => break, // All senders disconnected
            };

            // Append to capture buffer if capturing (with size cap)
            if let Some(ref mut buf) = capture_buffer {
                buf.extend_from_slice(&first_chunk);
                // Cap buffer size - keep tail since selection appears at end
                if buf.len() > CAPTURE_BUFFER_CAP {
                    let drain_to = buf.len() - CAPTURE_BUFFER_CAP;
                    buf.drain(..drain_to);
                }
            }
            pending_data.extend_from_slice(&first_chunk);

            // 2. Greedy non-blocking slurp - grab everything queued
            loop {
                match rx.try_recv() {
                    Ok(more_data) => {
                        // Append to capture buffer if capturing (with size cap)
                        if let Some(ref mut buf) = capture_buffer {
                            buf.extend_from_slice(&more_data);
                            if buf.len() > CAPTURE_BUFFER_CAP {
                                let drain_to = buf.len() - CAPTURE_BUFFER_CAP;
                                buf.drain(..drain_to);
                            }
                        }
                        pending_data.extend_from_slice(&more_data);
                        // Safety cap: send if buffer > 64KB to prevent lag
                        if pending_data.len() > 65536 {
                            break;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => break,
                }
            }

            // 3. Send via IPC Channel (base64 encoded for efficiency)
            if !pending_data.is_empty() {
                let payload = general_purpose::STANDARD.encode(&pending_data);
                if on_data.send(payload).is_err() {
                    break; // Frontend disconnected
                }
                pending_data.clear();
                // Shrink buffer if it got too large (memory optimization)
                if pending_data.capacity() > 1024 * 1024 {
                    pending_data.shrink_to(65536);
                }
            }
        }

        // Extract selection from capture buffer and send to reader thread
        let extracted = capture_buffer.map(|buf| extract_selection(&buf));
        let _ = capture_tx.send(extracted);
    });

    let session = Arc::new(Session {
        pair: Mutex::new(pair),
        child_killer: Mutex::new(child_killer),
        writer: Mutex::new(writer),
    });
    state.sessions.write().await.insert(handler, session);
    Ok(handler)
}

#[tauri::command]
async fn write(
    pid: PtyHandler,
    data: String,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    session
        .writer
        .lock()
        .await
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn resize(
    pid: PtyHandler,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    session
        .pair
        .lock()
        .await
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn kill(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    session
        .child_killer
        .lock()
        .await
        .kill()
        .map_err(|e| e.to_string())?;
    // Clean up session from map to prevent memory leak
    state.sessions.write().await.remove(&pid);
    Ok(())
}

#[tauri::command]
async fn dispose(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<(), String> {
    // Remove session from map without killing (for already-exited PTYs)
    state.sessions.write().await.remove(&pid);
    Ok(())
}

/// Deprecated: Exit status is now delivered via the on_exit channel event.
/// This command is kept for API compatibility but will return an error.
#[tauri::command]
async fn exitstatus(_pid: PtyHandler, _state: tauri::State<'_, PluginState>) -> Result<u32, String> {
    Err("exitstatus command is deprecated: exit code is now delivered via the on_exit channel event".to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("pty")
        .invoke_handler(tauri::generate_handler![
            spawn, write, resize, kill, dispose, exitstatus
        ])
        .setup(|app_handle, _api| {
            app_handle.manage(PluginState::default());
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_selection_with_marker() {
        // Simulates TV outputting garbage, then exiting alternate screen, then selection
        let data = b"garbage\x1b[?1049l/path/to/file.txt\n";
        assert_eq!(extract_selection(data), "/path/to/file.txt");
    }

    #[test]
    fn test_extract_selection_strips_ansi() {
        // Selection wrapped in ANSI color codes after exit marker
        let data = b"\x1b[?1049l\x1b[32m/path/file.txt\x1b[0m\n";
        assert_eq!(extract_selection(data), "/path/file.txt");
    }

    #[test]
    fn test_extract_selection_no_marker() {
        // No exit alternate screen marker - should fall back to using entire buffer
        let data = b"/fallback/path.txt\n";
        assert_eq!(extract_selection(data), "/fallback/path.txt");
    }

    #[test]
    fn test_extract_selection_empty() {
        // Just the marker, nothing after
        let data = b"\x1b[?1049l";
        assert_eq!(extract_selection(data), "");
    }

    #[test]
    fn test_extract_selection_empty_input() {
        // Completely empty input
        let data = b"";
        assert_eq!(extract_selection(data), "");
    }

    #[test]
    fn test_extract_selection_complex_path() {
        // Path with spaces and special characters
        let data = b"\x1b[?1049l/Users/test/My Documents/file (1).txt\n";
        assert_eq!(extract_selection(data), "/Users/test/My Documents/file (1).txt");
    }

    #[test]
    fn test_extract_selection_multiple_markers() {
        // Multiple alternate screen enter/exits (nested TUI applications)
        // Should use LAST marker
        let data = b"\x1b[?1049l/wrong/path\n\x1b[?1049h...\x1b[?1049l/correct/path.txt\n";
        assert_eq!(extract_selection(data), "/correct/path.txt");
    }

    #[test]
    fn test_extract_selection_with_cursor_sequences() {
        // Common cursor movement sequences after the marker
        let data = b"\x1b[?1049l\x1b[H\x1b[2J\x1b[?25h/path/with/cursors.txt\n";
        assert_eq!(extract_selection(data), "/path/with/cursors.txt");
    }

    #[test]
    fn test_extract_selection_multiline_output() {
        // Multiple lines after marker - takes full trimmed content
        let data = b"\x1b[?1049l\n\n/path/to/file.txt\n\n";
        assert_eq!(extract_selection(data), "/path/to/file.txt");
    }
}
