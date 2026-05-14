use crate::config::AggregatorConfig;
use crate::services::execution;
/// Tauri command wrappers for execution services
///
/// Thin adapters (3-10 lines each) that extract state and delegate to services.
use crate::AppState;
use tauri::State;

/// Execute a shell command and return stdout/stderr
///
/// Tauri command wrapper - delegates to services::execution::execute_shell
#[tauri::command]
pub async fn execute_shell_command(
    state: State<'_, AppState>,
    command: String,
) -> Result<String, String> {
    let config = AggregatorConfig::load_from(&state.config_path);
    let max_bytes = config.max_shell_output_bytes;

    let (output, exit_code) = execution::execute_shell(command, max_bytes).await?;

    // Log exit code for debugging (output already contains errors if non-zero)
    if exit_code != 0 {
        tracing::debug!(
            exit_code = exit_code,
            "Shell command returned non-zero exit code"
        );
    }

    Ok(output)
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
