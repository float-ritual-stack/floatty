//! Server lifecycle management for floatty-server subprocess.
//!
//! This module handles spawning, health-checking, and cleanup of the
//! floatty-server headless backend. It supports both standalone mode
//! (reusing existing server) and managed mode (spawning as subprocess).

use crate::config::ServerInfo;
use std::path::PathBuf;
use std::process::Child;

/// PID file path for stale server detection
fn pid_file_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".floatty")
        .join("server.pid")
}

/// State for the floatty-server subprocess
pub struct ServerState {
    /// Server info (URL + API key) for frontend
    pub info: ServerInfo,
    /// Child process handle - only Some if we spawned it (None = reusing existing server)
    process: Option<std::sync::Mutex<Child>>,
}

impl Drop for ServerState {
    fn drop(&mut self) {
        // Only kill if we spawned it
        if let Some(ref process) = self.process {
            if let Ok(mut child) = process.lock() {
                log::info!("Killing floatty-server subprocess (we spawned it)");
                let _ = child.kill();
                // Clean up PID file on graceful shutdown
                remove_pid_file();
            }
        } else {
            log::info!("Not killing floatty-server (reusing existing instance)");
        }
    }
}

/// Kill a stale server process using saved PID file.
/// Returns true if a stale server was found and killed.
fn kill_stale_server() -> bool {
    let pid_path = pid_file_path();

    if !pid_path.exists() {
        return false;
    }

    // Read PID from file
    let pid_str = match std::fs::read_to_string(&pid_path) {
        Ok(s) => s.trim().to_string(),
        Err(e) => {
            eprintln!("[floatty] Failed to read PID file: {}", e);
            let _ = std::fs::remove_file(&pid_path);
            return false;
        }
    };

    let pid: u32 = match pid_str.parse() {
        Ok(p) => p,
        Err(_) => {
            eprintln!("[floatty] Invalid PID in file: {}", pid_str);
            let _ = std::fs::remove_file(&pid_path);
            return false;
        }
    };

    // Check if process is still running (using kill -0 which doesn't actually kill)
    let is_running = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !is_running {
        eprintln!("[floatty] PID {} from file is not running (stale PID file)", pid);
        let _ = std::fs::remove_file(&pid_path);
        return false;
    }

    // Process exists - kill it
    eprintln!("[floatty] Killing stale server process (PID {})", pid);
    let killed = std::process::Command::new("kill")
        .arg(&pid.to_string())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if killed {
        // Wait a moment for process to exit
        std::thread::sleep(std::time::Duration::from_millis(200));
        let _ = std::fs::remove_file(&pid_path);
        eprintln!("[floatty] Stale server killed successfully");
        true
    } else {
        eprintln!("[floatty] Failed to kill stale server (PID {})", pid);
        false
    }
}

/// Write server PID to file for stale process detection
fn write_pid_file(pid: u32) {
    let pid_path = pid_file_path();

    // Ensure directory exists
    if let Some(parent) = pid_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[floatty] Failed to create PID file directory: {}", e);
            return;
        }
    }

    if let Err(e) = std::fs::write(&pid_path, pid.to_string()) {
        eprintln!("[floatty] Failed to write PID file: {}", e);
    } else {
        eprintln!("[floatty] Wrote server PID {} to {:?}", pid, pid_path);
    }
}

/// Remove PID file on clean shutdown
fn remove_pid_file() {
    let pid_path = pid_file_path();
    if pid_path.exists() {
        if let Err(e) = std::fs::remove_file(&pid_path) {
            log::warn!("Failed to remove PID file: {}", e);
        }
    }
}

/// Spawn the floatty-server subprocess and wait for it to be ready.
/// If a server is already running on the port, connects to it instead.
///
/// Returns `ServerState` on success, or None if spawn/health-check fails.
/// Uses eprintln for early boot logging (before tauri_plugin_log is initialized).
pub fn spawn_server(port: u16) -> Option<ServerState> {
    // First, kill any stale server from previous crashes
    kill_stale_server();

    let url = format!("http://127.0.0.1:{}", port);

    // Check if server is already running (from previous session or standalone)
    if wait_for_server_health(&url) {
        eprintln!("[floatty] Reusing existing server at {}", url);
        let api_key = read_api_key_from_config()?;
        return Some(ServerState {
            info: ServerInfo { url, api_key },
            process: None, // We didn't spawn it, don't kill it
        });
    }

    // No server running, spawn one
    let server_binary = find_server_binary()?;
    eprintln!("[floatty] Spawning server from {:?}", server_binary);

    // Spawn server (it reads config for port/api_key itself)
    // Use null/inherit instead of piped to prevent deadlock when buffer fills
    // (piped stdout/stderr would block writes if parent never reads - ~64KB buffer on Unix)
    let child = std::process::Command::new(&server_binary)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| {
            log::error!("Failed to spawn floatty-server: {}", e);
            e
        })
        .ok()?;

    // Write PID file for stale process detection on next launch
    write_pid_file(child.id());

    // Wait for server to be ready
    if !wait_for_server_health(&url) {
        log::error!("Server health check failed after timeout");
        return None;
    }

    // Read API key from config (server generates and persists if needed)
    let api_key = read_api_key_from_config()?;

    log::info!("floatty-server ready at {}", url);

    Some(ServerState {
        info: ServerInfo { url, api_key },
        process: Some(std::sync::Mutex::new(child)),
    })
}

/// Read API key from ~/.floatty/config.toml [server].api_key
fn read_api_key_from_config() -> Option<String> {
    let config_path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".floatty")
        .join("config.toml");

    if !config_path.exists() {
        log::warn!("Config file not found at {:?}", config_path);
        return None;
    }

    let content = std::fs::read_to_string(&config_path).ok()?;
    let doc: toml::Table = content.parse().ok()?;

    // Read from [server].api_key
    let api_key = doc
        .get("server")
        .and_then(|s| s.as_table())
        .and_then(|s| s.get("api_key"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if api_key.is_none() {
        log::warn!("No [server].api_key found in config");
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

/// Wait for server health endpoint to respond (with retries)
fn wait_for_server_health(base_url: &str) -> bool {
    let health_url = format!("{}/api/v1/health", base_url);
    let max_attempts = 30; // 3 seconds total
    let delay = std::time::Duration::from_millis(100);

    for attempt in 1..=max_attempts {
        match std::process::Command::new("curl")
            .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", &health_url])
            .output()
        {
            Ok(output) => {
                let status = String::from_utf8_lossy(&output.stdout);
                if status.trim() == "200" {
                    log::info!("Server health check passed (attempt {})", attempt);
                    return true;
                }
            }
            Err(_) => {}
        }
        std::thread::sleep(delay);
    }

    false
}
