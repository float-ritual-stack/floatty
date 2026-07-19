//! Descendant path walker — the directional mirror of [`walk_ancestors`].
//!
//! ADR-008 Decision 5: server-side descendant resolution is a new shared
//! primitive in `projections/`, mirroring [`walk_ancestors`] + `ParentLookup`
//! (adapters, cycle-guard via visited set, explicit termination enum, cap
//! semantics). It becomes PROTECTED architecture on merge, same governance as
//! its sibling (FLO-679 PR 1 precedent). Do not add a parallel inline
//! descendant walk; route path resolution through [`walk_descendants`].
//!
//! Where [`walk_ancestors`] climbs `parent → parent → …` collecting IDs, this
//! module descends a *path*: a sequence of section segments (`page > A > B`)
//! against the child tree, matching each segment against the children (Exact)
//! or descendants (Fuzzy) of the previously-matched block.
//!
//! # The pattern
//!
//! All call sites need the same primitive — "given a root block and a list of
//! path segments, walk down the child tree matching each segment in turn,
//! recording which block each segment resolved to and stopping on the first
//! miss." The variation is purely in how the child lookup is performed:
//!
//! - **Y.Doc direct** — `blocks_map.get(txn, id)` then read `childIds`
//! - **`Store::get_block`** — the same Y.Doc through a higher-level wrapper
//!   that materialises a `Block` struct
//! - **In-memory `HashMap<String, Vec<String>>`** — pre-built child map
//!
//! The [`ChildLookup`] trait abstracts the lookup; [`walk_descendants`] owns
//! the walk algorithm. Content (needed by the matcher) is supplied separately
//! via a `content_of` closure — structure comes from the lookup, data comes
//! from the closure, exactly as [`walk_ancestors`] takes `PageNameIndex`
//! alongside `ParentLookup`. Three adapters ship with this module:
//!
//! - [`YDocChildLookup`] — wraps `(&MapRef, &Txn)`
//! - [`StoreChildLookup`] — wraps `&YDocStore`
//! - [`HashMapChildLookup`] — wraps `&HashMap<String, Vec<String>>`
//!
//! # The matcher owns the tie-break — this walker composes it
//!
//! Segment matching (which candidate satisfies a segment, and by which rung)
//! is owned entirely by [`crate::projections::segment_match`]. This walker
//! NEVER decides what matches or re-derives oldest-createdAt-wins — it calls
//! [`match_exact`] / [`match_fuzzy`] and composes their results. Per the
//! matcher's module header: "Depth-proximity × recency cross-level scoring is
//! the walker's job, not the matcher's — `match_fuzzy` returns the rung so a
//! walker can compose it." The composition (ADR-008 D2 deterministic order):
//!
//! 1. **rung quality** — a lower rung always beats a higher one.
//! 2. **depth proximity** — among equal-rung hits, the shallower (nearer the
//!    current match) wins. The fuzzy walk is depth-ascending BFS, so the first
//!    depth carrying the globally-best rung is preferred.
//! 3. **oldest-createdAt** — the final within-candidate-set tie-break is the
//!    matcher's [`match_fuzzy`]/[`match_exact`] `select_oldest`, applied per
//!    depth level; the walker never re-implements it.
//!
//! (Recency — a distinct last-edit signal — is not carried on
//! [`MatchCandidate`] and is not modelled in v1; the ADR's order degrades
//! cleanly to rung → depth → oldest-createdAt.)
//!
//! # Two modes
//!
//! - [`ResolveMode::Exact`] — the WRITE predicate shape (mkdir-p) reused as a
//!   READ mode: **direct children only, no level skipping**, [`match_exact`]
//!   per segment. `page > C` resolves only if `C` is a direct child of the
//!   block `page` resolved to.
//! - [`ResolveMode::Fuzzy`] — the READ ladder: each segment's candidate set is
//!   **all descendants** of the current match (may skip levels), [`match_fuzzy`]
//!   composed across depths, bounded by [`DescendantCaps::fuzzy_visited_cap`].
//!
//! # Termination semantics
//!
//! The walk terminates when ANY of:
//!
//! 1. Every segment resolved → [`DescendantTermination::Resolved`]. The empty
//!    segment list also resolves immediately (deepest = `root_id`).
//! 2. A segment failed to match its candidate set →
//!    [`DescendantTermination::PartialMiss`]. `deepest_resolved` is the last
//!    block that DID resolve (or `root_id` when segment 0 missed);
//!    `unresolved` carries the tail from the failing segment onward.
//! 3. A fuzzy segment expansion exhausted [`DescendantCaps::fuzzy_visited_cap`]
//!    without resolving → [`DescendantTermination::Cap`]. If a match is found
//!    *before* the cap is hit, the walk continues normally.
//! 4. A segment matched a block already in the resolution chain (root + every
//!    prior match) → [`DescendantTermination::Cycle`]. The cyclic block is NOT
//!    appended to the trace (terminate BEFORE re-adding, mirroring
//!    [`walk_ancestors`]). The per-expansion visited set independently guards
//!    the fuzzy BFS against a cyclic `childIds` graph looping forever.
//!
//! # Mutation-guard note
//!
//! This walker is READ-side (nav resolve, `GET /resolve`). Unlike
//! [`walk_ancestors`], no caller mutates state under a resolved path today, so
//! there is no "reject Cycle before writing" contract yet. The mkdir-p WRITE
//! path (ADR-008 D6/D7, stage 2b) is a separate exact find-or-create loop, not
//! a consumer of this walker. If a future writer consumes `DescendantWalk`, it
//! MUST inspect `termination` and reject `Cycle`/`Cap` explicitly.

