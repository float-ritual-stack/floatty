//! Content parsing utilities for metadata extraction.
//!
//! Ports parsing patterns from TypeScript (`inlineParser.ts`, `wikilinkUtils.ts`)
//! for use in Rust hooks.

use crate::metadata::Marker;
use regex::Regex;
use std::sync::LazyLock;

// ═══════════════════════════════════════════════════════════════════════════
// PREFIX MARKERS
// ═══════════════════════════════════════════════════════════════════════════

/// Known prefix marker types (block type declarations).
const PREFIX_MARKERS: &[&str] = &[
    "sh", "term", "ai", "chat", "ctx", "dispatch", "pages", "web", "link", "img", "daily",
    "reminder", "meeting", "brain-boot", "door", "embed", "file", "ask", "media",
];

/// Code namespace patterns to exclude from standalone marker extraction.
/// These are Rust/code patterns like `std::string`, `tokio::spawn` that aren't semantic markers.
const CODE_NAMESPACES: &[&str] = &[
    "std", "core", "tauri", "tokio", "serde", "crate", "self", "super", "yrs", "log", "anyhow",
    "thiserror", "fs", "io", "env", "http", "tracing", "chrono", "regex", "tantivy", "async",
    "sync", "collections", "fmt", "path", "result", "option", "vec", "str", "string",
];

/// Extract prefix marker from block content (e.g., "sh::", "ctx::").
///
/// Returns the marker type if content starts with a known `prefix::` pattern.
///
/// # Examples
///
/// ```
/// use floatty_core::hooks::parsing::extract_prefix_marker;
///
/// assert_eq!(extract_prefix_marker("sh:: ls -la"), Some("sh".to_string()));
/// assert_eq!(extract_prefix_marker("ctx::2026-01-10"), Some("ctx".to_string()));
/// assert_eq!(extract_prefix_marker("just text"), None);
/// ```
pub fn extract_prefix_marker(content: &str) -> Option<String> {
    let lower = content.to_lowercase();
    for prefix in PREFIX_MARKERS {
        let pattern = format!("{}::", prefix);
        if lower.starts_with(&pattern) {
            return Some(prefix.to_string());
        }
    }
    None
}

// ═══════════════════════════════════════════════════════════════════════════
// TAG MARKERS
// ═══════════════════════════════════════════════════════════════════════════

/// Regex for inline tag markers: `[key::value]`
static TAG_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(\w+)::([^\]]+)\]").expect("valid regex"));

/// Known tag marker types (for validation/filtering if needed).
pub const KNOWN_TAG_TYPES: &[&str] = &["project", "mode", "issue", "repo", "branch", "meeting"];

/// Regex for standalone markers: `project::floatty` (not in brackets).
/// Captures: (1) marker_type, (2) value
/// We must exclude matches inside brackets or code chains, done via post-filtering.
static STANDALONE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // Match word boundary, marker_type, ::, value
    // \b ensures we match whole words, not partial (e.g., won't match inside `[project::floatty]`)
    Regex::new(r"\b([a-zA-Z_][a-zA-Z0-9_-]*)::([\w/.@_-]+)").expect("valid regex")
});

/// Extract all tag markers from content.
///
/// Returns markers for patterns like `[project::floatty]`, `[mode::dev]`.
///
/// # Examples
///
/// ```
/// use floatty_core::hooks::parsing::extract_tag_markers;
///
/// let markers = extract_tag_markers("working on [project::floatty] [mode::dev]");
/// assert_eq!(markers.len(), 2);
/// assert_eq!(markers[0].marker_type, "project");
/// assert_eq!(markers[0].value, Some("floatty".to_string()));
/// ```
pub fn extract_tag_markers(content: &str) -> Vec<Marker> {
    TAG_PATTERN
        .captures_iter(content)
        .map(|cap| Marker::with_value(&cap[1], &cap[2]))
        .collect()
}

