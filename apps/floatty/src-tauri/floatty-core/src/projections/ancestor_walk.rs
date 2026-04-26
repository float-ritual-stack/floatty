//! Depth-capped ancestor walk — the consolidated walker for FLO-679.
//!
//! Before this module landed, the codebase contained six divergent walks of
//! the parent chain (`get_ancestors`, search breadcrumb, reparent cycle
//! detection, export `find_root`, Tantivy `depth`, and `InheritanceIndex`),
//! each with its own depth cap and accumulator. Adding ancestor-context
//! fields (FLO-679 Phase 2a, [[FLO-680]]) on top of six implementations
//! would have inherited the hydra into the new feature surface.
//!
//! # The pattern
//!
//! All call sites need the same primitive — "walk parent → parent → … up to
//! a cap, collecting IDs nearest-first, terminating on cycle or null." The
//! variation is purely in how the parent lookup is performed:
//!
//! - **Y.Doc direct** — `blocks_map.get(txn, id)` then read `parentId`
//! - **`Store::get_block`** — calls into the same Y.Doc but through a
//!   higher-level wrapper that materialises a `Block` struct
//! - **In-memory `HashMap<String, String>`** — pre-built parent map (export)
//!
//! The [`ParentLookup`] trait abstracts the lookup; [`walk_ancestors`] owns
//! the walk algorithm. Three adapters ship with this module so callers can
//! pick the right shape without each site reinventing the trait impl:
//!
//! - [`YDocParentLookup`] — wraps `(&MapRef, &Txn)`
//! - [`StoreParentLookup`] — wraps `&YDocStore`
//! - [`HashMapParentLookup`] — wraps `&HashMap<String, String>`
//!
//! # Termination semantics
//!
//! The walk terminates when ANY of:
//!
//! 1. `parent_of(current)` returns `None` — reached the root
//!    → `walk.termination = WalkTermination::Root`
//! 2. `walk.ids.len() == max_depth` — caller-provided cap
//!    → `walk.termination = WalkTermination::MaxDepth`
//! 3. The next parent ID is already in the visited set — cycle detected
//!    → `walk.termination = WalkTermination::Cycle`
//!
//! On cycle: the cycle entry-point is NOT appended (the walker terminates
//! BEFORE adding the duplicate). The returned `ids` contains every ancestor
//! seen exactly once, in nearest-first order. See `walk_terminates_on_cycle`.
//!
//! **Mutation guard contract:** callers that write state under an ancestor
//! chain (reparent, reorder under a new parent, etc.) MUST inspect
//! `walk.termination` and reject `Cycle` explicitly — surfaces pre-existing
//! corruption that the visited-set short-circuit would otherwise hide.
//! Read-only callers (search breadcrumb, depth, find_root) can ignore it.
//!
//! # Cycle-as-root note (export `find_root` migration)
//!
//! The previous `find_root` impl in `api/export.rs` returned the *original*
//! block when it hit the depth cap (treating cycles as their own root). The
//! new `walk_ancestors(...).ids.last()` returns the deepest reachable
//! ancestor instead. In practice this is observably equivalent: cycle blocks
//! are never present in `rootIds`, so `root_names.get(...)` returns `None`
//! either way and the caller falls back to `"other"`. The pre-merge
//! caller-audit grep (`grep -rn 'find_root\|root_for' apps/.../*.rs`)
//! confirmed `find_root` has exactly one caller and it cannot observe the
//! difference. See PR description for the recorded audit.

use std::collections::{HashMap, HashSet};

use yrs::{Map, ReadTxn};

use crate::hooks::PageNameIndex;

