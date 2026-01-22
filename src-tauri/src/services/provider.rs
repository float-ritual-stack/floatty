/// Provider-Aware Conversation Execution (Config-Driven)
///
/// Routes conversation execution to different LLM backends based on config.toml.
/// Providers are defined in [providers.NAME] sections, supporting CLI and HTTP types.
///
/// Example config:
/// ```toml
/// [providers.kitty]
/// type = "cli"
/// command = "claude"
/// args = ["-p", "{prompt}", "--output-format", "stream-json", "--verbose"]
/// resume_flag = "--resume"
/// session_field = "session_id"
/// ```
///
/// @see FLO-187 Provider-Aware Dispatch System

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::execution::{execute_ai_conversation, ChatMessage};
use crate::config::{AggregatorConfig, CliProviderConfig, HttpProviderConfig, ProviderConfig};

// ═══════════════════════════════════════════════════════════════
// PROVIDER REQUEST (from TypeScript)
// ═══════════════════════════════════════════════════════════════

/// Provider request from TypeScript - just the name and overrides.
/// Config lookup happens on Rust side.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProviderRequest {
    /// Provider name (e.g., "kitty", "ollama", "gemini")
    pub name: String,

    /// Block ID where provider was defined
    #[serde(rename = "blockId")]
    pub block_id: String,

    /// Working directory override (from ai::kitty float-hub)
    #[serde(rename = "workingDir")]
    pub working_dir: Option<String>,

    /// Session ID for resuming conversations
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,

    /// Model override
    pub model: Option<String>,
}

impl Default for ProviderRequest {
    fn default() -> Self {
        Self {
            name: "ollama".to_string(),
            block_id: String::new(),
            working_dir: None,
            session_id: None,
            model: None,
        }
    }
}