/// Extract standalone markers like `project::floatty` (not bracketed).
///
/// Filters out code namespaces (std::, tokio::, etc.) to avoid polluting
/// the index with Rust/code patterns.
///
/// Also filters out markers that appear inside brackets (already captured by tag extraction).
///
/// # Examples
///
/// ```
/// use floatty_core::hooks::parsing::extract_standalone_markers;
///
/// let markers = extract_standalone_markers("working on project::floatty today");
/// assert_eq!(markers.len(), 1);
/// assert_eq!(markers[0].marker_type, "project");
/// assert_eq!(markers[0].value, Some("floatty".to_string()));
///
/// // Code namespaces are filtered out
/// let markers = extract_standalone_markers("std::string tokio::spawn project::floatty");
/// assert_eq!(markers.len(), 1); // Only project::floatty
/// ```
pub fn extract_standalone_markers(content: &str) -> Vec<Marker> {
    let bytes = content.as_bytes();

    STANDALONE_PATTERN
        .captures_iter(content)
        .filter_map(|cap| {
            // cap[1] = marker_type, cap[2] = value
            let marker_type = &cap[1];
            let marker_type_lower = marker_type.to_lowercase();

            // Skip code namespaces
            if CODE_NAMESPACES
                .iter()
                .any(|ns| ns.eq_ignore_ascii_case(marker_type))
            {
                return None;
            }

            // Skip prefix markers (already extracted as prefix, no value)
            // We want standalone to capture the VALUE, but prefix extraction only captures type
            if PREFIX_MARKERS.contains(&marker_type_lower.as_str()) {
                return None;
            }

            // Check if preceded by '[' (bracketed marker, already extracted by tag pattern)
            let match_start = cap.get(0).unwrap().start();
            if match_start > 0 && bytes[match_start - 1] == b'[' {
                return None;
            }

            // Skip if preceded by ':' (code chain like ::std::)
            if match_start > 0 && bytes[match_start - 1] == b':' {
                return None;
            }

            Some(Marker::with_value(marker_type, &cap[2]))
        })
        .collect()
}

// ═══════════════════════════════════════════════════════════════════════════
// WIKILINKS
// ═══════════════════════════════════════════════════════════════════════════

/// Find the closing `]]` for a wikilink starting at position `start`.
///
/// Uses bracket counting to handle nested `[[wikilinks]]`.
///
/// # Returns
///
/// Index after the closing `]]`, or `None` if unbalanced.
///
/// # Examples
///
/// ```
/// use floatty_core::hooks::parsing::find_wikilink_end;
///
/// assert_eq!(find_wikilink_end("[[simple]]", 0), Some(10));
/// assert_eq!(find_wikilink_end("[[outer [[inner]]]]", 0), Some(19));
/// assert_eq!(find_wikilink_end("[[unbalanced", 0), None);
/// ```
pub fn find_wikilink_end(content: &str, start: usize) -> Option<usize> {
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut depth = 0;
    let mut i = start;

    while i + 1 < len {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            depth += 1;
            i += 2;
        } else if bytes[i] == b']' && bytes[i + 1] == b']' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return Some(i);
            }
        } else {
            i += 1;
        }
    }

    None // Unbalanced
}

/// Parse wikilink inner content to extract target and alias.
///
/// Handles top-level pipe only (nested `[[links]]` can contain pipes).
///
/// # Returns
///
/// `(target, alias)` where alias is `None` if no pipe separator.
///
/// # Examples
///
/// ```
/// use floatty_core::hooks::parsing::parse_wikilink_inner;
///
/// assert_eq!(parse_wikilink_inner("Simple Page"), ("Simple Page".to_string(), None));
/// assert_eq!(parse_wikilink_inner("Target|Alias"), ("Target".to_string(), Some("Alias".to_string())));
/// assert_eq!(parse_wikilink_inner("outer [[inner]]|alias"), ("outer [[inner]]".to_string(), Some("alias".to_string())));
/// ```
pub fn parse_wikilink_inner(inner: &str) -> (String, Option<String>) {
    let bytes = inner.as_bytes();
    let len = bytes.len();
    let mut depth = 0;

    for i in 0..len {
        // Track bracket depth
        if i + 1 < len {
            if bytes[i] == b'[' && bytes[i + 1] == b'[' {
                depth += 1;
            } else if bytes[i] == b']' && bytes[i + 1] == b']' {
                depth -= 1;
            }
        }

        // Only match pipe at depth 0
        if bytes[i] == b'|' && depth == 0 {
            let target = inner[..i].trim().to_string();
            let alias = inner[i + 1..].trim();
            let alias = if alias.is_empty() {
                None
            } else {
                Some(alias.to_string())
            };
            return (target, alias);
        }
    }

    (inner.trim().to_string(), None)
}

