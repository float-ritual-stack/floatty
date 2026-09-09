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
    "sh",
    "term",
    "ctx",
    "dispatch",
    "pages",
    "web",
    "link",
    "img",
    "daily",
    "reminder",
    "meeting",
    "brain-boot",
    "door",
    "embed",
    "file",
    "ask",
    "media",
];

/// Code namespace patterns to exclude from standalone marker extraction.
/// These are Rust/code patterns like `std::string`, `tokio::spawn` that aren't semantic markers.
const CODE_NAMESPACES: &[&str] = &[
    "std",
    "core",
    "tauri",
    "tokio",
    "serde",
    "crate",
    "self",
    "super",
    "yrs",
    "log",
    "anyhow",
    "thiserror",
    "fs",
    "io",
    "env",
    "http",
    "tracing",
    "chrono",
    "regex",
    "tantivy",
    "async",
    "sync",
    "collections",
    "fmt",
    "path",
    "result",
    "option",
    "vec",
    "str",
    "string",
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

/// Regex for inline tag markers: `[key::value]`.
///
/// `pub(crate)` — THE canonical marker pattern for the crate. `segment_match`'s
/// rung-3 `marker_stripped_content` consumes this directly (it was a local
/// mirror, `TAG_MARKER_RE`, until the stage-2g reuse-audit consolidated it).
/// Mirrored cross-language by `TAG_MARKER` in `pathMatcher.ts`.
pub(crate) static TAG_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(\w+)::([^\]]+)\]").expect("valid regex"));

/// Known tag marker types (for validation/filtering if needed).
pub const KNOWN_TAG_TYPES: &[&str] = &["project", "mode", "issue", "repo", "branch", "meeting"];

/// Regex for standalone markers: `project::floatty` (not in brackets).
/// Captures: (1) marker_type, (2) value (optional — bare `floatctl::` is valid)
/// We must exclude matches inside brackets or code chains, done via post-filtering.
static STANDALONE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // Match word boundary, marker_type, ::, optional value (immediately adjacent)
    // Value group is optional → bare `floatctl::` matches with value=None
    Regex::new(r"\b([a-zA-Z_][a-zA-Z0-9_-]*)::(?:([\w/.@_-]+))?").expect("valid regex")
});

/// Extract all tag markers from content.
///
/// Returns markers for patterns like `[project::floatty]`, `[mode::dev]`.
///
/// Also unwraps the historic typo `[project::[[wikilink]]]` — the regex
/// captures `[[wikilink` (greedy match stops at the first `]`); the
/// sanitizer strips the leading `[[` so downstream consumers receive
/// the wikilink target as the value rather than a bracketed string.
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
///
/// // Historic typo: [project::[[floatty]]] captures "[[floatty",
/// // sanitizer unwraps to "floatty"
/// let markers = extract_tag_markers("[project::[[floatty]] = [[2026-04-19]]");
/// assert_eq!(markers[0].value, Some("floatty".to_string()));
/// ```
pub fn extract_tag_markers(content: &str) -> Vec<Marker> {
    TAG_PATTERN
        .captures_iter(content)
        .map(|cap| Marker::with_value(&cap[1], sanitize_marker_value(&cap[2])))
        .collect()
}

