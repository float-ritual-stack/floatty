# ADR-009: Query views and authored props — `query::` blocks, content-written properties, server-side write-through

## Status

**Proposed — 2026-09-08.** Staged on the `feat/query-views` integration branch
per `integration-branch-discipline.md` ([[PR #416]] `query::` block, [[PR #418]]
marker surgery, [[PR #417]] effective-marker index, [[PR #419]] props endpoint +
`Origin::Prop`, then the `create_block` redirect and the `PropStampHook`). It
flips to Accepted at the mainline merge, after the explicit "this is now a
building block" confirmation and the acceptance check below.

Track state: `.float/work/query-views/STATE.md` (Ground Truth + Decisions are
binding for the build; this ADR records the shape, not the staging). Design
context: [[2026-08-17-projection-surfaces-spine]]
(`apps/floatty/docs/design/2026-08-17-projection-surfaces-spine.md`, primitives
P1–P5). Tickets: [[FLO-947]] (virtual branches as standing queries),
[[FLO-954]] (the marker clobber that forced grammar parity), [[FLO-374]]
(effective markers).

## Context

Three asks arrived together after v0.26.4 and turned out to be one design:

1. **Boards as standing queries.** `todo` / `doing` / `done` columns that pull
   matching blocks in, with write-through when a block is added to or moved
   between them. The backlinks drawer (FLO-440) had just shipped as "the first
   standing query" — predicate pinned to `links-to: X`, scope wired to pane
   attention, rows through `BlockRefList`. A board is the same machine with a
   user-written predicate.
2. **A property-flip API** so agents stop splicing prose in Python to change a
   block's status.
3. **Predicates finer than "references ⬜"** — 56 `[[⬜]]` refs across 12 pages
   is unusable as a board without `project`, `page`, `since`, and pattern
   terms.

Two facts about floatty constrained every answer:

- **Props are authored text.** A block's properties ARE its `[key::value]`
  pills and `[[glyph]]` links; `metadata.markers` is a derived cache that the
  server's `MetadataExtractionHook` (and the client's `ctxRouterHook`)
  re-derive wholesale from the content on every `Created` / `ContentChanged`.
  `PATCH … metadata` is overwritten by the next extraction. Any honest
  property write must therefore splice the content.
- **The FLO-954 clobber was the forcing incident.** Live-verifying the drawer
  facet fix, the client's marker extractor (six known tag keys, gated on a
  `ctx::` date) re-extracted steady-state remote creates and wrote
  `markers: []` over the server's result for every API-created block with a
  pill but no `ctx::`. Fix: `lib/markerGrammar.ts` as the twin of
  `parsing.rs extract_all_markers`, pinned by the shared corpus
  `__fixtures__/marker-grammar.json`. That established the rule this ADR
  builds on: **marker grammar has ONE authority (`parsing.rs`) and TS twins
  are parity-by-fixture, never hand-authored copies.**

## Decision 1 — `query::` block = predicate × scope × BlockRefList render

A `query::` block is a first-class block type (Rust `BlockType::Query` →
`cargo run --bin ts-gen` → `parseBlockType` → `QueryBlockDisplay` mounted by
`BlockItem` as a sibling view under the still-editable query line). The first
line is the query; everything after it is ordinary content.

- **Predicate** (`lib/queryPredicate.ts`, pure, never throws): whitespace-
  separated terms AND together, `!` negates. `link:<target>` (exact, index-
  canonicalized) · `link~<regex>` · `page:<name>` / `page~<regex>` (nearest
  page) · `under:[[block]]` (subtree) · `since:<N>d` (`updatedAt` window) ·
  `text~<regex>` (first line) · `marker:<type>[:<value>]`. Options are pills
  on the query line, parsed by the marker grammar (`extractTagMarkers`):
  `[display:: rows|titles]`, `[limit:: N]`, `[stamp:: k=v …]`,
  `[create_block:: [[target]]]`. Keys are `\w+` on both sides — the
  hyphenated `create-block` is reported as an error pointing at the legal
  spelling, never silently ignored.
- **Scope / evaluation** (`lib/queryEval.ts`, pure): seed from the cheapest
  candidate set — a positive `link:` term reads `backlinks.referencing(key)`
  (the P2 `target → ids` index, no new index), else a positive `under:`
  subtree, else a scan — then every term filters. `marker:` evaluates the
  block's OWN markers today; swapping `ownMarkers()` for the effective set
  (`markerIndex.having`, Decision 3's index) is the open seam, the term shape
  does not change. Results sort newest-`updatedAt` first BEFORE the cap.
- **Render**: one memo over the store (P1 — fine-grained reactivity is the
  invalidation; nothing subscribes, nothing persists) whose id set renders
  through `BlockRefList` (P3) as a `{ kind: 'query' }` group. Navigation is
  the drawer's wiring verbatim: `resolveSameTabLink` at the call site, then
  `navigateToBlock` / `followWikilinkTarget` through `lib/navigation.ts`.
  Zero new navigation code.

Results are projections (ADR-002, D-zero): never persisted, re-derived on
every rebuild, keyed by live ids.

## Decision 2 — Props are WRITTEN to content via `set_marker_value`; metadata is READ

The authored/derived split is now a wire-level contract:

- **Write** = `set_marker_value(content, write, table)` in
  `floatty-core/src/hooks/parsing.rs`, beside `extract_tag_markers` so parity
  is by construction. TS twin `lib/markerSurgery.ts setMarkerValue`, pinned by
  `__fixtures__/marker-surgery.json` (both sides assert the corpus). A write
  returns `{ content, changed, before, after, rejected }` — no `Result`, a
  per-key `rejected` map (`unrepresentableValue`, `unknownGlyphValue`,
  `multipleExistingPills`, `unsupportedExistingSurface`).
- **Endpoint** = `POST /api/v1/blocks/:id/props` (`api/blocks.rs` →
  `block_service::set_block_props`): `set` / `unset` plus atomic guards —
  `expect { key: lastValue | null }` (null = must be absent, an atomic
  "claim") and optional `ifUpdatedAt`; a 409 carries the current values and
  `updatedAt`. Guards and the content splice share one doc write lock, and
  compare the block's OWN text, never inherited values. Response funnels
  through `attach_ancestor_context` like every block-returning endpoint.
- **Read** stays `metadata.markers` / `effectiveMarkers`, derived by the hooks
  after the write lands. Nothing ever writes `metadata.markers` to set a
  prop. API noun is `props`; the read field stays `metadata`.

## Decision 3 — Surface table: glyph-backed keys vs pills, default `status`

Which text a key lives in is a table, not a convention scattered over
callers. `floatty_core::props::default_prop_table()` (TS twin
`markerSurgery.ts defaultPropTable()`), overridable per key by `[props.<key>]`
in `config.toml` (an override replaces that key's whole entry).

| Key | Surface | Placement when absent |
|---|---|---|
| `status` | glyph link — `todo` → `[[⬜]]`, `doing` → `[[🟨]]`, `done` → `[[✅]]`, `waiting` → `[[👀]]` | head of the first line after the markdown / ordinal prefix (`## [[🟨]] …`, the dominant live shape: 543 glyph lines vs 3 `[status::]` pills) |
| every other key | `[key::value]` pill | end of the first line, or the existing envelope line when line 2 starts with a pill |

The read side mirrors the table: `getEffectiveMarkers` (`lib/blockContext.ts`,
mirroring `InheritanceIndex` — own types win, nearest ancestor supplies each
missing type) feeds the second P2 instantiation, `lib/markerIndex.ts`
(`(marker, value) → ids`, inheritance-shaped invalidation, pinned by
`__fixtures__/effective-markers.json`), and the drawer's `facet-inherited`
chips.

## Decision 4 — Write-through is a server-side `PropStampHook` on `Moved` / `Created`; one authority

"Add a block under the todo query and it gets todo's props; move it to doing
and they flip; an agent re-parenting via the API gets the same." All three are
one mechanism only if it lives where every reparent is visible:
`Store::compute_changes` diffs before/after on every applied update (UI drags
arrive as CRDT updates and diff to `BlockChange::Moved`) and
`PATCH parentId` emits `Moved` explicitly. So the stamper is a Rust
`BlockHook` (`floatty-core/src/hooks/prop_stamp.rs`, brief D): on `Created` /
`Moved`, walk ancestors (`projections::walk_ancestors`) to the nearest
`query::` block, take its stamp — `[stamp:: k=v …]` if present, else derived
from the predicate's exact terms (`link:⬜` → `status=todo` via the table's
reverse map, `marker:project:x` → `project=x`) — and apply it with
`set_marker_value` under `Origin::Prop`, FLO-927 shape (read the store into a
plan → release → write). Moving OUT of a query branch does not unset: a card
dragged to a daily note keeps its status (a decision, not an omission).

**Why not a client hook:** the client's two-lane rule skips `Remote` /
`ReconnectAuthority` origins on the EventBus (and the remote slim path skips
emission above 50 events), so a client stamper would miss exactly the API
reparents Evan named. The client may mirror the splice later for latency; it
is never the authority.

Registration order matters: the stamper registers after
`MetadataExtractionHook` so extraction of the stamped content runs after the
stamp; the order is documented where the hooks are registered
(`hooks/system.rs`).

## Decision 5 — `Origin::Prop`

A new origin (`floatty-core/src/origin.rs`) for hook- and endpoint-authored
content. `MetadataExtractionHook.accepts_origins()` excludes `Origin::Hook`
(the loop guard), so a stamp written as `Hook` would leave the pill in the
text and `metadata.markers` stale. `Prop` is accepted by the extractor, the
inheritance index, the page-name index and Tantivy — and excluded by the
stamper itself, which is what makes stamp → re-extract a bounded chain rather
than a loop. The `accepts_origins` audit across the hooks landed with the
endpoint ([[PR #419]]).

## Decision 6 — Real children show once, in place; `create_block` redirects the Enter create

A `query::` block's real children are ordinary blocks. The evaluator excludes
the query block's whole subtree from results, so a child that also matches
shows ONCE, in place — dedupe by construction, not at render.

The home for a block "added to the board" is the query's
`[create_block:: [[target]]]` when given, else the query block itself. The
redirect lives at ONE seam: `determineKeyAction` in `useBlockInput` consults
`resolveCreateTarget` (`lib/queryCreate.ts`, pure) for every end-of-content
Enter inside a `query::` subtree and returns a `create_trailing_block`
targeting the resolved parent (last child). The target resolves read-only
through `BacklinkIndex.canonicalTargetKey` — page name, full id, short hash —
the same ladder `queryEval.ts` uses for `under:`. Nested queries: the NEAREST
decides. Unresolvable target: create in place and `QueryBlockDisplay` renders
`⚠ create_block target not found` — never a throw, never a page created from
a read. Mid-content splits and create-before are not "add to the board" and
do not redirect. The redirected block is revealed through the expansion
policy when inside the pane's zoom, else through the navigation funnel.

## Decision 7 — Result cap and `since:`

200 rows per query by default (`[limit:: N]`, hard max 2000); the header
says `N of total · truncated at limit`. The cap is applied AFTER the
newest-first sort so a truncated board keeps its live edge, and BEFORE
`BlockRefList` so the layer tree stays bounded (the 2026-09-08 remount wedge
is why lists of rebuilt objects use `<Key by={identity}>`). `since:<N>d` is the
user's window over `updatedAt`; no default window for boards yet — live data
(73 of 82 ⬜ items are 7–30 days old, none older) says it would barely bite,
so the decision waits for real use.

## Consequences

- The outline gets a standing-query primitive with the drawer's exact
  machinery; every future view (kanban columns, lens, unlinked refs) composes
  P1 + P2 + P3 rather than building a framework (spine anti-goal).
- Agents change a property with one guarded `POST …/props` call; the
  `expect` guard makes "claim a todo" atomic across concurrent agents.
- `Origin::Prop` is a new value in the origin vocabulary; every future hook
  must decide whether it accepts it (the audit is the precedent).
- Marker grammar, marker surgery and effective markers each have a shared
  fixture corpus asserted by both sides — the parity shape from FLO-954 and
  ADR-008 is now the norm for marker logic.
- Open seams, deliberately: `marker:` predicates read own markers until the
  evaluator is pointed at `markerIndex`; "pin this facet chip into the
  predicate" is the missing half of chip-narrowing; the action-vocabulary
  consolidation waits for a third `setBlockProps` consumer.

## Acceptance check (gate to Accepted)

1. Shared corpora green on both sides: `marker-grammar.json`,
   `marker-surgery.json`, `effective-markers.json`.
2. Dev instance: three `query::` blocks render their rows through
   `BlockRefList` (wave 1 live check: 46/46, 19/19, 5/5 on the live outline);
   Enter on a query line with `create_block` lands the block under the target
   and focuses it; an unresolvable target warns and creates in place.
3. `POST …/props` with `expect` flips a status glyph; a second write with the
   stale `expect` returns 409 with the current values.
4. Stamp hook: create-under stamps; move between two query blocks restamps;
   move out leaves markers; the API reparent path reaches the hook; repeated
   events are idempotent; the origin filter excludes its own writes (bounded
   change count).
5. `symmetry_ancestor_context.rs` stays green.

## Rollback note

If the design is wrong, the artefacts to remove are small and every byte of
data survives:

- **Client**: `lib/queryPredicate.ts`, `lib/queryEval.ts`,
  `components/views/QueryBlockDisplay.tsx` (plus the `BlockItem` mount and
  the `query` case in `parseBlockType` / `BlockType`); the redirect seam is
  `lib/queryCreate.ts` + the `createRedirectParentId` branch in
  `useBlockInput`. A `query::` block degrades to a text block whose first line
  reads `query:: …` — nothing else in the outline references the view.
  `lib/markerSurgery.ts` / `lib/markerIndex.ts` are consumer-free pure
  modules and can stay or go independently.
- **Server**: delete the `/api/v1/blocks/:id/props` route
  (`api/blocks.rs`) and `block_service::set_block_props`; unregister
  `PropStampHook` in `hooks/system.rs`; `Origin::Prop` can remain as an
  accepted-everywhere origin or be folded into `Agent`.
- **Data**: everything the endpoint or the hook wrote is plain content —
  a `[key::value]` pill or a `[[glyph]]` link in the block's own text. No
  Y.Doc shape change, no SQLite change, no Tantivy schema dependency. On the
  old code it is just prose that the extractor already understands.

## Status label

`partial` — the client half (Decisions 1, 2-client, 3, 6, 7) and the endpoint
(Decisions 2, 5) are built and gated; Decision 4 (`PropStampHook`, brief D) is
in flight on `feat/qv-stamp-hook`. Flip to `built` when brief D merges into
`feat/query-views`; the mainline PR carries the label.

## See also

- [[ADR-002]] projections are not source (D-zero for query results)
- [[ADR-008]] path addressing — the parity-by-fixture shape this ADR reuses
- `.claude/rules/architecture.md` §Frontend Modules — `queryPredicate.ts`,
  `queryEval.ts`, `queryCreate.ts`, `markerGrammar.ts`, `markerSurgery.ts`,
  `markerIndex.ts`
- `.claude/rules/api-reference.md` §Authored props
