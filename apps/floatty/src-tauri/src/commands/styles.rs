/// User CSS override command.
///
/// Reads `{data_dir}/custom.css` so the frontend can inject it after the
/// bundled stylesheet — letting users tweak colors/spacing without an app
/// rebuild. Absent or unreadable file = empty string (no override), never an
/// error: a missing custom.css is the common, expected case.
use crate::paths::DataPaths;

const CUSTOM_CSS_TEMPLATE: &str = r#"/* floatty custom CSS — edit freely, then reload (⌘R or the command palette).
   Injected after the bundled stylesheet, so your rules win at equal specificity.
   Bundled selectors like `.block-display .md-bold` are specificity (0,2,0);
   match that (or use !important) if a bare override doesn't take.

   Example — nudge the bold-emphasis color for your eyes:
   .block-display .md-bold { color: #faba4a; }
*/
"#;

/// Write the commented template to `custom.css` if the file does not exist.
///
/// Discoverability: the override feature is invisible unless the file surfaces
/// itself. Never overwrites an existing file (checks first); a write failure is
/// logged and ignored — a missing template is cosmetic, not fatal.
pub fn seed_custom_css_template(path: &std::path::Path) {
    if path.exists() {
        return;
    }
    if let Err(e) = std::fs::write(path, CUSTOM_CSS_TEMPLATE) {
        tracing::debug!(path = ?path, error = %e, "could not seed custom.css template");
    }
}

/// Read the user CSS override, or return empty string if there is none.
#[tauri::command]
pub fn read_custom_css() -> String {
    let paths = DataPaths::resolve();
    match std::fs::read_to_string(&paths.custom_css) {
        Ok(css) => css,
        Err(e) => {
            // NotFound is the normal case (no override); anything else is worth
            // a debug line but still degrades to "no override".
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::debug!(path = ?paths.custom_css, error = %e, "custom.css unreadable");
            }
            String::new()
        }
    }
}
