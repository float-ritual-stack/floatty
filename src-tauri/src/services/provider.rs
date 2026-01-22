/// Provider-Aware Conversation Execution
///
/// Routes conversation execution to different LLM backends based on provider configuration.
/// Supports Ollama (default), Claude Code CLI, and Anthropic API.
///
/// @see FLO-187 Provider-Aware Dispatch System

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use super::execution::{execute_ai_conversation, ChatMessage};

// ═══════════════════════════════════════════════════════════════
// PROVIDER TYPES
// ═══════════════════════════════════════════════════════════════

/// Provider configuration - matches TypeScript ProviderConfig
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
pub enum Provider {
    /// Default Ollama backend
    #[serde(rename = "ollama")]
    Ollama {
        model: Option<String>,
        #[serde(rename = "blockId")]
        block_id: String,
    },

    /// Claude Code CLI backend
    #[serde(rename = "claude-code")]
    ClaudeCode {
        project: Option<String>,
        #[serde(rename = "sessionId")]
        session_id: Option<String>,
        #[serde(rename = "blockId")]
        block_id: String,
    },

    /// Anthropic API backend (future)
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

/// Response from provider execution
#[derive(Debug, Clone, Serialize)]
pub struct ProviderResponse {
    /// Response content
    pub content: String,
    /// Session ID (for Claude Code CLI)
    pub session_id: Option<String>,
    /// Provider type that generated response
    pub provider_type: String,
}

// ═══════════════════════════════════════════════════════════════
// PROVIDER ROUTING
// ═══════════════════════════════════════════════════════════════

/// Execute conversation with provider-aware routing
///
/// Routes to appropriate backend based on provider configuration.
pub async fn execute_with_provider(
    provider: Provider,
    messages: Vec<ChatMessage>,
    model_override: Option<String>,
    system: Option<String>,
    endpoint: String,
    default_model: String,
    max_bytes: usize,
) -> Result<ProviderResponse, String> {
    match provider {
        Provider::Ollama { model, .. } => {
            // Use override > provider model > default
            let effective_model = model_override
                .or(model)
                .unwrap_or(default_model);

            let content = execute_ai_conversation(
                messages,
                endpoint,
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
                provider_type: "ollama".to_string(),
            })
        }

        Provider::ClaudeCode {
            project,
            session_id,
            ..
        } => {
            execute_claude_cli(messages, session_id, project, max_bytes).await
        }

        Provider::Anthropic { model, .. } => {
            // For now, Anthropic routes through Ollama (future: direct API)
            tracing::warn!(
                model = ?model,
                "Anthropic provider not yet implemented, falling back to Ollama"
            );

            let effective_model = model_override
                .or(model)
                .unwrap_or(default_model);

            let content = execute_ai_conversation(
                messages,
                endpoint,
                effective_model,
                None,
                None,
                system,
                max_bytes,
            )
            .await?;

            Ok(ProviderResponse {
                content,
                session_id: None,
                provider_type: "anthropic".to_string(),
            })
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// CLAUDE CODE CLI EXECUTION
// ═══════════════════════════════════════════════════════════════

/// Execute conversation via Claude Code CLI
///
/// Invokes: `claude -p "{prompt}" --output-format json [--resume session_id]`
async fn execute_claude_cli(
    messages: Vec<ChatMessage>,
    session_id: Option<String>,
    project: Option<String>,
    max_bytes: usize,
) -> Result<ProviderResponse, String> {
    let start = Instant::now();

    // Build prompt from messages
    let prompt = build_prompt_from_messages(&messages);

    tracing::info!(
        session_id = ?session_id,
        project = ?project,
        prompt_len = prompt.len(),
        "Claude Code CLI execution requested"
    );

    // Build command
    let mut cmd = Command::new("claude");

    // Add prompt
    cmd.arg("-p").arg(&prompt);

    // Resume session if we have one
    if let Some(ref sid) = session_id {
        cmd.arg("--resume").arg(sid);
    }

    // Output format for parsing session ID
    // Note: stream-json with -p requires --verbose flag
    cmd.arg("--output-format").arg("stream-json");
    cmd.arg("--verbose");

    // Set working directory if project specified
    if let Some(ref proj) = project {
        // Expand ~ if present
        let project_path = if proj.starts_with("~/") {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(&proj[2..])
        } else {
            std::path::PathBuf::from(proj)
        };

        if project_path.exists() {
            cmd.current_dir(&project_path);
            tracing::debug!(path = ?project_path, "Set working directory to project");
        } else {
            tracing::warn!(path = ?project_path, "Project directory does not exist, using current dir");
        }
    }

    // Capture stdout/stderr
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Spawn process
    let mut child = cmd.spawn().map_err(|e| {
        tracing::error!(error = %e, "Failed to spawn claude command");
        format!("Failed to spawn claude: {}. Is Claude Code CLI installed?", e)
    })?;

    // Read stdout line by line for streaming JSON
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    let mut response_content = String::new();
    let mut new_session_id: Option<String> = None;

    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        // Each line is a JSON object in stream-json format
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
            // Check for session info
            if let Some(session) = parsed.get("session_id").and_then(|v| v.as_str()) {
                new_session_id = Some(session.to_string());
            }

            // Check for content
            if let Some(content) = parsed.get("content").and_then(|v| v.as_str()) {
                response_content.push_str(content);
            }

            // Check for text content in messages
            if let Some(result) = parsed.get("result") {
                if let Some(content) = result.as_str() {
                    response_content.push_str(content);
                }
            }

            // Handle assistant message type
            if parsed.get("type").and_then(|v| v.as_str()) == Some("assistant") {
                if let Some(message) = parsed.get("message") {
                    if let Some(content) = message.get("content").and_then(|v| v.as_array()) {
                        for part in content {
                            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                                response_content.push_str(text);
                            }
                        }
                    }
                }
            }
        }
    }

