/// Tauri command wrappers for execution services
///
/// Thin adapters (3-10 lines each) that extract state and delegate to services.

use crate::AppState;
use crate::config::AggregatorConfig;
use crate::services::execution;
use tauri::State;

/// Execute a shell command and return stdout/stderr
///
/// Tauri command wrapper - delegates to services::execution::execute_shell
#[tauri::command]
pub async fn execute_shell_command(state: State<'_, AppState>, command: String) -> Result<String, String> {
    let config = AggregatorConfig::load_from(&state.config_path);
    let max_bytes = config.max_shell_output_bytes;

    let (output, exit_code) = execution::execute_shell(command, max_bytes).await?;

    // Log exit code for debugging (output already contains errors if non-zero)
    if exit_code != 0 {
        tracing::debug!(exit_code = exit_code, "Shell command returned non-zero exit code");
    }

    Ok(output)
}

/// Execute an AI prompt using Ollama
///
/// Tauri command wrapper - delegates to services::execution::execute_ai
#[tauri::command]
pub async fn execute_ai_command(state: State<'_, AppState>, prompt: String) -> Result<String, String> {
    let config = AggregatorConfig::load_from(&state.config_path);

    execution::execute_ai(
        prompt,
        config.ollama_endpoint,
        config.ollama_model,
        config.max_shell_output_bytes,
    ).await
}

/// Open a URL in the default browser
///
/// Validates URL scheme (http/https only) to prevent injection.
/// Uses macOS `open` command (floatty is macOS-only currently).
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("Only http/https URLs supported, got: {scheme}"));
    }
    std::process::Command::new("open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|e| format!("Failed to open URL: {e}"))?;
    Ok(())
}

/// Execute a multi-turn conversation using Ollama chat API
///
/// Tauri command wrapper - delegates to services::execution::execute_ai_conversation
#[tauri::command]
pub async fn execute_ai_conversation(
    state: State<'_, AppState>,
    messages: Vec<execution::ChatMessage>,
    model: Option<String>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    system: Option<String>,
) -> Result<String, String> {
    let config = AggregatorConfig::load_from(&state.config_path);

    // Use provided model or fall back to config
    let model = model.unwrap_or(config.ollama_model);

    execution::execute_ai_conversation(
        messages,
        config.ollama_endpoint,
        model,
        max_tokens,
        temperature,
        system,
        config.max_shell_output_bytes,
    ).await
}
