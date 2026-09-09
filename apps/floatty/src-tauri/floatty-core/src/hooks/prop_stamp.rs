//! `PropStampHook` — write-through of a `query::` branch's properties onto the
//! blocks created or moved beneath it (query-views track, brief D — FLO-947).
//!
//! "Add a block under the todo query and it gets the todo properties; move it
//! to doing and the properties flip; an agent re-parenting via the API gets
//! the same." All three are ONE mechanism because it lives server-side:
//!
//! - UI drags arrive as CRDT updates → `Store::compute_changes` diffs
//!   `parentId` → `BlockChange::Moved`.
//! - `PATCH /blocks/:id { parentId }` emits `Moved` explicitly
//!   (`block_service::update_block_locked`).
//! - `POST /blocks` / a CRDT insert → `BlockChange::Created`.
//!
//! A client hook would miss the API path (the client two-lane rule skips
//! remote/reconnect origins on the EventBus), so this is a Rust [`BlockHook`].
//!
//! # What a stamp is
//!
//! The nearest `query::` ancestor decides. Its stamp is, in order:
//!
//! 1. the `[stamp:: key=value key2=value2]` option on the query line, when
//!    present — an empty `[stamp:: ]` is "present with nothing to write" and
//!    disables write-through for that branch;
//! 2. else, derived from the predicate's EXACT terms: `link:⬜` maps through
//!    the prop table's glyph reverse map to `status=todo`; `marker:project:x`
//!    is `project=x`. Negated (`!`), regex (`~`), valueless-marker, `page:`,
//!    `under:`, `since:` and `text~` terms carry no stamp.
//!
//! The stamp is applied with [`set_marker_value`] — the same splice the props
//! endpoint uses — so glyph-backed keys land as `[[🟨]]` at the head of the
//! first line and everything else as a `[key::value]` pill. See
//! [`query_stamp`]; the grammar mirrors `lib/queryPredicate.ts` on the client.
//!
//! # Decisions (not omissions)
//!
//! - **Moving OUT of a query branch does not unset.** A card dragged from the
//!   `doing` board to a daily note keeps `[[🟨]]` and its pills — the stamp is
//!   authored content the block now owns, not a projection of where it sits.
//!   Only landing under ANOTHER query restamps (todo → doing flips the glyph).
//! - **Nested `query::` blocks are never stamped.** A board under a board is
//!   structure, not a card — and a head glyph would push `query::` off column
//!   0 and change the block's type.
//! - **Rejections skip the block** (logged at `warn`): a stamp that
//!   `set_marker_value` cannot represent (unknown glyph value, two existing
//!   pills for the key, …) leaves the block untouched rather than half-stamped.
//! - **`Created` and `Moved` only.** Content edits never restamp — a user who
//!   flips `[[🟨]]` back to `[[⬜]]` by hand under the doing board keeps it
//!   until the block moves again. Cold-start rehydration emits
//!   `ContentChanged`, so booting never mass-restamps the outline.
//!
//! # Lock order (FLO-927) and the plan/apply race
//!
//! Plan first: every store read (`get_block` = `doc.read()`, the ancestor walk
//! through [`StoreParentLookup`]) happens with no lock of ours held. Apply
//! last: one `YDocStore::update_block_content` per block, each its own
//! `doc.write()`. This hook owns no index, so there is no index guard to hold
//! across a doc read. The write is compare-and-set against the content read
//! at plan time: if the block changed in between, the write is skipped as
//! `Stale` (warn) instead of clobbering a concurrent edit — the next
//! `Created`/`Moved` re-stamps.
//!
//! # Loop guard
//!
//! The stamp is written with [`Origin::Prop`]. `accepts_origins` excludes
//! `Prop` (our own writes, and the props endpoint's) and `Hook` (metadata
//! writes), so the `ContentChanged` our write emits never re-enters this hook,
//! while `MetadataExtractionHook` DOES accept `Prop` and re-derives
//! `metadata.markers`/`outlinks` from the stamped text one batch later.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use tracing::{debug, error, instrument, warn};

use super::BlockHook;
use crate::block::{parse_block_type, BlockType};
use crate::events::BlockChange;
use crate::hooks::parsing::{
    extract_tag_markers, set_marker_value, PropSpec, PropSurface, PropWrite,
};
use crate::projections::ancestor_walk::{walk_ancestors, StoreParentLookup, WalkTermination};
use crate::{BlockChangeBatch, ContentWrite, Origin, YDocStore};