/// Extract all wikilink targets from content, including nested ones.
///
/// For `[[outer [[inner]]]]`, returns: `["outer [[inner]]", "inner"]`
///
/// This enables backlinks to both the outer and inner targets.
///
/// # Examples
///
/// ```
/// use floatty_core::hooks::parsing::extract_wikilink_targets;
///
/// assert_eq!(extract_wikilink_targets("[[Page]]"), vec!["Page"]);
/// assert_eq!(extract_wikilink_targets("[[Target|Alias]]"), vec!["Target"]);
/// assert_eq!(extract_wikilink_targets("[[outer [[inner]]]]"), vec!["outer [[inner]]", "inner"]);
/// ```
pub fn extract_wikilink_targets(content: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let bytes = content.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i + 1 < len {
        // Look for `[[`
        if bytes[i] != b'[' || bytes[i + 1] != b'[' {
            i += 1;
            continue;
        }

        // Found opening [[
        let open_idx = i;
        let Some(end_idx) = find_wikilink_end(content, open_idx) else {
            // Unbalanced - skip this [[
            i += 2;
            continue;
        };

        // Extract inner content (strip outer [[ ]])
        let inner = &content[open_idx + 2..end_idx - 2];
        let (target, _alias) = parse_wikilink_inner(inner);

        if !target.is_empty() {
            // Recursively extract from the target (for nested wikilinks)
            let nested = extract_wikilink_targets(&target);

            targets.push(target);
            targets.extend(nested);
        }

        i = end_idx;
    }

    targets
}

/// Quick check if content contains `[[wikilink]]` patterns.
pub fn has_wikilink_patterns(content: &str) -> bool {
    let bytes = content.as_bytes();
    let len = bytes.len();

    // Find [[
    for i in 0..len.saturating_sub(3) {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            // Check for ]] after
            for j in i + 2..len.saturating_sub(1) {
                if bytes[j] == b']' && bytes[j + 1] == b']' {
                    return true;
                }
            }
        }
    }
    false
}