use std::collections::HashSet;

use yrs::{Array, Map, ReadTxn};

use crate::projections::segment_match::{match_exact, match_fuzzy, MatchCandidate, MatchRung};

/// Default per-segment fuzzy expansion cap — total descendants visited while
/// resolving one segment before giving up. Mirrors `get_subtree`'s 1000-node
/// cap (block_service.rs) and the ADR-008 D2 "~1000" bound.
pub const DEFAULT_FUZZY_VISITED_CAP: usize = 1000;

/// Resolution mode — which matcher entry point drives each segment.
///
/// [`ResolveMode::Exact`] is the write predicate reused as a read mode
/// (direct-child, no skipping); [`ResolveMode::Fuzzy`] is the read ladder
/// (descendant selector, may skip levels). Mirrors the two matcher entry
/// points ([`match_exact`] / [`match_fuzzy`]) exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveMode {
    /// Direct children only, no level skipping, [`match_exact`] per segment.
    Exact,
    /// All descendants of the current match, [`match_fuzzy`] composed across
    /// depths (shallower wins on a rung tie), bounded by the visited cap.
    Fuzzy,
}

/// Caps governing a descendant walk. Bundled as a struct (rather than a bare
/// `usize` like [`walk_ancestors`]'s `max_depth`) so the fuzzy bound can grow
/// additional knobs without churning every call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DescendantCaps {
    /// Total descendants visited per fuzzy segment expansion before the walk
    /// gives up with [`DescendantTermination::Cap`]. Ignored in
    /// [`ResolveMode::Exact`] (direct-child only — the candidate set is one
    /// level and inherently bounded by the fan-out).
    pub fuzzy_visited_cap: usize,
}

impl Default for DescendantCaps {
    fn default() -> Self {
        Self {
            fuzzy_visited_cap: DEFAULT_FUZZY_VISITED_CAP,
        }
    }
}

/// Content + creation time for one candidate block — the minimum the matcher
/// needs. Supplied by the caller's `content_of` closure so the walker stays
/// agnostic to how blocks materialise (Y.Doc read, `Store::get_block`, test
/// map). Mirrors [`MatchCandidate`]'s fields but owns its `content` string so
/// it can outlive a single match call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeInfo {
    /// Raw block content (the matcher canonicalizes it).
    pub content: String,
    /// Epoch ms. 0 / missing means "unknown age" → the matcher compares it as
    /// `i64::MAX` (never steals a tie), matching `PageNameIndex` semantics.
    pub created_at: i64,
}

