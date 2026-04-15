//! Server-side markdown projection for door-block output.
//!
//! Two layers of a four-layer fallback chain (see FLO-633):
//! 1. `output.data.normalizedMarkdown` — future, not handled here
//! 2. `metadata.renderedMarkdown` — frontend hook, not handled here
//! 3. [`walk_spec_to_markdown`] — crude spec-aware walker (this module)
//! 4. [`walk_generic_json_to_markdown`] — last-resort generic walker (this module)
//!
//! Target audience is agents consuming the API, not humans. The walker is
//! deliberately crude: heading line per element, common text props as
//! one-liners, recursive children. No per-component semantic rendering, no
//! visual formatting preserved, no round-trip fidelity.
//!
//! Both functions are pure, sync, and must never panic on malformed input.
//! Callers should still wrap in `std::panic::catch_unwind` as defense-in-depth.

use serde_json::Value;
use std::collections::HashSet;

/// Walk a door-block `output.data` object and project it into crude markdown.
///
/// Expected shape (port of `flattenSpecToMarkdown` in `outputSummaryHook.ts`):
/// ```json
/// {
///   "title": "optional lead title",
///   "spec": {
///     "root": "element-key",
///     "elements": {
///       "element-key": {
///         "type": "Section",
///         "props": { "title": "…", "content": "…" },
///         "children": ["other-key", …]
///       }
///     }
///   }
/// }
/// ```
///
/// Returns an empty string if the spec is missing or unparseable — callers
/// should fall through to [`walk_generic_json_to_markdown`] in that case.
pub fn walk_spec_to_markdown(output_data: &Value) -> String {
    let spec = output_data.get("spec").or_else(|| output_data.get("Spec"));
    let Some(spec) = spec else { return String::new(); };

    let Some(root_key) = spec.get("root").and_then(Value::as_str) else {
        return String::new();
    };
    let Some(elements) = spec.get("elements").and_then(Value::as_object) else {
        return String::new();
    };

    let mut lines: Vec<String> = Vec::new();

    // Lead with data.title if it's clean (not a JSON blob, reasonable length).
    if let Some(title) = output_data.get("title").and_then(Value::as_str) {
        let trimmed = title.trim_start();
        if !trimmed.is_empty() && !trimmed.starts_with('{') && title.len() < 200 {
            lines.push(format!("# {}", title));
            lines.push(String::new());
        }
    }

    let mut visiting: HashSet<String> = HashSet::new();
    walk_element(root_key, elements, &mut lines, &mut visiting);

    let joined = lines.join("\n");
    joined.trim().to_string()
}

/// Recurse into a single element by key. Mutates `lines` in place.
fn walk_element(
    key: &str,
    elements: &serde_json::Map<String, Value>,
    lines: &mut Vec<String>,
    visiting: &mut HashSet<String>,
) {
    if visiting.contains(key) {
        return;
    }
    visiting.insert(key.to_string());

    let Some(el) = elements.get(key) else {
        visiting.remove(key);
        return;
    };

    let el_type = el.get("type").and_then(Value::as_str).unwrap_or("Unknown");
    let props = el.get("props");

    emit_element(el_type, props, lines);

    if let Some(children) = el.get("children").and_then(Value::as_array) {
        for child in children {
            if let Some(child_key) = child.as_str() {
                walk_element(child_key, elements, lines, visiting);
            }
        }
    }

    visiting.remove(key);
}