/// Dispatch priority: after `MetadataExtractionHook` (10), before
/// `InheritanceIndexHook` (15). See `hooks/system.rs` for the verified order.
pub const PROP_STAMP_PRIORITY: i32 = 12;

/// Ancestor cap for the nearest-`query::` walk — same cap as the
/// `AncestorContext` shaper (`ANCESTOR_CONTEXT_MAX_DEPTH`); the live outline's
/// deepest chain was 16 when that cap was bumped.
pub const STAMP_ANCESTOR_MAX_DEPTH: usize = 20;

const QUERY_PREFIX: &str = "query::";

/// Hook that stamps a `query::` branch's properties onto blocks created or
/// moved beneath it. See the module docs for the contract.
pub struct PropStampHook {
    table: Vec<PropSpec>,
}

impl PropStampHook {
    /// Build with the prop surface table (glyph-backed keys vs pills) — the
    /// server passes its configured table, the same one the props endpoint
    /// uses, so a `link:🟨` predicate and a `POST …/props` write agree on
    /// what `status=doing` looks like.
    pub fn new(table: Vec<PropSpec>) -> Self {
        Self { table }
    }

    /// Build with [`crate::props::default_prop_table`].
    pub fn with_default_table() -> Self {
        Self::new(crate::props::default_prop_table())
    }

    /// The table this hook stamps with.
    pub fn table(&self) -> &[PropSpec] {
        &self.table
    }
}

impl Default for PropStampHook {
    fn default() -> Self {
        Self::with_default_table()
    }
}

/// One planned write: everything read from the store at plan time.
struct StampPlan {
    id: String,
    query_id: String,
    /// Content at plan time — the compare-and-set expectation for the write.
    content: String,
    write: PropWrite,
}

impl BlockHook for PropStampHook {
    fn name(&self) -> &'static str {
        "prop_stamp"
    }

    fn priority(&self) -> i32 {
        PROP_STAMP_PRIORITY
    }

    fn is_sync(&self) -> bool {
        // Runs inline on the dispatch thread so a Created+Moved sequence for
        // the same block is stamped in order; the work is one ancestor walk
        // and at most one content write per affected block.
        true
    }

    fn accepts_origins(&self) -> Option<Vec<Origin>> {
        // Everything EXCEPT:
        // - Origin::Prop — our own stamp writes (and the props endpoint's
        //   splices). Structural, not incidental: we only react to
        //   Created/Moved today, but excluding Prop keeps the loop guard
        //   independent of which variants a future edit reacts to.
        // - Origin::Hook — metadata writes from the extraction hooks; they
        //   never move or create blocks, and Hook is the conventional
        //   "derived state, do not re-process" tag.
        Some(vec![
            Origin::User,
            Origin::Remote,
            Origin::Agent,
            Origin::BulkImport,
        ])
    }

    #[instrument(skip(self, batch, store), fields(batch_size = batch.changes.len()))]
    fn process(&self, batch: &BlockChangeBatch, store: Arc<YDocStore>) {
        // Phase 1 — plan: every store read happens here, no lock held.
        let plans = self.plan(batch, &store);
        if plans.is_empty() {
            return;
        }
        // Phase 2 — apply: one compare-and-set content write per block.
        let written = self.apply(plans, &store);
        debug!(written, "prop_stamp: batch applied");
    }
}

impl PropStampHook {
    fn plan(&self, batch: &BlockChangeBatch, store: &YDocStore) -> Vec<StampPlan> {
        let mut seen: HashSet<&str> = HashSet::new();
        let mut plans = Vec::new();

        for change in &batch.changes {
            let id = match change {
                BlockChange::Created { id, .. } | BlockChange::Moved { id, .. } => id.as_str(),
                _ => continue,
            };
            // A block created AND moved in one batch is planned once, from
            // the store's current (post-batch) position.
            if !seen.insert(id) {
                continue;
            }

            let Some(block) = store.get_block(id) else {
                debug!(block_id = %id, "prop_stamp: block gone before plan, skipping");
                continue;
            };
            if parse_block_type(&block.content) == BlockType::Query {
                debug!(block_id = %id, "prop_stamp: nested query:: block is structure, not a card");
                continue;
            }

            let lookup = StoreParentLookup::new(store);
            let walk = walk_ancestors(&lookup, id, STAMP_ANCESTOR_MAX_DEPTH, None);
            if walk.termination == WalkTermination::Cycle {
                warn!(block_id = %id, "prop_stamp: ancestor cycle above block, refusing to stamp");
                continue;
            }
            if walk.termination == WalkTermination::MaxDepth {
                // Distinguishable from "no query ancestor": a board deeper
                // than the cap never stamps, and that should leave a trace.
                debug!(
                    block_id = %id,
                    max_depth = STAMP_ANCESTOR_MAX_DEPTH,
                    "prop_stamp: ancestor walk hit the depth cap before finding a query:: block"
                );
            }

            // Nearest `query::` ancestor decides — even when it carries no
            // stamp (a further-up query does NOT get a second look).
            let nearest_query = walk.ids.iter().find_map(|ancestor_id| {
                let ancestor = store.get_block(ancestor_id)?;
                (parse_block_type(&ancestor.content) == BlockType::Query)
                    .then(|| (ancestor_id.clone(), ancestor.content))
            });
            let Some((query_id, query_content)) = nearest_query else {
                continue;
            };
            let Some(write) = query_stamp(&query_content, &self.table) else {
                debug!(block_id = %id, query_id = %query_id, "prop_stamp: query carries no stamp");
                continue;
            };

            plans.push(StampPlan {
                id: id.to_string(),
                query_id,
                content: block.content,
                write,
            });
        }

        plans
    }