/// How one path segment resolved — which block, by which rung.
///
/// In [`ResolveMode::Exact`] the rung is always [`MatchRung::Exact`]; in
/// [`ResolveMode::Fuzzy`] it is whichever rung [`match_fuzzy`] reported for the
/// winning candidate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentResolution {
    /// The segment text (as passed in), for round-trip observability.
    pub segment: String,
    /// The block ID this segment resolved to.
    pub block_id: String,
    /// The ladder rung that matched.
    pub rung: MatchRung,
}

/// Why a descendant walk stopped. Surfacing the reason lets callers
/// distinguish "resolved the whole path" from "missed partway" from "hit the
/// fuzzy cap" from "hit a cycle" — four semantically distinct situations, all
/// producing a finite [`DescendantWalk::trace`]. Mirrors
/// [`crate::projections::WalkTermination`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum DescendantTermination {
    /// Every segment resolved (or the segment list was empty). `unresolved`
    /// is empty; `deepest_resolved` is the leaf (or `root_id` when empty).
    #[default]
    Resolved,
    /// A segment failed to match its candidate set. `deepest_resolved` is the
    /// last resolved block; `unresolved` carries the tail from the miss on.
    PartialMiss,
    /// A fuzzy segment expansion exhausted the visited cap without resolving.
    /// `deepest_resolved` / `unresolved` as for `PartialMiss`.
    Cap,
    /// A segment matched a block already in the resolution chain. The cyclic
    /// block is NOT appended to the trace (terminate before re-adding).
    Cycle,
}

/// Result of walking a path down the child tree.
///
/// `trace` records each resolved segment nearest-root-first (`trace[0]` is the
/// first segment under `root_id`), so `trace.len()` equals the number of
/// segments that resolved. `deepest_resolved` is the block the walk reached —
/// the leaf on [`DescendantTermination::Resolved`], otherwise the last block
/// that resolved (or `root_id` if the first segment missed). `unresolved` is
/// the segment tail that did NOT resolve (empty on `Resolved`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DescendantWalk {
    /// Per-segment resolutions, in path order. Contains no duplicate block IDs
    /// (the chain-cycle guard terminates before re-adding).
    pub trace: Vec<SegmentResolution>,
    /// The deepest block reached. `root_id` when nothing resolved.
    pub deepest_resolved: String,
    /// Segments that did not resolve, in path order. Empty on `Resolved`.
    pub unresolved: Vec<String>,
    /// Why the walk stopped. See [`DescendantTermination`].
    pub termination: DescendantTermination,
}

/// Child-list lookup abstraction — the only structural thing
/// [`walk_descendants`] needs. Implementations decide how to resolve a block
/// ID to its ordered child IDs. Three adapters are provided in this module.
pub trait ChildLookup {
    /// Return the ordered child block IDs for `block_id`, or an empty vec when
    /// `block_id` is a leaf (or doesn't exist — both terminate a branch
    /// identically).
    fn children_of(&self, block_id: &str) -> Vec<String>;
}

// =========================================================================
// The walk
// =========================================================================

