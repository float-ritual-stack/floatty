//! Server lifecycle management for floatty-server subprocess.
//!
//! This module handles spawning, health-checking, and cleanup of the
//! floatty-server headless backend. It supports both standalone mode
//! (reusing existing server) and managed mode (spawning as subprocess).

use crate::config::{ServerInfo, ServerStatus};
use crate::paths::DataPaths;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

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
            tracing::info!(
                pid = pid,
                "Stale server exited before SIGTERM was delivered"
            );
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
            tracing::info!(
                pid = pid,
                "Stale server exited before SIGKILL was delivered"
            );
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

// ═══════════════════════════════════════════════════════════════
// MCP bridge instance targeting (FLO-826)
// ═══════════════════════════════════════════════════════════════

/// Resolve the MCP-bridge base port: `FLOATTY_MCP_PORT` env override, else a
/// per-profile band — release keeps the plugin's historical default (9223)
/// so existing Desktop workflows are unbroken; dev gets its own band (9333,
/// mirroring the 33333 visually-distinct dev-port pattern). Hermetic test
/// launches pass `FLOATTY_MCP_PORT` alongside `FLOATTY_DATA_DIR`. The
/// plugin's internal scan then only disambiguates WITHIN a band, never
/// across release/dev/scratch instances.
pub fn resolve_mcp_base_port(env_value: Option<String>) -> u16 {
    env_value
        .and_then(|p| p.parse().ok())
        // Port 0 parses but means "OS-assigned": the scan's probe bind would
        // succeed on an ephemeral port while returning 0, and the identity
        // file would advertise 0 — useless to readers. Fall to the band.
        .filter(|&p| p != 0)
        .unwrap_or(if cfg!(debug_assertions) { 9333 } else { 9223 })
}

/// Bind address for the MCP bridge — used by BOTH floatty's pre-selection
/// scan below and the plugin Builder in lib.rs. The two scans MUST probe the
/// same interface or a port free on one but taken on the other silently
/// diverges pre-selection from the plugin's actual bind.
pub const MCP_BIND_ADDR: &str = "127.0.0.1";

/// Pick a free port for the MCP bridge starting at `base`.
///
/// The mcp-bridge plugin selects its own port with an identical bind-and-drop
/// scan but never exposes the result (a local inside its setup closure). So
/// floatty pre-selects: verify a port free here, hand it to the plugin as
/// `base_port`, and the plugin's first probe lands on the same port — which
/// lets the identity file below advertise it.
///
/// Known gap: if the port is taken between this scan and the plugin's (two
/// same-band instances racing, or a foreign bind), the plugin drifts to the
/// next port while the identity file still advertises this one — unlike the
/// plugin's internal TOCTOU, that one is identity≠actual. Different profile
/// bands make the common case immune; the reader-side recipe's data_dir
/// assertion catches the rest (see config-and-logging.md §MCP).
pub fn find_free_mcp_port(base: u16) -> u16 {
    for offset in 0..100u16 {
        let port = base.saturating_add(offset);
        if std::net::TcpListener::bind((MCP_BIND_ADDR, port)).is_ok() {
            return port;
        }
    }
    // Mirror the plugin's own all-taken fallback: return base and let the
    // plugin's bind fail loudly in its log rather than drifting bands.
    base
}

/// Instance identity advertised at `{data_dir}/mcp-bridge.json`.
///
/// The agent-targeting contract: launched an instance with
/// `FLOATTY_DATA_DIR=X` → read `X/mcp-bridge.json` → verify `pid` is alive
/// (`ps -p`) → `driver_session(port)` → assert `get_ctx_config().data_dir`
/// matches. The data dir is the isolation boundary, so this makes it the
/// address — no port guessing across instances.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBridgeIdentity {
    pub port: u16,
    pub pid: u32,
    pub workspace_name: String,
    pub profile: &'static str,
    pub version: &'static str,
}