/// Emit the text-bearing lines for a single element based on its type and props.
///
/// Handles a handful of well-known element types explicitly (matching the shape
/// of `flattenSpecToMarkdown`) and falls back to a generic prop harvester for
/// everything else. Never panics; missing/unexpected props are silently skipped.
fn emit_element(el_type: &str, props: Option<&Value>, lines: &mut Vec<String>) {
    let p = props.and_then(Value::as_object);

    match el_type {
        // Well-known types with nice rendering (ported loosely from TS).
        "EntryHeader" | "MetadataHeader" => {
            if let Some(title) = string_prop(p, "title") {
                let date = string_prop(p, "date").map(|d| format!(" ({})", d)).unwrap_or_default();
                let author = string_prop(p, "author").map(|a| format!(" — {}", a)).unwrap_or_default();
                lines.push(format!("## {}{}{}", title, date, author));
                lines.push(String::new());
            }
        }
        "Section" => {
            if let Some(title) = string_prop(p, "title") {
                lines.push(format!("## {}", title));
                lines.push(String::new());
            }
        }
        "EntryBody" => {
            if let Some(md) = string_prop(p, "markdown") {
                lines.push(md);
                lines.push(String::new());
            }
        }
        "Text" => {
            if let Some(content) = string_prop(p, "content") {
                lines.push(content);
            }
        }
        "PatternCard" => {
            let title = string_prop(p, "title").unwrap_or_else(|| "Pattern".to_string());
            let ty = string_prop(p, "type").map(|t| format!(" [{}]", t)).unwrap_or_default();
            let conf = string_prop(p, "confidence").map(|c| format!(" ({})", c)).unwrap_or_default();
            lines.push(format!("### {}{}{}", title, ty, conf));
            if let Some(content) = string_prop(p, "content") {
                lines.push(String::new());
                lines.push(content);
            }
            if let Some(connects) = p.and_then(|p| p.get("connectsTo")).and_then(Value::as_array) {
                let refs: Vec<String> = connects
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|c| format!("[[{}]]", c))
                    .collect();
                if !refs.is_empty() {
                    lines.push(String::new());
                    lines.push(format!("connects to: {}", refs.join(", ")));
                }
            }
            lines.push(String::new());
        }
        "QuoteBlock" => {
            if let Some(text) = string_prop(p, "text") {
                let attr = string_prop(p, "attribution")
                    .map(|a| format!("\n> — {}", a))
                    .unwrap_or_default();
                lines.push(format!("> {}{}", text, attr));
                lines.push(String::new());
            }
        }
        "TuiStat" | "Metric" | "StatPill" => {
            if let (Some(label), Some(value)) = (string_prop(p, "label"), string_prop(p, "value")) {
                lines.push(format!("- **{}**: {}", label, value));
            }
        }
        "WikilinkChip" => {
            if let Some(target) = string_prop(p, "target") {
                let label = string_prop(p, "label").map(|l| format!(" {}", l)).unwrap_or_default();
                lines.push(format!("- [[{}]]{}", target, label));
            }
        }
        "BacklinksFooter" => {
            emit_link_list(p, "inbound", "inbound", lines);
            emit_link_list(p, "outbound", "outbound", lines);
        }
        "Code" => {
            if let Some(content) = string_prop(p, "content") {
                lines.push("```".to_string());
                lines.push(content);
                lines.push("```".to_string());
                lines.push(String::new());
            }
        }
        "Divider" => {
            lines.push("---".to_string());
            lines.push(String::new());
        }
        // Nav chrome — explicitly skipped (no text contribution).
        "NavBrand" | "NavSection" | "NavItem" | "NavFooter" => {}

        // Generic fallback for unknown types: emit type as heading + harvest
        // any string-valued text-bearing props.
        _ => {
            let mut harvested: Vec<String> = Vec::new();
            for key in ["title", "label", "content", "text", "description", "subtitle", "value", "markdown"] {
                if let Some(s) = string_prop(p, key) {
                    if !s.trim().is_empty() {
                        harvested.push(s);
                    }
                }
            }

            if !harvested.is_empty() {
                // Use type as a hint heading if there's a title-ish harvest.
                let head = harvested.remove(0);
                lines.push(format!("### {} — {}", el_type, head));
                for extra in harvested {
                    lines.push(extra);
                }
                lines.push(String::new());
            }
            // Pure layout containers (Stack, Grid, etc.) produce nothing; children
            // still recurse from walk_element.
        }
    }
}

/// Emit `label: [[a]], [[b]], …` for a string-array prop, if non-empty.
fn emit_link_list(
    props: Option<&serde_json::Map<String, Value>>,
    prop_key: &str,
    label: &str,
    lines: &mut Vec<String>,
) {
    let Some(arr) = props.and_then(|p| p.get(prop_key)).and_then(Value::as_array) else {
        return;
    };
    let refs: Vec<String> = arr
        .iter()
        .filter_map(Value::as_str)
        .map(|r| format!("[[{}]]", r))
        .collect();
    if !refs.is_empty() {
        lines.push(format!("{}: {}", label, refs.join(", ")));
        lines.push(String::new());
    }
}

