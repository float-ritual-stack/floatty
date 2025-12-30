use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::Read,
    sync::{
        atomic::{AtomicU32, Ordering},
        mpsc::{self, TryRecvError},
        Arc, Mutex as StdMutex,
    },
    thread,
};

use base64::{engine::general_purpose, Engine as _};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, PtyPair, PtySize};
use tauri::{
    async_runtime::{Mutex, RwLock},
    ipc::Channel,
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[derive(Default)]
struct PluginState {
    session_id: AtomicU32,
    sessions: RwLock<BTreeMap<PtyHandler, Arc<Session>>>,
}

struct Session {
    pair: Mutex<PtyPair>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn std::io::Write + Send>>,
}

type PtyHandler = u32;

/// Extract selection from captured PTY output.
///
/// TV and other TUI pickers output their selection AFTER exiting alternate screen mode.
/// The alternate screen exit sequence is `\x1b[?1049l`.
///
/// Algorithm:
/// 1. Find the last occurrence of the exit-alternate-screen marker
/// 2. Extract everything after it
/// 3. Strip remaining ANSI escape codes
/// 4. Trim whitespace
fn extract_selection(data: &[u8]) -> String {
    // Exit Alternate Screen marker (DEC Private Mode Reset)
    const MARKER: &[u8] = b"\x1b[?1049l";

    // Find content after last marker occurrence
    let relevant = data
        .windows(MARKER.len())
        .rposition(|w| w == MARKER)
        .map(|idx| &data[idx + MARKER.len()..])
        .unwrap_or(data);

    // Strip ANSI codes using the strip-ansi-escapes crate
    let clean = strip_ansi_escapes::strip(relevant).unwrap_or_else(|_| relevant.to_vec());

    String::from_utf8_lossy(&clean).trim().to_string()
}

#[tauri::command]
async fn spawn(
    file: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    on_data: Channel<String>,
    on_exit: Channel<u32>,
    // Optional: capture all output and return extracted selection on exit
    capture_output: Option<bool>,
    on_capture: Option<Channel<String>>,
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
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let child_killer = child.clone_killer();
    let handler = state.session_id.fetch_add(1, Ordering::Relaxed);

    // Create internal channel for reader -> batcher communication
    let (tx, rx) = mpsc::channel::<Vec<u8>>();

    // Optional capture buffer (shared between batcher and reader threads)
    let should_capture = capture_output.unwrap_or(false) && on_capture.is_some();
    let capture_buffer: Option<Arc<StdMutex<Vec<u8>>>> = if should_capture {
        Some(Arc::new(StdMutex::new(Vec::with_capacity(65536))))
    } else {
        None
    };
    let capture_buffer_for_exit = capture_buffer.clone();

    // READER THREAD: Reads from PTY and pushes to internal channel
    // Notifies on_exit when PTY closes (EOF or error)
    // Also extracts selection and sends via on_capture if capturing
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

        // PTY closed - extract and send captured output if applicable
        if let Some(ref capture_buf) = capture_buffer_for_exit {
            if let Some(ref capture_channel) = on_capture {
                let data = capture_buf.lock().unwrap();
                let selection = extract_selection(&data);
                if let Err(e) = capture_channel.send(selection) {
                    eprintln!("[PTY Reader] Failed to send captured output: {}", e);
                }
            }
        }

        // Notify frontend of exit
        if let Err(e) = on_exit.send(0) {
            eprintln!("[PTY Reader] Failed to send exit notification: {}", e);
        }
    });

    // BATCHER THREAD: Greedy slurp pattern - collects data and sends via IPC Channel
    // Also accumulates to capture buffer if capturing is enabled
    thread::spawn(move || {
        let mut pending_data: Vec<u8> = Vec::with_capacity(65536);

        loop {
            // 1. Blocking wait for first chunk (0 CPU when idle)
            let first_chunk = match rx.recv() {
                Ok(d) => d,
                Err(_) => break, // All senders disconnected
            };
            pending_data.extend_from_slice(&first_chunk);

            // 2. Greedy non-blocking slurp - grab everything queued
            loop {
                match rx.try_recv() {
                    Ok(more_data) => {
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

                // 4. Accumulate to capture buffer if enabled
                if let Some(ref buf) = capture_buffer {
                    let mut capture = buf.lock().unwrap();
                    capture.extend_from_slice(&pending_data);
                    // Cap capture buffer at 2MB to prevent memory explosion
                    // (picker output shouldn't be this large anyway)
                    if capture.len() > 2 * 1024 * 1024 {
                        capture.drain(..capture.len() - 1024 * 1024);
                    }
                }

                pending_data.clear();
                // Shrink buffer if it got too large (memory optimization)
                if pending_data.capacity() > 1024 * 1024 {
                    pending_data.shrink_to(65536);
                }
            }
        }
    });

    let session = Arc::new(Session {
        pair: Mutex::new(pair),
        child: Mutex::new(child),
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

#[tauri::command]
async fn exitstatus(pid: PtyHandler, state: tauri::State<'_, PluginState>) -> Result<u32, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&pid)
        .ok_or("Unavailable pid")?
        .clone();
    let exitstatus = session
        .child
        .lock()
        .await
        .wait()
        .map_err(|e| e.to_string())?
        .exit_code();
    Ok(exitstatus)
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
    fn extracts_after_marker() {
        let data = b"garbage\x1b[?1049l/path/to/file.txt\n";
        assert_eq!(extract_selection(data), "/path/to/file.txt");
    }

    #[test]
    fn strips_ansi_codes() {
        // Color codes around the path
        let data = b"\x1b[?1049l\x1b[32m/path/file.txt\x1b[0m\n";
        assert_eq!(extract_selection(data), "/path/file.txt");
    }

    #[test]
    fn handles_no_marker() {
        // Fallback: return cleaned content even without marker
        let data = b"/fallback/path.txt\n";
        assert_eq!(extract_selection(data), "/fallback/path.txt");
    }

    #[test]
    fn handles_empty_after_marker() {
        let data = b"\x1b[?1049l";
        assert_eq!(extract_selection(data), "");
    }

    #[test]
    fn handles_multiple_markers() {
        // Should use content after the LAST marker
        let data = b"\x1b[?1049l/wrong/path.txt\x1b[?1049l/correct/path.txt\n";
        assert_eq!(extract_selection(data), "/correct/path.txt");
    }

    #[test]
    fn handles_path_with_spaces() {
        let data = b"\x1b[?1049l/path/to/my file.txt\n";
        assert_eq!(extract_selection(data), "/path/to/my file.txt");
    }

    #[test]
    fn handles_complex_ansi_sequences() {
        // Bold, color, cursor movement, etc.
        let data = b"\x1b[?1049l\x1b[1;32m\x1b[2K/path/file.txt\x1b[0m\r\n";
        assert_eq!(extract_selection(data), "/path/file.txt");
    }

    #[test]
    fn handles_real_tv_output() {
        // Simulated TV output pattern
        let mut data = Vec::new();
        // TUI content before exit
        data.extend_from_slice(b"\x1b[?1049h\x1b[22;0;0t\x1b[1;1H\x1b[J");
        data.extend_from_slice(b"Files picker content here...");
        // Exit alternate screen
        data.extend_from_slice(b"\x1b[?1049l");
        // Selection output
        data.extend_from_slice(b"\x1b[32msrc/lib/tvResolver.ts\x1b[0m\n");

        assert_eq!(extract_selection(&data), "src/lib/tvResolver.ts");
    }
}