/// Write the identity file. No removal hook by design: a fresh start
/// overwrites, and READERS validate `pid` liveness (the server.pid stale
/// pattern applied client-side), so a crashed instance's leftover file is
/// harmless. The advertised port may briefly pre-date the plugin's deferred
/// WS bind — connectors retry, so that gap is not a race that matters.
pub fn write_mcp_bridge_identity(path: &PathBuf, port: u16, workspace_name: String) {
    let identity = McpBridgeIdentity {
        port,
        pid: std::process::id(),
        workspace_name,
        profile: if cfg!(debug_assertions) {
            "dev"
        } else {
            "release"
        },
        version: env!("CARGO_PKG_VERSION"),
    };
    match serde_json::to_string_pretty(&identity) {
        // Degrade on failure (optional feature per logging-discipline §3):
        // targeting falls back to the log-grep protocol. The path is not
        // logged — data-dir paths carry the username (rule 1).
        Ok(json) => {
            if let Err(e) = std::fs::write(path, json) {
                tracing::warn!(error = %e, "Failed to write mcp-bridge identity file");
            } else {
                tracing::info!(port = port, "Wrote mcp-bridge identity file");
            }
        }
        Err(e) => tracing::warn!(error = %e, "Failed to serialize mcp-bridge identity"),
    }
}

/// Spawn the floatty-server subprocess and wait for it to be ready.
/// If a server is already running on the port, connects to it instead.
///
/// Build the base `Command` for the app-MANAGED floatty-server sidecar.
///
/// The app is the sidecar's manager, so it controls the sidecar's environment
/// EXPLICITLY instead of inheriting whatever ambient state it was launched with:
///
/// - `FLOATTY_DATA_DIR` is set so the sidecar uses the app's data dir.
/// - `FLOATTY_API_KEY` is REMOVED. That variable is a *client* credential —
///   floatty injects it into terminals so shells can authenticate TO a server
///   (`terminalManager.ts`). If the app (or `pnpm tauri:dev`) is launched from
///   inside a floatty terminal, that key — for a possibly DIFFERENT server — is
///   in the app's env, and `floatty-server` prefers `FLOATTY_API_KEY` over the
///   config key (`floatty-server/src/main.rs`). The managed sidecar would then
///   accept a client key for another server, while the app hands the client the
///   CONFIG key (`read_api_key_from_config`) — so every request 401s. Stripping
///   it makes the managed sidecar always derive its key from config, matching
///   the client, in every launch context (Finder, ssh, or a floatty terminal).
fn build_sidecar_command(server_binary: &Path, data_dir: &Path) -> Command {
    let mut cmd = Command::new(server_binary);
    cmd.env("FLOATTY_DATA_DIR", data_dir);
    cmd.env_remove("FLOATTY_API_KEY");
    cmd
}

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

    let mut cmd = build_sidecar_command(&server_binary, &paths.root);
    cmd.stdout(std::process::Stdio::null());
    if let Some(log_file) = server_log {
        cmd.stderr(std::process::Stdio::from(log_file));
    } else {
        cmd.stderr(std::process::Stdio::inherit());
    }
    let child = cmd
        .spawn()
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

/// Why a remote-authority connect attempt produced no `ServerState`.
///
/// The old signature returned `Option<ServerState>`, collapsing "float-box is
/// down", "no local API key" and "the remote rejected our key" into one `None` —
/// which the frontend then collapsed further into `"Server not running"`,
/// indistinguishable from "no remote is configured at all". Fast-boot Phase 2
/// has to tell remote-configured-but-down (→ offline mode, boot from cache)
/// apart from misconfiguration (→ genuinely broken, don't pretend to be offline).
///
/// `resolve_server` branches on the variants: `Unreachable` surfaces as
/// `reachable: false` (the recoverable-offline case), while `NoApiKey` /
/// `AuthRejected` surface as `reachable: true, auth_failed: true` — the remote
/// answered, the config is wrong, and waiting will not fix it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteConnectError {
    /// Health probe failed after retries — remote down, tailnet blip.
    Unreachable,
    /// No `[server].api_key` in the local config to authenticate with.
    NoApiKey,
    /// The remote rejected our API key (401/403). Local key must match theirs.
    AuthRejected,
}