/// Why a walk stopped. Surfacing the reason lets callers distinguish
/// "reached the top of the tree" from "hit a pre-existing cycle" from
/// "ran out of caller-allotted depth" — three semantically distinct
/// situations that all produce a finite [`AncestorWalk::ids`] vector.
///
/// Added 2026-04-25 in response to PR #281 reviewer findings: silently
/// folding `Cycle` into a short walk weakened the reparent corruption
/// guard (Greptile P1) and made the walker's contract ambiguous
/// (CodeRabbit Major). Callers that mutate state on top of an ancestor
/// chain (e.g. reparent) MUST inspect this to reject `Cycle` explicitly.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum WalkTermination {
    /// `parent_of(current)` returned `None` — the walk reached a root
    /// block, or `block_id` itself didn't exist (both terminate the
    /// walk identically; callers that need to distinguish should check
    /// `walk.ids.is_empty()` and look the start block up themselves).
    #[default]
    Root,
    /// `walk.ids.len() == max_depth` — the caller's cap was reached
    /// before either of the other two terminations.
    MaxDepth,
    /// The next parent ID was already in the visited set — a cycle was
    /// detected. The cycle entry-point is NOT included in `walk.ids`.
    /// Callers performing tree mutations under this ancestry should
    /// treat this as "data corruption upstream" and refuse to write.
    Cycle,
}

/// Result of walking the parent chain.
///
/// `ids` is nearest-first (the immediate parent is `ids[0]`), depth-capped at
/// the caller's `max_depth`. `nearest_page` is set when one of the walked
/// ancestors is registered in [`PageNameIndex`] as an existing page (allowing
/// callers to short-circuit "what page does this block live on" without a
/// separate walk). `depth` always equals `ids.len() as u32`. `termination`
/// records WHY the walk stopped — see [`WalkTermination`].
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AncestorWalk {
    /// Ancestor block IDs, nearest-first, capped at `max_depth`.
    pub ids: Vec<String>,
    /// `(block_id, page_name)` of the nearest ancestor that is a registered
    /// page in `PageNameIndex`, when a `page_name_index` was provided AND
    /// such an ancestor was found. Used by PR 2's `AncestorContext` surface.
    pub nearest_page: Option<(String, String)>,
    /// `ids.len() as u32`. Convenience field; equivalent to `walk.ids.len()`.
    pub depth: u32,
    /// Why the walk stopped. Inspect this when "reached root" vs "hit a
    /// cycle" vs "hit the cap" matters (e.g. mutation guards). See
    /// [`WalkTermination`] for the doctrine.
    pub termination: WalkTermination,
}

/// Parent-chain lookup abstraction — the only thing [`walk_ancestors`] needs.
///
/// Implementations decide how to resolve a block ID to its parent. Three
/// adapters are provided in this module covering every shape used by the
/// codebase as of FLO-679.
pub trait ParentLookup {
    /// Return the parent block ID for `block_id`, or `None` when `block_id`
    /// is at the root (or doesn't exist — both terminate the walk identically).
    fn parent_of(&self, block_id: &str) -> Option<String>;
}

// =========================================================================
// The walk
// =========================================================================

/// Walk the parent chain up from `block_id`, returning IDs nearest-first.
///
/// `max_depth` caps the number of ancestors collected (NOT the number of
/// lookup attempts; cycles can short-circuit early via the visited set).
/// Pass [`PageNameIndex`] to get [`AncestorWalk::nearest_page`] populated;
/// pass `None` to skip the lookup.
///
/// Behaviour invariants (covered by unit tests in this module):
///
/// - `walk.depth == walk.ids.len() as u32`
/// - `walk.ids` contains no duplicates
/// - On a cycle A → B → A, walking from A yields `ids = [B]` (the entry
///   back to A is NOT appended)
/// - When `max_depth == 0`, returns an empty `AncestorWalk` regardless of
///   whether parents exist
pub fn walk_ancestors(
    lookup: &impl ParentLookup,
    block_id: &str,
    max_depth: usize,
    page_name_index: Option<&PageNameIndex>,
) -> AncestorWalk {
    if max_depth == 0 {
        // The caller asked for zero ancestors; we hit the cap immediately.
        return AncestorWalk {
            termination: WalkTermination::MaxDepth,
            ..AncestorWalk::default()
        };
    }

    let mut ids: Vec<String> = Vec::new();
    let mut nearest_page: Option<(String, String)> = None;
    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(block_id.to_string());

    let mut current = block_id.to_string();
    let mut termination = WalkTermination::Root;

    while ids.len() < max_depth {
        let Some(parent_id) = lookup.parent_of(&current) else {
            // parent_of returned None → reached the top of the tree.
            termination = WalkTermination::Root;
            break;
        };
        if !visited.insert(parent_id.clone()) {
            // Cycle — terminate BEFORE re-adding. Callers that mutate state
            // on top of this ancestry MUST inspect `termination` and reject.
            termination = WalkTermination::Cycle;
            break;
        }

        // PageNameIndex stores name → block_id. We only ever need this once
        // (nearest), so a small linear scan over `existing_pages()` is fine.
        // PR 2 may add a reverse-index helper if profiling shows the scan is
        // hot; PR 1's call sites don't even consume `nearest_page`.
        if nearest_page.is_none() {
            if let Some(idx) = page_name_index {
                if let Some(name) = page_name_for_block(idx, &parent_id) {
                    nearest_page = Some((parent_id.clone(), name));
                }
            }
        }

        ids.push(parent_id.clone());
        current = parent_id;

        if ids.len() == max_depth {
            // We filled to the cap on this iteration. The loop condition
            // would also stop us next iteration, but we want the
            // termination reason to be MaxDepth, not the default Root.
            termination = WalkTermination::MaxDepth;
        }
    }

    let depth = ids.len() as u32;
    AncestorWalk {
        ids,
        nearest_page,
        depth,
        termination,
    }
}