/// Walk `segments` down the child tree from `root_id`, resolving each segment
/// against the previously-matched block's children (Exact) or descendants
/// (Fuzzy).
///
/// `content_of` supplies content + creation time per block for the matcher;
/// return `None` for a block that has no content / doesn't exist (it is then
/// simply not a candidate). `root_id` is the anchor — for `GET /resolve` this
/// is the page block resolved from segment 1 via `PageNameIndex`, and
/// `segments` are the remaining path segments.
///
/// Behaviour invariants (covered by unit tests in this module):
///
/// - `walk.trace.len()` equals the number of resolved segments; on full
///   resolution it equals `segments.len()`.
/// - `walk.trace` contains no duplicate block IDs.
/// - Empty `segments` → `Resolved`, `deepest_resolved == root_id`, empty trace.
/// - Exact mode never skips levels; Fuzzy mode resolves nested descendants.
/// - A fuzzy expansion exceeding `caps.fuzzy_visited_cap` with no match →
///   `Cap`; a genuine no-match → `PartialMiss`.
/// - A segment matching a block already in the chain → `Cycle` (not appended).
pub fn walk_descendants<L, F>(
    lookup: &L,
    content_of: F,
    root_id: &str,
    segments: &[String],
    mode: ResolveMode,
    caps: DescendantCaps,
) -> DescendantWalk
where
    L: ChildLookup,
    F: Fn(&str) -> Option<NodeInfo>,
{
    let mut trace: Vec<SegmentResolution> = Vec::new();
    let mut chain: HashSet<String> = HashSet::new();
    chain.insert(root_id.to_string());

    let mut current = root_id.to_string();
    let mut deepest = root_id.to_string();

    for (i, segment) in segments.iter().enumerate() {
        let outcome = match mode {
            ResolveMode::Exact => resolve_segment_exact(lookup, &content_of, &current, segment),
            ResolveMode::Fuzzy => resolve_segment_fuzzy(
                lookup,
                &content_of,
                &current,
                segment,
                caps.fuzzy_visited_cap,
            ),
        };

        match outcome {
            SegmentOutcome::Matched { block_id, rung } => {
                if !chain.insert(block_id.clone()) {
                    // Cycle — the match points back into the resolution chain.
                    // Terminate BEFORE appending, mirroring walk_ancestors.
                    return DescendantWalk {
                        trace,
                        deepest_resolved: deepest,
                        unresolved: segments[i..].to_vec(),
                        termination: DescendantTermination::Cycle,
                    };
                }
                trace.push(SegmentResolution {
                    segment: segment.clone(),
                    block_id: block_id.clone(),
                    rung,
                });
                deepest = block_id.clone();
                current = block_id;
            }
            SegmentOutcome::Miss { hit_cap } => {
                return DescendantWalk {
                    trace,
                    deepest_resolved: deepest,
                    unresolved: segments[i..].to_vec(),
                    termination: if hit_cap {
                        DescendantTermination::Cap
                    } else {
                        DescendantTermination::PartialMiss
                    },
                };
            }
        }
    }

    DescendantWalk {
        trace,
        deepest_resolved: deepest,
        unresolved: Vec::new(),
        termination: DescendantTermination::Resolved,
    }
}

/// Outcome of resolving a single segment. `Miss` carries `hit_cap` so the
/// caller can distinguish a genuine no-match from a fuzzy cap exhaustion.
enum SegmentOutcome {
    Matched { block_id: String, rung: MatchRung },
    Miss { hit_cap: bool },
}

/// Resolve one segment against the DIRECT children of `current` via the exact
/// (write) predicate. No level skipping.
fn resolve_segment_exact<L, F>(
    lookup: &L,
    content_of: &F,
    current: &str,
    segment: &str,
) -> SegmentOutcome
where
    L: ChildLookup,
    F: Fn(&str) -> Option<NodeInfo>,
{
    // Gather owned infos first so MatchCandidate can borrow their content for
    // the duration of the match call. ids[i] ⟷ candidates[i].
    let mut ids: Vec<String> = Vec::new();
    let mut infos: Vec<NodeInfo> = Vec::new();
    for id in lookup.children_of(current) {
        if let Some(info) = content_of(&id) {
            ids.push(id);
            infos.push(info);
        }
    }
    let candidates: Vec<MatchCandidate> = infos
        .iter()
        .map(|info| MatchCandidate {
            content: &info.content,
            created_at: info.created_at,
        })
        .collect();

    match match_exact(segment, &candidates) {
        Some(idx) => SegmentOutcome::Matched {
            block_id: ids[idx].clone(),
            rung: MatchRung::Exact,
        },
        None => SegmentOutcome::Miss { hit_cap: false },
    }
}

