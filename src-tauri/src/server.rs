//! Server lifecycle management for floatty-server subprocess.
//!
//! This module handles spawning, health-checking, and cleanup of the
//! floatty-server headless backend. It supports both standalone mode
//! (reusing existing server) and managed mode (spawning as subprocess).

use crate::config::ServerInfo;
use crate::paths::DataPaths;
use std::path::PathBuf;
use std::process::Child;

/// State for the floatty-server subprocess
pub struct ServerState {
    /// Server info (URL + API key) for frontend
    pub info: ServerInfo,
    /// Child process handle - only Some if we spawned it (None = reusing existing server)
    process: Option<std::sync::Mutex<Child>>,
    /// Path to PID file for cleanup on drop
    pid_file: PathBuf,
}

impl Drop for ServerState {
    fn drop(&mut self) {
        // Only kill if we spawned it
        if let Some(ref process) = self.process {
            if let Ok(mut child) = process.lock() {
                tracing::info!("Killing floatty-server subprocess (we spawned it)");
                let _ = child.kill();
                // Clean up PID file on graceful shutdown
                remove_pid_file(&self.pid_file);
            }
        } else {
            tracing::info!("Not killing floatty-server (reusing existing instance)");
        }
    }
}

/// Check whether a PID is currently alive (kill -0 semantics).
fn pid_is_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Send a signal to a PID. Returns true if `kill` reported success.
fn send_signal(pid: u32, signal: &str) -> bool {
    std::process::Command::new("kill")
        .args([signal, &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Wait up to `timeout` for `pid` to exit, polling every 50ms.
fn wait_for_exit(pid: u32, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if !pid_is_alive(pid) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    !pid_is_alive(pid)
}

/// Verify that `pid` is actually a floatty-server process before signaling it.
///
/// Between floatty exits and the next launch, the OS can recycle the PID we
/// wrote to disk. Without this check, `kill_stale_server` could SIGKILL a
/// completely unrelated process that happened to inherit the number. We use
/// `ps -p <pid> -o comm=` (BSD/macOS + GNU-compat) to read the command name
/// and require it to contain "floatty-server".
///
/// Returns true if verification succeeds OR if we can't determine (we err on
/// the side of allowing the kill — the alternative is leaving a real zombie
/// in place). Returns false only when we have positive evidence the PID
/// belongs to something else.
fn verify_pid_is_floatty_server(pid: u32) -> bool {
    let output = match std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!(pid = pid, error = %e, "ps failed; allowing signal as fallback");
            return true;
        }
    };

    if !output.status.success() {
        // ps exited non-zero — usually means PID no longer exists. pid_is_alive
        // already returned true moments ago, so this is a race. Allow the signal.
        return true;
    }

    let comm = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if comm.is_empty() {
        return true;
    }

    // Match the binary basename. `ps comm=` gives the program name without path.
    // macOS truncates long names, so use `contains` not exact match.
    let is_ours = comm.contains("floatty-server") || comm.contains("float-pty");
    if !is_ours {
        tracing::error!(
            pid = pid,
            command = %comm,
            "PID from file does NOT belong to floatty-server — refusing to signal (OS likely recycled the PID)"
        );
    }
    is_ours
}

/// Kill a stale server process using saved PID file.
/// Returns true if the PID file was consumed (either the process is now dead
/// or there was no live process to begin with). Returns false only if a
/// living process could not be killed — in that case the caller should
/// abort spawning a new server, since the port is still held.
///
/// Escalates SIGTERM → SIGKILL. A zombie in accept-but-never-respond state
/// may ignore SIGTERM if its signal handler is wedged on the same lock
/// that broke the HTTP path. SIGKILL is uncatchable and always works.
fn kill_stale_server(pid_path: &PathBuf) -> bool {
    if !pid_path.exists() {
        return true;
    }

    // Read PID from file
    let pid_str = match std::fs::read_to_string(pid_path) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            tracing::error!(error = %e, "Failed to read PID file");
            let _ = std::fs::remove_file(pid_path);
            return true;
        }
    };

    let pid: u32 = match pid_str.parse() {
        Ok(p) => p,
        Err(_) => {
            tracing::warn!(pid_str = %pid_str, "Invalid PID in file");
            let _ = std::fs::remove_file(pid_path);
            return true;
        }
    };

    if !pid_is_alive(pid) {
        tracing::info!(pid = pid, "PID from file is not running (stale PID file)");
        let _ = std::fs::remove_file(pid_path);
        return true;
    }

    // PID recycling guard: between our last shutdown and now, the OS may have
    // assigned this number to something unrelated. Verify the process is
    // actually a floatty-server before sending signals.
    //
    // Known TOCTOU window: the process could exit and its PID be recycled
    // between this verify call and the send_signal calls below. Closing that
    // window requires pidfd_send_signal (Linux-only) or equivalent; macOS has
    // no atomic primitive. The window is microseconds and the probability is
    // negligible, so we accept the race.
    if !verify_pid_is_floatty_server(pid) {
        // Not our process — remove the stale file so we don't keep trying,
        // but don't touch the mystery process.
        let _ = std::fs::remove_file(pid_path);
        return true;
    }

    // SIGTERM first — give the process a chance to clean up.
    //
    // State-transition table for this path (send_signal × process-state-after):
    //   (true,  exited)  → return true (clean exit)
    //   (true,  alive)   → escalate to SIGKILL (real zombie ignoring SIGTERM)
    //   (false, exited)  → return true (benign race: process exited between
    //                      kill -0 and kill -TERM, the port is already free)
    //   (false, alive)   → escalate to SIGKILL (EPERM or similar; SIGKILL
    //                      will also fail and bail cleanly)
    tracing::warn!(pid = pid, "Killing stale server process (SIGTERM)");
    if !send_signal(pid, "-TERM") {
        // Distinguish benign race from real delivery failure by re-checking.
        if !pid_is_alive(pid) {
            let _ = std::fs::remove_file(pid_path);
            tracing::info!(pid = pid, "Stale server exited before SIGTERM was delivered");
            return true;
        }
        tracing::warn!(pid = pid, "SIGTERM delivery failed, escalating immediately");
    } else if wait_for_exit(pid, std::time::Duration::from_millis(500)) {
        let _ = std::fs::remove_file(pid_path);
        tracing::info!(pid = pid, "Stale server exited on SIGTERM");
        return true;
    }

    // SIGTERM ignored or undeliverable — escalate to SIGKILL. This is the
    // zombie-recovery path: a server wedged on a poisoned mutex will not
    // respond to SIGTERM because its runtime can't schedule the handler.
    //
    // Same state table as SIGTERM above — a send_signal=false result could
    // still mean the process exited on its own during the race.
    tracing::warn!(pid = pid, "Escalating to SIGKILL");
    if !send_signal(pid, "-KILL") {
        if !pid_is_alive(pid) {
            let _ = std::fs::remove_file(pid_path);
            tracing::info!(pid = pid, "Stale server exited before SIGKILL was delivered");
            return true;
        }
        tracing::error!(pid = pid, "SIGKILL delivery failed — cannot recover");
        return false;
    }

    if wait_for_exit(pid, std::time::Duration::from_millis(500)) {
        let _ = std::fs::remove_file(pid_path);
        tracing::info!(pid = pid, "Stale server exited on SIGKILL");
        true
    } else {
        // SIGKILL delivered but process still alive — kernel pathology.
        // Don't delete the PID file — next launch will try again.
        tracing::error!(pid = pid, "SIGKILL failed — zombie still holding port");
        false
    }
}

