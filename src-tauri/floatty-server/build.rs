//! Build script for floatty-server.
//!
//! Embeds git commit info at build time for /api/v1/health endpoint.

use vergen_gix::{Emitter, GixBuilder};

fn main() {
    // Emit git info as env vars (accessible via option_env!() in code)
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
}