/// Resolve one segment against ALL descendants of `current` via the fuzzy
/// ladder, composing [`match_fuzzy`] across depth levels (rung primary, then
/// shallower depth). Bounded by `visited_cap`.
///
/// The BFS is depth-ascending so the shallowest carrier of the globally-best
/// rung is preferred, and an early exit fires once an [`MatchRung::Exact`] hit
/// is found (nothing deeper can beat rung 1 at a shallower depth). Within each
/// depth level, [`match_fuzzy`]'s own `select_oldest` owns the createdAt
/// tie-break — this function never re-derives it.
fn resolve_segment_fuzzy<L, F>(
    lookup: &L,
    content_of: &F,
    current: &str,
    segment: &str,
    visited_cap: usize,
) -> SegmentOutcome
where
    L: ChildLookup,
    F: Fn(&str) -> Option<NodeInfo>,
{
    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(current.to_string());

    // `best`: (rung_number, depth, block_id, rung) minimised lexicographically
    // over (rung_number, depth) — rung primary, depth secondary.
    let mut best: Option<(u8, usize, String, MatchRung)> = None;
    let mut visited_count: usize = 0;
    let mut hit_cap = false;

    let mut frontier: Vec<String> = lookup.children_of(current);
    let mut depth: usize = 1;

    'bfs: while !frontier.is_empty() {
        let mut ids: Vec<String> = Vec::new();
        let mut infos: Vec<NodeInfo> = Vec::new();
        let mut next: Vec<String> = Vec::new();

        for id in frontier {
            // Cycle / DAG-convergence guard: never revisit a node within one
            // expansion (protects against a cyclic childIds graph).
            if !visited.insert(id.clone()) {
                continue;
            }
            visited_count += 1;
            if visited_count > visited_cap {
                hit_cap = true;
                break 'bfs;
            }
            if let Some(info) = content_of(&id) {
                ids.push(id.clone());
                infos.push(info);
            }
            next.extend(lookup.children_of(&id));
        }

        // Match this depth level as one candidate set — match_fuzzy owns the
        // within-level rung + oldest-createdAt selection.
        let candidates: Vec<MatchCandidate> = infos
            .iter()
            .map(|info| MatchCandidate {
                content: &info.content,
                created_at: info.created_at,
            })
            .collect();

        if let Some(fm) = match_fuzzy(segment, &candidates) {
            let rung_n = fm.rung.as_number();
            let candidate = (rung_n, depth, ids[fm.index].clone(), fm.rung);
            best = Some(match best {
                Some(existing) if (existing.0, existing.1) <= (candidate.0, candidate.1) => {
                    existing
                }
                _ => candidate,
            });
            // Early exit: an exact hit at the current (shallowest-so-far) depth
            // can never be beaten by anything deeper.
            if matches!(best, Some((1, ..))) {
                break 'bfs;
            }
        }

        frontier = next;
        depth += 1;
    }

    match best {
        Some((_, _, block_id, rung)) => SegmentOutcome::Matched { block_id, rung },
        // No match. `hit_cap` distinguishes "searched the whole subtree, not
        // there" (PartialMiss) from "gave up at the cap" (Cap).
        None => SegmentOutcome::Miss { hit_cap },
    }
}

// =========================================================================
// Adapters — one per child-lookup shape used by the codebase
// =========================================================================

/// Adapter that reads `childIds` directly from a `yrs::MapRef` ("blocks") with
/// a borrowed read transaction. The Y.Doc-native shape used by
/// `floatty-server` handlers that already hold a transaction and the blocks
/// map (e.g. `GET /api/v1/resolve`).
pub struct YDocChildLookup<'a, T: ReadTxn> {
    pub blocks_map: &'a yrs::MapRef,
    pub txn: &'a T,
}

impl<'a, T: ReadTxn> YDocChildLookup<'a, T> {
    pub fn new(blocks_map: &'a yrs::MapRef, txn: &'a T) -> Self {
        Self { blocks_map, txn }
    }
}