/// Write server PID to file for stale process detection
fn write_pid_file(pid: u32, pid_path: &PathBuf) {
    // Ensure directory exists
    if let Some(parent) = pid_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            tracing::error!(error = %e, "Failed to create PID file directory");
            return;
        }
    }

    if let Err(e) = std::fs::write(pid_path, pid.to_string()) {
        tracing::error!(error = %e, "Failed to write PID file");
    } else {
        tracing::info!(pid = pid, path = ?pid_path, "Wrote server PID to file");
    }
}

/// Remove PID file on clean shutdown
fn remove_pid_file(pid_path: &PathBuf) {
    if pid_path.exists() {
        if let Err(e) = std::fs::remove_file(pid_path) {
            tracing::warn!(error = %e, "Failed to remove PID file");
        }
    }
}

/// Spawn the floatty-server subprocess and wait for it to be ready.
/// If a server is already running on the port, connects to it instead.
///
/// Returns `ServerState` on success, or None if spawn/health-check fails.
///
/// # Arguments
/// * `paths` - Data paths (used for PID file and passed to subprocess via FLOATTY_DATA_DIR)
/// * `port` - Port to run server on
pub fn spawn_server(paths: &DataPaths, port: u16) -> Option<ServerState> {
    let pid_file = paths.pid_file.clone();
    let url = format!("http://127.0.0.1:{}", port);

    // Check if server is already running BEFORE killing anything.
    // Previous behavior killed PID from stale file first, which murdered
    // a healthy server from the previous dev session, then the replacement
    // couldn't start fast enough within the 3s health check window.
    //
    // Single-probe with a tight 1s timeout: a healthy server responds in
    // <10ms; anything slower is treated as dead. We can't retry here — a
    // zombie accept-but-never-respond server would otherwise delay startup
    // by 30s before we give up and kill it.
    if probe_server_health(&url, 1) {
        tracing::info!(url = %url, "Reusing existing server (healthy)");
        let api_key = read_api_key_from_config(&paths.config)?;
        return Some(ServerState {
            info: ServerInfo { url, api_key },
            process: None, // We didn't spawn it, don't kill it
            pid_file,
        });
    }

    // Server not responding — kill any stale process, then spawn fresh.
    // If kill_stale_server returns false, a zombie is still holding the
    // port and a fresh spawn would panic with AddrInUse. Bail out so the
    // parent app can surface a meaningful error instead of silently dying.
    if !kill_stale_server(&pid_file) {
        tracing::error!(
            "Cannot spawn floatty-server: stale process still holds the port. \
             Manual intervention required (kill -9 the stale PID)."
        );
        return None;
    }

    // No server running, spawn one
    let server_binary = find_server_binary()?;
    tracing::info!(binary = ?server_binary, "Spawning floatty-server");

    // Spawn server with FLOATTY_DATA_DIR env var
    // This ensures the server uses the same data directory as the main app
    // Redirect stderr to a log file so server tracing output is captured in release builds
    // (inherit goes nowhere when launched from .app bundle)
    let log_dir = paths.root.join("logs");
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        // Non-fatal: we'll fall through to stderr inherit below, which goes
        // nowhere in the .app bundle. Log so the disappearance is visible.
        tracing::warn!(
            error = %e,
            log_dir = ?log_dir,
            "Failed to create server log dir; server.log will be absent and stderr will inherit (goes nowhere in .app bundle)"
        );
    }
    let server_log = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("server.log"))
    {
        Ok(f) => Some(f),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "Failed to open server.log; stderr will inherit (goes nowhere in .app bundle)"
            );
            None
        }
    };

    let mut cmd = std::process::Command::new(&server_binary);
    cmd.env("FLOATTY_DATA_DIR", &paths.root)
        .stdout(std::process::Stdio::null());
    if let Some(log_file) = server_log {
        cmd.stderr(std::process::Stdio::from(log_file));
    } else {
        cmd.stderr(std::process::Stdio::inherit());
    }
    let child = cmd.spawn()
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to spawn floatty-server");
            e
        })
        .ok()?;

    let pid = child.id();
    tracing::info!(pid = pid, data_dir = ?paths.root, "floatty-server subprocess launched");

    // Write PID file for stale process detection on next launch
    write_pid_file(pid, &pid_file);

    // Wait for server to be ready
    if !wait_for_server_health(&url) {
        tracing::error!("Server health check failed after timeout");
        return None;
    }

    // Read API key from config (server generates and persists if needed)
    let api_key = read_api_key_from_config(&paths.config)?;

    tracing::info!(url = %url, pid = pid, "floatty-server ready");

    Some(ServerState {
        info: ServerInfo { url, api_key },
        process: Some(std::sync::Mutex::new(child)),
        pid_file,
    })
}

