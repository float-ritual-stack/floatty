//! Segment matcher — ADR-008 Decision 2, the coupling invariant lives HERE.
//!
//! Two entry points over one grammar:
//!   - [`match_exact`] — the WRITE predicate (mkdir-p direct-child find-or-create).
//!   - [`match_fuzzy`] — the READ ladder (nav / resolve descendant matching).
//!
//! [`match_fuzzy`]'s rung 1 IS [`match_exact`] (same call, not a copy): if they
//! diverge, write-then-read round-trips land in different blocks.
//!
//! OWNED INVARIANT — oldest-createdAt-wins is implemented ONCE, in
//! [`select_oldest`] below. The stage-2 `walk_descendants` walker and the
//! mkdir-p write endpoint CALL this matcher; they never re-derive the
//! tie-break. `created_at` of 0/missing compares as `i64::MAX` (never steals),
//! matching `PageNameIndex::add_existing_page` /
//! `scan_pages_container_for_name` semantics.
//!
//! Depth-proximity × recency cross-level scoring is the walker's job, not the
//! matcher's — [`match_fuzzy`] returns the rung so a walker can compose it.
//!
//! PARITY: mirrors `pathMatcher.ts` in the frontend; shared corpus
//! `src/lib/__fixtures__/path-grammar.json` `match` section asserts both.

use crate::hooks::page_name_index::section_key_from_content;
use crate::hooks::parsing::extract_tag_markers;
use regex::Regex;
use std::sync::LazyLock;

/// `[key::value]` — local mirror of `TAG_PATTERN` in `hooks/parsing.rs`, used
/// only to strip markers out of rung-3 `contains` input. Rung-4 values come
/// from the canonical [`extract_tag_markers`]; parity of both against the
/// canonical pattern is enforced by the shared fixture (rung 3 + rung 4).
static TAG_MARKER_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(\w+)::([^\]]+)\]").expect("valid regex"));

/// Minimal candidate — content + creation time only. Borrows `content` so
/// stage-2 adapters can build these cheaply from Y.Doc blocks, store rows, or
/// DTOs; the caller maps the returned index back to its own block list.
pub struct MatchCandidate<'a> {
    pub content: &'a str,
    /// Epoch ms. 0 (or missing) means "unknown age" → compares as `i64::MAX`.
    pub created_at: i64,
}

/// Fuzzy ladder rung (lower beats higher).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchRung {
    Exact,
    MarkdownStripped,
    Contains,
    Marker,
}

impl MatchRung {
    /// 1-based rung number (matches the fixture's `expected_rung`).
    pub fn as_number(self) -> u8 {
        match self {
            MatchRung::Exact => 1,
            MatchRung::MarkdownStripped => 2,
            MatchRung::Contains => 3,
            MatchRung::Marker => 4,
        }
    }
}

/// A fuzzy hit: which candidate, and by which rung it resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FuzzyMatch {
    pub index: usize,
    pub rung: MatchRung,
}

/// Effective created_at for tie-breaking: 0/missing → `i64::MAX` (never steals).
///
/// `pub` so walkers composing the ADR-008 D2 total order (rung → depth →
/// recency → oldest-createdAt) reuse THIS rule for their final tie-break
/// instead of re-deriving the +∞ semantics. Mirrors `effectiveCreatedAt`
/// exported by `pathMatcher.ts`.
pub fn effective_created_at(created_at: i64) -> i64 {
    if created_at > 0 {
        created_at
    } else {
        i64::MAX
    }
}

/// THE tie-break. Among candidates satisfying `predicate`, return the index of
/// the oldest (min effective created_at); ties resolve to the first encountered
/// (mirrors `scan_pages_container_for_name`'s `>= best` keep-earlier rule).
fn select_oldest<F>(candidates: &[MatchCandidate], predicate: F) -> Option<usize>
where
    F: Fn(&str) -> bool,
{
    let mut best: Option<(usize, i64)> = None;
    for (i, c) in candidates.iter().enumerate() {
        if !predicate(c.content) {
            continue;
        }
        let eff = effective_created_at(c.created_at);
        match best {
            Some((_, best_eff)) if eff >= best_eff => {}
            _ => best = Some((i, eff)),
        }
    }
    best.map(|(i, _)| i)
}