impl<'a, T: ReadTxn> ChildLookup for YDocChildLookup<'a, T> {
    fn children_of(&self, block_id: &str) -> Vec<String> {
        let block_map = match self.blocks_map.get(self.txn, block_id) {
            Some(yrs::Out::YMap(map)) => map,
            _ => return Vec::new(),
        };
        block_map
            .get(self.txn, "childIds")
            .and_then(|v| match v {
                yrs::Out::YArray(arr) => Some(
                    arr.iter(self.txn)
                        .filter_map(|v| match v {
                            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                            _ => None,
                        })
                        .collect(),
                ),
                _ => None,
            })
            .unwrap_or_default()
    }
}

/// Adapter that resolves children via [`crate::YDocStore::get_block`]. For
/// callers that don't manage their own transactions; each lookup acquires its
/// own read txn under the hood. Prefer [`YDocChildLookup`] on hot paths that
/// already hold a txn.
pub struct StoreChildLookup<'a> {
    pub store: &'a crate::YDocStore,
}

impl<'a> StoreChildLookup<'a> {
    pub fn new(store: &'a crate::YDocStore) -> Self {
        Self { store }
    }
}

impl<'a> ChildLookup for StoreChildLookup<'a> {
    fn children_of(&self, block_id: &str) -> Vec<String> {
        self.store
            .get_block(block_id)
            .map(|b| b.child_ids)
            .unwrap_or_default()
    }
}

/// Adapter for callers that have already materialised a `block_id → child_ids`
/// map (e.g. an export path's single-pass scan, or tests).
pub struct HashMapChildLookup<'a> {
    pub child_map: &'a std::collections::HashMap<String, Vec<String>>,
}

impl<'a> HashMapChildLookup<'a> {
    pub fn new(child_map: &'a std::collections::HashMap<String, Vec<String>>) -> Self {
        Self { child_map }
    }
}

impl<'a> ChildLookup for HashMapChildLookup<'a> {
    fn children_of(&self, block_id: &str) -> Vec<String> {
        self.child_map.get(block_id).cloned().unwrap_or_default()
    }
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A tiny in-process tree: `children` for structure, `content` holding the
    /// content string and createdAt. Keeps walker tests independent of
    /// `YDocStore` setup (the Y.Doc adapter is exercised by the endpoint tests
    /// in `floatty-server`).
    struct TreeFixture {
        children: HashMap<String, Vec<String>>,
        content: HashMap<String, (String, i64)>,
    }

    impl TreeFixture {
        fn new() -> Self {
            Self {
                children: HashMap::new(),
                content: HashMap::new(),
            }
        }

        /// Add a block with content + createdAt, parented under `parent`
        /// (append order). Pass `parent = ""` for a root anchor.
        fn add(&mut self, id: &str, parent: &str, content: &str, created_at: i64) -> &mut Self {
            self.content
                .insert(id.to_string(), (content.to_string(), created_at));
            if !parent.is_empty() {
                self.children
                    .entry(parent.to_string())
                    .or_default()
                    .push(id.to_string());
            }
            self
        }

        fn lookup(&self) -> HashMapChildLookup<'_> {
            HashMapChildLookup::new(&self.children)
        }

