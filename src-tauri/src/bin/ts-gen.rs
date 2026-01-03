//! Generate TypeScript bindings from Rust types using ts-rs.
//!
//! Run with: `cargo run --bin ts-gen`
//! Output goes to: `src-tauri/bindings/` (then copy to `src/generated/`)

use floatty_core::{Block, BlockType};
use ts_rs::TS;

fn main() {
    // Export to bindings/ directory (ts-rs default is relative to crate root)
    let bindings_dir = std::path::Path::new("bindings");
    if !bindings_dir.exists() {
        std::fs::create_dir_all(bindings_dir).expect("Failed to create bindings directory");
    }

    // Export BlockType enum
    BlockType::export_all_to(bindings_dir).expect("Failed to export BlockType");
    println!("✓ Exported BlockType to bindings/BlockType.ts");

    // Export Block struct
    Block::export_all_to(bindings_dir).expect("Failed to export Block");
    println!("✓ Exported Block to bindings/Block.ts");

    println!("\nNext steps:");
    println!("  cp bindings/*.ts ../src/generated/");
    println!("  Update imports in src/lib/blockTypes.ts");
}
