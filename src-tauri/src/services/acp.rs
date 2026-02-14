/// ACP (Agent Client Protocol) client service
///
/// Manages AI coding agent subprocesses, communicating via JSON-RPC over stdio.
/// Agents (Claude Code, Gemini CLI, Cline, etc.) are spawned as child processes
/// and communicate through the ACP protocol.
///
/// Architecture:
///   Frontend (AcpPane) → invoke() → commands/acp.rs → services/acp.rs
///   services/acp.rs ↔ agent subprocess (stdin/stdout JSON-RPC)
///   services/acp.rs → Channel<AcpUpdate> → Frontend (streaming updates)

use agent_client_protocol as acp;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex, RwLock};

/// Generate a random u64 for session IDs (no uuid crate needed).
fn rand_u64() -> u64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    RandomState::new().build_hasher().finish()
}

// ---------------------------------------------------------------------------
// Types shared with frontend (serialized over IPC)
// ---------------------------------------------------------------------------

/// Connection state for an ACP agent
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AcpConnectionState {
    Connecting,
    Connected,
    Error(String),
    Disconnected,
}

/// A streamed update from the agent, sent to the frontend via Tauri Channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AcpUpdate {
    /// Connection state changed
    #[serde(rename_all = "camelCase")]
    ConnectionState { state: AcpConnectionState },
    /// Agent sent a text message chunk
    #[serde(rename_all = "camelCase")]
    MessageChunk { text: String },
    /// Agent reported a tool call
    #[serde(rename_all = "camelCase")]
    ToolCall {
        tool_call_id: String,
        title: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        kind: Option<String>,
    },
    /// Agent updated a tool call status
    #[serde(rename_all = "camelCase")]
    ToolCallUpdate {
        tool_call_id: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        content_text: Option<String>,
    },
    /// Agent shared its plan
    #[serde(rename_all = "camelCase")]
    Plan {
        entries: Vec<AcpPlanEntry>,
    },
    /// Agent is requesting permission for a tool call
    #[serde(rename_all = "camelCase")]
    PermissionRequest {
        request_id: String,
        tool_call_id: String,
        title: String,
        options: Vec<AcpPermissionOption>,
    },
    /// Agent sent a thought chunk (extended thinking)
    #[serde(rename_all = "camelCase")]
    ThoughtChunk { text: String },
    /// Prompt turn completed
    #[serde(rename_all = "camelCase")]
    PromptComplete { stop_reason: String },
    /// Agent process exited
    #[serde(rename_all = "camelCase")]
    ProcessExited {
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPlanEntry {
    pub title: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

/// Configuration for spawning an ACP agent
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentConfig {
    /// Command to launch the agent (e.g., "claude", "gemini")
    pub command: String,
    /// Arguments to pass (e.g., ["--acp"])
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory for the agent
    #[serde(default)]
    pub cwd: Option<String>,
    /// Additional environment variables
    #[serde(default)]
    pub env: HashMap<String, String>,
}

// ---------------------------------------------------------------------------
// Type aliases (avoid triple-angle-bracket parsing issues)
// ---------------------------------------------------------------------------

type PendingRequestMap = HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>;
type PendingPermissionMap = HashMap<String, tokio::sync::oneshot::Sender<AcpPermissionResponse>>;

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

/// An active ACP session with an agent subprocess
struct AcpSession {
    /// The agent child process
    _child: Child,
    /// Writer to agent's stdin (for sending JSON-RPC messages)
    stdin_tx: mpsc::Sender<String>,
    /// ACP session ID returned by the agent
    acp_session_id: Option<String>,
    /// Next JSON-RPC request ID
    next_request_id: u64,
    /// Pending request responses (id → oneshot sender)
    pending_requests: Arc<Mutex<PendingRequestMap>>,
    /// Pending permission responses (request_id string → oneshot sender)
    pending_permissions: Arc<Mutex<PendingPermissionMap>>,
}

/// Permission response from the frontend
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionResponse {
    pub option_id: String,
}

// ---------------------------------------------------------------------------
// ACP Manager — owns all sessions
// ---------------------------------------------------------------------------

/// Manages all ACP agent sessions.
///
/// Thread-safe (wrapped in Arc<RwLock<>>), stored in Tauri state.
pub struct AcpManager {
    sessions: RwLock<HashMap<String, AcpSession>>,
}

impl AcpManager {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    /// Spawn a new ACP agent subprocess and establish a session.
    ///
    /// Returns a pane-local session ID (not the ACP session ID, which comes later).
    /// The `channel` receives streaming updates for the frontend.
    pub async fn spawn_agent(
        &self,
        config: AcpAgentConfig,
        channel: Channel<AcpUpdate>,
    ) -> Result<String, String> {
        let pane_session_id = format!(
            "acp-{:016x}{:016x}",
            rand_u64(),
            rand_u64(),
        );

        // Emit connecting state
        let _ = channel.send(AcpUpdate::ConnectionState {
            state: AcpConnectionState::Connecting,
        });

        // Build the subprocess command
        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if let Some(ref cwd) = config.cwd {
            cmd.current_dir(cwd);
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }

        let mut child = cmd.spawn().map_err(|e| {
            let msg = format!("Failed to spawn agent '{}': {}", config.command, e);
            tracing::error!("{}", msg);
            let _ = channel.send(AcpUpdate::ConnectionState {
                state: AcpConnectionState::Error(msg.clone()),
            });
            msg
        })?;

        tracing::info!(
            command = %config.command,
            session_id = %pane_session_id,
            pid = ?child.id(),
            "ACP agent process spawned"
        );

        let stdout = child.stdout.take()
            .ok_or_else(|| "Failed to capture agent stdout".to_string())?;
        let stdin = child.stdin.take()
            .ok_or_else(|| "Failed to capture agent stdin".to_string())?;
        let stderr = child.stderr.take();

        // Channel for sending messages to agent's stdin
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);

        // Shared state for request/response correlation
        let pending_requests: Arc<Mutex<PendingRequestMap>> =
            Arc::new(Mutex::new(HashMap::new()));
        let pending_permissions: Arc<Mutex<PendingPermissionMap>> =
            Arc::new(Mutex::new(HashMap::new()));

        // Stdin writer task: reads from channel, writes to agent stdin
        let stdin_session_id = pane_session_id.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(msg) = stdin_rx.recv().await {
                if let Err(e) = stdin.write_all(msg.as_bytes()).await {
                    tracing::error!(session_id = %stdin_session_id, error = %e, "Failed to write to agent stdin");
                    break;
                }
                if let Err(e) = stdin.write_all(b"\n").await {
                    tracing::error!(session_id = %stdin_session_id, error = %e, "Failed to write newline to agent stdin");
                    break;
                }
                if let Err(e) = stdin.flush().await {
                    tracing::error!(session_id = %stdin_session_id, error = %e, "Failed to flush agent stdin");
                    break;
                }
            }
            tracing::debug!(session_id = %stdin_session_id, "Stdin writer task ended");
        });

        // Stderr reader task: log agent stderr
        if let Some(stderr) = stderr {
            let stderr_session_id = pane_session_id.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(session_id = %stderr_session_id, agent_stderr = %line, "Agent stderr");
                }
            });
        }

        // Stdout reader task: parse JSON-RPC messages, dispatch to channel
        let stdout_channel = channel.clone();
        let stdout_pending = Arc::clone(&pending_requests);
        let stdout_permissions = Arc::clone(&pending_permissions);
        let stdout_session_id = pane_session_id.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }

                // Parse as JSON-RPC message
                let msg: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            session_id = %stdout_session_id,
                            error = %e,
                            line = %line,
                            "Failed to parse agent message as JSON"
                        );
                        continue;
                    }
                };

                // Check if this is a response to one of our requests
                if let Some(id) = msg.get("id").and_then(|v| v.as_u64()) {
                    if msg.get("result").is_some() || msg.get("error").is_some() {
                        let mut pending = stdout_pending.lock().await;
                        if let Some(tx) = pending.remove(&id) {
                            let _ = tx.send(msg);
                            continue;
                        }
                    }
                }

                // Check if this is a notification (no "id" field, has "method")
                if let Some(method) = msg.get("method").and_then(|v| v.as_str()) {
                    dispatch_notification(
                        method,
                        msg.get("params"),
                        &stdout_channel,
                        &stdout_permissions,
                        &stdout_session_id,
                    ).await;
                    continue;
                }

                // Check if this is a request FROM the agent (has "id" and "method")
                if msg.get("id").is_some() && msg.get("method").is_some() {
                    let method = msg["method"].as_str().unwrap_or("");
                    let id = msg["id"].clone();
                    tracing::debug!(
                        session_id = %stdout_session_id,
                        method = %method,
                        "Agent-initiated request (not yet handled)"
                    );
                    // TODO: Handle agent-initiated requests (fs/read_text_file, terminal/*, etc.)
                    // For now, respond with "method not found"
                    // This would require access to stdin_tx which we don't have here yet.
                    // Will be wired up in a follow-up.
                    continue;
                }

                tracing::debug!(
                    session_id = %stdout_session_id,
                    msg = %line,
                    "Unhandled agent message"
                );
            }

            tracing::info!(session_id = %stdout_session_id, "Agent stdout reader ended");
            let _ = stdout_channel.send(AcpUpdate::ProcessExited { exit_code: None });
            let _ = stdout_channel.send(AcpUpdate::ConnectionState {
                state: AcpConnectionState::Disconnected,
            });
        });

        // Store the session
        let session = AcpSession {
            _child: child,
            stdin_tx,
            acp_session_id: None,
            next_request_id: 1,
            pending_requests,
            pending_permissions,
        };

        self.sessions.write().await.insert(pane_session_id.clone(), session);

        // Perform ACP initialization handshake
        self.initialize_session(&pane_session_id, &config, &channel).await?;

        Ok(pane_session_id)
    }

    /// Perform the ACP initialization handshake (initialize + new session).
    async fn initialize_session(
        &self,
        pane_session_id: &str,
        config: &AcpAgentConfig,
        channel: &Channel<AcpUpdate>,
    ) -> Result<(), String> {
        // Send initialize request
        let init_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {
                        "readTextFile": true,
                        "writeTextFile": true
                    },
                    "terminal": true
                },
                "clientInfo": {
                    "name": "floatty",
                    "title": "floatty",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        });

        let init_response = self.send_request(pane_session_id, 0, init_request).await?;

        // Check for errors
        if let Some(error) = init_response.get("error") {
            let msg = format!("ACP initialization failed: {}", error);
            tracing::error!(session_id = %pane_session_id, "{}", msg);
            let _ = channel.send(AcpUpdate::ConnectionState {
                state: AcpConnectionState::Error(msg.clone()),
            });
            return Err(msg);
        }

        let agent_caps = init_response.get("result")
            .and_then(|r| r.get("agentCapabilities"));
        tracing::info!(
            session_id = %pane_session_id,
            agent_capabilities = ?agent_caps,
            "ACP initialization complete"
        );

        // Send new session request
        let cwd = config.cwd.clone()
            .unwrap_or_else(|| std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("/"))
                .to_string_lossy()
                .to_string());

        let new_session_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session/new",
            "params": {
                "cwd": cwd,
                "mcpServers": []
            }
        });

        let session_response = self.send_request(pane_session_id, 1, new_session_request).await?;

        if let Some(error) = session_response.get("error") {
            let msg = format!("ACP session creation failed: {}", error);
            tracing::error!(session_id = %pane_session_id, "{}", msg);
            let _ = channel.send(AcpUpdate::ConnectionState {
                state: AcpConnectionState::Error(msg.clone()),
            });
            return Err(msg);
        }

        // Store the ACP session ID
        let acp_session_id = session_response.get("result")
            .and_then(|r| r.get("sessionId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        if let Some(ref sid) = acp_session_id {
            let mut sessions = self.sessions.write().await;
            if let Some(session) = sessions.get_mut(pane_session_id) {
                session.acp_session_id = Some(sid.clone());
            }
        }

        tracing::info!(
            session_id = %pane_session_id,
            acp_session_id = ?acp_session_id,
            "ACP session created"
        );

        let _ = channel.send(AcpUpdate::ConnectionState {
            state: AcpConnectionState::Connected,
        });

        Ok(())
    }

    /// Send a JSON-RPC request to the agent and wait for the response.
    async fn send_request(
        &self,
        pane_session_id: &str,
        request_id: u64,
        message: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let sessions = self.sessions.read().await;
        let session = sessions.get(pane_session_id)
            .ok_or_else(|| format!("Session {} not found", pane_session_id))?;

        // Register a oneshot for the response
        let (tx, rx) = tokio::sync::oneshot::channel();
        session.pending_requests.lock().await.insert(request_id, tx);

        // Send the message
        let msg_str = serde_json::to_string(&message)
            .map_err(|e| format!("Failed to serialize request: {}", e))?;

        session.stdin_tx.send(msg_str).await
            .map_err(|e| format!("Failed to send to agent stdin: {}", e))?;

        drop(sessions); // Release read lock while waiting

        // Wait for response with timeout
        match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => Err("Response channel closed".to_string()),
            Err(_) => Err("Request timed out (30s)".to_string()),
        }
    }

    /// Send a prompt to the agent.
    pub async fn send_prompt(
        &self,
        pane_session_id: &str,
        text: String,
    ) -> Result<(), String> {
        let sessions = self.sessions.read().await;
        let session = sessions.get(pane_session_id)
            .ok_or_else(|| format!("Session {} not found", pane_session_id))?;

        let acp_session_id = session.acp_session_id.as_ref()
            .ok_or_else(|| "ACP session not yet initialized".to_string())?
            .clone();

        // Get next request ID
        // Note: In a production implementation this would be atomic.
        // For now, prompts use IDs starting at 100 to avoid colliding with init.
        let request_id = 100; // Simplified — real impl would use AtomicU64

        let prompt_request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/prompt",
            "params": {
                "sessionId": acp_session_id,
                "prompt": [{
                    "type": "text",
                    "text": text
                }]
            }
        });

        let msg_str = serde_json::to_string(&prompt_request)
            .map_err(|e| format!("Failed to serialize prompt: {}", e))?;

        session.stdin_tx.send(msg_str).await
            .map_err(|e| format!("Failed to send prompt: {}", e))?;

        // Note: The response will come asynchronously via the stdout reader task,
        // which will emit it through the channel. The prompt response (stop_reason)
        // arrives after all session/update notifications have been sent.

        Ok(())
    }

    /// Respond to a permission request from the agent.
    pub async fn respond_permission(
        &self,
        pane_session_id: &str,
        request_id: String,
        response: AcpPermissionResponse,
    ) -> Result<(), String> {
        let sessions = self.sessions.read().await;
        let session = sessions.get(pane_session_id)
            .ok_or_else(|| format!("Session {} not found", pane_session_id))?;

        let mut pending = session.pending_permissions.lock().await;
        if let Some(tx) = pending.remove(&request_id) {
            let _ = tx.send(response);
            Ok(())
        } else {
            Err(format!("No pending permission request with id {}", request_id))
        }
    }

    /// Cancel the current prompt.
    pub async fn cancel_prompt(
        &self,
        pane_session_id: &str,
    ) -> Result<(), String> {
        let sessions = self.sessions.read().await;
        let session = sessions.get(pane_session_id)
            .ok_or_else(|| format!("Session {} not found", pane_session_id))?;

        let acp_session_id = session.acp_session_id.as_ref()
            .ok_or_else(|| "ACP session not yet initialized".to_string())?
            .clone();

        // Cancel is a notification (no id, no response expected)
        let cancel = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/cancel",
            "params": {
                "sessionId": acp_session_id
            }
        });

        let msg_str = serde_json::to_string(&cancel)
            .map_err(|e| format!("Failed to serialize cancel: {}", e))?;

        session.stdin_tx.send(msg_str).await
            .map_err(|e| format!("Failed to send cancel: {}", e))?;

        Ok(())
    }

    /// Kill an ACP session and its agent subprocess.
    pub async fn kill_session(
        &self,
        pane_session_id: &str,
    ) -> Result<(), String> {
        let mut sessions = self.sessions.write().await;
        if let Some(mut session) = sessions.remove(pane_session_id) {
            // Kill the child process
            if let Err(e) = session._child.kill().await {
                tracing::warn!(
                    session_id = %pane_session_id,
                    error = %e,
                    "Failed to kill agent process (may have already exited)"
                );
            }
            tracing::info!(session_id = %pane_session_id, "ACP session killed");
        }
        Ok(())
    }

    /// Kill all sessions (called on app shutdown).
    pub async fn kill_all(&self) {
        let mut sessions = self.sessions.write().await;
        for (id, mut session) in sessions.drain() {
            if let Err(e) = session._child.kill().await {
                tracing::warn!(
                    session_id = %id,
                    error = %e,
                    "Failed to kill agent on shutdown"
                );
            }
        }
        tracing::info!("All ACP sessions killed");
    }

    /// Check if a session exists.
    pub async fn has_session(&self, pane_session_id: &str) -> bool {
        self.sessions.read().await.contains_key(pane_session_id)
    }
}

