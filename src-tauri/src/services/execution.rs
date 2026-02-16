/// Shell and AI command execution services
/// 
/// Pure business logic for executing commands - minimal external dependencies.
/// Uses tokio for async execution. Testable without Tauri runtime.

use ollama_rs::{Ollama, generation::completion::request::GenerationRequest};
use std::time::Instant;

/// Execute a shell command and return stdout/stderr
///
/// # Security Model
/// This is intentionally exposed for power users - commands run with shell privileges.
/// No validation/allowlist applied since this is equivalent to the user's terminal.
/// Runs command through user's shell to inherit PATH and other environment setup.
///
/// # Arguments
/// * `command` - Shell command string to execute
/// * `max_bytes` - Maximum output size (truncates if exceeded)
///
/// # Returns
/// Tuple of (output_string, exit_code)
pub async fn execute_shell(command: String, max_bytes: usize) -> Result<(String, i32), String> {
    if command.trim().is_empty() {
        return Ok(("".to_string(), 0));
    }

    let start = Instant::now();
    let command_len = command.len();
    
    tracing::info!(command_len = command_len, "Shell command requested");

    let result = tokio::task::spawn_blocking(move || {
        // Use user's shell to inherit PATH from .zshrc/.bashrc
        // This ensures commands like `floatctl` in ~/.cargo/bin work
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());

        tracing::debug!(shell = %shell, "Executing shell command");

        let output = std::process::Command::new(&shell)
            .arg("-li")  // Login + interactive: sources .zshrc (aliases, zoxide, etc.)
            .arg("-c")   // Execute command string
            .arg(&command)
            .output()
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to spawn shell");
                format!("Failed to execute shell: {}", e)
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let exit_code = output.status.code().unwrap_or(-1);

        let result = if output.status.success() {
            stdout.to_string()
        } else {
            format!("{}\nError: {}", stdout, stderr)
        };

        // Truncate if output exceeds limit (prevents UI freeze on large output)
        let final_result = if result.len() > max_bytes {
            truncate_at_char_boundary(&result, max_bytes)
        } else {
            result
        };
        
        Ok::<(String, i32), String>((final_result, exit_code))
    }).await.map_err(|e| e.to_string())??;
    
    let duration_ms = start.elapsed().as_millis() as u64;
    
    if result.1 == 0 {
        tracing::info!(
            exit_code = result.1,
            duration_ms = duration_ms,
            output_bytes = result.0.len(),
            "Shell command succeeded"
        );
    } else {
        tracing::warn!(
            exit_code = result.1,
            duration_ms = duration_ms,
            "Shell command failed"
        );
    }
    
    Ok(result)
}

/// Parse Ollama endpoint URL into components for ollama-rs
///
/// ollama-rs expects "http://host" format separately from port
fn parse_ollama_endpoint(endpoint: &str) -> Result<(String, u16), String> {
    let url = url::Url::parse(endpoint).map_err(|e| e.to_string())?;
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("localhost");
    let port = url.port().unwrap_or(11434);
    let host_with_scheme = format!("{}://{}", scheme, host);
    Ok((host_with_scheme, port))
}

/// Execute an AI prompt using Ollama
///
/// # Arguments
/// * `prompt` - Text prompt to send to the LLM
/// * `endpoint` - Ollama endpoint URL (e.g. "http://localhost:11434")
/// * `model` - Model name (e.g. "qwen2.5:7b")
/// * `max_bytes` - Maximum response size (truncates if exceeded)
///
/// # Returns
/// Generated response text
pub async fn execute_ai(
    prompt: String,
    endpoint: String,
    model: String,
    max_bytes: usize,
) -> Result<String, String> {
    let start = Instant::now();

    let (host_with_scheme, port) = parse_ollama_endpoint(&endpoint)?;

    tracing::info!(
        model = %model,
        host = %host_with_scheme,
        port = port,
        prompt_len = prompt.len(),
        "AI command requested"
    );

    let ollama = Ollama::new(host_with_scheme, port);

    let request = GenerationRequest::new(model.clone(), prompt);

    match ollama.generate(request).await {
        Ok(res) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            let response_bytes = res.response.len();
            
            tracing::info!(
                model = %model,
                duration_ms = duration_ms,
                response_bytes = response_bytes,
                "AI command succeeded"
            );
            
            let result = res.response;
            // Truncate if output exceeds limit
            if result.len() > max_bytes {
                Ok(truncate_at_char_boundary(&result, max_bytes))
            } else {
                Ok(result)
            }
        },
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            tracing::error!(
                error = %e,
                model = %model,
                duration_ms = duration_ms,
                "AI command failed"
            );
            Err(format!("Ollama error: {}", e))
        },
    }
}

