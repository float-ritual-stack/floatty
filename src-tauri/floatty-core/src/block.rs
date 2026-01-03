//! Block types and parsing for Floatty's executable outliner.
//!
//! Block type is DERIVED from content on every access, never stored.
//! This matches the frontend behavior in `src/lib/blockTypes.ts`.
//!
//! NOTE: BlockType is exported to TypeScript via ts-rs. Run `cargo run --bin ts-gen`
//! after modifying this file to regenerate bindings.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Block types determine rendering and execution behavior.
/// Derived from content prefix - NOT stored in the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[ts(export, rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum BlockType {
    #[default]
    Text,
    /// Shell block: prefix `sh::` or `term::`
    Sh,
    /// Agent block: prefix `ai::` or `chat::`
    Ai,
    /// Context block: prefix `ctx::`
    Ctx,
    /// Dispatch block: prefix `dispatch::`
    Dispatch,
    /// Web embed: prefix `web::` or `link::`
    Web,
    /// Output from sh:: or ai:: execution
    Output,
    /// Error output from execution
    Error,
    /// Picker UI (internal): prefix `picker::`
    Picker,
    /// Resolved command after $tv() substitution: prefix `ran::`
    Ran,
    /// Heading level 1: `# `
    H1,
    /// Heading level 2: `## `
    H2,
    /// Heading level 3: `### `
    H3,
    /// Bullet point: `- `
    Bullet,
    /// Todo item: `- [ ]` or `- [x]`
    Todo,
    /// Blockquote: `> `
    Quote,
}

/// Check for bullet-style ctx marker: `- ctx::YYYY-MM-DD`
/// Matches TS regex: `/^- ctx::\d{4}-\d{2}-\d{2}/i`
fn is_bullet_ctx(s: &str) -> bool {
    // Must start with "- ctx::" (case-insensitive)
    let lower = s.to_lowercase();
    if !lower.starts_with("- ctx::") {
        return false;
    }
    // Then check for date pattern YYYY-MM-DD after "- ctx::"
    let after_prefix = &s[7..]; // Skip "- ctx::"
    if after_prefix.len() < 10 {
        return false;
    }
    let date_part = &after_prefix[..10];
    // Check format: 4 digits, dash, 2 digits, dash, 2 digits
    let bytes = date_part.as_bytes();
    bytes.len() == 10
        && bytes[0..4].iter().all(|b| b.is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(|b| b.is_ascii_digit())
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(|b| b.is_ascii_digit())
}

/// Check for todo item: `- [ ]` or `- [x]` (case-insensitive for x)
/// Matches TS regex: `/^- \[[ x]\] /i`
fn is_todo(s: &str) -> bool {
    if s.len() < 6 {
        return false;
    }
    let bytes = s.as_bytes();
    // Must start with "- ["
    if bytes[0] != b'-' || bytes[1] != b' ' || bytes[2] != b'[' {
        return false;
    }
    // Fourth char must be space, 'x', or 'X'
    let checkbox = bytes[3];
    if checkbox != b' ' && checkbox != b'x' && checkbox != b'X' {
        return false;
    }
    // Must end with "] " (closing bracket + space)
    bytes[4] == b']' && bytes[5] == b' '
}

/// Parse block type from content prefix.
///
/// This is the Rust equivalent of `parseBlockType()` in `src/lib/blockTypes.ts`.
/// The type is computed on every access - it is NOT stored.
pub fn parse_block_type(content: &str) -> BlockType {
    let trimmed = content.trim();
    let lower = trimmed.to_lowercase();

    // Magic triggers (case-insensitive)
    if lower.starts_with("sh::") || lower.starts_with("term::") {
        return BlockType::Sh;
    }
    if lower.starts_with("ai::") || lower.starts_with("chat::") {
        return BlockType::Ai;
    }
    // ctx:: at line start OR bullet with ctx:: and date - block-level context marker
    // Matches: "ctx::..." or "- ctx::2024-01-15 ..."
    if lower.starts_with("ctx::") || is_bullet_ctx(trimmed) {
        return BlockType::Ctx;
    }
    if lower.starts_with("dispatch::") {
        return BlockType::Dispatch;
    }
    if lower.starts_with("web::") || lower.starts_with("link::") {
        return BlockType::Web;
    }
    if lower.starts_with("output::") {
        return BlockType::Output;
    }
    if lower.starts_with("error::") {
        return BlockType::Error;
    }
    if lower.starts_with("picker::") {
        return BlockType::Picker;
    }
    if lower.starts_with("ran::") {
        return BlockType::Ran;
    }

    // Markdown syntax (case-sensitive for headings)
    if trimmed.starts_with("### ") {
        return BlockType::H3;
    }
    if trimmed.starts_with("## ") {
        return BlockType::H2;
    }
    if trimmed.starts_with("# ") {
        return BlockType::H1;
    }
    if trimmed.starts_with("> ") {
        return BlockType::Quote;
    }

    // Todo: `- [ ]` or `- [x]` (case-insensitive for x, matches TS regex)
    if is_todo(trimmed) {
        return BlockType::Todo;
    }

    // Bullet: `- `
    if trimmed.starts_with("- ") {
        return BlockType::Bullet;
    }

    BlockType::Text
}

/// A single block in the outliner tree.
///
/// This is the Rust equivalent of the Block interface in `src/lib/blockTypes.ts`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    pub parent_id: Option<String>,
    pub child_ids: Vec<String>,
    pub content: String,
    pub collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    // metadata: Option<serde_json::Value>, // Future: currently unused
}

