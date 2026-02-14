/// Tauri command wrappers for ACP (Agent Client Protocol) services
///
/// Thin adapters that extract state and delegate to services::acp.
/// Frontend calls these via invoke('acp_*', { ... }).

use crate::services::acp::{AcpAgentConfig, AcpManager, AcpPermissionResponse, AcpUpdate};
use tauri::ipc::Channel;
use tauri::State;

/// Spawn an ACP agent subprocess and establish a session.
///
/// Returns a pane-local session ID. The `on_update` channel receives
/// streaming updates (message chunks, tool calls, plans, permissions).
#[tauri::command]
pub async fn acp_spawn_agent(
    config: AcpAgentConfig,
    on_update: Channel<AcpUpdate>,
    acp_manager: State<'_, AcpManager>,
) -> Result<String, String> {
    acp_manager.spawn_agent(config, on_update).await
}

/// Send a text prompt to an active ACP session.
///
/// The response arrives asynchronously via the on_update channel
/// (as MessageChunk, ToolCall, etc. updates, then PromptComplete).
#[tauri::command]
pub async fn acp_send_prompt(
    session_id: String,
    text: String,
    acp_manager: State<'_, AcpManager>,
) -> Result<(), String> {
    acp_manager.send_prompt(&session_id, text).await
}

/// Respond to a permission request from the agent.
///
/// Called when the user clicks allow/reject on a permission dialog
/// in the AcpPane component.
#[tauri::command]
pub async fn acp_respond_permission(
    session_id: String,
    request_id: String,
    option_id: String,
    acp_manager: State<'_, AcpManager>,
) -> Result<(), String> {
    acp_manager.respond_permission(
        &session_id,
        request_id,
        AcpPermissionResponse { option_id },
    ).await
}

/// Cancel the current prompt turn.
#[tauri::command]
pub async fn acp_cancel_prompt(
    session_id: String,
    acp_manager: State<'_, AcpManager>,
) -> Result<(), String> {
    acp_manager.cancel_prompt(&session_id).await
}

/// Kill an ACP session and its agent subprocess.
///
/// Called when the ACP pane is closed.
#[tauri::command]
pub async fn acp_kill_session(
    session_id: String,
    acp_manager: State<'_, AcpManager>,
) -> Result<(), String> {
    acp_manager.kill_session(&session_id).await
}
