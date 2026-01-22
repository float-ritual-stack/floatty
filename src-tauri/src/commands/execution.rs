/// Tauri command wrappers for execution services
///
/// Thin adapters (3-10 lines each) that extract state and delegate to services.

use crate::config::AggregatorConfig;
use crate::services::execution;
use crate::services::provider::{Provider, ProviderResponse};

/// Execute a shell command and return stdout/stderr
///
/// Tauri command wrapper - delegates to services::execution::execute_shell
#[tauri::command]
pub async fn execute_shell_command(command: String) -> Result<String, String> {
    let config = AggregatorConfig::load();
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
pub async fn execute_ai_command(prompt: String) -> Result<String, String> {
    let config = AggregatorConfig::load();

    execution::execute_ai(
        prompt,
        config.ollama_endpoint,
        config.ollama_model,
        config.max_shell_output_bytes,
    ).await
}

/// Execute a multi-turn conversation using Ollama chat API
///
/// Tauri command wrapper - delegates to services::execution::execute_ai_conversation
#[tauri::command]
pub async fn execute_ai_conversation(
    messages: Vec<execution::ChatMessage>,
    model: Option<String>,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    system: Option<String>,
) -> Result<String, String> {
    let config = AggregatorConfig::load();

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

/// Execute conversation with provider-aware routing
///
/// Routes to Ollama, Claude Code CLI, or Anthropic API based on provider config.
/// This is the FLO-187 provider-aware dispatch system.
#[tauri::command]
pub async fn execute_provider_conversation(
    messages: Vec<execution::ChatMessage>,
    provider: Provider,
    model_override: Option<String>,
    system: Option<String>,
) -> Result<ProviderResponse, String> {
    let config = AggregatorConfig::load();

    crate::services::provider::execute_with_provider(
        provider,
        messages,
        model_override,
        system,
        config.ollama_endpoint,
        config.ollama_model,
        config.max_shell_output_bytes,
    ).await
}