impl Block {
    /// Create a new block with the given content.
    pub fn new(id: String, content: String) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;

        Self {
            id,
            parent_id: None,
            child_ids: Vec::new(),
            content,
            collapsed: false,
            created_at: now,
            updated_at: now,
        }
    }

    /// Get the block type (derived from content).
    pub fn block_type(&self) -> BlockType {
        parse_block_type(&self.content)
    }

    /// Check if this block has children.
    pub fn has_children(&self) -> bool {
        !self.child_ids.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_block_type_text() {
        assert_eq!(parse_block_type("hello world"), BlockType::Text);
        assert_eq!(parse_block_type(""), BlockType::Text);
        assert_eq!(parse_block_type("   "), BlockType::Text);
    }

    #[test]
    fn test_parse_block_type_executable() {
        assert_eq!(parse_block_type("sh:: ls -la"), BlockType::Sh);
        assert_eq!(parse_block_type("SH:: uppercase"), BlockType::Sh);
        assert_eq!(parse_block_type("term:: pwd"), BlockType::Sh);
        assert_eq!(parse_block_type("ai:: generate something"), BlockType::Ai);
        assert_eq!(parse_block_type("chat:: hello"), BlockType::Ai);
        assert_eq!(parse_block_type("  ai:: with leading space"), BlockType::Ai);
    }

    #[test]
    fn test_parse_block_type_metadata() {
        assert_eq!(parse_block_type("ctx:: project context"), BlockType::Ctx);
        assert_eq!(parse_block_type("dispatch:: run task"), BlockType::Dispatch);
    }

    #[test]
    fn test_parse_block_type_output() {
        assert_eq!(parse_block_type("output:: result"), BlockType::Output);
        assert_eq!(parse_block_type("error:: failed"), BlockType::Error);
        assert_eq!(parse_block_type("picker:: choose"), BlockType::Picker);
        assert_eq!(parse_block_type("ran:: ls -la"), BlockType::Ran);
    }

    #[test]
    fn test_parse_block_type_markdown() {
        assert_eq!(parse_block_type("# Heading 1"), BlockType::H1);
        assert_eq!(parse_block_type("## Heading 2"), BlockType::H2);
        assert_eq!(parse_block_type("### Heading 3"), BlockType::H3);
        assert_eq!(parse_block_type("> Quote"), BlockType::Quote);
        assert_eq!(parse_block_type("- Bullet"), BlockType::Bullet);
        assert_eq!(parse_block_type("- [ ] Todo unchecked"), BlockType::Todo);
        assert_eq!(parse_block_type("- [x] Todo checked"), BlockType::Todo);
        assert_eq!(parse_block_type("- [X] Todo checked upper"), BlockType::Todo);
    }

    #[test]
    fn test_block_type_derived() {
        let block = Block::new("test-id".to_string(), "sh:: echo hello".to_string());
        assert_eq!(block.block_type(), BlockType::Sh);

        let text_block = Block::new("test-id-2".to_string(), "just text".to_string());
        assert_eq!(text_block.block_type(), BlockType::Text);
    }
}
