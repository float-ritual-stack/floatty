//! Build script for floatty.
//!
//! Embeds git commit info at build time for enhanced title bar:
//! `floatty (dev) - workspace v0.4.2 (abc1234)`

use vergen_gix::{Emitter, GixBuilder};

fn main() {
    // Emit git info as env vars (accessible via option_env!() in code)
    // Only git info - keep it minimal to avoid dependency conflicts
    let gix = GixBuilder::default()
        .sha(true)
        .dirty(true)
        .build()
        .expect("Failed to configure git info");

    // Try to emit, but don't fail the build if git info unavailable
    if let Err(e) = Emitter::default()
        .add_instructions(&gix)
        .and_then(|e| e.emit())
    {
        eprintln!("Warning: Failed to emit git info: {}. Continuing without.", e);
    }

    // Run tauri build (generates bindings, etc.)
    tauri_build::build();
}