/// Read a string prop, returning `None` for missing or non-string values.
fn string_prop(props: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<String> {
    props
        .and_then(|p| p.get(key))
        .and_then(|v| match v {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            _ => None,
        })
}

/// Last-resort fallback: walk an arbitrary JSON value and flatten to readable
/// text. Used when the spec walker produces nothing (malformed, missing, or
/// non-door-shaped output).
///
/// Emits key/value pairs for objects (one per line, indented by depth),
/// bulleted entries for arrays, and primitive values inline. Skips `null`.
/// Capped at a sensible depth to avoid runaway output on pathological input.
pub fn walk_generic_json_to_markdown(value: &Value) -> String {
    let mut lines: Vec<String> = Vec::new();
    walk_generic(value, 0, &mut lines);
    lines.join("\n").trim().to_string()
}

const GENERIC_MAX_DEPTH: usize = 8;

fn walk_generic(value: &Value, depth: usize, lines: &mut Vec<String>) {
    if depth > GENERIC_MAX_DEPTH {
        return;
    }
    let indent = "  ".repeat(depth);
    match value {
        Value::Null => {}
        Value::Bool(b) => lines.push(format!("{}{}", indent, b)),
        Value::Number(n) => lines.push(format!("{}{}", indent, n)),
        Value::String(s) => {
            if !s.is_empty() {
                lines.push(format!("{}{}", indent, s));
            }
        }
        Value::Array(arr) => {
            for item in arr {
                match item {
                    Value::Null => {}
                    Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                        let s = match item {
                            Value::String(s) => s.clone(),
                            Value::Number(n) => n.to_string(),
                            Value::Bool(b) => b.to_string(),
                            _ => unreachable!(),
                        };
                        if !s.is_empty() {
                            lines.push(format!("{}- {}", indent, s));
                        }
                    }
                    _ => {
                        walk_generic(item, depth + 1, lines);
                    }
                }
            }
        }
        Value::Object(map) => {
            for (key, v) in map {
                match v {
                    Value::Null => {}
                    Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                        let s = match v {
                            Value::String(s) => s.clone(),
                            Value::Number(n) => n.to_string(),
                            Value::Bool(b) => b.to_string(),
                            _ => unreachable!(),
                        };
                        if !s.is_empty() {
                            lines.push(format!("{}{}: {}", indent, key, s));
                        }
                    }
                    _ => {
                        lines.push(format!("{}{}:", indent, key));
                        walk_generic(v, depth + 1, lines);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Full fixture: the real output.data for block 7f5ef11c from the release server
    /// (captured 2026-04-15). See `tests/fixtures/spec-7f5ef11c.json`.
    const FIXTURE_7F5EF11C: &str = include_str!("../tests/fixtures/spec-7f5ef11c.json");

    #[test]
    fn test_spec_walker_produces_expected_markdown() {
        let output_data: Value = serde_json::from_str(FIXTURE_7F5EF11C).expect("fixture parses");
        let md = walk_spec_to_markdown(&output_data);

        assert!(!md.is_empty(), "walker should produce non-empty output");
        // Title from data envelope
        assert!(md.contains("Monday Apr 13 At a Glance"), "should contain title; got:\n{}", md);
        // At least one Section header appears — spec has 22 elements
        assert!(md.contains("## "), "should contain at least one section header; got:\n{}", md);
        // Token reduction sanity: walker output should be meaningfully smaller than raw JSON
        assert!(
            md.len() < FIXTURE_7F5EF11C.len(),
            "walker output ({}) should be smaller than raw JSON ({})",
            md.len(),
            FIXTURE_7F5EF11C.len()
        );
    }

    #[test]
    fn test_spec_walker_handles_missing_spec() {
        let output = json!({ "title": "hello" });
        let md = walk_spec_to_markdown(&output);
        assert_eq!(md, "", "no spec → empty output, no panic");
    }

    #[test]
    fn test_spec_walker_handles_missing_root() {
        let output = json!({
            "spec": { "elements": { "x": { "type": "Text", "props": { "content": "hi" } } } }
        });
        let md = walk_spec_to_markdown(&output);
        assert_eq!(md, "", "no root key → empty output, no panic");
    }

    #[test]
    fn test_spec_walker_handles_missing_elements() {
        let output = json!({
            "title": "Just A Title",
            "spec": { "root": "x" }
        });
        let md = walk_spec_to_markdown(&output);
        assert_eq!(md, "", "no elements map → empty output, no panic");
    }

    #[test]
    fn test_spec_walker_renders_title_only_element() {
        let output = json!({
            "title": "Doc Title",
            "spec": {
                "root": "r",
                "elements": {
                    "r": { "type": "Section", "props": { "title": "Intro" }, "children": ["t"] },
                    "t": { "type": "Text", "props": { "content": "Hello world" } }
                }
            }
        });
        let md = walk_spec_to_markdown(&output);
        assert!(md.contains("# Doc Title"), "should render data.title; got:\n{}", md);
        assert!(md.contains("## Intro"), "should render Section heading; got:\n{}", md);
        assert!(md.contains("Hello world"), "should render Text content; got:\n{}", md);
    }

    #[test]
    fn test_spec_walker_detects_cycles() {
        let output = json!({
            "spec": {
                "root": "a",
                "elements": {
                    "a": { "type": "Section", "props": { "title": "A" }, "children": ["b"] },
                    "b": { "type": "Section", "props": { "title": "B" }, "children": ["a"] }
                }
            }
        });
        // Should not infinite-loop or panic
        let md = walk_spec_to_markdown(&output);
        assert!(md.contains("## A"));
        assert!(md.contains("## B"));
    }

    #[test]
    fn test_spec_walker_skips_dirty_title() {
        // JSON-blob titles should not be emitted as lead headings
        let output = json!({
            "title": "{\"raw\": \"json\"}",
            "spec": {
                "root": "r",
                "elements": { "r": { "type": "Text", "props": { "content": "ok" } } }
            }
        });
        let md = walk_spec_to_markdown(&output);
        assert!(!md.starts_with("#"), "dirty title should be skipped; got:\n{}", md);
        assert!(md.contains("ok"));
    }

    #[test]
    fn test_spec_walker_generic_fallback_for_unknown_types() {
        let output = json!({
            "spec": {
                "root": "r",
                "elements": {
                    "r": {
                        "type": "MysteryComponent",
                        "props": { "title": "Mystery", "description": "unknown type" }
                    }
                }
            }
        });
        let md = walk_spec_to_markdown(&output);
        assert!(md.contains("MysteryComponent"), "should emit type hint; got:\n{}", md);
        assert!(md.contains("Mystery"));
        assert!(md.contains("unknown type"));
    }

    #[test]
    fn test_generic_walker_flattens_nested_object() {
        let value = json!({
            "outer": {
                "inner": "deep value",
                "count": 42
            },
            "flag": true
        });
        let md = walk_generic_json_to_markdown(&value);
        assert!(md.contains("deep value"), "should surface nested string; got:\n{}", md);
        assert!(md.contains("42"), "should surface nested number");
        assert!(md.contains("flag"), "should surface top-level key");
    }

    #[test]
    fn test_generic_walker_handles_null() {
        assert_eq!(walk_generic_json_to_markdown(&Value::Null), "");
    }

    #[test]
    fn test_generic_walker_handles_empty_object() {
        assert_eq!(walk_generic_json_to_markdown(&json!({})), "");
    }

    #[test]
    fn test_generic_walker_handles_deep_nesting_without_panic() {
        let mut v = json!("bottom");
        for _ in 0..50 {
            v = json!({ "nested": v });
        }
        // Should not stack-overflow or panic, even though depth cap truncates.
        let md = walk_generic_json_to_markdown(&v);
        assert!(md.contains("nested"));
    }

    #[test]
    fn test_generic_walker_flattens_arrays() {
        let value = json!({ "items": ["alpha", "beta", "gamma"] });
        let md = walk_generic_json_to_markdown(&value);
        assert!(md.contains("alpha"));
        assert!(md.contains("gamma"));
    }
}