/// Read API key from config.toml [server].api_key
fn read_api_key_from_config(config_path: &PathBuf) -> Option<String> {
    if !config_path.exists() {
        tracing::warn!(path = ?config_path, "Config file not found");
        return None;
    }

    let content = match std::fs::read_to_string(config_path) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(path = ?config_path, error = %e, "Failed to read config file");
            return None;
        }
    };
    let doc: toml::Table = match content.parse() {
        Ok(d) => d,
        Err(e) => {
            tracing::error!(path = ?config_path, error = %e, "Failed to parse config TOML");
            return None;
        }
    };

    // Read from [server].api_key
    let api_key = doc
        .get("server")
        .and_then(|s| s.as_table())
        .and_then(|s| s.get("api_key"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if api_key.is_none() {
        tracing::warn!("No [server].api_key found in config");
    }

    api_key
}

/// Find the floatty-server binary (checks sidecar path, exe dir, workspace paths, then PATH)
fn find_server_binary() -> Option<PathBuf> {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            // Check for Tauri sidecar (bundled with target triple suffix)
            let target_triple = get_target_triple();
            let sidecar_name = format!("floatty-server-{}", target_triple);
            let sidecar_path = exe_dir.join(&sidecar_name);
            if sidecar_path.exists() {
                eprintln!("[floatty] Found sidecar at {:?}", sidecar_path);
                return Some(sidecar_path);
            }

            // Check for plain binary next to exe (dev mode)
            let dev_path = exe_dir.join("floatty-server");
            if dev_path.exists() {
                return Some(dev_path);
            }
        }
    }

    // Try cargo target directory (running from workspace)
    let workspace_paths = [
        "target/debug/floatty-server",
        "target/release/floatty-server",
        "src-tauri/target/debug/floatty-server",
        "src-tauri/target/release/floatty-server",
        "../target/debug/floatty-server",
        "../target/release/floatty-server",
    ];
    for path in workspace_paths {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    // Check if it's in PATH (installed globally)
    #[cfg(unix)]
    if let Ok(output) = std::process::Command::new("which")
        .arg("floatty-server")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }

    eprintln!("[floatty] ERROR: Could not find floatty-server binary");
    None
}