    // Also capture stderr for error messages
    let stderr = child.stderr.take();

    // Wait for process to complete
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let duration_ms = start.elapsed().as_millis() as u64;

    if !status.success() {
        // Read stderr for error details
        let stderr_content = if let Some(stderr) = stderr {
            let mut stderr_reader = BufReader::new(stderr);
            let mut stderr_buf = String::new();
            let _ = tokio::io::AsyncReadExt::read_to_string(&mut stderr_reader, &mut stderr_buf).await;
            stderr_buf
        } else {
            String::new()
        };

        tracing::error!(
            exit_code = ?status.code(),
            duration_ms = duration_ms,
            stderr = %stderr_content,
            response_so_far = %response_content,
            "Claude Code CLI failed"
        );
        return Err(format!(
            "Claude Code CLI exited with status: {:?}. stderr: {}",
            status.code(),
            stderr_content.trim()
        ));
    }

    tracing::info!(
        session_id = ?new_session_id.as_ref().or(session_id.as_ref()),
        duration_ms = duration_ms,
        response_bytes = response_content.len(),
        "Claude Code CLI succeeded"
    );

    // Truncate if needed
    let final_content = if response_content.len() > max_bytes {
        truncate_at_char_boundary(&response_content, max_bytes)
    } else {
        response_content
    };

    Ok(ProviderResponse {
        content: final_content,
        session_id: new_session_id.or(session_id),
        provider_type: "claude-code".to_string(),
    })
}

/// Build a prompt string from conversation messages
fn build_prompt_from_messages(messages: &[ChatMessage]) -> String {
    // For Claude Code CLI, we send the last user message as the prompt
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
// TESTS
// ═══════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_provider_deserialization_ollama() {
        let json = r#"{"type": "ollama", "model": "qwen2.5:7b", "blockId": "block1"}"#;
        let provider: Provider = serde_json::from_str(json).unwrap();

        match provider {
            Provider::Ollama { model, block_id } => {
                assert_eq!(model, Some("qwen2.5:7b".to_string()));
                assert_eq!(block_id, "block1");
            }
            _ => panic!("Expected Ollama variant"),
        }
    }

    #[test]
    fn test_provider_deserialization_claude_code() {
        let json =
            r#"{"type": "claude-code", "project": "float-hub", "sessionId": "abc123", "blockId": "block2"}"#;
        let provider: Provider = serde_json::from_str(json).unwrap();

        match provider {
            Provider::ClaudeCode {
                project,
                session_id,
                block_id,
            } => {
                assert_eq!(project, Some("float-hub".to_string()));
                assert_eq!(session_id, Some("abc123".to_string()));
                assert_eq!(block_id, "block2");
            }
            _ => panic!("Expected ClaudeCode variant"),
        }
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
    fn test_truncate_at_char_boundary() {
        let text = "Hello\nWorld\nThis is long";
        let truncated = truncate_at_char_boundary(text, 15);
        assert!(truncated.contains("Hello\nWorld"));
        assert!(truncated.contains("[truncated:"));
    }
}
