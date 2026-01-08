/// Tauri command wrappers for execution services
/// 
/// Thin adapters (3-10 lines each) that extract state and delegate to services.

use crate::config::AggregatorConfig;
use crate::services::execution;

/// Execute a shell command and return stdout/stderr
///
/// Tauri command wrapper - delegates to services::execution::execute_shell
#[tauri::command]
pub async fn execute_shell_command(command: String) -> Result<String, String> {
    let config = AggregatorConfig::load();
    let max_bytes = config.max_shell_output_bytes;
    
    let (output, _exit_code) = execution::execute_shell(command, max_bytes).await?;
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