/// Get the target triple for the current platform (for sidecar binary name)
fn get_target_triple() -> &'static str {
    #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
    return "aarch64-apple-darwin";

    #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
    return "x86_64-apple-darwin";

    #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
    return "x86_64-unknown-linux-gnu";

    #[cfg(all(target_arch = "aarch64", target_os = "linux"))]
    return "aarch64-unknown-linux-gnu";

    #[cfg(all(target_arch = "x86_64", target_os = "windows"))]
    return "x86_64-pc-windows-msvc";

    #[cfg(not(any(
        all(target_arch = "aarch64", target_os = "macos"),
        all(target_arch = "x86_64", target_os = "macos"),
        all(target_arch = "x86_64", target_os = "linux"),
        all(target_arch = "aarch64", target_os = "linux"),
        all(target_arch = "x86_64", target_os = "windows"),
    )))]
    return "unknown";
}

/// Single health probe with a hard curl timeout. Returns true only if the
/// endpoint returns HTTP 200 within the timeout.
///
/// Uses `curl -m` because curl has NO default response timeout — a zombie
/// server in accept-but-never-respond state will otherwise hang forever.
fn probe_server_health(base_url: &str, timeout_secs: u32) -> bool {
    let health_url = format!("{}/api/v1/health", base_url);
    let timeout_str = timeout_secs.to_string();
    match std::process::Command::new("curl")
        .args(["-s", "-m", &timeout_str, "-o", "/dev/null", "-w", "%{http_code}", &health_url])
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim() == "200",
        Err(_) => false,
    }
}

/// Wait for server health endpoint to respond (with retries).
/// Used AFTER spawning a fresh server to give it time to bind and start serving.
fn wait_for_server_health(base_url: &str) -> bool {
    // Worst case: 30 × (1s probe timeout + 100ms sleep) ≈ 33s.
    // In practice a healthy fresh server responds within 1-2 attempts (~200ms).
    let max_attempts = 30;
    let delay = std::time::Duration::from_millis(100);

    for attempt in 1..=max_attempts {
        if probe_server_health(base_url, 1) {
            tracing::info!(attempt = attempt, "Server health check passed");
            return true;
        }
        std::thread::sleep(delay);
    }

    false
}