/// Reverse-lookup `block_id → page_name` against [`PageNameIndex`].
///
/// O(1) — backed by the `PageNameIndex::page_name_for_block` reverse index
/// (added alongside the AncestorContext shaping helpers so per-block hot
/// paths don't re-scan the full pages set). Returns the lowercased page
/// name; callers that need preserved casing should look it up upstream.
fn page_name_for_block(index: &PageNameIndex, block_id: &str) -> Option<String> {
    index.page_name_for_block(block_id).map(String::from)
}

// =========================================================================
// Adapters — one per parent-lookup shape used by the codebase
// =========================================================================

/// Adapter that reads `parentId` directly from a `yrs::MapRef` ("blocks") with
/// a borrowed read transaction.
///
/// Used by `floatty-server::block_service` (`get_ancestors`, search
/// breadcrumb, reparent cycle detection) and any other call site that
/// already holds a transaction and the blocks map.
pub struct YDocParentLookup<'a, T: ReadTxn> {
    pub blocks_map: &'a yrs::MapRef,
    pub txn: &'a T,
}

impl<'a, T: ReadTxn> YDocParentLookup<'a, T> {
    pub fn new(blocks_map: &'a yrs::MapRef, txn: &'a T) -> Self {
        Self { blocks_map, txn }
    }
}

impl<'a, T: ReadTxn> ParentLookup for YDocParentLookup<'a, T> {
    fn parent_of(&self, block_id: &str) -> Option<String> {
        let block_map = match self.blocks_map.get(self.txn, block_id)? {
            yrs::Out::YMap(map) => map,
            _ => return None,
        };
        block_map.get(self.txn, "parentId").and_then(|v| match v {
            yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
    }
}

/// Adapter that resolves parents via [`crate::YDocStore::get_block`].
///
/// Used by hooks that don't manage their own transactions (e.g.
/// `tantivy_index`'s depth computation). Each lookup acquires its own read
/// txn under the hood; for hot paths that already hold a txn, prefer
/// [`YDocParentLookup`].
pub struct StoreParentLookup<'a> {
    pub store: &'a crate::YDocStore,
}

impl<'a> StoreParentLookup<'a> {
    pub fn new(store: &'a crate::YDocStore) -> Self {
        Self { store }
    }
}

impl<'a> ParentLookup for StoreParentLookup<'a> {
    fn parent_of(&self, block_id: &str) -> Option<String> {
        self.store.get_block(block_id).and_then(|b| b.parent_id)
    }
}

/// Adapter for callers that have already materialised a `block_id → parent_id`
/// map (e.g. the export path's single-pass scan).
pub struct HashMapParentLookup<'a> {
    pub parent_map: &'a HashMap<String, String>,
}