    fn apply(&self, plans: Vec<StampPlan>, store: &YDocStore) -> usize {
        let mut written = 0;
        for plan in plans {
            let change = set_marker_value(&plan.content, &plan.write, &self.table);
            if !change.rejected.is_empty() {
                warn!(
                    block_id = %plan.id,
                    query_id = %plan.query_id,
                    rejected = ?change.rejected,
                    "prop_stamp: stamp not representable on this block, skipped"
                );
                continue;
            }
            if !change.changed {
                debug!(block_id = %plan.id, query_id = %plan.query_id, "prop_stamp: already stamped");
                continue;
            }
            match store.update_block_content(
                &plan.id,
                Some(&plan.content),
                &change.content,
                Origin::Prop,
            ) {
                Ok(ContentWrite::Written) => {
                    debug!(
                        block_id = %plan.id,
                        query_id = %plan.query_id,
                        before = ?change.before,
                        after = ?change.after,
                        "prop_stamp: stamped"
                    );
                    written += 1;
                }
                Ok(ContentWrite::Stale) => warn!(
                    block_id = %plan.id,
                    query_id = %plan.query_id,
                    "prop_stamp: content changed between plan and apply, skipped (next Created/Moved re-stamps)"
                ),
                Ok(ContentWrite::Unchanged) => {
                    debug!(block_id = %plan.id, "prop_stamp: no-op write")
                }
                Ok(ContentWrite::NotFound) => {
                    debug!(block_id = %plan.id, "prop_stamp: block deleted before apply")
                }
                // Persist failed after the in-memory transaction committed —
                // a source-of-truth write failure (logging-discipline §3).
                Err(e) => error!(block_id = %plan.id, error = %e, "prop_stamp: write failed"),
            }
        }
        written
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// QUERY LINE → STAMP
// ═══════════════════════════════════════════════════════════════════════════

/// Split a query line on whitespace at bracket depth zero, so `[[a b]]` and
/// `[stamp:: a=b c=d]` stay whole. Port of `tokenizeQueryLine` in
/// `lib/queryPredicate.ts`.
pub fn tokenize_query_line(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    for ch in line.chars() {
        if ch == '[' {
            depth += 1;
        } else if ch == ']' {
            depth = depth.saturating_sub(1);
        }
        if depth == 0 && ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// The write-through stamp a `query::` block applies to blocks beneath it.
///
/// `None` when `content` is not a `query::` block or yields no stamp (no
/// `[stamp::]` pill and no exact `link:`/`marker:` term that maps to a
/// key=value; or an explicitly empty `[stamp:: ]`). Only the first line is
/// read. Duplicate keys resolve last-wins, matching the client parser.
pub fn query_stamp(content: &str, table: &[PropSpec]) -> Option<PropWrite> {
    if parse_block_type(content) != BlockType::Query {
        return None;
    }
    let first_line = content.lines().next().unwrap_or("").trim();
    // parse_block_type matched `query::` case-insensitively on the trimmed
    // text; the prefix is ASCII so the byte slice is a char boundary.
    let body = first_line.get(QUERY_PREFIX.len()..).unwrap_or("");

    let mut explicit: Option<BTreeMap<String, String>> = None;
    let mut derived: BTreeMap<String, String> = BTreeMap::new();

    for token in tokenize_query_line(body) {
        if token.starts_with('[') && !token.starts_with("[[") {
            for marker in extract_tag_markers(&token) {
                if !marker.marker_type.eq_ignore_ascii_case("stamp") {
                    continue;
                }
                let map = explicit.get_or_insert_with(BTreeMap::new);
                for pair in marker.value.as_deref().unwrap_or("").split_whitespace() {
                    match pair.split_once('=') {
                        Some((key, value)) if !key.is_empty() && !value.is_empty() => {
                            map.insert(key.to_string(), value.to_string());
                        }
                        _ => debug!(pair, "prop_stamp: stamp expects key=value, ignored"),
                    }
                }
            }
            continue;
        }
        if let Some((key, value)) = derive_term(&token, table) {
            derived.insert(key, value);
        }
    }

    let set = explicit.unwrap_or(derived);
    if set.is_empty() {
        return None;
    }
    Some(PropWrite {
        set: set.into_iter().collect(),
        unset: Vec::new(),
    })
}

/// `link:<glyph>` → `(glyph key, value)` via the table's reverse map;
/// `marker:<type>:<value>` → `(type, value)`. Everything else carries no stamp.
fn derive_term(token: &str, table: &[PropSpec]) -> Option<(String, String)> {
    if token.starts_with('!') {
        return None;
    }
    let op = token.find([':', '~'])?;
    if op == 0 || token.as_bytes()[op] == b'~' {
        return None;
    }
    let kind = token[..op].to_ascii_lowercase();
    let value = &token[op + 1..];
    if value.is_empty() {
        return None;
    }
    match kind.as_str() {
        "link" => {
            let target = strip_wikilink(value);
            table
                .iter()
                .filter(|spec| spec.surface == PropSurface::Glyph)
                .find_map(|spec| {
                    spec.glyphs
                        .iter()
                        .find(|(_, glyph)| !glyph.is_empty() && glyph == target)
                        .map(|(name, _)| (spec.key.clone(), name.clone()))
                })
        }
        "marker" => {
            let (marker_type, marker_value) = value.split_once(':')?;
            let (marker_type, marker_value) = (marker_type.trim(), marker_value.trim());
            if marker_type.is_empty() || marker_value.is_empty() {
                return None;
            }
            Some((marker_type.to_string(), marker_value.to_string()))
        }
        _ => None,
    }
}

fn strip_wikilink(raw: &str) -> &str {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix("[[")
        .and_then(|s| s.strip_suffix("]]"))
        .map_or(trimmed, str::trim)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::{HookRegistry, HookSystem, MetadataExtractionHook};
    use crate::props::default_prop_table;
    use std::sync::Mutex;
    use tempfile::tempdir;
    use yrs::{Array, ArrayPrelim, Map, ReadTxn, Transact, WriteTxn};

    #[test]
    fn shared_query_stamp_corpus() {
        #[derive(serde::Deserialize)]
        struct Case {
            name: String,
            content: String,
            stamp: BTreeMap<String, String>,
        }
        #[derive(serde::Deserialize)]
        struct Tokens {
            line: String,
            tokens: Vec<String>,
        }
        #[derive(serde::Deserialize)]
        struct Corpus {
            cases: Vec<Case>,
            tokens: Vec<Tokens>,
        }
        let corpus: Corpus = serde_json::from_str(include_str!(
            "../../../../src/lib/__fixtures__/query-stamp.json"
        ))
        .unwrap();
        for case in corpus.cases {
            let actual: BTreeMap<String, String> =
                query_stamp(&case.content, &default_prop_table())
                    .map(|write| write.set.into_iter().collect())
                    .unwrap_or_default();
            assert_eq!(actual, case.stamp, "{}", case.name);
        }
        for case in corpus.tokens {
            assert_eq!(
                tokenize_query_line(&case.line),
                case.tokens,
                "{}",
                case.line
            );
        }
    }

    const Q_TODO: &str = "00000000-0000-4000-8000-000000000001";
    const Q_DOING: &str = "00000000-0000-4000-8000-000000000002";
    const PLAIN: &str = "00000000-0000-4000-8000-000000000003";
    const CARD: &str = "00000000-0000-4000-8000-000000000004";
    const NESTED: &str = "00000000-0000-4000-8000-000000000005";

    fn table() -> Vec<PropSpec> {
        default_prop_table()
    }

    fn pairs(write: Option<PropWrite>) -> Vec<(String, String)> {
        write.map(|w| w.set).unwrap_or_default()
    }

    fn kv(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    // ── query_stamp ────────────────────────────────────────────────────────

    #[test]
    fn tokenizer_keeps_bracketed_spans_whole() {
        assert_eq!(
            tokenize_query_line(" link:⬜  under:[[My Page]] [stamp:: a=b c=d] !link:✅"),
            vec![
                "link:⬜",
                "under:[[My Page]]",
                "[stamp:: a=b c=d]",
                "!link:✅"
            ]
        );
    }

    #[test]
    fn explicit_stamp_pill_wins_over_predicate() {
        let write = query_stamp(
            "query:: link:⬜ [stamp:: status=doing project=demo/alpha] [display:: titles]",
            &table(),
        );
        assert_eq!(
            pairs(write),
            kv(&[("project", "demo/alpha"), ("status", "doing")])
        );
    }

    #[test]
    fn derived_from_exact_terms_via_glyph_reverse_map() {
        assert_eq!(
            pairs(query_stamp("query:: link:⬜ marker:project:demo", &table())),
            kv(&[("project", "demo"), ("status", "todo")])
        );
        assert_eq!(
            pairs(query_stamp("query:: link:[[🟨]] since:14d", &table())),
            kv(&[("status", "doing")])
        );
        // Case-insensitive prefix + leading whitespace, like parse_block_type.
        assert_eq!(
            pairs(query_stamp(
                "  Query:: marker:mode:dev\nsecond line ignored",
                &table()
            )),
            kv(&[("mode", "dev")])
        );
    }

    #[test]
    fn non_stampable_terms_carry_nothing() {
        for line in [
            "query:: !link:⬜",
            "query:: link~^(PC|REX)-\\d+$",
            "query:: link:not-a-glyph",
            "query:: marker:project",
            "query:: page:2026-w33 under:[[board]] since:7d text~todo",
            "query::",
            "query:: [display:: rows] [limit:: 50]",
            "query:: [stamp:: ]",
            "query:: link:⬜ [stamp:: ]",
            "query:: link:⬜ [stamp:: junk]",
            "not a query link:⬜",
            "sh:: query:: link:⬜",
        ] {
            assert_eq!(query_stamp(line, &table()), None, "{line}");
        }
    }

    #[test]
    fn duplicate_keys_resolve_last_wins() {
        assert_eq!(
            pairs(query_stamp("query:: link:⬜ link:🟨", &table())),
            kv(&[("status", "doing")])
        );
        assert_eq!(
            pairs(query_stamp(
                "query:: [stamp:: project=a] [stamp:: project=b]",
                &table()
            )),
            kv(&[("project", "b")])
        );
    }

    // ── hook fixtures ──────────────────────────────────────────────────────

    fn insert_block(
        store: &YDocStore,
        id: &str,
        content: &str,
        parent_id: Option<&str>,
        child_ids: &[&str],
    ) {
        let doc = store.doc();
        let guard = doc.write().unwrap();
        let mut txn = guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, id);
        block_map.insert(&mut txn, "content", yrs::Any::String(content.into()));
        if let Some(pid) = parent_id {
            block_map.insert(&mut txn, "parentId", yrs::Any::String(pid.into()));
        }
        let child_any: Vec<yrs::Any> = child_ids
            .iter()
            .map(|c| yrs::Any::String((*c).into()))
            .collect();
        block_map.insert(&mut txn, "childIds", ArrayPrelim::from(child_any));
    }

    /// Reparent directly in the Y.Doc (what a CRDT drag looks like once
    /// applied) — parentId + both childIds arrays. Test-only wholesale rewrite.
    fn reparent(store: &YDocStore, id: &str, old_parent: &str, new_parent: &str) {
        let doc = store.doc();
        let guard = doc.write().unwrap();
        let mut txn = guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block: yrs::MapRef = blocks.get_or_init(&mut txn, id);
        block.insert(&mut txn, "parentId", yrs::Any::String(new_parent.into()));
        for (parent, keep) in [(old_parent, false), (new_parent, true)] {
            let parent_map: yrs::MapRef = blocks.get_or_init(&mut txn, parent);
            let mut ids: Vec<String> = match parent_map.get(&txn, "childIds") {
                Some(yrs::Out::YArray(arr)) => arr
                    .iter(&txn)
                    .filter_map(|v| match v {
                        yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            ids.retain(|c| c != id);
            if keep {
                ids.push(id.to_string());
            }
            let any: Vec<yrs::Any> = ids
                .into_iter()
                .map(|c| yrs::Any::String(c.into()))
                .collect();
            parent_map.insert(&mut txn, "childIds", ArrayPrelim::from(any));
        }
    }

    fn content_of(store: &YDocStore, id: &str) -> String {
        store.get_block(id).map(|b| b.content).unwrap_or_default()
    }

    /// todo board, doing board (explicit stamp), a plain container, and one
    /// card under the todo board.
    fn seed() -> (tempfile::TempDir, Arc<YDocStore>) {
        let dir = tempdir().unwrap();
        let store = YDocStore::open(&dir.path().join("stamp.db"), "test").unwrap();
        insert_block(
            &store,
            Q_TODO,
            "query:: link:⬜ [display:: rows]",
            None,
            &[CARD],
        );
        insert_block(
            &store,
            Q_DOING,
            "query:: link:🟨 [stamp:: status=doing project=demo/alpha]",
            None,
            &[],
        );
        insert_block(&store, PLAIN, "# Demo Page", None, &[]);
        insert_block(&store, CARD, "card [project::scratch]", Some(Q_TODO), &[]);
        (dir, Arc::new(store))
    }

    fn created(id: &str, content: &str, parent: Option<&str>) -> BlockChangeBatch {
        let mut batch = BlockChangeBatch::new();
        batch.push(BlockChange::Created {
            id: id.to_string(),
            content: content.to_string(),
            parent_id: parent.map(str::to_string),
            origin: Origin::User,
        });
        batch
    }

    fn moved(id: &str, old: &str, new: &str, origin: Origin) -> BlockChangeBatch {
        let mut batch = BlockChangeBatch::new();
        batch.push(BlockChange::Moved {
            id: id.to_string(),
            old_parent_id: Some(old.to_string()),
            new_parent_id: Some(new.to_string()),
            origin,
        });
        batch
    }

    // ── hook behaviour ─────────────────────────────────────────────────────

    #[test]
    fn create_under_query_stamps_derived_glyph() {
        let (_dir, store) = seed();
        let hook = PropStampHook::with_default_table();
        hook.process(
            &created(CARD, "card [project::scratch]", Some(Q_TODO)),
            Arc::clone(&store),
        );
        assert_eq!(content_of(&store, CARD), "[[⬜]] card [project::scratch]");
    }

    #[test]
    fn move_between_boards_flips_glyph_and_pill_keys() {
        let (_dir, store) = seed();
        let hook = PropStampHook::with_default_table();
        hook.process(
            &created(CARD, "card [project::scratch]", Some(Q_TODO)),
            Arc::clone(&store),
        );
        assert_eq!(content_of(&store, CARD), "[[⬜]] card [project::scratch]");

        // Remote origin = a CRDT drag diffed by compute_changes.
        reparent(&store, CARD, Q_TODO, Q_DOING);
        hook.process(
            &moved(CARD, Q_TODO, Q_DOING, Origin::Remote),
            Arc::clone(&store),
        );
        assert_eq!(
            content_of(&store, CARD),
            "[[🟨]] card [project::demo/alpha]"
        );

        // And back: derived stamp restores the glyph; the project pill stays
        // (the todo board's stamp says nothing about project).
        reparent(&store, CARD, Q_DOING, Q_TODO);
        hook.process(&moved(CARD, Q_DOING, Q_TODO, Origin::Agent), store.clone());
        assert_eq!(
            content_of(&store, CARD),
            "[[⬜]] card [project::demo/alpha]"
        );
    }

    #[test]
    fn move_out_of_query_branch_keeps_markers() {
        let (_dir, store) = seed();
        let hook = PropStampHook::with_default_table();
        reparent(&store, CARD, Q_TODO, Q_DOING);
        hook.process(&moved(CARD, Q_TODO, Q_DOING, Origin::User), store.clone());
        let stamped = content_of(&store, CARD);
        assert_eq!(stamped, "[[🟨]] card [project::demo/alpha]");

        reparent(&store, CARD, Q_DOING, PLAIN);
        hook.process(&moved(CARD, Q_DOING, PLAIN, Origin::User), store.clone());
        assert_eq!(
            content_of(&store, CARD),
            stamped,
            "leaving a board never unsets"
        );
    }

    #[test]
    fn nearest_query_ancestor_decides_even_without_a_stamp() {
        let (_dir, store) = seed();
        // A stampless board nested under the doing board: cards under it get
        // nothing — the outer board does not get a second look.
        insert_block(&store, NESTED, "query:: page:2026-w33", Some(Q_DOING), &[]);
        reparent(&store, CARD, Q_TODO, NESTED);
        let hook = PropStampHook::with_default_table();
        hook.process(&moved(CARD, Q_TODO, NESTED, Origin::User), store.clone());
        assert_eq!(content_of(&store, CARD), "card [project::scratch]");
        // The nested query block itself is structure, never a card.
        hook.process(
            &created(NESTED, "query:: page:2026-w33", Some(Q_DOING)),
            store.clone(),
        );
        assert_eq!(content_of(&store, NESTED), "query:: page:2026-w33");
    }

    #[test]
    fn rejected_stamp_skips_the_block_untouched() {
        let (_dir, store) = seed();
        insert_block(
            &store,
            NESTED,
            "[project::a] [project::b] two pills",
            Some(Q_DOING),
            &[],
        );
        let hook = PropStampHook::with_default_table();
        hook.process(
            &created(NESTED, "[project::a] [project::b] two pills", Some(Q_DOING)),
            store.clone(),
        );
        // MultipleExistingPills on `project` → whole block skipped, glyph not
        // half-applied.
        assert_eq!(
            content_of(&store, NESTED),
            "[project::a] [project::b] two pills"
        );
    }

    #[test]
    fn repeated_events_are_idempotent_and_bounded() {
        let (_dir, store) = seed();
        let emitted: Arc<Mutex<Vec<BlockChange>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&emitted);
        store
            .set_change_callback(move |changes| sink.lock().unwrap().extend(changes))
            .unwrap();

        let hook = PropStampHook::with_default_table();
        let batch = created(CARD, "card [project::scratch]", Some(Q_TODO));
        for _ in 0..3 {
            hook.process(&batch, Arc::clone(&store));
        }
        // Created + Moved for the same block in one batch → planned once.
        let mut both = created(CARD, "card [project::scratch]", Some(Q_TODO));
        both.push(BlockChange::Moved {
            id: CARD.to_string(),
            old_parent_id: Some(PLAIN.to_string()),
            new_parent_id: Some(Q_TODO.to_string()),
            origin: Origin::User,
        });
        hook.process(&both, Arc::clone(&store));

        assert_eq!(content_of(&store, CARD), "[[⬜]] card [project::scratch]");
        let emitted = emitted.lock().unwrap();
        assert_eq!(
            emitted.len(),
            1,
            "exactly one write for four dispatches: {emitted:?}"
        );
        assert!(matches!(
            &emitted[0],
            BlockChange::ContentChanged { id, origin: Origin::Prop, new_content, .. }
                if id == CARD && new_content == "[[⬜]] card [project::scratch]"
        ));
    }

    #[test]
    fn own_writes_are_filtered_by_origin() {
        let hook = PropStampHook::with_default_table();
        assert!(!crate::hooks::should_process(&hook, Origin::Prop));
        assert!(!crate::hooks::should_process(&hook, Origin::Hook));
        for origin in [
            Origin::User,
            Origin::Remote,
            Origin::Agent,
            Origin::BulkImport,
        ] {
            assert!(crate::hooks::should_process(&hook, origin), "{origin:?}");
        }
    }

    #[test]
    fn stale_plan_never_clobbers_a_concurrent_edit() {
        let (_dir, store) = seed();
        let hook = PropStampHook::with_default_table();
        // Plan against the seeded content, then edit the block before apply.
        let plans = hook.plan(
            &created(CARD, "card [project::scratch]", Some(Q_TODO)),
            &store,
        );
        assert_eq!(plans.len(), 1);
        insert_block(&store, CARD, "card edited meanwhile", Some(Q_TODO), &[]);
        assert_eq!(hook.apply(plans, &store), 0);
        assert_eq!(content_of(&store, CARD), "card edited meanwhile");
    }

    /// Registry order is by `priority()`, not registration order — the
    /// contract `hooks/system.rs` relies on when it says "after
    /// MetadataExtractionHook".
    #[test]
    fn registry_orders_prop_stamp_after_metadata_extraction() {
        let registry = HookRegistry::new();
        registry.register(Arc::new(PropStampHook::with_default_table()));
        registry.register(Arc::new(MetadataExtractionHook));
        assert!(MetadataExtractionHook.priority() < PROP_STAMP_PRIORITY);
        assert!(PROP_STAMP_PRIORITY < crate::hooks::InheritanceIndexHook::new().priority());
        assert_eq!(registry.len(), 2);
    }

    /// The full sequence through the real hook system: Created → stamp
    /// (Prop ContentChanged) → re-extract (Hook MetadataChanged) → quiet.
    /// Bounded: exactly one ContentChanged, no second stamp, no loop.
    #[tokio::test]
    async fn create_under_query_stamps_then_reextracts_without_looping() {
        use std::time::{Duration, Instant};

        let (_dir, store) = seed();
        let system = Arc::new(HookSystem::initialize_at(Arc::clone(&store), None));
        {
            let system = Arc::clone(&system);
            store
                .set_change_callback(move |changes| {
                    for change in changes {
                        system.emit_change(change).unwrap();
                    }
                })
                .unwrap();
        }
        let mut rx = system.emitter().subscribe();
        system
            .emit_change(BlockChange::Created {
                id: CARD.to_string(),
                content: "card [project::scratch]".to_string(),
                parent_id: Some(Q_TODO.to_string()),
                origin: Origin::User,
            })
            .unwrap();

        let mut log: Vec<String> = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut quiet_since: Option<Instant> = None;
        loop {
            let wait = if quiet_since.is_some() {
                Duration::from_millis(300)
            } else {
                deadline.saturating_duration_since(Instant::now())
            };
            match tokio::time::timeout(wait, rx.recv()).await {
                Ok(Ok(batch)) => {
                    for change in &batch.changes {
                        let line = match change {
                            BlockChange::Created { id, origin, .. } => {
                                format!("Created         {id} origin={origin:?}")
                            }
                            BlockChange::ContentChanged {
                                id,
                                origin,
                                new_content,
                                ..
                            } => format!(
                                "ContentChanged  {id} origin={origin:?} new_content={new_content:?}"
                            ),
                            BlockChange::MetadataChanged { id, origin, .. } => {
                                format!("MetadataChanged {id} origin={origin:?}")
                            }
                            other => format!("{other:?}"),
                        };
                        log.push(line);
                    }
                    let reextracted = log
                        .iter()
                        .any(|l| l.starts_with("MetadataChanged") && l.contains("origin=Hook"))
                        && log.iter().any(|l| l.contains("origin=Prop"));
                    if reextracted && quiet_since.is_none() {
                        quiet_since = Some(Instant::now());
                    }
                }
                Ok(Err(e)) => panic!("emitter closed: {e}"),
                Err(_) => {
                    if quiet_since.is_some() {
                        break;
                    }
                    panic!("stamp → re-extract sequence did not complete: {log:#?}");
                }
            }
        }

        println!("--- change-event → stamp → re-extract sequence ---");
        for line in &log {
            println!("{line}");
        }

        assert_eq!(content_of(&store, CARD), "[[⬜]] card [project::scratch]");
        let block = store.get_block(CARD).unwrap();
        let metadata = block.metadata.expect("re-extracted metadata");
        assert!(
            metadata.outlinks.contains(&"⬜".to_string()),
            "{metadata:?}"
        );
        assert!(metadata
            .markers
            .iter()
            .any(|m| m.marker_type == "project" && m.value.as_deref() == Some("scratch")));

        let content_changes = log
            .iter()
            .filter(|l| l.starts_with("ContentChanged"))
            .count();
        assert_eq!(content_changes, 1, "one stamp write, no loop: {log:#?}");
        assert!(
            log.iter()
                .all(|l| !l.starts_with("Created") || l.contains("origin=User")),
            "no synthetic Created events: {log:#?}"
        );
        let prop_index = log.iter().position(|l| l.contains("origin=Prop")).unwrap();
        let meta_index = log
            .iter()
            .rposition(|l| l.starts_with("MetadataChanged") && l.contains(CARD))
            .unwrap();
        assert!(
            prop_index < meta_index,
            "re-extraction follows the stamp: {log:#?}"
        );
    }

    #[test]
    fn store_update_block_content_contract() {
        let (_dir, store) = seed();
        let (Ok(ContentWrite::NotFound) | Err(_)) =
            store.update_block_content("missing", None, "x", Origin::Prop)
        else {
            panic!("missing block must be NotFound");
        };
        assert_eq!(
            store
                .update_block_content(CARD, Some("nope"), "x", Origin::Prop)
                .unwrap(),
            ContentWrite::Stale
        );
        assert_eq!(
            store
                .update_block_content(CARD, None, "card [project::scratch]", Origin::Prop)
                .unwrap(),
            ContentWrite::Unchanged
        );
        assert_eq!(
            store
                .update_block_content(CARD, Some("card [project::scratch]"), "new", Origin::Prop)
                .unwrap(),
            ContentWrite::Written
        );
        let block = store.get_block(CARD).unwrap();
        assert_eq!(block.content, "new");
        assert!(block.updated_at > 0, "updatedAt stamped: {block:?}");
        let doc = store.doc();
        let guard = doc.read().unwrap();
        let txn = guard.transact();
        assert!(txn.get_map("blocks").is_some());
    }
}