/// Connect to a remote floatty-server instead of spawning a local subprocess (FLO-762).
///
/// Returns the same external-mode `ServerState` shape as the "reusing existing
/// server" path in `spawn_server` (`process: None` = we don't own it, don't kill
/// it). Never touches the PID-file/kill path — that machinery is for local
/// subprocess lifecycle only.
///
/// Failure policy is error-and-surface, NOT fall-back-to-local-spawn: a silent
/// local spawn would create a split-brain where edits land in a local outline
/// while the user believes they're on the shared one.
///
/// Logging note: the configured URL is deliberately NOT formatted into tracing
/// events (config-sourced URLs are sensitive by default — see
/// .claude/rules/logging-discipline.md rule 1). Messages reference the
/// `remote_server_url` config field instead, which is unambiguous.
pub fn connect_remote_server(
    remote_url: &str,
    paths: &DataPaths,
) -> Result<ServerState, RemoteConnectError> {
    let url = remote_url.trim_end_matches('/').to_string();
    let pid_file = paths.pid_file.clone();

    // Probe with retries — tolerate transient tailnet blips / remote restart
    // races at app launch. 3 × (2s probe timeout + 500ms gap) ≈ 7.5s worst case.
    let max_attempts = 3;
    let mut healthy = false;
    for attempt in 1..=max_attempts {
        if probe_server_health(&url, 2) {
            tracing::info!(
                attempt = attempt,
                "Remote floatty-server health check passed"
            );
            healthy = true;
            break;
        }
        if attempt < max_attempts {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
    if !healthy {
        tracing::error!(
            attempts = max_attempts,
            "Remote floatty-server unreachable — check `remote_server_url` in config.toml \
             and network (tailnet) connectivity. NOT falling back to local spawn."
        );
        return Err(RemoteConnectError::Unreachable);
    }

    // Version-skew visibility: desktop, laptop, and the remote authority are
    // built independently and WILL drift. A mismatch isn't fatal (the API is
    // versioned-by-convention), but it should never be invisible.
    //
    // Off the blocking path: this fetch is pure diagnostics, and it used to
    // run serially inside the window-blocking handshake (~0.5s of the
    // measured 1.7s pre-window curls — boot-sequence audit §3.7).
    {
        let url = url.clone();
        std::thread::spawn(move || {
            if let Some(health) = fetch_health_json(&url, 2) {
                if let Some(server_version) = health.get("version").and_then(|v| v.as_str()) {
                    let client_version = env!("CARGO_PKG_VERSION");
                    if server_version != client_version {
                        tracing::warn!(
                            client_version = client_version,
                            server_version = server_version,
                            "Version skew between this app and the remote floatty-server"
                        );
                    }
                }
            }
        });
    }

    let api_key = read_api_key_from_config(&paths.config).ok_or(RemoteConnectError::NoApiKey)?;

    // Authed probe — /api/v1/health is unauthenticated, so a key mismatch
    // would otherwise pass startup and surface as silent 401s on every
    // subsequent API call (dead outline, no explanation).
    match probe_authed_status(&url, "/api/v1/stats", &api_key, 2) {
        Some(200) => {}
        Some(401) | Some(403) => {
            tracing::error!(
                "API key rejected by remote floatty-server — local [server].api_key \
                 must match the remote server's key. Refusing to start in remote mode."
            );
            return Err(RemoteConnectError::AuthRejected);
        }
        Some(code) => {
            // Unexpected but not an auth failure (e.g., 500). The health probe
            // already passed, so let the app come up and surface errors in-UI.
            tracing::warn!(
                status = code,
                "Unexpected status from authed probe of remote server; continuing"
            );
        }
        None => {
            tracing::warn!("Authed probe of remote server failed to execute; continuing");
        }
    }

    tracing::info!("Connected to remote floatty-server (external mode, no local spawn)");

    Ok(ServerState {
        info: ServerInfo { url, api_key },
        process: None, // Remote server — we didn't spawn it, never kill it
        pid_file,
    })
}

/// Resolve which floatty-server backs this app, and report that resolution
/// honestly (fast-boot Phase 0).
///
/// Remote-authority mode (FLO-762) when `remote_server_url` is set in
/// config.toml; a local subprocess otherwise. **An unreachable remote never
/// falls back to a local spawn** — that is the split-brain guard, and it stays.
/// What changes here is only that the failure is now *legible*: the returned
/// `ServerStatus` says whether a remote was configured at all, which is what
/// separates "offline, your outline is fine, wait for float-box" from "this app
/// is misconfigured".
///
/// `spawn_local` is injected so tests can assert "we did NOT spawn a local
/// server" without the side effects of actually spawning one.
pub fn resolve_server(
    remote_url: Option<&str>,
    paths: &DataPaths,
    spawn_local: impl FnOnce(&DataPaths) -> Option<ServerState>,
) -> (Option<ServerState>, ServerStatus) {
    match remote_url {
        Some(url) => match connect_remote_server(url, paths) {
            Ok(state) => (
                Some(state),
                ServerStatus {
                    remote_configured: true,
                    reachable: true,
                    auth_failed: false,
                },
            ),
            // By the time these fire the health probe has PASSED — the remote
            // is up, our key is missing/rejected. Reporting reachable: false
            // here would let a cache-boot branch treat misconfiguration as the
            // recoverable-offline case.
            Err(RemoteConnectError::NoApiKey | RemoteConnectError::AuthRejected) => (
                None,
                ServerStatus {
                    remote_configured: true,
                    reachable: true,
                    auth_failed: true,
                },
            ),
            // The remote is configured but down — the ONE recoverable failure.
            // Hand the frontend the config-derived connection info anyway
            // (`process: None` — the split-brain guard is about never SPAWNING
            // locally, not about withholding the URL). The frontend
            // health-checks before using it, and this is what the reconnect
            // loop redials when float-box comes back: without it, a remote
            // that was dead at launch was permanently unrecoverable, because
            // no URL ever crossed the IPC boundary (`get_server_info` had
            // nothing to return).
            Err(RemoteConnectError::Unreachable) => {
                let state = read_api_key_from_config(&paths.config).map(|api_key| ServerState {
                    info: ServerInfo {
                        url: url.trim_end_matches('/').to_string(),
                        api_key,
                    },
                    process: None,
                    pid_file: paths.pid_file.clone(),
                });
                (
                    state,
                    ServerStatus {
                        remote_configured: true,
                        reachable: false,
                        auth_failed: false,
                    },
                )
            }
        },
        None => {
            let state = spawn_local(paths);
            let reachable = state.is_some();
            (
                state,
                ServerStatus {
                    remote_configured: false,
                    reachable,
                    auth_failed: false,
                },
            )
        }
    }
}

/// Fetch and parse the remote server's health JSON (`{status, version, ...}`).
/// Returns None on network failure or unparseable body.
fn fetch_health_json(base_url: &str, timeout_secs: u32) -> Option<serde_json::Value> {
    let health_url = format!("{}/api/v1/health", base_url);
    let output = std::process::Command::new("curl")
        .args(["-s", "-m", &timeout_secs.to_string(), &health_url])
        .output()
        .ok()?;
    serde_json::from_slice(&output.stdout).ok()
}

/// Probe an authenticated endpoint, returning the HTTP status code.
/// Returns None if curl itself failed to run or produced no parseable code.
fn probe_authed_status(
    base_url: &str,
    path: &str,
    api_key: &str,
    timeout_secs: u32,
) -> Option<u16> {
    let full_url = format!("{}{}", base_url, path);
    let auth_header = format!("Authorization: Bearer {}", api_key);
    let output = std::process::Command::new("curl")
        .args([
            "-s",
            "-m",
            &timeout_secs.to_string(),
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            "-H",
            &auth_header,
            &full_url,
        ])
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
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
        .args([
            "-s",
            "-m",
            &timeout_str,
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            &health_url,
        ])
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// Minimal blocking HTTP responder exercising the curl-based probes
    /// end-to-end. Mirrors the real floatty-server auth split:
    /// /api/v1/health is unauthenticated, /api/v1/stats requires the Bearer key.
    fn spawn_mock_server(valid_key: &'static str, version: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(match stream.try_clone() {
                    Ok(s) => s,
                    Err(_) => continue,
                });
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut authorized = false;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if line == "\r\n" {
                        break;
                    }
                    if line.to_ascii_lowercase().starts_with("authorization:")
                        && line.contains(valid_key)
                    {
                        authorized = true;
                    }
                }
                let response = if request_line.starts_with("GET /api/v1/health") {
                    let body = format!("{{\"status\":\"ok\",\"version\":\"{}\"}}", version);
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    )
                } else if request_line.starts_with("GET /api/v1/stats") {
                    if authorized {
                        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
                            .to_string()
                    } else {
                        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_string()
                    }
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .to_string()
                };
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://{}", addr)
    }

    fn temp_paths_with_key(key: Option<&str>) -> (tempfile::TempDir, DataPaths) {
        let dir = tempfile::tempdir().unwrap();
        let paths = DataPaths::from_root(dir.path().to_path_buf());
        if let Some(key) = key {
            std::fs::write(&paths.config, format!("[server]\napi_key = \"{}\"\n", key)).unwrap();
        }
        (dir, paths)
    }

    #[test]
    fn remote_connect_happy_path_normalizes_url_and_returns_external_mode() {
        let url = spawn_mock_server("test-key-123", env!("CARGO_PKG_VERSION"));
        let (_dir, paths) = temp_paths_with_key(Some("test-key-123"));

        // Trailing slash must be trimmed — downstream code concatenates paths.
        let state = connect_remote_server(&format!("{}/", url), &paths)
            .expect("healthy remote + matching key should connect");

        assert_eq!(state.info.url, url);
        assert_eq!(state.info.api_key, "test-key-123");
        // External mode: we didn't spawn it, Drop must never kill it.
        assert!(state.process.is_none());
    }

    #[test]
    fn remote_connect_rejects_on_api_key_mismatch() {
        // Mock accepts "right-key"; local config holds "wrong-key" →
        // authed probe gets 401 → refuse to start (fail visibly, not
        // silent 401s on every later call).
        let url = spawn_mock_server("right-key", "0.0.0");
        let (_dir, paths) = temp_paths_with_key(Some("wrong-key"));
        // ServerState holds a Child handle, so it is neither Debug nor PartialEq —
        // assert on the error side.
        assert_eq!(
            connect_remote_server(&url, &paths).err(),
            Some(RemoteConnectError::AuthRejected),
            "a rejected key is misconfiguration, NOT 'offline' — Phase 2 must not \
             boot from cache and pretend the outline is fine"
        );
    }

    #[test]
    fn remote_connect_fails_when_unreachable() {
        // Bind-then-drop to obtain a port with nothing listening.
        // Connection-refused fails each probe instantly, so the 3-attempt
        // retry loop completes in ~1s of sleeps, not probe timeouts.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let (_dir, paths) = temp_paths_with_key(Some("k"));
        assert_eq!(
            connect_remote_server(&format!("http://127.0.0.1:{}", port), &paths).err(),
            Some(RemoteConnectError::Unreachable),
            "the ONE recoverable failure: remote is configured and simply down"
        );
    }

    #[test]
    fn remote_connect_fails_without_local_api_key() {
        let url = spawn_mock_server("k", "0.0.0");
        let (_dir, paths) = temp_paths_with_key(None);
        assert_eq!(
            connect_remote_server(&url, &paths).err(),
            Some(RemoteConnectError::NoApiKey)
        );
    }

    #[test]
    fn server_status_distinguishes_no_remote_from_remote_down() {
        // The whole reason the Option→Result change exists: these two used to
        // be the same `None`, and the frontend saw the same "Server not
        // running" string for both.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let (_dir, paths) = temp_paths_with_key(Some("k"));

        let remote_url = format!("http://127.0.0.1:{}", port);
        let down = resolve_server(Some(&remote_url), &paths, /* local_spawn */ |_| None);
        // Unreachable-but-configured still hands over the connection info —
        // it's what the reconnect loop redials — while NEVER spawning locally
        // (the split-brain guard) and reporting reachable: false honestly.
        let state = down
            .0
            .expect("unreachable remote with a local key still returns connection info");
        assert_eq!(state.info.url, remote_url);
        assert_eq!(state.info.api_key, "k");
        assert!(state.process.is_none(), "must NOT spawn locally");
        assert!(down.1.remote_configured);
        assert!(!down.1.reachable);
        assert!(!down.1.auth_failed);

        let no_remote = resolve_server(None, &paths, |_| None);
        assert!(!no_remote.1.remote_configured);
        assert!(!no_remote.1.reachable);
        assert!(!no_remote.1.auth_failed);
    }

    #[test]
    fn unreachable_remote_without_local_key_returns_no_state() {
        // Without an api_key there is nothing useful to hand the frontend —
        // a URL it can't authenticate against is not a recovery path.
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let (_dir, paths) = temp_paths_with_key(None);

        let down = resolve_server(Some(&format!("http://127.0.0.1:{}", port)), &paths, |_| {
            None
        });
        assert!(down.0.is_none());
        assert!(down.1.remote_configured);
        assert!(!down.1.reachable);
    }

    #[test]
    fn server_status_reports_auth_failure_as_reachable_not_offline() {
        // A rejected key is misconfiguration, not an outage: the health probe
        // passed, so `reachable` stays true and `auth_failed` carries the
        // difference. Collapsing this into reachable:false would let a
        // cache-boot branch treat a live-but-unauthorized remote as the
        // recoverable offline case.
        let url = spawn_mock_server("k", "0.0.0");

        // NB: the mock authorizes any header CONTAINING valid_key, so the
        // wrong key must not have "k" as a substring.
        let (_dir, wrong_key) = temp_paths_with_key(Some("wrong"));
        let rejected = resolve_server(Some(&url), &wrong_key, |_| None);
        assert!(rejected.0.is_none(), "auth failure must NOT spawn locally");
        assert!(rejected.1.remote_configured);
        assert!(rejected.1.reachable, "the remote answered — not an outage");
        assert!(rejected.1.auth_failed);

        let (_dir, no_key) = temp_paths_with_key(None);
        let missing = resolve_server(Some(&url), &no_key, |_| None);
        assert!(missing.0.is_none());
        assert!(missing.1.reachable);
        assert!(missing.1.auth_failed);
    }

    // ── MCP bridge instance targeting (FLO-826) ──

    #[test]
    fn mcp_base_port_env_override_wins() {
        assert_eq!(resolve_mcp_base_port(Some("9411".to_string())), 9411);
    }

    #[test]
    fn mcp_base_port_garbage_env_falls_back_to_profile_default() {
        // Tests compile in debug → the dev band. A silent parse-failure must
        // land in the profile band, not some accidental port.
        assert_eq!(resolve_mcp_base_port(Some("not-a-port".to_string())), 9333);
        assert_eq!(resolve_mcp_base_port(None), 9333);
        // Port 0 = OS-assigned = an identity file advertising 0. Rejected.
        assert_eq!(resolve_mcp_base_port(Some("0".to_string())), 9333);
    }

    #[test]
    fn find_free_mcp_port_skips_an_occupied_base() {
        // Hold an OS-assigned port, then ask for a free port starting there —
        // the scan must move off the held port but stay inside the band.
        let holder = TcpListener::bind("127.0.0.1:0").unwrap();
        let held = holder.local_addr().unwrap().port();

        let chosen = find_free_mcp_port(held);
        assert_ne!(chosen, held, "must not claim a port something else holds");
        assert!(
            chosen > held && chosen <= held.saturating_add(99),
            "must stay within the 100-port band"
        );
        // And the choice must actually be bindable right now.
        drop(TcpListener::bind(("127.0.0.1", chosen)).unwrap());
    }

    #[test]
    fn mcp_identity_file_round_trips_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp-bridge.json");

        write_mcp_bridge_identity(&path, 9411, "test-ws".to_string());

        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        // camelCase wire contract (serde-api-patterns) — readers are TS/agents.
        assert_eq!(parsed["port"], 9411);
        assert_eq!(parsed["pid"], std::process::id());
        assert_eq!(parsed["workspaceName"], "test-ws");
        assert_eq!(parsed["profile"], "dev");
        assert!(parsed["version"].as_str().unwrap().contains('.'));

        // Startup overwrite is the recycling mechanism — a second write with
        // new values must fully replace the first.
        write_mcp_bridge_identity(&path, 9412, "other-ws".to_string());
        let parsed2: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed2["port"], 9412);
        assert_eq!(parsed2["workspaceName"], "other-ws");
    }

    /// The managed sidecar must NOT inherit a `FLOATTY_API_KEY` from the app's
    /// ambient env — that variable is a CLIENT credential (injected into floatty
    /// terminals) for a possibly-different server, and floatty-server prefers it
    /// over the config key, which would 401 the client that uses the config key.
    /// See `build_sidecar_command`. (Fails without the `env_remove`: the key
    /// would simply not appear in the override map.)
    #[test]
    fn managed_sidecar_command_strips_leaked_client_api_key() {
        use std::collections::HashMap;
        use std::ffi::OsStr;

        let cmd = build_sidecar_command(
            Path::new("/usr/local/bin/floatty-server"),
            Path::new("/tmp/floatty-managed"),
        );
        let envs: HashMap<_, _> = cmd.get_envs().collect();

        // FLOATTY_API_KEY is explicitly REMOVED (present in the override map
        // with a None value), so the sidecar can't inherit a leaked client key.
        assert_eq!(
            envs.get(OsStr::new("FLOATTY_API_KEY")),
            Some(&None),
            "managed sidecar must strip the ambient FLOATTY_API_KEY"
        );
        // FLOATTY_DATA_DIR is explicitly set to the app's data dir.
        assert_eq!(
            envs.get(OsStr::new("FLOATTY_DATA_DIR")),
            Some(&Some(OsStr::new("/tmp/floatty-managed"))),
            "managed sidecar must run against the app's data dir"
        );
    }
}
