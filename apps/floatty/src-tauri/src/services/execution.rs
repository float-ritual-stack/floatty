/// Shell command execution services
///
/// Pure business logic for executing commands - minimal external dependencies.
/// Uses tokio for async execution. Testable without Tauri runtime.
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

        // Login shell (-l) sources .zshenv + .zprofile but NOT .zshrc (that's interactive-only).
        // Instead of -li (which requires a TTY and can hang on starship/p10k init),
        // explicitly source .zshrc in the command string for aliases/PATH additions.
        let rc_source = if shell.contains("zsh") {
            "[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null; "
        } else if shell.contains("bash") {
            "[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null; "
        } else {
            ""
        };

        let output = std::process::Command::new(&shell)
            .arg("-lc") // Login shell + command (non-interactive, no TTY needed)
            .arg(format!("{}{}", rc_source, &command))
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
    })
    .await
    .map_err(|e| e.to_string())??;

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
        assert!(!result.is_empty());
    }
}
