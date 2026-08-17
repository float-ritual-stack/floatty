# Projection Surfaces — the spine

**Status**: direction map, 2026-08-17. Not a build plan — the thing that keeps
seven in-flight tickets from being built as seven bespoke features. Constraints
crystallize per-track at build time (compost doctrine); this doc names the
shared grammar and the shared primitives so each build composes instead of
reinventing.

**The grammar** (Evan, 2026-08-13, mid-zoomies): *"what are backlinks if not
just a filter scoped to the current thing with a predefined query as a starting
point."* Generalized:

```text
a view = PREDICATE × SCOPE × RENDER
         (which blocks)  (from where)  (shown how)
```

Every surface below is that triple with different axes pinned. The two dead
implementations (LinkedReferences, filter:: — [[FLO-890]] autopsy) died
because each hand-fused all three axes into a bespoke lump; nothing was
reusable and both rotted alone.

## The family (all currently in flight or backlogged)

| Surface | Ticket(s) | predicate | scope | render |
|---|---|---|---|---|
| Backlinks drawer | [[FLO-440]] + track (executing) | `links-to: X` (pinned) | reactive — focal block + nearest page, follows pane attention | BlockRefList rows, bottom drawer |
| ⟲n count chips | backlinks U5 | `links-to: X` | — | count badge |
| Kanban (rebuild) | [[FLO-897]] | children-of (structural) | board root block | reactive columns/cards |
| Kanban v2 wishes | [[FLO-861]] | 〃 | **"query a slice"** → lens-shaped scope | column collapse (view state), **card field selection = field projection** |
| Scoped lens:: | [[FLO-329]] | fuzzy match (`matchFuzzy` ladder) | reactive slice, re-roots the view | slice-mounted outliner |
| Transclusion `![[id]]` | [[FLO-375]] | `id = X` (degenerate, one result) | — | mounted slice (nested pane) |
| Field projection `![[id:field]]` | [[FLO-375]] | `id = X` | — | one property, some interactive |
| Query views `?[[...]]` | [[FLO-890]] (blocked by [[FLO-374]]) | arbitrary (markers, text) | first-class | BlockRefList rows / board columns |
| ToC sidebar | [[FLO-887]] | heading-shaped children | follows FOCUSED pane | tree skeleton |

Cross-connections that make "3 separate features" the wrong frame:

- **FLO-861's "card field selection" IS FLO-375's field projection** — a card
  showing `status` / `owner` pulled from markers is `![[cardId:status]]`
  rendered in a board cell instead of inline. One property-renderer, two hosts.
- **FLO-861's "kanban queries a slice" IS FLO-329's lens** — the board root
  stops being a fixed block and becomes a scope expression. Lens and
  board-scope are one primitive with two renders.
- **FLO-329's slice host IS transclusion's mount** — both need "render a
  subtree rooted somewhere else, with local navigation boundaries." The render
  audit's verdict (transclusion = nested pane; pin shelf = shipped proof;
  `floorId` = the boundary primitive) serves both.
- **Backlinks = the first standing query** — predicate pinned, scope wired to
  attention. FLO-890's rebuild is "expose the predicate axis" of the same
  machine.

## The other half of D-zero: instance state

