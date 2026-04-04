//! Generate TypeScript bindings from Rust types using ts-rs.
//!
//! Run with: `cd src-tauri && cargo run --bin ts-gen`
//! Output goes directly to: `src/generated/` (canonical location, imported by blockTypes.ts)

use floatty_core::{Block, BlockType};
use ts_rs::TS;

fn main() {
    // Export directly to src/generated/ — the single canonical location.
    // ts-gen runs from src-tauri/, so ../src/generated/ reaches the frontend.
    let generated_dir = std::path::Path::new("../src/generated");
    if !generated_dir.exists() {
        std::fs::create_dir_all(generated_dir).expect("Failed to create generated directory");
    }

    BlockType::export_all_to(generated_dir).expect("Failed to export BlockType");
    println!("✓ Exported BlockType to src/generated/BlockType.ts");

    Block::export_all_to(generated_dir).expect("Failed to export Block");
    println!("✓ Exported Block to src/generated/Block.ts");

    println!("\nGenerated bindings written to src/generated/");
}