/// The authored representation of a property (not its derived metadata).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropSurface {
    Pill,
    Glyph,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropSpec {
    pub key: String,
    pub surface: PropSurface,
    /// (value name, glyph) pairs, in precedence order for a bare head glyph.
    pub glyphs: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PropWrite {
    pub set: Vec<(String, String)>,
    pub unset: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RejectReason {
    UnrepresentableValue,
    UnknownGlyphValue,
    MultipleExistingPills,
    UnsupportedExistingSurface,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropChange {
    pub content: String,
    pub changed: bool,
    pub rejected: std::collections::BTreeMap<String, RejectReason>,
    /// All extracted properties; absent keys are omitted, present valueless keys are None.
    /// Multiple extracted values use the extractor's first (sorted) value.
    pub before: std::collections::BTreeMap<String, Option<String>>,
    pub after: std::collections::BTreeMap<String, Option<String>>,
}

// Only horizontal ASCII whitespace is structural here; never consume a newline.
// Repeated prefixes allow shapes such as `> - ## title`. Bold is title content.
static PROP_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[ \t]*(?:(?:#{1,6}|[-+*>]|[0-9]+[.)]|[①-⑳㉑-㉟㊱-㊿])[ \t]+)*")
        .expect("valid regex")
});

fn prop_head(line: &str) -> usize {
    PROP_PREFIX.find(line).map_or(0, |m| m.end())
}

fn glyph_spans<'a>(content: &str, spec: &'a PropSpec) -> Vec<(usize, usize, &'a str)> {
    let line = content.split('\n').next().unwrap_or("");
    let mut spans = Vec::new();
    for (value, glyph) in &spec.glyphs {
        if glyph.is_empty() {
            continue;
        }
        let link = format!("[[{glyph}]]");
        for (start, _) in line.match_indices(&link) {
            spans.push((start, start + link.len(), value.as_str()));
        }
    }
    let head = prop_head(line);
    for (value, glyph) in &spec.glyphs {
        if !glyph.is_empty() && line[head..].starts_with(glyph) {
            let end = head + glyph.len();
            if end == line.len() || line[end..].starts_with([' ', '\t', '\r']) {
                spans.push((head, end, value.as_str()));
                break;
            }
        }
    }
    spans.sort_by_key(|span| span.0);
    spans.dedup_by_key(|span| span.0);
    spans
}

fn prop_values(
    content: &str,
    table: &[PropSpec],
) -> std::collections::BTreeMap<String, Option<String>> {
    let mut values = std::collections::BTreeMap::new();
    for marker in extract_all_markers(content) {
        values.entry(marker.marker_type).or_insert(marker.value);
    }
    for spec in table {
        if spec.surface == PropSurface::Glyph {
            if let Some((_, _, value)) = glyph_spans(content, spec).first() {
                values.insert(spec.key.clone(), Some((*value).to_owned()));
            }
        }
    }
    values
}

/// Read an own property through the canonical extractor plus glyph mapping.
/// None = absent; Some(None) = present without a value. A first-line mapped
/// glyph takes precedence over a pill of the same key.
pub fn current_prop_value(content: &str, key: &str, table: &[PropSpec]) -> Option<Option<String>> {
    prop_values(content, table).remove(key)
}

/// Remove one targeted span and one redundant adjoining space (if any).
/// Work backwards through spans so earlier offsets remain valid.
fn remove_prop_span(content: &mut String, mut start: usize, mut end: usize) {
    let bytes = content.as_bytes();
    let line_start = start == 0 || bytes[start - 1] == b'\n';
    let line_end = end == bytes.len() || matches!(bytes[end], b'\n' | b'\r');
    if end < bytes.len()
        && bytes[end] == b' '
        && (line_start || (start > 0 && bytes[start - 1] == b' '))
    {
        end += 1;
    } else if line_end && start > 0 && bytes[start - 1] == b' ' {
        start -= 1;
    }
    content.replace_range(start..end, "");
}

fn write_prop(
    content: &mut String,
    key: &str,
    value: Option<&str>,
    table: &[PropSpec],
) -> Option<RejectReason> {
    let original = content.clone();
    let glyph_spec = table
        .iter()
        .find(|spec| spec.key == key && spec.surface == PropSurface::Glyph);
    let (spans, replacement) = if let Some(spec) = glyph_spec {
        let replacement = if let Some(value) = value {
            let Some((_, glyph)) = spec
                .glyphs
                .iter()
                .find(|(name, glyph)| name == value && !glyph.is_empty())
            else {
                return Some(RejectReason::UnknownGlyphValue);
            };
            Some(format!("[[{glyph}]]"))
        } else {
            None
        };
        (
            glyph_spans(content, spec)
                .into_iter()
                .map(|(a, b, _)| (a, b))
                .collect::<Vec<_>>(),
            replacement,
        )
    } else {
        let replacement =
            value.map(|value| format!("[{key}::{}]", if value.is_empty() { " " } else { value }));
        if let (Some(value), Some(pill)) = (value, &replacement) {
            // Refuse unrepresentable input rather than silently changing its meaning.
            let markers = extract_tag_markers(pill);
            if value.trim().is_empty()
                || value.contains(['\r', '\n'])
                || markers.len() != 1
                || markers[0].marker_type != key
                || markers[0].value.as_deref() != Some(value)
                || TAG_PATTERN.find(pill).is_none_or(|m| m.as_str() != pill)
            {
                return Some(RejectReason::UnrepresentableValue);
            }
        }
        let spans = TAG_PATTERN
            .captures_iter(content)
            .filter(|cap| &cap[1] == key)
            .map(|cap| {
                let m = cap.get(0).expect("whole match");
                (m.start(), m.end())
            })
            .collect::<Vec<_>>();
        if spans.len() > 1 {
            return Some(RejectReason::MultipleExistingPills);
        }
        (spans, replacement)
    };
    for (index, &(start, end)) in spans.iter().enumerate().rev() {
        if index == 0 {
            if let Some(replacement) = &replacement {
                content.replace_range(start..end, replacement);
                continue;
            }
        }
        remove_prop_span(content, start, end);
    }
    if spans.is_empty() {
        if let Some(replacement) = replacement {
            if glyph_spec.is_some() {
                let head = prop_head(content.split('\n').next().unwrap_or(""));
                content.insert_str(head, &format!("{replacement} "));
            } else {
                let first_end = content.find('\n').unwrap_or(content.len());
                let second_start = (first_end < content.len()).then_some(first_end + 1);
                let mut end = first_end;
                if let Some(start) = second_start {
                    if TAG_PATTERN
                        .find(&content[start..])
                        .is_some_and(|m| m.start() == 0)
                    {
                        end = content[start..]
                            .find('\n')
                            .map_or(content.len(), |n| start + n);
                    }
                }
                if end > 0 && content.as_bytes()[end - 1] == b'\r' {
                    end -= 1;
                }
                let separator =
                    if end == 0 || matches!(content.as_bytes()[end - 1], b' ' | b'\t' | b'\n') {
                        ""
                    } else {
                        " "
                    };
                content.insert_str(end, &format!("{separator}{replacement}"));
            }
        }
    }
    if current_prop_value(content, key, table) != value.map(|v| Some(v.to_owned())) {
        *content = original;
        return Some(RejectReason::UnsupportedExistingSurface);
    }
    None
}

/// Splice authored properties without writing derived metadata. Set operations
/// run in key order (last value wins duplicate keys), then unset wins any overlap. Invalid/unrepresentable pill values
/// and unknown glyph values leave that key untouched with a rejection diagnostic.
/// Multiple existing pills are rejected instead of collapsing authored values.
/// Only targeted spans and the redundant spaces left by removal are changed.
pub fn set_marker_value(content: &str, write: &PropWrite, table: &[PropSpec]) -> PropChange {
    let before = prop_values(content, table);
    let mut result = content.to_owned();
    let mut rejected = std::collections::BTreeMap::new();
    let sets: std::collections::BTreeMap<_, _> =
        write.set.iter().map(|(key, value)| (key, value)).collect();
    for (key, value) in sets {
        if let Some(reason) = write_prop(&mut result, key, Some(value), table) {
            rejected.insert(key.clone(), reason);
        }
    }
    for key in &write.unset {
        if let Some(reason) = write_prop(&mut result, key, None, table) {
            rejected.insert(key.clone(), reason);
        }
    }
    PropChange {
        rejected,
        changed: result != content,
        after: prop_values(&result, table),
        content: result,
        before,
    }
}

/// Sanitize a captured marker value.
///
/// Handles the `[type::[[wikilink]]]` typo case: the TAG_PATTERN regex
/// (`[^\]]+`) stops at the first `]`, so it captures `[[wikilink` (with
/// the closing `]]` left as broken trailing content). When the captured
/// value starts with `[[`, strip that prefix (and any matching `]]`
/// suffix) so the value is the wikilink target rather than the
/// bracketed source. Clean values pass through unchanged.
fn sanitize_marker_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(after_open) = trimmed.strip_prefix("[[") {
        let cleaned = after_open.strip_suffix("]]").unwrap_or(after_open);
        return cleaned.trim().to_string();
    }
    trimmed.to_string()
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
            // cap[1] = marker_type, cap[2] = value (optional)
            let marker_type = &cap[1];

            // Skip code namespaces
            if CODE_NAMESPACES
                .iter()
                .any(|ns| ns.eq_ignore_ascii_case(marker_type))
            {
                return None;
            }

            // Skip prefix markers — their "values" are command content, not metadata.
            // Exception: ctx:: values are dates/timestamps we want to capture.
            let marker_type_lower = marker_type.to_lowercase();
            if PREFIX_MARKERS.contains(&marker_type_lower.as_str()) && marker_type_lower != "ctx" {
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

            // Value is optional (bare `floatctl::` has no value)
            match cap.get(2) {
                Some(value_match) => Some(Marker::with_value(marker_type, value_match.as_str())),
                None => Some(Marker::new(marker_type.to_string())),
            }
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

/// Split a wikilink target into path segments on whitespace-delimited `>`.
///
/// ADR-008 Decision 1 grammar. Runs on the alias-stripped target (call
/// [`parse_wikilink_inner`] first). PARITY: mirrors `parsePathSegments` in the
/// frontend `lib/wikilinkUtils.ts`; shared corpus
/// `src/lib/__fixtures__/path-grammar.json` asserts both. Interpretation is a
/// USE-time concern (click, API call); extraction/render stay `>`-naive, so
/// this is NOT wired into [`parse_wikilink_inner`] or
/// [`extract_wikilink_targets`].
///
/// A `>` splits only at `[[`/`]]` depth 0 with whitespace on the left AND
/// whitespace-or-end-of-string on the right (bare `a>b`, generics
/// `Vec<String>`, arrows `A->B` never split). Any malformed shape — an empty
/// segment (leading/middle/trailing) or unbalanced `[[` — yields the whole
/// target as one opaque segment, preserving pre-path-addressing behavior.
///
/// # Examples
///
/// ```
/// use floatty_core::hooks::parsing::parse_path_segments;
///
/// assert_eq!(parse_path_segments("a > b > c"), vec!["a", "b", "c"]);
/// assert_eq!(parse_path_segments("just a page"), vec!["just a page"]);
/// assert_eq!(parse_path_segments("a>b"), vec!["a>b"]); // bare > stays opaque
/// assert_eq!(parse_path_segments("a >  > b"), vec!["a >  > b"]); // empty seg → opaque
/// ```
pub fn parse_path_segments(target: &str) -> Vec<String> {
    let bytes = target.as_bytes();
    let len = bytes.len();
    let mut segments: Vec<String> = Vec::new();
    let mut depth: i32 = 0;
    let mut seg_start = 0usize;
    let mut i = 0usize;

    while i < len {
        if i + 1 < len && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            depth += 1;
            i += 2;
            continue;
        }
        if i + 1 < len && bytes[i] == b']' && bytes[i + 1] == b']' {
            depth -= 1;
            i += 2;
            continue;
        }

        if depth == 0 && bytes[i] == b'>' {
            // Unicode White_Space (char::is_whitespace), not ASCII — NBSP and
            // friends must split identically to the TS twin's /\p{White_Space}/u
            // (macOS Opt+Space types NBSP). `>` is ASCII so `i` is always a
            // char boundary; decode the adjacent CHARS, not bytes.
            let prev_is_ws = target[..i]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
            let next_is_ws_or_end = target[i + 1..]
                .chars()
                .next()
                .is_none_or(char::is_whitespace);
            if prev_is_ws && next_is_ws_or_end {
                let seg = target[seg_start..i].trim();
                if seg.is_empty() {
                    return vec![target.to_string()]; // empty segment → opaque
                }
                segments.push(seg.to_string());
                seg_start = i + 1;
                i += 1;
                continue;
            }
        }
        i += 1;
    }

    if depth != 0 {
        return vec![target.to_string()]; // unbalanced [[ → opaque
    }
    if segments.is_empty() {
        return vec![target.to_string()]; // no separator → single opaque segment
    }
    let last = target[seg_start..].trim();
    if last.is_empty() {
        return vec![target.to_string()]; // trailing empty → opaque
    }
    segments.push(last.to_string());
    segments
}

/// Extract all wikilink targets from content, including nested ones.
///
/// For `[[outer [[inner]]]]`, returns: `["outer [[inner]]", "inner"]`
///
/// This enables backlinks to both the outer and inner targets.
///
/// ADR-008 Decision 4 (stage 2c, FLO-830): a path link contributes its FIRST
/// segment as the target — `[[a > b > c]]` → `"a"` (a page reference), not the
/// opaque phantom `"a > b > c"`. Single-segment targets pass through unchanged
/// (`parse_path_segments` returns `[target]` opaque). The emitted first segment
/// is raw/as-written, staying consistent with how single-segment outlinks are
/// stored and compared today (read-time case-insensitive matching). PARITY:
/// mirrors `extractAllWikilinkTargets` in the frontend `lib/wikilinkUtils.ts`;
/// the shared corpus (`__fixtures__/path-grammar.json` "outlinks" section)
/// asserts both.
///
/// # Examples
///
/// ```
/// use floatty_core::hooks::parsing::extract_wikilink_targets;
///
/// assert_eq!(extract_wikilink_targets("[[Page]]"), vec!["Page"]);
/// assert_eq!(extract_wikilink_targets("[[Target|Alias]]"), vec!["Target"]);
/// assert_eq!(extract_wikilink_targets("[[outer [[inner]]]]"), vec!["outer [[inner]]", "inner"]);
/// assert_eq!(extract_wikilink_targets("[[a > b > c]]"), vec!["a"]); // ADR-008 D4
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
            // ADR-008 D4: contribute the path's first segment (page reference).
            let first_segment = parse_path_segments(&target)
                .into_iter()
                .next()
                .unwrap_or_else(|| target.clone());

            // Recurse on the raw target so genuinely-nested [[wikilinks]] still
            // resolve (e.g. [[outer [[inner]]]] → "inner").
            let nested = extract_wikilink_targets(&target);

            targets.push(first_segment);
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
// CTX DATETIME EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

/// Regex for extracting full datetime from ctx:: markers.
/// Handles: `ctx::2026-03-11`, `ctx::2026-03-11 @ 04:42:47 AM`, `ctx::2026-03-11 @ 4:42 PM`
/// Case-insensitive for AM/PM (accepts am/pm/Am/Pm).
static CTX_DATETIME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)ctx::(\d{4}-\d{2}-\d{2})(?:\s*@\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?))?")
        .expect("valid regex")
});