**Canonical state belongs to blocks. View state belongs to the projection
instance.** (2026-08-17 GPT cross-audit, verified against code.) `usePaneStore`
already keeps collapse, zoom, focus, nav history, full-width, host kind, and
`floorId` per paneId — that IS the substrate for kanban column-hidden /
card-density / lens-local expansion / transclusion-local collapse. None of
those are source-block properties; writing view state into the CRDT is the
inverse D-zero violation (`EXPAND_COLLAPSE_NAVIGATION.md`: "expansion policy
NEVER modifies Y.Doc `block.collapsed`" — same law, generalized).

**Terminology guard** — "projection" currently names three different layers
that share invariants, not machinery. Don't ram one through another's plumbing:

```text
WRITE-TIME DERIVATION   Rust BlockHooks (metadata, indexes)     — real, active
READ-TIME SELECTION     floatty_core::projections (walks/match) — real, active
LIVE UI PROJECTION      Solid components reading the store      — the P1 path
```

EventBus is a **notification lane beside** that stack, not a link in it — the
remote slim path deliberately skips emission above 50 events
(`useBlockStore.ts:599`), so a live view that depends on EventBus delivery for
correctness is wrong by design. Corollary (verified 2026-08-17): the TS
`ProjectionScheduler` has zero production consumers and `hookRegistry` zero
registrations — P2 does NOT default onto them just because the word matches.

## The five shared primitives (build once, everything composes)

| # | Primitive | Where it gets built | Who consumes it |
|---|---|---|---|
| P1 | **Reactive store-reading view component** — views read the block store directly; SolidJS fine-grained reactivity IS the invalidation. No subscriptions, no spec regen, no persisted output. | [[FLO-897]] kanban rebuild (pattern already proven by BlockItem / pin shelf / TableView) | kanban, lens, transclusion mounts, ToC |
| P2 | **Derived-index primitive** — mark-dirty in observeDeep → rAF-coalesced rebuild → swap-signal publish. Generic over key type. Key type dictates the dirty set, not just the key: `target → ids` is block-local, `(marker,val) → ids` is inheritance-shaped (below). API note: the axis is really SELECTION, not boolean predicate — traversals, path resolution, exact identity, and ranked results are all selections; don't shape P2's contract as `(block) => boolean`. Prior art: `ARCHITECTURE_MAP.md` §Backlink Projection contract table (April) + `archive/audits-reviews/EVENTBUS_HOOK_MIGRATION_REVIEW.md` §1. Failure template to not reproduce: `archive/spikes-migrations/FLO-361-HOOK-STARVATION.md`. | backlinks slice 1 (U1, `target → ids`), instantiated again as `(marker,val) → ids` | backlinks, chips, query views, query-fed columns |
| P3 | **BlockRefList** — row renderer (crumbs, kind dots, facets, sorts, churn, slice+dial). Row-generic: backlinks are just the first rows. | backlinks slice 3 (U3) | backlinks, `?[[query]]` results, FLO-833 search, unlinked refs |
| P4 | **Field projection renderer** — one block property, displayed + optionally interactive. Write path forks on marker ownership (below); the renderer is gated on that fork being decided, and reads stay safe either way. | FLO-375 track when it builds | inline `![[id:field]]` chips, kanban card fields (FLO-861), properties panels |
| P5 | **Scope/slice mount** — NOT "build a scope primitive": **generalize the shipped pane-scope contract**. `setScope(paneId, floorBlockId)` + floor-clamped navigation (`usePaneStore.ts` floorId, `navigation.ts` requestPaneZoom/isWithinPaneScope) + pin shelf's `registerPane → setScope → <Outliner paneId>` recipe already ARE projectionInstanceId + canonical root + local nav context. | FLO-375/FLO-329 whichever builds first — mostly a host-kind generalization | transclusion, lens, board-scope, drawer's expand-in-place |

**The marker index is keyed on effective markers, so its invalidation is
inheritance-shaped.** A marker predicate that indexed own-markers-only would
answer a different question than the surface claims (a query view or an honest
card field shows the *effective* value: own marker, else the nearest ancestor's,
additive per marker type — the rule the server already implements in
`apps/floatty/src-tauri/floatty-core/src/hooks/inheritance_index.rs`). Indexed
input is therefore the resolved value, and the dirty set is never just the
edited block. Three change classes mark dirty:

- **marker edited on B** → B plus every descendant that resolves that marker
  type through B (they gain, lose, or change an inherited value).
- **hierarchy changed** (reparent, indent/outdent, merge, delete) → the moved
  subtree under both its old and new chain, since every effective value in it is
  re-derived from a new ancestor path.
- **ancestor marker edited** → the same descendant fan-out as the first case,
  rooted at that ancestor rather than at the edit site.

The Rust `InheritanceIndex::update_affected` precedent is the shape to copy:
expand the affected set to descendants + ancestors, drop deleted ids, and fall
back to a full rebuild once the expanded set is large (500 blocks there). Fanned
descendants are marked dirty inside the same observeDeep pass, so a subtree edit
still coalesces into one rAF rebuild and one swap-signal publish — query views
and Kanban card fields cannot read a stale resolved value, and they cannot pay
N rebuilds for one indent either. Note this is why the `(marker,val) → ids`
instantiation sits *behind* the [[FLO-374]] gate instead of beside `target →
ids`: without client `getEffectiveMarkers` there is no correct value to index,
and anything built ahead of it would be own-marker-only and quietly wrong.

**Text predicates are not an index instantiation.** P2 answers equality keys
(`target → ids`, `(marker,val) → ids`); a marker/value map cannot answer
`content contains "foo"`. So the text half of the predicate axis (`?[[...]]`
text terms, text-fed board columns) has an explicit second implementation:
scoped store scan first, index later.

- **Scan path (first pass)** — walk the blocks inside SCOPE and test the term.
  Cost is `O(blocks in scope)` per evaluation, which is the same walk the
  scope/slice mount and BlockRefList already pay; invalidation is free because
  it is a plain reactive store read (P1), not a cached artifact. Acceptable
  because every text surface we have is scope-bounded (a slice, a board root, a
  pane's page) rather than workspace-global.
- **Index path (escalation, not first pass)** — if a text surface goes
  workspace-wide or the scan shows in frame budget, either instantiate P2 over a
  tokenized key (`token → ids`, same mark-dirty → rAF → swap lifecycle, cost
  moves to `O(edited blocks)` per rebuild plus memory for the token map) or
  delegate to the existing server-side Tantivy projection that FLO-833 search
  already queries. Choose one; do not grow a third text path.
- Until that escalation happens, a text predicate composes exactly like an
  indexed one at the call site (`predicate(scope) → ids`) — that is the
  contract P3 and the board columns depend on, and it is what makes the
  predicate implementation reusable regardless of which side answers.

Gates that sit under the family (from the 2026-08-13 projection soil audit — a
FLOAT vault note, not in this repo; see Pointers — so each gate is stated in
full here rather than by reference):

- **[[FLO-374]] effective markers** gates every marker-reading predicate
  (query views, query-fed columns, honest card fields). The starved organ,
  three receipts.
- **Markers: derived vs authored** — the data-model fork; every interactive
  property write funnels into it. Both branches, so P4 can be built against
  whichever wins: an **authored** marker owns its own value, so the write is a
  content splice on the source block (today's shape). A **derived** marker does
  not own its value — it is computed from an authoritative input (inherited
  ancestor marker, ctx:: extraction, structural position), so writing it means
  editing that input, and splicing the rendered text would either be
  overwritten on the next recompute or fork the two. Ownership has to be
  answerable per marker at render time (the projection asks, it does not guess);
  until that predicate exists, P4 ships **read-only** — display and
  `![[id:field]]` chips are safe, interactive writes (kanban card edits,
  properties panels) are gated.
- **ID lifecycle (tombstone/alias)** gates every ID-keyed predicate, not just
  `![[blockId]]` embeds. `mergeBlocks` (`useBlockStore.ts`) lifts the source's
  children, splices its content into the target, and deletes the source id — one
  ordinary Backspace at line start retires an id. So the contract is shared
  across all of them: (1) one canonical resolution step, `resolve(id) → live id |
  tombstoned`, sits in front of `links-to: X`, `id = X` (transclusion),
  `![[id:field]]`, and P2's `target → ids` keys — no surface open-codes its own
  id fixup; (2) a merge or delete publishes the retired id as an invalidation the
  same way a marker change does, so index entries keyed on it are dropped or
  rekeyed to the survivor in that rAF pass instead of surviving to hand back
  deleted ids; (3) an id that resolves to nothing degrades visibly (broken-ref
  row or chip) rather than mounting empty or rendering a blank row. Until the
  lifecycle closes there is no alias to rekey to, so the bound is
  survive-or-degrade everywhere: FLO-375 embeds show a broken-ref state, and
  ID-keyed rows drop entries whose store read misses (P1 reactivity does that
  much for free) rather than displaying them.
- **D-zero invariant**, verbatim: *a projection never owns the data it
  renders.* FLO-897 exists because the current kanban violates it (persisted
  spec = the board owning a copy of state).

## Build-order gravity (not a plan — where weight already is)

1. **Backlinks drawer track** (executing) ships P2 + P3.
2. **[[FLO-897]] kanban rebuild** ships P1 — and is independently urgent
   (workspace-global refresh storm; prime suspect in the [[FLO-895]]
   long-session degradation).
3. **[[FLO-374]]** unlocks the predicate axis (client `getEffectiveMarkers`).
4. After those: [[FLO-861]], [[FLO-329]], [[FLO-375]], [[FLO-890]] become
   thin compositions — each mostly picks axes and glues primitives. "Thin"
   applies only to the part of each track whose gates have closed; FLO-374 is
   not the only gate, so per-track:
   - **[[FLO-861]] kanban v2** — column collapse and query-a-slice scope are
     thin on P1 + P5. Card *fields* need FLO-374 to read honestly, and card
     field *writes* stay blocked on the derived-vs-authored fork (P4 read-only
     until then). Land the board, defer the editable cell.
   - **[[FLO-375]] transclusion / field projection** — the mount is thin on P5,
     but `![[blockId]]` durability is blocked on the ID tombstone/alias
     lifecycle, and `![[id:field]]` interactivity is blocked on the marker fork
     (same gate as FLO-861 cards). Read-only embeds with a visible broken-ref
     state can ship ahead of both.
   - **[[FLO-329]] lens** — the only member with no marker or ID gate; blocked
     only on P5 existing. `matchFuzzy` + slice mount is genuinely thin.
   - **[[FLO-890]] query views** — blocked on FLO-374 for marker predicates and
     on the text-predicate decision above; the render half (P3 rows / board
     columns) is thin once the predicate answers.
   - All four inherit **D-zero**: if a composition needs to persist its own copy
     of results or spec, it has stopped being a projection and is repeating the
     FLO-897 bug.

Anti-goal, stated so it survives: do NOT build a "generic view framework"
up front. Each track builds its primitive at need, generically shaped
(row-generic, key-generic, scope-generic), per the guardrails already banked
in the backlinks design doc and FLO-897. The spine is a direction, not a
cathedral.

## Pointers

- Grammar + unification: 2026-08-13 projection soil audit §The unification —
  **not in this repo**, it lives in the FLOAT vault
  (`.float/work/transclusion/2026-08-13-projection-soil-audit.md`, outside the
  git tree). Everything this doc leans on from it is restated inline above (the
  five primitives, the four gates, D-zero verbatim), so nothing here depends on
  reading it.
- Backlinks: `apps/floatty/docs/design/2026-08-11-backlinks-drawer.md`
- Compost threads: [[FLO-375]] comments (transclusion deltas), [[FLO-890]]
  (filter:: autopsy + rebuild requirements), [[FLO-897]] (kanban rungs)
- Prior spine: `apps/floatty/docs/design/2026-07-12-revamp-spine.md`