/// Sanitize a captured marker value — unwrap the `[key::[[wikilink]]]` typo
/// (mirrors `sanitize_marker_value` in `hooks/parsing.rs`).
fn sanitize_marker_value(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(after_open) = trimmed.strip_prefix("[[") {
        return after_open
            .strip_suffix("]]")
            .unwrap_or(after_open)
            .trim()
            .to_string();
    }
    trimmed.to_string()
}

/// Remove markdown emphasis markers so rung 2 compares on the plain name.
fn strip_markdown(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '*' | '_' | '~' | '`'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Lowercased content with `[key::value]` markers removed (rung 3 input).
fn marker_stripped_content(content: &str) -> String {
    TAG_MARKER_RE
        .replace_all(&content.to_lowercase(), "")
        .to_string()
}

/// WRITE predicate — exact canonicalized equality only, oldest-createdAt wins.
/// No prefix/contains/marker matching (a fuzzy write is a bug, ADR-008 D2).
///
/// Returns the index of the matching candidate, or `None`.
pub fn match_exact(segment: &str, candidates: &[MatchCandidate]) -> Option<usize> {
    let key = section_key_from_content(segment);
    // Empty canonical key (e.g. "## ", whitespace-only) matches nothing — the
    // tokenizer never emits such segments, but the matcher guards its own door.
    if key.is_empty() {
        return None;
    }
    select_oldest(candidates, |content| {
        section_key_from_content(content) == key
    })
}

/// READ ladder — 4 rungs, lower always beats higher; within a rung, oldest
/// created_at wins. Rung 1 delegates to [`match_exact`] (shared predicate).
///   1. exact (canonicalized equality) — the write predicate.
///   2. markdown-stripped equality.
///   3. contains (case-insensitive) against marker-stripped content.
///   4. marker-value match — segment equals a `[key::value]` value.
///
/// Rung 3 runs on marker-stripped content so a segment appearing ONLY inside a
/// marker falls through to rung 4 (otherwise the value is always a literal
/// substring of the raw content and rung 4 is unreachable).
///
/// Returns `{ index, rung }`, or `None` when no rung matches.
pub fn match_fuzzy(segment: &str, candidates: &[MatchCandidate]) -> Option<FuzzyMatch> {
    if let Some(index) = match_exact(segment, candidates) {
        return Some(FuzzyMatch {
            index,
            rung: MatchRung::Exact,
        });
    }

    let key = section_key_from_content(segment);
    // Empty key would make rung 3's contains("") match every candidate.
    if key.is_empty() {
        return None;
    }

    let stripped_key = strip_markdown(&key);
    if let Some(index) = select_oldest(candidates, |c| {
        strip_markdown(&section_key_from_content(c)) == stripped_key
    }) {
        return Some(FuzzyMatch {
            index,
            rung: MatchRung::MarkdownStripped,
        });
    }

    if let Some(index) = select_oldest(candidates, |c| marker_stripped_content(c).contains(&key)) {
        return Some(FuzzyMatch {
            index,
            rung: MatchRung::Contains,
        });
    }

    if let Some(index) = select_oldest(candidates, |c| {
        extract_tag_markers(c)
            .iter()
            .filter_map(|m| m.value.as_deref())
            .any(|v| section_key_from_content(&sanitize_marker_value(v)) == key)
    }) {
        return Some(FuzzyMatch {
            index,
            rung: MatchRung::Marker,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{match_exact, match_fuzzy, MatchCandidate};
    use crate::hooks::page_name_index::section_key_from_content;
    use crate::hooks::parsing::{
        extract_wikilink_targets, parse_path_segments, parse_wikilink_inner,
    };
    use serde::Deserialize;

    /// The shared corpus — the SAME file the TS tests import via `?raw`.
    const CORPUS_RAW: &str = include_str!("../../../../src/lib/__fixtures__/path-grammar.json");

    #[derive(Deserialize)]
    struct Corpus {
        tokenize: Vec<TokenizeCase>,
        canonicalize: Vec<CanonicalizeCase>,
        #[serde(rename = "match")]
        match_section: MatchSection,
    }

    #[derive(Deserialize)]
    struct TokenizeCase {
        name: String,
        input: Option<String>,
        input_inner: Option<String>,
        target: Option<String>,
        alias: Option<String>,
        segments: Vec<String>,
    }

    #[derive(Deserialize)]
    struct CanonicalizeCase {
        name: String,
        input: String,
        canonical: String,
    }

    #[derive(Deserialize)]
    struct MatchSection {
        cases: Vec<MatchCase>,
    }

    #[derive(Deserialize)]
    struct MatchCase {
        name: String,
        mode: String,
        segment: String,
        candidates: Vec<CandidateFixture>,
        expected: Option<usize>,
        expected_rung: Option<u8>,
    }

    #[derive(Deserialize)]
    struct CandidateFixture {
        content: String,
        #[serde(rename = "createdAt")]
        created_at: i64,
    }

    fn corpus() -> Corpus {
        serde_json::from_str(CORPUS_RAW).expect("corpus parses")
    }

    #[test]
    fn tokenize_corpus() {
        for c in &corpus().tokenize {
            let target = if let Some(inner) = &c.input_inner {
                // Alias split happens FIRST — parse_path_segments runs on target.
                let (t, a) = parse_wikilink_inner(inner);
                assert_eq!(&t, c.target.as_ref().unwrap(), "{}: target", c.name);
                assert_eq!(a.as_deref(), c.alias.as_deref(), "{}: alias", c.name);
                t
            } else {
                c.input.clone().expect("input or input_inner")
            };
            assert_eq!(parse_path_segments(&target), c.segments, "{}", c.name);
        }
    }

    #[test]
    fn canonicalize_corpus() {
        for c in &corpus().canonicalize {
            assert_eq!(
                section_key_from_content(&c.input),
                c.canonical,
                "{}",
                c.name
            );
        }
    }

    #[test]
    fn match_corpus() {
        for c in &corpus().match_section.cases {
            let candidates: Vec<MatchCandidate> = c
                .candidates
                .iter()
                .map(|cf| MatchCandidate {
                    content: &cf.content,
                    created_at: cf.created_at,
                })
                .collect();

            match c.mode.as_str() {
                "exact" => {
                    assert_eq!(
                        match_exact(&c.segment, &candidates),
                        c.expected,
                        "{}",
                        c.name
                    );
                }
                "fuzzy" => {
                    let result = match_fuzzy(&c.segment, &candidates);
                    assert_eq!(
                        result.as_ref().map(|m| m.index),
                        c.expected,
                        "{}: index",
                        c.name
                    );
                    if let (Some(rung), Some(m)) = (c.expected_rung, result.as_ref()) {
                        assert_eq!(m.rung.as_number(), rung, "{}: rung", c.name);
                    }
                }
                other => panic!("{}: unknown mode {}", c.name, other),
            }
        }
    }

    /// Rung 1 IS match_exact — a fuzzy hit on an exact-equal candidate must be
    /// rung 1 at the same index the write predicate would pick.
    #[test]
    fn fuzzy_rung1_is_match_exact() {
        let candidates = [
            MatchCandidate {
                content: "## Section B",
                created_at: 100,
            },
            MatchCandidate {
                content: "Section C",
                created_at: 50,
            },
        ];
        assert_eq!(match_exact("section b", &candidates), Some(0));
        let fuzzy = match_fuzzy("section b", &candidates).expect("fuzzy hit");
        assert_eq!(fuzzy.index, 0);
        assert_eq!(fuzzy.rung.as_number(), 1);
    }

    /// Characterization: the `>`-naive surfaces must be unchanged by stage 1.
    #[test]
    fn characterization_gt_naive_surfaces_unchanged() {
        let (target, alias) = parse_wikilink_inner("a > b");
        assert_eq!(target, "a > b");
        assert_eq!(alias, None);
        assert_eq!(
            extract_wikilink_targets("[[a > b]]"),
            vec!["a > b".to_string()]
        );
    }
}