/// Response from provider execution
#[derive(Debug, Clone, Serialize)]
pub struct ProviderResponse {
    /// Response content
    pub content: String,
    /// Session ID (for CLI providers with session support)
    pub session_id: Option<String>,
    /// Provider name that generated response
    pub provider_name: String,
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER ROUTING
// ═══════════════════════════════════════════════════════════════

/// Execute conversation with config-driven provider routing.
///
/// Looks up provider by name in config.providers, then routes to
/// appropriate executor (CLI or HTTP).
pub async fn execute_with_provider(
    request: ProviderRequest,
    messages: Vec<ChatMessage>,
    model_override: Option<String>,
    system: Option<String>,
    config: &AggregatorConfig,
) -> Result<ProviderResponse, String> {
    let provider_name = &request.name;

    // Look up provider in config
    let provider_config = config.providers.get(provider_name).ok_or_else(|| {
        format!(
            "Unknown provider '{}'. Available: {:?}",
            provider_name,
            config.providers.keys().collect::<Vec<_>>()
        )
    })?;

    tracing::info!(
        provider = %provider_name,
        working_dir = ?request.working_dir,
        session_id = ?request.session_id,
        "Routing to provider"
    );

    match provider_config {
        ProviderConfig::Cli(cli_config) => {
            execute_cli_provider(
                cli_config,
                &request,
                &messages,
                config.max_shell_output_bytes,
            )
            .await
        }

        ProviderConfig::Http(http_config) => {
            execute_http_provider(
                http_config,
                &request,
                messages,
                model_override,
                system,
                config.max_shell_output_bytes,
            )
            .await
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// CLI PROVIDER EXECUTION
// ═══════════════════════════════════════════════════════════════

/// Execute conversation via CLI provider (claude, gemini, amp, opencode, etc.)
async fn execute_cli_provider(
    config: &CliProviderConfig,
    request: &ProviderRequest,
    messages: &[ChatMessage],
    max_bytes: usize,
) -> Result<ProviderResponse, String> {
    let start = Instant::now();

    // Build prompt from messages
    let prompt = build_prompt_from_messages(messages);

    tracing::info!(
        command = %config.command,
        session_id = ?request.session_id,
        working_dir = ?request.working_dir.as_ref().or(config.working_dir.as_ref()),
        prompt_len = prompt.len(),
        "CLI provider execution requested"
    );

    // Build command
    let mut cmd = Command::new(&config.command);

    // Add configured args with {prompt} substitution
    for arg in &config.args {
        if arg == "{prompt}" {
            cmd.arg(&prompt);
        } else {
            cmd.arg(arg);
        }
    }

    // Resume session if we have one and provider supports it
    if let (Some(ref sid), Some(ref resume_flag)) = (&request.session_id, &config.resume_flag) {
        cmd.arg(resume_flag).arg(sid);
    }

    // Set working directory: request override > config default
    let working_dir = request
        .working_dir
        .as_ref()
        .or(config.working_dir.as_ref());

    if let Some(ref dir) = working_dir {
        let path = expand_tilde(dir);
        if path.exists() {
            cmd.current_dir(&path);
            tracing::debug!(path = ?path, "Set working directory");
        } else {
            tracing::warn!(path = ?path, "Working directory does not exist, using current dir");
        }
    }

    // Capture stdout/stderr
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Spawn process
    let mut child = cmd.spawn().map_err(|e| {
        tracing::error!(command = %config.command, error = %e, "Failed to spawn CLI");
        format!(
            "Failed to spawn '{}': {}. Is the CLI installed?",
            config.command, e
        )
    })?;

    // Read stdout line by line
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let mut response_content = String::new();
    let mut new_session_id: Option<String> = None;

    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        // Try to parse as JSON for session extraction
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            // Extract session ID if configured
            if let Some(ref field) = config.session_field {
                if let Some(session) = parsed.get(field).and_then(|v| v.as_str()) {
                    new_session_id = Some(session.to_string());
                }
            }

            // Extract content from various JSON formats
            extract_content_from_json(&parsed, &mut response_content);
        } else {
            // Plain text output
            response_content.push_str(&line);
            response_content.push('\n');
        }
    }

    // Capture stderr
    let stderr = child.stderr.take();

    // Wait for process
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let duration_ms = start.elapsed().as_millis() as u64;

    if !status.success() {
        let stderr_content = read_stderr(stderr).await;

        tracing::error!(
            command = %config.command,
            exit_code = ?status.code(),
            duration_ms = duration_ms,
            stderr = %stderr_content,
            "CLI provider failed"
        );
        return Err(format!(
            "'{}' exited with status: {:?}. stderr: {}",
            config.command,
            status.code(),
            stderr_content.trim()
        ));
    }

    tracing::info!(
        command = %config.command,
        session_id = ?new_session_id.as_ref().or(request.session_id.as_ref()),
        duration_ms = duration_ms,
        response_bytes = response_content.len(),
        "CLI provider succeeded"
    );

    // Truncate if needed
    let final_content = if response_content.len() > max_bytes {
        truncate_at_char_boundary(&response_content, max_bytes)
    } else {
        response_content
    };

    Ok(ProviderResponse {
        content: final_content.trim().to_string(),
        session_id: new_session_id.or_else(|| request.session_id.clone()),
        provider_name: request.name.clone(),
    })
}

/// Extract content from various JSON response formats (Claude, Gemini, etc.)
fn extract_content_from_json(parsed: &serde_json::Value, content: &mut String) {
    // Direct content field
    if let Some(c) = parsed.get("content").and_then(|v| v.as_str()) {
        content.push_str(c);
    }

    // Result field
    if let Some(result) = parsed.get("result") {
        if let Some(c) = result.as_str() {
            content.push_str(c);
        }
    }

    // Claude-style assistant message
    if parsed.get("type").and_then(|v| v.as_str()) == Some("assistant") {
        if let Some(message) = parsed.get("message") {
            if let Some(content_array) = message.get("content").and_then(|v| v.as_array()) {
                for part in content_array {
                    if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                        content.push_str(text);
                    }
                }
            }
        }
    }

    // Text field (Gemini style)
    if let Some(c) = parsed.get("text").and_then(|v| v.as_str()) {
        content.push_str(c);
    }
}

// ═══════════════════════════════════════════════════════════════
// HTTP PROVIDER EXECUTION
// ═══════════════════════════════════════════════════════════════

/// Execute conversation via HTTP API provider (Ollama, Anthropic, etc.)
async fn execute_http_provider(
    config: &HttpProviderConfig,
    request: &ProviderRequest,
    messages: Vec<ChatMessage>,
    model_override: Option<String>,
    system: Option<String>,
    max_bytes: usize,
) -> Result<ProviderResponse, String> {
    // Use model override > request model > config model > default
    let effective_model = model_override
        .or_else(|| request.model.clone())
        .or_else(|| config.model.clone())
        .unwrap_or_else(|| "qwen2.5:7b".to_string());

    tracing::info!(
        endpoint = %config.endpoint,
        model = %effective_model,
        "HTTP provider execution requested"
    );

    let content = execute_ai_conversation(
        messages,
        config.endpoint.clone(),
        effective_model,
        None, // max_tokens
        None, // temperature
        system,
        max_bytes,
    )
    .await?;

    Ok(ProviderResponse {
        content,
        session_id: None,
        provider_name: request.name.clone(),
    })
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

/// Build a prompt string from conversation messages
fn build_prompt_from_messages(messages: &[ChatMessage]) -> String {
    // For CLI providers, send the last user message as the prompt
    // The CLI manages its own conversation history via session
    if let Some(last_user) = messages.iter().rev().find(|m| m.role == "user") {
        return last_user.content.clone();
    }

    // Fallback: concatenate all messages
    messages
        .iter()
        .map(|m| format!("[{}]: {}", m.role, m.content))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Expand ~ to home directory
fn expand_tilde(path: &str) -> std::path::PathBuf {
    if path.starts_with("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(&path[2..])
    } else {
        std::path::PathBuf::from(path)
    }
}

/// Read stderr from child process
async fn read_stderr(
    stderr: Option<tokio::process::ChildStderr>,
) -> String {
    if let Some(stderr) = stderr {
        let mut reader = BufReader::new(stderr);
        let mut buf = String::new();
        let _ = tokio::io::AsyncReadExt::read_to_string(&mut reader, &mut buf).await;
        buf
    } else {
        String::new()
    }
}

/// Truncate string at UTF-8 character boundary
fn truncate_at_char_boundary(text: &str, max_bytes: usize) -> String {
    let mut safe_max = max_bytes;
    while safe_max > 0 && !text.is_char_boundary(safe_max) {
        safe_max -= 1;
    }

    let cut_point = text[..safe_max].rfind('\n').unwrap_or(safe_max);

    format!(
        "{}\n\n... [truncated: {} → {} bytes]",
        &text[..cut_point],
        text.len(),
        cut_point
    )
}

// ═══════════════════════════════════════════════════════════════
// BACKWARDS COMPATIBILITY
// ═══════════════════════════════════════════════════════════════

/// Legacy Provider enum for backwards compatibility during migration.
/// Will be removed once TypeScript is updated to use ProviderRequest.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum Provider {
    #[serde(rename = "ollama")]
    Ollama {
        model: Option<String>,
        #[serde(rename = "blockId")]
        block_id: String,
    },

    #[serde(rename = "claude-code")]
    ClaudeCode {
        project: Option<String>,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        #[serde(rename = "blockId")]
        block_id: String,
    },

    #[serde(rename = "anthropic")]
    Anthropic {
        model: Option<String>,
        #[serde(rename = "blockId")]
        block_id: String,
    },
}

impl Default for Provider {
    fn default() -> Self {
        Provider::Ollama {
            model: None,
            block_id: String::new(),
        }
    }
}

/// Convert legacy Provider to ProviderRequest
impl From<Provider> for ProviderRequest {
    fn from(provider: Provider) -> Self {
        match provider {
            Provider::Ollama { model, block_id } => ProviderRequest {
                name: "ollama".to_string(),
                block_id,
                working_dir: None,
                session_id: None,
                model,
            },
            Provider::ClaudeCode {
                project,
                session_id,
                block_id,
            } => ProviderRequest {
                name: "kitty".to_string(), // Map claude-code to kitty provider
                block_id,
                working_dir: project,
                session_id,
                model: None,
            },
            Provider::Anthropic { model, block_id } => ProviderRequest {
                name: "ollama".to_string(), // Anthropic not yet supported, fallback
                block_id,
                working_dir: None,
                session_id: None,
                model,
            },
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_request_default() {
        let req = ProviderRequest::default();
        assert_eq!(req.name, "ollama");
        assert!(req.working_dir.is_none());
    }

    #[test]
    fn test_legacy_provider_conversion() {
        let legacy = Provider::ClaudeCode {
            project: Some("float-hub".to_string()),
            session_id: Some("abc123".to_string()),
            block_id: "block1".to_string(),
        };

        let request: ProviderRequest = legacy.into();
        assert_eq!(request.name, "kitty");
        assert_eq!(request.working_dir, Some("float-hub".to_string()));
        assert_eq!(request.session_id, Some("abc123".to_string()));
    }

    #[test]
    fn test_build_prompt_from_messages() {
        let messages = vec![
            ChatMessage {
                role: "user".to_string(),
                content: "Hello".to_string(),
            },
            ChatMessage {
                role: "assistant".to_string(),
                content: "Hi there!".to_string(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: "What is 2+2?".to_string(),
            },
        ];

        let prompt = build_prompt_from_messages(&messages);
        assert_eq!(prompt, "What is 2+2?");
    }

    #[test]
    fn test_expand_tilde() {
        let expanded = expand_tilde("~/projects/test");
        assert!(!expanded.to_string_lossy().contains("~"));
    }

    #[test]
    fn test_truncate_at_char_boundary() {
        let text = "Hello\nWorld\nThis is long";
        let truncated = truncate_at_char_boundary(text, 15);
        assert!(truncated.contains("Hello\nWorld"));
        assert!(truncated.contains("[truncated:"));
    }
}