/// Truncate string at UTF-8 character boundary with truncation message
///
/// Walks backwards from max_bytes to find a valid char boundary,
/// then finds the last newline to avoid cutting mid-line.
fn truncate_at_char_boundary(text: &str, max_bytes: usize) -> String {
    // Find safe UTF-8 boundary (avoids panic on multi-byte chars like emoji)
    let mut safe_max = max_bytes;
    while safe_max > 0 && !text.is_char_boundary(safe_max) {
        safe_max -= 1;
    }
    
    // Find last newline to avoid cutting mid-line
    let cut_point = text[..safe_max].rfind('\n').unwrap_or(safe_max);
    
    format!(
        "{}\n\n... [truncated: {} → {} bytes]",
        &text[..cut_point],
        text.len(),
        cut_point
    )
}

/// Execute a multi-turn conversation using Ollama chat API
///
/// # Arguments
/// * `messages` - Array of conversation messages with role and content
/// * `endpoint` - Ollama endpoint URL (e.g. "http://localhost:11434")
/// * `model` - Model name (e.g. "qwen2.5:7b")
/// * `max_tokens` - Maximum tokens to generate (optional)
/// * `temperature` - Temperature for generation (optional)
/// * `system` - System prompt (optional)
/// * `max_bytes` - Maximum response size (truncates if exceeded)
///
/// # Returns
/// Generated assistant response text
pub async fn execute_ai_conversation(
    messages: Vec<ChatMessage>,
    endpoint: String,
    model: String,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    system: Option<String>,
    max_bytes: usize,
) -> Result<String, String> {
    use ollama_rs::generation::chat::{ChatMessage as OllamaChatMessage, request::ChatMessageRequest};
    use ollama_rs::models::ModelOptions;

    let start = Instant::now();

    let (host_with_scheme, port) = parse_ollama_endpoint(&endpoint)?;

    tracing::info!(
        model = %model,
        host = %host_with_scheme,
        port = port,
        message_count = messages.len(),
        has_system = system.is_some(),
        "AI conversation requested"
    );

    let ollama = Ollama::new(host_with_scheme, port);

    // Convert messages to Ollama format
    let mut ollama_messages: Vec<OllamaChatMessage> = Vec::new();

    // Add system message first if provided
    if let Some(sys) = &system {
        ollama_messages.push(OllamaChatMessage::system(sys.clone()));
    }

    // Add conversation messages
    for msg in &messages {
        let ollama_msg = match msg.role.as_str() {
            "user" => OllamaChatMessage::user(msg.content.clone()),
            "assistant" => OllamaChatMessage::assistant(msg.content.clone()),
            "system" => OllamaChatMessage::system(msg.content.clone()),
            unknown => {
                tracing::warn!(role = %unknown, "Unknown message role, defaulting to user");
                OllamaChatMessage::user(msg.content.clone())
            }
        };
        ollama_messages.push(ollama_msg);
    }

    // Build request with options
    let mut request = ChatMessageRequest::new(model.clone(), ollama_messages);

    // Apply generation options if provided
    let mut options = ModelOptions::default();
    if let Some(tokens) = max_tokens {
        // Clamp to i32::MAX to prevent overflow on cast
        let capped = tokens.min(i32::MAX as u32);
        options = options.num_predict(capped as i32);
    }
    if let Some(temp) = temperature {
        options = options.temperature(temp);
    }
    request = request.options(options);

    match ollama.send_chat_messages(request).await {
        Ok(res) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            let response = res.message.content.clone();
            let response_bytes = response.len();

            tracing::info!(
                model = %model,
                duration_ms = duration_ms,
                response_bytes = response_bytes,
                "AI conversation succeeded"
            );

            // Truncate if output exceeds limit
            if response.len() > max_bytes {
                Ok(truncate_at_char_boundary(&response, max_bytes))
            } else {
                Ok(response)
            }
        },
        Err(e) => {
            let duration_ms = start.elapsed().as_millis() as u64;
            tracing::error!(
                error = %e,
                model = %model,
                duration_ms = duration_ms,
                "AI conversation failed"
            );
            Err(format!("Ollama error: {}", e))
        },
    }
}

/// Chat message for conversation API
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_at_char_boundary() {
        let text = "Hello\nWorld\nThis is a long line";
        let truncated = truncate_at_char_boundary(text, 15);
        
        // Should truncate at newline before "This"
        assert!(truncated.contains("Hello\nWorld"));
        assert!(truncated.contains("[truncated:"));
        assert!(!truncated.contains("This is"));
    }

    #[test]
    fn test_truncate_preserves_emoji() {
        let text = "Hello 👋 World";
        let result = truncate_at_char_boundary(text, 10);
        
        // Should not panic on multi-byte emoji
        assert!(result.len() > 0);
    }
}
