/// Door hot-reload watcher — watches {data_dir}/doors/ for file changes.
///
/// When a door's `index.js` or `door.json` changes, emits a `door-changed`
/// Tauri event so the frontend can reload that specific door.
///
/// Uses `notify` crate with debouncing to handle editor multi-write patterns.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Event payload emitted to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorChangedEvent {
    pub door_id: String,
    pub removed: bool,
}

/// Start watching the doors directory for changes.
///
/// Spawns a background thread that:
/// 1. Watches `doors_dir` recursively via `notify`
/// 2. Debounces changes per door_id (300ms)
/// 3. Emits `door-changed` Tauri events
pub fn start_door_watcher(doors_dir: PathBuf, app_handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        tracing::info!(?doors_dir, "Starting door watcher");

        if !doors_dir.exists() {
            tracing::warn!(?doors_dir, "Doors directory does not exist, watcher will not start");
            return;
        }

        let (tx, rx) = mpsc::channel();
        let mut watcher: RecommendedWatcher = match Watcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            notify::Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => {
                tracing::error!(error = %e, "Failed to create door watcher");
                return;
            }
        };

        if let Err(e) = watcher.watch(&doors_dir, RecursiveMode::Recursive) {
            tracing::error!(error = %e, "Failed to watch doors directory");
            return;
        }

        // Debounce state: door_id -> last event time
        let mut pending: HashMap<String, Instant> = HashMap::new();
        let debounce = Duration::from_millis(300);

        loop {
            // Block on first event, then drain queue
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(event) => process_event(&event, &doors_dir, &mut pending),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    tracing::info!("Door watcher channel disconnected, stopping");
                    break;
                }
            }

            // Drain any queued events
            while let Ok(event) = rx.try_recv() {
                process_event(&event, &doors_dir, &mut pending);
            }

            // Emit for debounced doors
            let now = Instant::now();
            let ready: Vec<String> = pending
                .iter()
                .filter(|(_, last_time)| now.duration_since(**last_time) >= debounce)
                .map(|(id, _)| id.clone())
                .collect();

            for door_id in ready {
                pending.remove(&door_id);

                // Check if door was removed (directory no longer exists)
                let door_dir = doors_dir.join(&door_id);
                let removed = !door_dir.exists();

                let payload = DoorChangedEvent {
                    door_id: door_id.clone(),
                    removed,
                };

                tracing::info!(?payload, "Emitting door-changed event");
                if let Err(e) = app_handle.emit("door-changed", &payload) {
                    tracing::error!(error = %e, "Failed to emit door-changed event");
                }
            }
        }
    });
}

/// Extract door_id from a changed file path and update pending map.
fn process_event(
    event: &Event,
    doors_dir: &PathBuf,
    pending: &mut HashMap<String, Instant>,
) {
    // Only care about modifications, creates, and removes
    match event.kind {
        EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_) => {}
        _ => return,
    }

    for path in &event.paths {
        // Extract door_id: path should be doors_dir/<door_id>/something
        if let Ok(relative) = path.strip_prefix(doors_dir) {
            if let Some(door_id) = relative.iter().next() {
                let door_id = door_id.to_string_lossy().to_string();
                // Only trigger on relevant files
                let filename = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
                if filename == "index.js" || filename == "door.json" {
                    pending.insert(door_id, Instant::now());
                }
            }
        }
    }
}