// ---------------------------------------------------------------------------
// Notification dispatch
// ---------------------------------------------------------------------------

/// Dispatch an ACP notification from the agent to the frontend channel.
async fn dispatch_notification(
    method: &str,
    params: Option<&serde_json::Value>,
    channel: &Channel<AcpUpdate>,
    pending_permissions: &Arc<Mutex<PendingPermissionMap>>,
    session_id: &str,
) {
    let params = match params {
        Some(p) => p,
        None => return,
    };

    match method {
        "session/update" => {
            if let Some(update) = params.get("update") {
                dispatch_session_update(update, channel, pending_permissions, session_id).await;
            }
        }
        _ => {
            tracing::debug!(
                session_id = %session_id,
                method = %method,
                "Unhandled ACP notification"
            );
        }
    }
}

/// Dispatch a session update to the frontend.
async fn dispatch_session_update(
    update: &serde_json::Value,
    channel: &Channel<AcpUpdate>,
    _pending_permissions: &Arc<Mutex<PendingPermissionMap>>,
    session_id: &str,
) {
    let update_type = update.get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match update_type {
        "agent_message_chunk" => {
            if let Some(content) = update.get("content") {
                let content_type = content.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if content_type == "text" {
                    if let Some(text) = content.get("text").and_then(|v| v.as_str()) {
                        let _ = channel.send(AcpUpdate::MessageChunk {
                            text: text.to_string(),
                        });
                    }
                }
            }
        }
        "agent_thought_chunk" => {
            if let Some(content) = update.get("content") {
                if let Some(text) = content.get("text").and_then(|v| v.as_str()) {
                    let _ = channel.send(AcpUpdate::ThoughtChunk {
                        text: text.to_string(),
                    });
                }
            }
        }
        "tool_call" => {
            let _ = channel.send(AcpUpdate::ToolCall {
                tool_call_id: update.get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                title: update.get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                status: update.get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                kind: update.get("kind")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            });
        }
        "tool_call_update" => {
            let content_text = update.get("content")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let _ = channel.send(AcpUpdate::ToolCallUpdate {
                tool_call_id: update.get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                status: update.get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                content_text,
            });
        }
        "plan" => {
            if let Some(entries) = update.get("entries").and_then(|v| v.as_array()) {
                let plan_entries: Vec<AcpPlanEntry> = entries.iter().map(|e| {
                    AcpPlanEntry {
                        title: e.get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        status: e.get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("pending")
                            .to_string(),
                    }
                }).collect();

                let _ = channel.send(AcpUpdate::Plan { entries: plan_entries });
            }
        }
        _ => {
            tracing::debug!(
                session_id = %session_id,
                update_type = %update_type,
                "Unhandled session update type"
            );
        }
    }
}