// ═══════════════════════════════════════════════════════════════════════════
// COMBINED EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/// Extract all markers from block content.
///
/// Returns both prefix markers (sh::, ctx::, etc.) and tag markers ([project::X]).
pub fn extract_all_markers(content: &str) -> Vec<Marker> {
    let mut markers = Vec::new();

    // Check for prefix marker
    if let Some(prefix_type) = extract_prefix_marker(content) {
        markers.push(Marker::new(prefix_type));
    }

    // Extract tag markers [project::X]
    markers.extend(extract_tag_markers(content));

    // Extract standalone markers project::X (not bracketed)
    markers.extend(extract_standalone_markers(content));

    // Deduplicate by (marker_type, value)
    markers.sort_by(|a, b| (&a.marker_type, &a.value).cmp(&(&b.marker_type, &b.value)));
    markers.dedup_by(|a, b| a.marker_type == b.marker_type && a.value == b.value);

    markers
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─────────────────────────────────────────────────────────────────────────
    // Prefix markers
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_prefix_marker_sh() {
        assert_eq!(extract_prefix_marker("sh:: ls -la"), Some("sh".to_string()));
    }

    #[test]
    fn test_prefix_marker_ctx() {
        assert_eq!(
            extract_prefix_marker("ctx::2026-01-10 working"),
            Some("ctx".to_string())
        );
    }

    #[test]
    fn test_prefix_marker_ai() {
        assert_eq!(
            extract_prefix_marker("ai:: explain this"),
            Some("ai".to_string())
        );
    }

    #[test]
    fn test_prefix_marker_case_insensitive() {
        assert_eq!(extract_prefix_marker("SH:: uppercase"), Some("sh".to_string()));
        assert_eq!(extract_prefix_marker("Ctx:: mixed"), Some("ctx".to_string()));
    }

    #[test]
    fn test_prefix_marker_none() {
        assert_eq!(extract_prefix_marker("just plain text"), None);
        assert_eq!(extract_prefix_marker("not:: a prefix"), None);
        assert_eq!(extract_prefix_marker(""), None);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tag markers
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_tag_marker_single() {
        let markers = extract_tag_markers("[project::floatty]");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
        assert_eq!(markers[0].value, Some("floatty".to_string()));
    }

    #[test]
    fn test_tag_marker_multiple() {
        let markers = extract_tag_markers("working on [project::floatty] [mode::dev]");
        assert_eq!(markers.len(), 2);
        assert_eq!(markers[0].marker_type, "project");
        assert_eq!(markers[1].marker_type, "mode");
    }

    #[test]
    fn test_tag_marker_with_spaces_in_value() {
        let markers = extract_tag_markers("[issue::Fix the bug]");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].value, Some("Fix the bug".to_string()));
    }

    #[test]
    fn test_tag_marker_none() {
        let markers = extract_tag_markers("no tags here");
        assert!(markers.is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Standalone markers
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_standalone_simple() {
        let markers = extract_standalone_markers("working on project::floatty today");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
        assert_eq!(markers[0].value, Some("floatty".to_string()));
    }

    #[test]
    fn test_standalone_multiple() {
        let markers = extract_standalone_markers("project::floatty mode::dev issue::264");
        assert_eq!(markers.len(), 3);
        assert_eq!(markers[0].marker_type, "project");
        assert_eq!(markers[1].marker_type, "mode");
        assert_eq!(markers[2].marker_type, "issue");
    }

    #[test]
    fn test_standalone_with_path_values() {
        let markers = extract_standalone_markers("project::rangle/pharmacy");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].value, Some("rangle/pharmacy".to_string()));
    }

    #[test]
    fn test_standalone_filters_code_namespaces() {
        let markers = extract_standalone_markers("std::string tokio::spawn project::floatty");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
    }

    #[test]
    fn test_standalone_filters_many_code_patterns() {
        let content = "serde::Deserialize tauri::command anyhow::Result project::floatty mode::dev";
        let markers = extract_standalone_markers(content);
        assert_eq!(markers.len(), 2);
        assert_eq!(markers[0].marker_type, "project");
        assert_eq!(markers[1].marker_type, "mode");
    }

    #[test]
    fn test_standalone_case_insensitive_filter() {
        // STD:: should also be filtered
        let markers = extract_standalone_markers("STD::string Tokio::spawn project::floatty");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
    }

    #[test]
    fn test_standalone_does_not_match_bracketed() {
        // Bracketed markers should NOT be matched by standalone pattern
        // (the negative lookbehind prevents [ before the match)
        let markers = extract_standalone_markers("[project::floatty]");
        assert!(markers.is_empty());
    }

    #[test]
    fn test_standalone_none() {
        let markers = extract_standalone_markers("no markers here");
        assert!(markers.is_empty());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wikilink bracket counting
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_find_wikilink_end_simple() {
        assert_eq!(find_wikilink_end("[[Page]]", 0), Some(8));
    }

    #[test]
    fn test_find_wikilink_end_nested() {
        assert_eq!(find_wikilink_end("[[outer [[inner]]]]", 0), Some(19));
    }

    #[test]
    fn test_find_wikilink_end_unbalanced() {
        assert_eq!(find_wikilink_end("[[unbalanced", 0), None);
        assert_eq!(find_wikilink_end("[[only one close]", 0), None);
    }

    #[test]
    fn test_find_wikilink_end_with_text_after() {
        assert_eq!(find_wikilink_end("[[Page]] more text", 0), Some(8));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wikilink inner parsing
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_parse_inner_simple() {
        let (target, alias) = parse_wikilink_inner("Page Name");
        assert_eq!(target, "Page Name");
        assert_eq!(alias, None);
    }

    #[test]
    fn test_parse_inner_with_alias() {
        let (target, alias) = parse_wikilink_inner("Target|Display");
        assert_eq!(target, "Target");
        assert_eq!(alias, Some("Display".to_string()));
    }

    #[test]
    fn test_parse_inner_nested_with_alias() {
        let (target, alias) = parse_wikilink_inner("outer [[inner]]|alias");
        assert_eq!(target, "outer [[inner]]");
        assert_eq!(alias, Some("alias".to_string()));
    }

    #[test]
    fn test_parse_inner_pipe_inside_nested() {
        // Pipe inside nested brackets should NOT be treated as separator
        let (target, alias) = parse_wikilink_inner("outer [[with|pipe]]");
        assert_eq!(target, "outer [[with|pipe]]");
        assert_eq!(alias, None);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Wikilink extraction
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_extract_simple() {
        let targets = extract_wikilink_targets("[[Page]]");
        assert_eq!(targets, vec!["Page"]);
    }

    #[test]
    fn test_extract_multiple() {
        let targets = extract_wikilink_targets("link to [[Page A]] and [[Page B]]");
        assert_eq!(targets, vec!["Page A", "Page B"]);
    }

    #[test]
    fn test_extract_with_alias() {
        let targets = extract_wikilink_targets("[[Target|Display]]");
        assert_eq!(targets, vec!["Target"]);
    }

    #[test]
    fn test_extract_nested() {
        let targets = extract_wikilink_targets("[[outer [[inner]]]]");
        assert_eq!(targets, vec!["outer [[inner]]", "inner"]);
    }

    #[test]
    fn test_extract_deeply_nested() {
        let targets = extract_wikilink_targets("[[a [[b [[c]]]]]]");
        assert_eq!(targets, vec!["a [[b [[c]]]]", "b [[c]]", "c"]);
    }

    #[test]
    fn test_extract_empty() {
        let targets = extract_wikilink_targets("no wikilinks here");
        assert!(targets.is_empty());
    }

    #[test]
    fn test_extract_unbalanced() {
        // Should skip unbalanced, extract valid
        let targets = extract_wikilink_targets("[[valid]] [[unbalanced");
        assert_eq!(targets, vec!["valid"]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Has wikilink patterns
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_has_wikilink_true() {
        assert!(has_wikilink_patterns("link to [[Page]]"));
    }

    #[test]
    fn test_has_wikilink_false() {
        assert!(!has_wikilink_patterns("no links here"));
        assert!(!has_wikilink_patterns("single [ bracket"));
        assert!(!has_wikilink_patterns("[[ unbalanced"));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Combined extraction
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_extract_all_markers_prefix_only() {
        let markers = extract_all_markers("sh:: ls -la");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "sh");
        assert_eq!(markers[0].value, None);
    }

    #[test]
    fn test_extract_all_markers_tags_only() {
        let markers = extract_all_markers("working [project::floatty]");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
    }

    #[test]
    fn test_extract_all_markers_mixed() {
        let markers = extract_all_markers("ctx::2026-01-10 [project::floatty] [mode::dev]");
        assert_eq!(markers.len(), 3);
        // Sorted alphabetically by (marker_type, value)
        assert_eq!(markers[0].marker_type, "ctx");
        assert_eq!(markers[1].marker_type, "mode");
        assert_eq!(markers[2].marker_type, "project");
    }

    #[test]
    fn test_extract_all_markers_standalone() {
        let markers = extract_all_markers("working on project::floatty today");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
        assert_eq!(markers[0].value, Some("floatty".to_string()));
    }

    #[test]
    fn test_extract_all_markers_filters_code() {
        // Code namespaces should be filtered even in combined extraction
        let markers = extract_all_markers("std::string tokio::spawn project::floatty");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
    }

    #[test]
    fn test_extract_all_markers_deduplicates() {
        // Same marker in both bracketed and standalone form should dedupe
        let markers = extract_all_markers("[project::floatty] and project::floatty again");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
        assert_eq!(markers[0].value, Some("floatty".to_string()));
    }

    #[test]
    fn test_extract_all_markers_mixed_with_standalone() {
        let content = "ctx::2026-01-11 [project::floatty] mode::synthesis issue::264";
        let markers = extract_all_markers(content);
        // ctx, issue, mode, project (sorted alphabetically by type)
        assert_eq!(markers.len(), 4);
        assert_eq!(markers[0].marker_type, "ctx");
        assert_eq!(markers[1].marker_type, "issue");
        assert_eq!(markers[2].marker_type, "mode");
        assert_eq!(markers[3].marker_type, "project");
    }
}