/// Extract ISO datetime from a ctx:: marker.
///
/// Returns the most specific datetime string possible:
/// - `ctx::2026-03-11` → `"2026-03-11"`
/// - `ctx::2026-03-11 @ 04:42:47 AM` → `"2026-03-11T04:42:47"`
/// - `ctx::2026-03-11 @ 4:42 PM` → `"2026-03-11T16:42:00"`
pub fn extract_ctx_datetime(content: &str) -> Option<String> {
    let caps = CTX_DATETIME.captures(content)?;
    let date = caps.get(1)?.as_str();

    match caps.get(2) {
        None => Some(date.to_string()),
        Some(time_match) => {
            let time_str = time_match.as_str().trim();
            // Parse 12h time to 24h
            let time_upper = time_str.to_uppercase();
            let is_pm = time_upper.ends_with("PM");
            let is_am = time_upper.ends_with("AM");
            let time_digits = time_str
                .trim_end_matches(|c: char| c.is_ascii_alphabetic())
                .trim();

            let parts: Vec<&str> = time_digits.split(':').collect();
            if parts.is_empty() {
                return Some(date.to_string());
            }

            let mut hour: u32 = parts[0].parse().ok()?;
            let minute: u32 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
            let second: u32 = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);

            if is_pm || is_am {
                // Validate 12h range before conversion
                if !(1..=12).contains(&hour) {
                    return None;
                }
                if is_pm && hour != 12 {
                    hour += 12;
                } else if is_am && hour == 12 {
                    hour = 0;
                }
            }

            // Validate ranges
            if hour > 23 || minute > 59 || second > 59 {
                return None;
            }

            Some(format!("{date}T{hour:02}:{minute:02}:{second:02}"))
        }
    }
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

    #[test]
    fn set_marker_value_corpus() {
        use serde::Deserialize;
        use std::collections::BTreeMap;
        #[derive(Deserialize)]
        struct Corpus {
            cases: Vec<Case>,
        }
        #[derive(Deserialize)]
        struct Case {
            name: String,
            content: String,
            write: Write,
            table: String,
            expect: Expected,
        }
        #[derive(Deserialize)]
        struct Write {
            set: BTreeMap<String, String>,
            unset: Vec<String>,
        }
        #[derive(Deserialize)]
        struct Expected {
            content: String,
            changed: bool,
            #[serde(default)]
            rejected: BTreeMap<String, RejectReason>,
        }
        let corpus: Corpus = serde_json::from_str(include_str!(
            "../../../../src/lib/__fixtures__/marker-surgery.json"
        ))
        .unwrap();
        let table = crate::props::default_prop_table();
        for c in corpus.cases {
            assert_eq!(c.table, "default");
            let write = PropWrite {
                set: c.write.set.into_iter().collect(),
                unset: c.write.unset,
            };
            let result = set_marker_value(&c.content, &write, &table);
            assert_eq!(result.content, c.expect.content, "{}", c.name);
            assert_eq!(result.changed, c.expect.changed, "{}", c.name);
            assert_eq!(result.rejected, c.expect.rejected, "{}", c.name);
            let repeated = set_marker_value(&result.content, &write, &table);
            assert!(!repeated.changed, "{}: idempotence", c.name);
            assert_eq!(repeated.after, result.after, "{}", c.name);
            for key in result
                .before
                .keys()
                .chain(result.after.keys())
                .chain(write.set.iter().map(|(key, _)| key))
                .chain(write.unset.iter())
            {
                assert_eq!(
                    result.before.get(key).cloned(),
                    current_prop_value(&c.content, key, &table),
                    "{} before {key}",
                    c.name
                );
                assert_eq!(
                    result.after.get(key).cloned(),
                    current_prop_value(&result.content, key, &table),
                    "{} after {key}",
                    c.name
                );
            }
        }
    }

    #[test]
    fn current_prop_value_states_and_custom_table() {
        let table = crate::props::default_prop_table();
        let content = "ctx:: [project:: ] [[🟨]] card";
        assert_eq!(current_prop_value(content, "missing", &table), None);
        assert_eq!(current_prop_value(content, "ctx", &table), Some(None));
        assert_eq!(
            current_prop_value(content, "project", &table),
            Some(Some("".into()))
        );
        assert_eq!(
            current_prop_value(content, "status", &table),
            Some(Some("doing".into()))
        );
        assert_eq!(
            current_prop_value("[project::z] [project::a]", "project", &table),
            Some(Some("a".into()))
        );
        let table = vec![PropSpec {
            key: "review".into(),
            surface: PropSurface::Glyph,
            glyphs: vec![("ready".into(), "🔎".into())],
        }];
        let result = set_marker_value(
            "card",
            &PropWrite {
                set: vec![("review".into(), "ready".into())],
                unset: vec![],
            },
            &table,
        );
        assert_eq!(result.content, "[[🔎]] card");
        assert_eq!(result.after.get("review"), Some(&Some("ready".into())));
    }

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
    fn test_prefix_marker_retired_ai_is_not_special() {
        assert_eq!(extract_prefix_marker("ai:: explain this"), None);
    }

    #[test]
    fn test_prefix_marker_case_insensitive() {
        assert_eq!(
            extract_prefix_marker("SH:: uppercase"),
            Some("sh".to_string())
        );
        assert_eq!(
            extract_prefix_marker("Ctx:: mixed"),
            Some("ctx".to_string())
        );
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

    #[test]
    fn test_tag_marker_unwraps_embedded_wikilink() {
        // Historic typo: [project::[[floatty]]] — the regex captures
        // "[[floatty" (greedy [^\]]+ stops at the first `]`); sanitizer
        // should strip the leading `[[` so the value is the wikilink target.
        // From daddy's 2026-04-26 ancestor-context test pass on the live
        // outline (one block had this typo).
        let markers = extract_tag_markers("[project::[[floatty]] = [[2026-04-19]]");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "project");
        assert_eq!(markers[0].value, Some("floatty".to_string()));
    }

    #[test]
    fn test_tag_marker_clean_value_passes_through() {
        // Regression guard: sanitizer must not mangle clean values.
        let markers = extract_tag_markers("[project::floatty]");
        assert_eq!(markers[0].value, Some("floatty".to_string()));
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

    #[test]
    fn test_standalone_bare_marker() {
        // Bare marker with no value (e.g., `floatctl::`)
        let markers = extract_standalone_markers("floatctl::");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "floatctl");
        assert_eq!(markers[0].value, None);
    }

    #[test]
    fn test_standalone_bare_in_prose() {
        // Bare marker followed by prose — value is None, prose is not captured
        let markers = extract_standalone_markers("portless:: is a door type");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "portless");
        assert_eq!(markers[0].value, None);
    }

    #[test]
    fn test_standalone_bare_at_end() {
        let markers = extract_standalone_markers("this is floatctl::");
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].marker_type, "floatctl");
        assert_eq!(markers[0].value, None);
    }

    #[test]
    fn test_standalone_prefix_markers_capture_value() {
        // Standalone filters all PREFIX_MARKERS except "ctx" — ctx:: values are dates
        // we want to capture, while other prefixes (sh::) have command content as values.
        let markers = extract_standalone_markers("ctx::2026-01-10 project::floatty");
        assert_eq!(markers.len(), 2);
        assert_eq!(markers[0].marker_type, "ctx");
        assert_eq!(markers[0].value, Some("2026-01-10".to_string()));
        assert_eq!(markers[1].marker_type, "project");
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
    // Path-link outlink extraction (ADR-008 D4, FLO-830)
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_extract_path_link_first_segment() {
        // ADR-008 D4: a path link's outlink is its FIRST segment (page ref).
        assert_eq!(extract_wikilink_targets("[[a > b > c]]"), vec!["a"]);
        assert_eq!(extract_wikilink_targets("[[a > b|label]]"), vec!["a"]);
        // Nested [[y]] inside a deeper path segment still resolves via recursion.
        assert_eq!(extract_wikilink_targets("[[x > [[y]]]]"), vec!["x", "y"]);
        // Single-segment + bare `>` stay opaque (unchanged from pre-2c).
        assert_eq!(
            extract_wikilink_targets("[[Demo Alpha]]"),
            vec!["Demo Alpha"]
        );
        assert_eq!(extract_wikilink_targets("[[a>b]]"), vec!["a>b"]);
    }

    /// The SAME fixture the TS tests import (`extractAllWikilinkTargets`) — the
    /// "outlinks" section of the shared corpus asserts both sides in parity.
    #[test]
    fn extract_wikilink_targets_outlinks_corpus() {
        use serde::Deserialize;

        #[derive(Deserialize)]
        struct Corpus {
            outlinks: Vec<OutlinkCase>,
        }
        #[derive(Deserialize)]
        struct OutlinkCase {
            name: String,
            content: String,
            targets: Vec<String>,
        }

        const CORPUS_RAW: &str = include_str!("../../../../src/lib/__fixtures__/path-grammar.json");
        let corpus: Corpus = serde_json::from_str(CORPUS_RAW).expect("corpus parses");

        for c in &corpus.outlinks {
            assert_eq!(
                extract_wikilink_targets(&c.content),
                c.targets,
                "{}",
                c.name
            );
        }
    }

    /// FLO-954: the marker grammar is the contract with the client's
    /// `src/lib/markerGrammar.ts`. The "markers" section of
    /// `__fixtures__/marker-grammar.json` asserts both sides — a client that
    /// recognises fewer shapes than this function clobbers server-extracted
    /// markers on remote re-extraction.
    #[test]
    fn extract_all_markers_corpus() {
        use serde::Deserialize;

        #[derive(Deserialize)]
        struct Corpus {
            markers: Vec<MarkerCase>,
        }
        #[derive(Deserialize)]
        struct MarkerCase {
            name: String,
            content: String,
            markers: Vec<ExpectedMarker>,
        }
        #[derive(Deserialize)]
        struct ExpectedMarker {
            #[serde(rename = "type")]
            marker_type: String,
            value: Option<String>,
        }

        const CORPUS_RAW: &str =
            include_str!("../../../../src/lib/__fixtures__/marker-grammar.json");
        let corpus: Corpus = serde_json::from_str(CORPUS_RAW).expect("corpus parses");

        for c in &corpus.markers {
            let got: Vec<(String, Option<String>)> = extract_all_markers(&c.content)
                .into_iter()
                .map(|m| (m.marker_type, m.value))
                .collect();
            let want: Vec<(String, Option<String>)> = c
                .markers
                .iter()
                .map(|m| (m.marker_type.clone(), m.value.clone()))
                .collect();
            assert_eq!(got, want, "{}", c.name);
        }
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
    // ctx:: datetime extraction
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn test_ctx_datetime_date_only() {
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-11"),
            Some("2026-03-11".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_full() {
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-11 @ 04:42:47 AM"),
            Some("2026-03-11T04:42:47".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_pm() {
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-11 @ 4:42 PM"),
            Some("2026-03-11T16:42:00".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_noon() {
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-11 @ 12:00 PM"),
            Some("2026-03-11T12:00:00".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_midnight() {
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-11 @ 12:00 AM"),
            Some("2026-03-11T00:00:00".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_24h_no_ampm() {
        // 24h format without AM/PM — hour passes through unchanged
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-11 @ 14:30"),
            Some("2026-03-11T14:30:00".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_lowercase_pm() {
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-11 @ 4:42 pm"),
            Some("2026-03-11T16:42:00".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_with_dash_project() {
        // Real text expander format: ctx::DATE @ TIME AM - [project::X]
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-15 @ 03:33:24 AM - [project::rangle/pharmacy]"),
            Some("2026-03-15T03:33:24".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_with_newline() {
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-15 @ 12:27:25 AM\n"),
            Some("2026-03-15T00:27:25".to_string())
        );
    }

    #[test]
    fn test_ctx_datetime_no_ctx() {
        assert_eq!(extract_ctx_datetime("project::floatty"), None);
    }

    #[test]
    fn test_ctx_datetime_in_context() {
        assert_eq!(
            extract_ctx_datetime("ctx::2026-03-11 @ 11:22:26 PM [project::floatty]"),
            Some("2026-03-11T23:22:26".to_string())
        );
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
        // ctx prefix gives {ctx, None}, standalone gives {ctx, Some("2026-01-10")}
        // Both survive dedup (different values). Total: 4
        assert_eq!(markers.len(), 4);
        // Sorted: ctx(None) < ctx(Some) < mode < project
        assert_eq!(markers[0].marker_type, "ctx");
        assert_eq!(markers[0].value, None);
        assert_eq!(markers[1].marker_type, "ctx");
        assert_eq!(markers[1].value, Some("2026-01-10".to_string()));
        assert_eq!(markers[2].marker_type, "mode");
        assert_eq!(markers[3].marker_type, "project");
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
        // ctx prefix {ctx, None} + standalone {ctx, Some("2026-01-11")} + issue, mode, project
        assert_eq!(markers.len(), 5);
        assert_eq!(markers[0].marker_type, "ctx");
        assert_eq!(markers[0].value, None);
        assert_eq!(markers[1].marker_type, "ctx");
        assert_eq!(markers[1].value, Some("2026-01-11".to_string()));
        assert_eq!(markers[2].marker_type, "issue");
        assert_eq!(markers[3].marker_type, "mode");
        assert_eq!(markers[4].marker_type, "project");
    }
}