        fn content_of(&self) -> impl Fn(&str) -> Option<NodeInfo> + '_ {
            move |id: &str| {
                self.content.get(id).map(|(c, ts)| NodeInfo {
                    content: c.clone(),
                    created_at: *ts,
                })
            }
        }
    }

    fn segs(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    // --- Basic resolution --------------------------------------------------

    #[test]
    fn empty_segments_resolves_at_root() {
        let t = TreeFixture::new();
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &[],
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        assert_eq!(walk.termination, DescendantTermination::Resolved);
        assert_eq!(walk.deepest_resolved, "page");
        assert!(walk.trace.is_empty());
        assert!(walk.unresolved.is_empty());
    }

    #[test]
    fn exact_linear_chain_resolves() {
        // page > A > B > C — all direct-child links.
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10)
            .add("a", "page", "A", 20)
            .add("b", "a", "B", 30)
            .add("c", "b", "C", 40);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["A", "B", "C"]),
            ResolveMode::Exact,
            DescendantCaps::default(),
        );
        assert_eq!(walk.termination, DescendantTermination::Resolved);
        assert_eq!(walk.deepest_resolved, "c");
        assert_eq!(walk.trace.len(), 3, "depth == trace len invariant");
        assert_eq!(
            walk.trace
                .iter()
                .map(|r| r.block_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
        assert!(walk.trace.iter().all(|r| r.rung == MatchRung::Exact));
    }

    // --- read_skips_levels_write_does_not (corpus roundtrip property) -------

    #[test]
    fn fuzzy_skips_levels_finds_nested() {
        // Seed page > A > B > C; fuzzy 'page > C' finds nested C via skip.
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10)
            .add("a", "page", "A", 20)
            .add("b", "a", "B", 30)
            .add("c", "b", "C", 40);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["C"]),
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        assert_eq!(walk.termination, DescendantTermination::Resolved);
        assert_eq!(walk.deepest_resolved, "c");
        assert_eq!(walk.trace.len(), 1);
        assert_eq!(walk.trace[0].block_id, "c");
        assert_eq!(walk.trace[0].rung, MatchRung::Exact);
    }

    #[test]
    fn exact_does_not_skip_levels() {
        // Same tree; exact 'page > C' must NOT match nested C (direct-child only).
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10)
            .add("a", "page", "A", 20)
            .add("b", "a", "B", 30)
            .add("c", "b", "C", 40);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["C"]),
            ResolveMode::Exact,
            DescendantCaps::default(),
        );
        assert_eq!(walk.termination, DescendantTermination::PartialMiss);
        assert_eq!(walk.deepest_resolved, "page");
        assert_eq!(walk.unresolved, segs(&["C"]));
        assert!(walk.trace.is_empty());
    }

    // --- miss_lands_deepest (corpus roundtrip property) --------------------

    #[test]
    fn miss_lands_deepest_with_tail() {
        // Seed page > A; resolve 'page > A > missing' → deepest = A, tail = [missing].
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10).add("a", "page", "A", 20);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["A", "missing"]),
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        assert_eq!(walk.termination, DescendantTermination::PartialMiss);
        assert_eq!(walk.deepest_resolved, "a");
        assert_eq!(walk.unresolved, segs(&["missing"]));
        assert_eq!(walk.trace.len(), 1);
        assert_eq!(walk.trace[0].block_id, "a");
    }

    // --- Fuzzy scoring: rung then depth ------------------------------------

    #[test]
    fn fuzzy_prefers_better_rung_over_shallower_depth() {
        // Under page: a direct child 'C notes' (rung 3 contains) at depth 1,
        // and a nested exact 'C' at depth 2. Better rung must win over depth.
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10)
            .add("shallow", "page", "C notes and more", 20)
            .add("mid", "page", "Mid", 30)
            .add("deep", "mid", "C", 40);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["C"]),
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        assert_eq!(walk.termination, DescendantTermination::Resolved);
        assert_eq!(
            walk.trace[0].block_id, "deep",
            "exact rung beats shallower contains"
        );
        assert_eq!(walk.trace[0].rung, MatchRung::Exact);
    }

    #[test]
    fn fuzzy_prefers_shallower_on_equal_rung() {
        // Two exact 'C' matches, depth 1 and depth 2. Shallower (depth 1) wins
        // even though the deeper one is older (depth beats createdAt here).
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10)
            .add("shallow_c", "page", "C", 500)
            .add("mid", "page", "Mid", 20)
            .add("deep_c", "mid", "C", 1);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["C"]),
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        assert_eq!(
            walk.trace[0].block_id, "shallow_c",
            "depth proximity beats createdAt"
        );
    }

    #[test]
    fn fuzzy_oldest_wins_within_same_depth() {
        // Two exact 'C' matches at the SAME depth — matcher's select_oldest
        // owns this tie: the older createdAt wins.
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10)
            .add("newer", "page", "C", 200)
            .add("older", "page", "C", 100);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["C"]),
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        assert_eq!(
            walk.trace[0].block_id, "older",
            "matcher owns oldest-createdAt tie"
        );
    }

    // --- Cap semantics -----------------------------------------------------

    #[test]
    fn fuzzy_cap_terminates_without_match() {
        // A wide subtree with no matching segment, cap below the node count →
        // Cap termination (not PartialMiss).
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10);
        for i in 0..50 {
            t.add(&format!("n{i}"), "page", &format!("filler {i}"), 20 + i);
        }
        let caps = DescendantCaps {
            fuzzy_visited_cap: 10,
        };
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["absent-segment"]),
            ResolveMode::Fuzzy,
            caps,
        );
        assert_eq!(walk.termination, DescendantTermination::Cap);
        assert_eq!(walk.deepest_resolved, "page");
        assert_eq!(walk.unresolved, segs(&["absent-segment"]));
    }

    #[test]
    fn fuzzy_genuine_miss_is_partial_not_cap() {
        // Small subtree fully searched under the cap, no match → PartialMiss.
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10)
            .add("a", "page", "A", 20)
            .add("b", "a", "B", 30);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["zzz-absent"]),
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        assert_eq!(walk.termination, DescendantTermination::PartialMiss);
    }

    // --- Cycle semantics ---------------------------------------------------

    #[test]
    fn cycle_in_chain_terminates_before_readd() {
        // page's child 'a', whose only child points back to 'page' (synthetic
        // cycle in childIds). Resolve 'A' (matches child a), then 'Page' (would
        // match the cyclic page under a) → chain already contains page → Cycle,
        // page NOT re-added to the trace.
        let mut t = TreeFixture::new();
        t.add("page", "", "Page", 10).add("a", "page", "A", 20);
        t.children.insert("a".to_string(), vec!["page".to_string()]);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["A", "Page"]),
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        assert_eq!(walk.termination, DescendantTermination::Cycle);
        assert_eq!(walk.trace.len(), 1, "cyclic match not appended");
        assert_eq!(walk.trace[0].block_id, "a");
        assert_eq!(walk.deepest_resolved, "a");
        assert_eq!(walk.unresolved, segs(&["Page"]));
    }

    #[test]
    fn fuzzy_bfs_survives_cyclic_child_graph() {
        // a ↔ b cycle in childIds under page; searching for an absent segment
        // must terminate (visited-set guard), not loop forever.
        let mut t = TreeFixture::new();
        t.add("page", "", "Page", 10)
            .add("a", "page", "A", 20)
            .add("b", "a", "B", 30);
        // b's child is a → cycle a → b → a.
        t.children.insert("b".to_string(), vec!["a".to_string()]);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["zzz-absent"]),
            ResolveMode::Fuzzy,
            DescendantCaps::default(),
        );
        // No match, whole (finite) reachable set searched under the cap.
        assert_eq!(walk.termination, DescendantTermination::PartialMiss);
    }

    // --- No-duplicate-block-ids invariant ----------------------------------

    #[test]
    fn trace_has_no_duplicate_block_ids() {
        let mut t = TreeFixture::new();
        t.add("page", "", "# Page", 10)
            .add("a", "page", "A", 20)
            .add("b", "a", "B", 30)
            .add("c", "b", "C", 40);
        let walk = walk_descendants(
            &t.lookup(),
            t.content_of(),
            "page",
            &segs(&["A", "B", "C"]),
            ResolveMode::Exact,
            DescendantCaps::default(),
        );
        let mut seen = HashSet::new();
        for r in &walk.trace {
            assert!(
                seen.insert(r.block_id.clone()),
                "duplicate block id in trace"
            );
        }
        assert_eq!(walk.trace.len(), seen.len());
    }

    #[test]
    fn hashmap_adapter_returns_ordered_children() {
        let mut children = HashMap::new();
        children.insert("p".to_string(), vec!["x".to_string(), "y".to_string()]);
        let lookup = HashMapChildLookup::new(&children);
        assert_eq!(lookup.children_of("p"), vec!["x", "y"]);
        assert!(lookup.children_of("missing").is_empty());
    }
}