impl<'a> HashMapParentLookup<'a> {
    pub fn new(parent_map: &'a HashMap<String, String>) -> Self {
        Self { parent_map }
    }
}

impl<'a> ParentLookup for HashMapParentLookup<'a> {
    fn parent_of(&self, block_id: &str) -> Option<String> {
        self.parent_map.get(block_id).cloned()
    }
}

// =========================================================================
// Tests
// =========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Owns its `HashMap` instead of borrowing — avoids the per-test
    /// `Box::leak` accumulation that the original helper had (Greptile P2 on
    /// PR #281: each `map_lookup` call leaked one map; with a 17+ test
    /// module that scaled with suite size).
    struct OwnedMapLookup(HashMap<String, String>);

    impl ParentLookup for OwnedMapLookup {
        fn parent_of(&self, block_id: &str) -> Option<String> {
            self.0.get(block_id).cloned()
        }
    }

    /// Tiny in-process lookup used to keep walker tests independent from
    /// `YDocStore` setup. The Y.Doc adapter is exercised via the migrated
    /// call sites' own behaviour-preservation tests.
    fn map_lookup(pairs: &[(&str, &str)]) -> OwnedMapLookup {
        OwnedMapLookup(
            pairs
                .iter()
                .map(|(c, p)| (c.to_string(), p.to_string()))
                .collect(),
        )
    }

    #[test]
    fn walk_returns_empty_for_root() {
        let lookup = map_lookup(&[]);
        let walk = walk_ancestors(&lookup, "root", 10, None);
        assert!(walk.ids.is_empty());
        assert_eq!(walk.depth, 0);
        assert_eq!(walk.nearest_page, None);
        assert_eq!(walk.termination, WalkTermination::Root);
    }

    #[test]
    fn walk_caps_at_max_depth() {
        // 5-deep chain: a → b → c → d → e (e is root)
        let lookup = map_lookup(&[("a", "b"), ("b", "c"), ("c", "d"), ("d", "e")]);
        let walk = walk_ancestors(&lookup, "a", 3, None);
        assert_eq!(walk.ids, vec!["b", "c", "d"]);
        assert_eq!(walk.depth, 3);
        assert_eq!(walk.termination, WalkTermination::MaxDepth);
    }

    #[test]
    fn walk_walks_full_chain_under_cap() {
        let lookup = map_lookup(&[("a", "b"), ("b", "c"), ("c", "d"), ("d", "e")]);
        let walk = walk_ancestors(&lookup, "a", 100, None);
        assert_eq!(walk.ids, vec!["b", "c", "d", "e"]);
        assert_eq!(walk.depth, 4);
        assert_eq!(walk.termination, WalkTermination::Root);
    }

    #[test]
    fn walk_terminates_on_cycle() {
        // a → b → a (synthetic cycle)
        let lookup = map_lookup(&[("a", "b"), ("b", "a")]);
        let walk = walk_ancestors(&lookup, "a", 100, None);
        // b is collected, the next step (back to a) terminates the walk.
        assert_eq!(walk.ids, vec!["b"]);
        assert_eq!(walk.depth, 1);
        assert_eq!(walk.termination, WalkTermination::Cycle);
    }

    #[test]
    fn walk_terminates_on_long_cycle() {
        // a → b → c → b (cycle further from start)
        let lookup = map_lookup(&[("a", "b"), ("b", "c"), ("c", "b")]);
        let walk = walk_ancestors(&lookup, "a", 100, None);
        assert_eq!(walk.ids, vec!["b", "c"]);
        assert_eq!(walk.depth, 2);
        assert_eq!(walk.termination, WalkTermination::Cycle);
    }

    #[test]
    fn walk_terminates_on_pre_existing_cycle_not_through_start() {
        // Greptile PR #281 review case: a → b → c → b (cycle at b, NOT
        // involving start `a`). Old inline loop spun until depth=1001
        // → "data corruption" reject. New walker terminates early with
        // termination=Cycle so callers can reject explicitly.
        let lookup = map_lookup(&[("a", "b"), ("b", "c"), ("c", "b")]);
        let walk = walk_ancestors(&lookup, "a", 1001, None);
        assert_eq!(walk.depth, 2, "visited-set short-circuits at b's re-entry");
        assert_eq!(
            walk.termination,
            WalkTermination::Cycle,
            "termination MUST be Cycle so reparent guards can reject"
        );
    }

    #[test]
    fn walk_handles_missing_block_as_root() {
        // "ghost" has no parent in the map → treated identically to a root.
        let lookup = map_lookup(&[]);
        let walk = walk_ancestors(&lookup, "ghost", 10, None);
        assert!(walk.ids.is_empty());
        assert_eq!(walk.termination, WalkTermination::Root);
    }

    #[test]
    fn walk_max_depth_zero_returns_empty() {
        let lookup = map_lookup(&[("a", "b"), ("b", "c")]);
        let walk = walk_ancestors(&lookup, "a", 0, None);
        assert!(walk.ids.is_empty());
        assert_eq!(walk.depth, 0);
        assert_eq!(
            walk.termination,
            WalkTermination::MaxDepth,
            "zero-cap = MaxDepth even though we never ran the loop"
        );
    }

    #[test]
    fn walk_max_depth_exact_match_terminates_max_depth() {
        // 3-deep chain, cap=3 → fills exactly and terminates as MaxDepth
        // (the loop condition would stop us next iter; we set the reason
        // on the iteration that filled the cap).
        let lookup = map_lookup(&[("a", "b"), ("b", "c"), ("c", "d")]);
        let walk = walk_ancestors(&lookup, "a", 3, None);
        assert_eq!(walk.ids, vec!["b", "c", "d"]);
        assert_eq!(walk.termination, WalkTermination::MaxDepth);
    }

    #[test]
    fn walk_self_parent_terminates_immediately() {
        // Block lists itself as parent — the visited set blocks re-entry.
        let lookup = map_lookup(&[("a", "a")]);
        let walk = walk_ancestors(&lookup, "a", 10, None);
        assert!(walk.ids.is_empty(), "self-parent must not produce ids");
        assert_eq!(walk.termination, WalkTermination::Cycle);
    }

    #[test]
    fn walk_depth_matches_ids_len_invariant() {
        let lookup = map_lookup(&[("a", "b"), ("b", "c"), ("c", "d")]);
        for cap in 0..=10 {
            let walk = walk_ancestors(&lookup, "a", cap, None);
            assert_eq!(
                walk.depth as usize,
                walk.ids.len(),
                "depth must equal ids.len() (cap={})",
                cap
            );
        }
    }

    #[test]
    fn walk_finds_nearest_page_via_index() {
        // a → b → c, where c is registered in PageNameIndex as "Some Page".
        let lookup = map_lookup(&[("a", "b"), ("b", "c")]);
        let mut idx = PageNameIndex::new();
        idx.add_existing_page("Some Page", "c");
        let walk = walk_ancestors(&lookup, "a", 10, Some(&idx));
        assert_eq!(walk.ids, vec!["b", "c"]);
        assert_eq!(
            walk.nearest_page,
            Some(("c".to_string(), "some page".to_string())),
            "PageNameIndex normalises names to lowercase on insert"
        );
    }

    #[test]
    fn walk_skips_intermediate_non_pages() {
        // a → b (not a page) → c (page). nearest_page must be c, not b.
        let lookup = map_lookup(&[("a", "b"), ("b", "c")]);
        let mut idx = PageNameIndex::new();
        idx.add_existing_page("Page C", "c");
        let walk = walk_ancestors(&lookup, "a", 10, Some(&idx));
        assert_eq!(
            walk.nearest_page.as_ref().map(|(id, _)| id.as_str()),
            Some("c")
        );
    }

    #[test]
    fn walk_nearest_page_is_first_match_only() {
        // a → b (page) → c (also a page). nearest_page must be b.
        let lookup = map_lookup(&[("a", "b"), ("b", "c")]);
        let mut idx = PageNameIndex::new();
        idx.add_existing_page("Page B", "b");
        idx.add_existing_page("Page C", "c");
        let walk = walk_ancestors(&lookup, "a", 10, Some(&idx));
        assert_eq!(
            walk.nearest_page.as_ref().map(|(id, _)| id.as_str()),
            Some("b"),
            "nearest_page must lock onto the FIRST page-ancestor encountered"
        );
    }

    #[test]
    fn walk_no_page_index_leaves_nearest_page_none() {
        let lookup = map_lookup(&[("a", "b")]);
        let walk = walk_ancestors(&lookup, "a", 10, None);
        assert_eq!(walk.nearest_page, None);
    }

    #[test]
    fn walk_no_page_match_leaves_nearest_page_none() {
        let lookup = map_lookup(&[("a", "b")]);
        let idx = PageNameIndex::new();
        let walk = walk_ancestors(&lookup, "a", 10, Some(&idx));
        assert_eq!(walk.nearest_page, None);
    }

    // -----------------------------------------------------------------
    // Cycle-as-root semantic note (PR 1 / find_root migration)
    // -----------------------------------------------------------------

    /// Documents the semantic for `walk.ids.last()` on a cycle — used by the
    /// migrated `find_root` in `api/export.rs`.
    ///
    /// OLD impl (pre-PR-1): on cycle, `find_root` returned the original
    /// `block_id` — "treat cycles as their own root" — because the depth cap
    /// fired before the recursion could resolve.
    ///
    /// NEW impl: returns the deepest reachable ancestor. For the cycle
    /// A → B → A, walking from A yields ids = [B] and `.last()` = B.
    /// For the cycle A → B → C → B, walking from A yields ids = [B, C] and
    /// `.last()` = C.
    ///
    /// In `api/export.rs` the only caller does `root_names.get(&root)` —
    /// which only contains entries for blocks present in `rootIds`. Cycle
    /// participants are by definition NOT in `rootIds`, so the lookup
    /// returns `None` under both old and new semantics and the caller falls
    /// back to the `"other"` territory either way. The single-caller audit
    /// is recorded in the PR description.
    #[test]
    fn walk_last_on_cycle_returns_deepest_reachable() {
        // A → B → A
        let lookup = map_lookup(&[("a", "b"), ("b", "a")]);
        let walk = walk_ancestors(&lookup, "a", 500, None);
        assert_eq!(walk.ids.last().map(|s| s.as_str()), Some("b"));

        // A → B → C → B
        let lookup = map_lookup(&[("a", "b"), ("b", "c"), ("c", "b")]);
        let walk = walk_ancestors(&lookup, "a", 500, None);
        assert_eq!(walk.ids.last().map(|s| s.as_str()), Some("c"));
    }

    /// Documents the semantic for `walk.ids.contains(&id)` on a cycle — used
    /// by reparent cycle detection in `block_service`.
    ///
    /// The old reparent walker iterated up to MAX_ANCESTOR_DEPTH (1000) and
    /// returned `Err(InvalidParent)` if it ever hit the candidate descendant
    /// `id` along the way. The new shape — `walk_ancestors(...).ids.contains(&id)`
    /// — produces the same answer because:
    ///
    /// - If `id` IS an ancestor of the proposed parent, the walker collects
    ///   it and `contains` returns true.
    /// - If a separate cycle exists higher up the chain that doesn't pass
    ///   through `id`, the walker terminates safely; `contains(&id)` returns
    ///   false. Old impl would have looped 1000 iterations and returned
    ///   "depth limit" — the new impl terminates faster but reaches the same
    ///   verdict (no cycle through `id`).
    #[test]
    fn walk_contains_detects_descendant_in_chain() {
        // candidate parent X has ancestors [Y, Z]. "Z" is the block being
        // reparented — moving X under Z would create a cycle.
        let lookup = map_lookup(&[("x", "y"), ("y", "z")]);
        let walk = walk_ancestors(&lookup, "x", 1000, None);
        assert!(walk.ids.contains(&"z".to_string()));
    }

    #[test]
    fn walk_contains_clean_chain_returns_false() {
        let lookup = map_lookup(&[("x", "y"), ("y", "z")]);
        let walk = walk_ancestors(&lookup, "x", 1000, None);
        assert!(!walk.ids.contains(&"unrelated".to_string()));
    }
}
