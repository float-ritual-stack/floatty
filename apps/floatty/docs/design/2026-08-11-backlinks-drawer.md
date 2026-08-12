# Backlinks Drawer — rip-and-replace backlinks + the per-pane bottom drawer

**Status**: design settled 2026-08-11 (one evening: artifact loop v1–v7 + live
prototype v1–v6 against the real 26k-block outline + desktop review). Execution
via `/floatty:loop backlinks-drawer`; track memory at
`.float/work/backlinks-drawer/STATE.md`.

**Verdict from recon**: rip-and-replace, not refactor. The current
implementation (`useBacklinkNavigation.ts::findBacklinks`) is an O(all-blocks)
scan that re-parses raw content on every call and ignores its own forward index
(`metadata.outlinks`); the render guard in `LinkedReferences.tsx` only shows
panels on direct children of `pages::` (nested pages never get one); block-id
targets never resolve ([[FLO-711]]); the server-side `inboundCount` /
`PageNameIndex.referencing_blocks` have zero frontend consumers and are
nearest-page-scoped anyway.

## The forcing pattern (why now)

W33 agent-loop workflows stamp changelog entries with `[[blockId]]` links to
outbox draft blocks — each draft accumulates 3–5 inbound links as it moves
drafted → v2 → sent → stamped. **The backlinks ARE the lifecycle.** Block-level
backlinks went from nice-to-have to the primary navigation need, and none of
them resolve today. See [[2e0a065c]] (W33 hub) and the `outline-revisions`
skill (write-side conventions, shipped 2026-08-11).

## Evan's asks (verbatim shape)

1. Sort/filter backlinks — none exists.
2. More context per row — one-line blocks are useless without surroundings.
3. Zoom deeper on a page → backlinks must NOT disappear.
4. Block-level backlinks + Roam-style inbound-count indicator on blocks.
5. Scope semantics: zoomed on page → page's backlinks; zoomed into child →
   STILL page's backlinks; zoomed into a block with its own inbound → page
   group + focal-block group.
6. Drawer housing: "shouldn't need to scroll all the way down a long outline
   to view backlinks." Bottom tabbed panel per pane — housing built so
   graph/properties/debug/block-history can move in later (not built now).

## Decisions (all Evan-endorsed, 2026-08-11)

### Drawer

- **D1 — default CLOSED, per-pane.** The ⟲n count chip advertises; open-by-
  default becomes wallpaper.
- **D11 — height is drag-resizable in v1.** Grip drag sets px height
  (per-pane, persisted); **double-click grip resets to default** — the use
  case is transient-taller, so undo must be one gesture.
- **D12 — bottom-only; side-swap REJECTED.** The side-position want was the
  ToC want in disguise; a per-pane side drawer fights the reading column.
- **D13 — ToC is "over there".** Focus-following *sidebar* door, Zed
  outline-panel shape → [[FLO-887]] (successor to FLO-117 via FLO-267). Not
  this track's scope; it inherits BlockRefList later.
- Housing ships with ONE real tab. graph/properties/history are slots, not
  scope.

### Rows & interaction

- **D2 — focal-block group FIRST**, nearest-page group under it (always
  present). Most-specific-first is the scope-stack's point.
- **D3 — row click = NOTHING.** Expand and navigate are explicit affordances
  only (the search:: bug, ported away from).
- **D4 — expand-in-place slice = parent + block + children.** No siblings by
  default; the context-radius dial covers wider rings.
- **D8 — the dial is expand-only.** Breadcrumb segments on a row re-root the
  slice at that ancestor (path-to-source expanded, siblings dim, source
  highlighted). Modifier-slip navigation would destroy the reading position
  the drawer exists to preserve; navigation lives in the pane's top crumb bar.
  Crumb segments are the click TARGET (real padding + hover backdrop);
  separators are inert `pointer-events:none` — search::'s inverted hit-areas
  (`index.css:2456`) are the named anti-pattern.
- **D5 — no keybind in v1.** ⌘⇧P stays unclaimed until the drawer survives
  two weeks of real use.
- **D6 — empty state is a feature.** True-empty says "nothing links here yet —
  [[page]] references will gather here"; distinct from filtered-empty.
- **D7 — facets are drawer-wide**, not per-group. Same marker means the same
  thing in both groups. Facet model ported from the Apr-30 qmd-graph-explorer
  prior art (`~/.floatty/artifacts/floatty-qmd-graph-explorer.html`):
  `page::` / `marker::type::value` / `link::` co-outlink families,
  click=include, shift+click=exclude, per-chip counts, active-filters bar.
  Don't redesign it — port it.
- **D9 — truncation.** MIDDLE-truncate prose (identity front, disambiguation
  back); hashes exempt; long chains elide INTERIOR levels (⋯), keeping root +
  leaf-adjacent. Chain elision ≠ segment truncation — two rules.
  **Atomic-token addendum (lilbug)**: the ellipsis must never land inside a
  `[[..]]` span. Rule: crumb/scope labels are DISPLAY text — strip wikilink
  brackets at the label layer, then truncation only ever bites prose. Bonus:
  stripping alone un-truncates most path-stub labels.

### Sorting

- **D10c — compound sort.** Every sort mode carries `updatedAt`-desc as the
  FIXED universal tiebreak; the asc/desc toggle flips the PRIMARY key only
  (one toggle, not per-level). Implementation trap: `out.reverse()` after a
  compound comparator flips the tiebreak too — apply direction inside the
  primary comparator (`flip * primary || b.u - a.u`).

### Revision-churn clustering

- **D10 — collapse revision churn.** Same source page + same primary outlink +
  ≤1h window + prose-similar → one row (`⊟ N revisions`, expandable).
  `supersedes::` (authoring-side, see `outline-revisions` skill) overrides the
  heuristics entirely.
- **D10d — the prose-similarity gate is PART of the key, by measurement.**
  Naive page+target+1h formed 186 clusters on the real outline, **63% false**
  — same-hour changelog entries are often distinct EVENTS ("PR merged" vs
  "Gate B green"), and daily-nav scaffolding false-clusters. Gate: bigram-Dice
  ≥ 0.5 over a **prose-only norm** — wikilink spans removed ENTIRELY (a
  link-only row has no prose and never clusters; stripping only brackets left
  path-stub scaffolding false-clustering), marker pills + clock-times
  stripped, first 300 chars. Post-gate: 73 clusters / 180 rows folded, all
  revision-shaped. Smoke: revision pair 0.95 · link-only 0.00 · distinct
  events 0.27.
- **v1 parameters** (flip by feel after real use, both proven in prototype):
  cluster fronts the LATEST revision (status, not origin); window = 1h;
  cluster rank under weight sort = heaviest member (falls out of clustering
  the sorted list — never sum, sum rewards churn).

## Architecture (v1 is client-only)

No server changes, no CRDT schema changes, no new public API. Everything
derives from the local Y.Doc.

```
Y.Doc ──observeDeep──▶ U1 reverse index (derived, in-memory, NEVER persisted)
                          │
        pane zoom/focus ──┤
                          ▼
                    U4 scope stack ──▶ U2 drawer (per-pane, bottom)
                                          └─ U3 BlockRefList (rows, facets,
                                             sorts, churn, slice+dial)
        blocks with inbound ──▶ U5 ⟲n chips ──click──▶ open drawer @ block
```

### U1 — canonicalizing reverse index (`src/lib/backlinkIndex.ts`)

- **Prototype-proven numbers** (26,164 blocks): build 11ms flat / 37ms with
  nested extraction; 0 collisions on 8-char id prefixes. Full rebuild on
  change is affordable — no incremental machinery in v1.
- **Nested-aware extraction**: bracket-counting; EVERY nesting level of
  `[[a [[b]] c]]` is a target; alias (`|`) and path (` > `) cut at each span's
  top level only. Resolves the FLO-831 parser divergence. Extractor's home is
  `wikilinkUtils.ts` (extended, not a third parser — symmetry-check: the
  outlinks hook and this index must share one extractor).
- **Canonicalization order is load-bearing**: page-name lookup MUST precede
  the hex test — all-digit date links (`[[2026-08-11]]` → `20260811`) are
  valid hex and get dropped as dangling ids in the other order (found live:
  63 targets / 13 inbound recovered on one page).
- Reference implementation: the live prototype's `topLevelCut` / `targetsOf` /
  `canonical` (see STATE.md §Links for the artifact).

### U2 — drawer housing

Per-pane bottom region inside the pane (below the outliner scroll area). Tab
strip (backlinks + inert slot tabs), grab strip (drag = px height,
double-click = default, `touch-action:none`, pointer capture), collapsed-by-
default with the count chip in the bar. Height + open-state persisted
per-pane (rides `usePaneStore` / workspace persistence). Plain flex +
pointer events — no corvu (the resize is one axis inside one pane; the
prototype pattern is sufficient). Accessibility baseline applies
(`accessibility-baseline.md`): the grab strip needs a keyboard-reachable
resize affordance or an explicit exemption note.

### U3 — BlockRefList (the shared row renderer)

The component both the drawer and later consumers (FLO-833 search surface,
FLO-887 ToC-adjacent) will use. Owns: row (kind dot ◆/•/· · crumb · content ·
age), facet bar, free-text filter, compound sorts, churn clustering,
expand-in-place slice + context-radius dial, expand/collapse-all, both empty
states. Display-only rows inside a single focus point per
`output-block-patterns.md` §2. Likely splits at execution into U3a
(rows/sorts/filter/facets) → U3b (slice + dial) → U3c (churn clustering).

### U4 — scope stack

Resolves "what groups does this pane's drawer show" from (zoomRoot,
focusedBlock): nearest page ancestor → page group (ALWAYS, at any zoom
depth — ask 3); focused/zoomed block with its own inbound → focal group first
(D2). Pure function over the U1 index + `usePaneStore` state; unit-testable
without DOM.

### U5 — ⟲n count chips

Roam-style inbound indicator on blocks (trailing the line, dim), click opens
the drawer focused on that block. Density sanity-checked on real data: the
W33 hub renders 154 nodes, 21 chip-bearing. Reads the U1 index via a
context-level memo (`solidjs-patterns.md` §10 — one memo, not N).

### Funeral (final unit)

Delete `findBacklinks`, `LinkedReferences.tsx` page-bottom panel, and the
`isPageBlock` guard once the drawer covers them. [[FLO-456]]/[[FLO-711]] die
here. Navigation from rows still goes through `lib/navigation.ts` (funnel is
untouched).

## Integration-branch assessment (decided at plan time)

**Main-targeted PRs, normal flow** — not an integration branch. Rationale
against `integration-branch-discipline.md`: no new domain primitive in the
block model, no storage topology change (U1 is derived state, never
persisted), no new public API surface. BlockRefList is a component on the
scale of the sidebar-door container, which landed on main. The
`architecture-reviewer` gate still applies before U1's extractor change lands
(it touches the shared wikilink parser — the one genuinely cross-cutting
edit). Veto point: Evan at execution start.

## PR grouping (personal-tool-pr-scope: bundle where coherent)

| Slice | Units | Shape |
|---|---|---|
| 1 | U1 (+ wikilinkUtils extension) | foundation lib + tests, no UI |
| 2 | U2 + U4 + dumb list | drawer skeleton visible end-to-end |
| 3 | U3 (a→c as commits or split if huge) | the renderer |
| 4 | U5 + funeral | chips on, old implementation out |

Design-doc PR (this file) precedes slice 1.

## Ticket consolidation (execution start)

Absorbs/advances: [[FLO-763]] (filter/expand → U3), [[FLO-711]] (block-id
backlinks → U1), [[FLO-456]] (O(n) scan → U1/funeral), [[FLO-440]] (backlinks
epic umbrella — becomes the tracking issue, comment links this doc),
[[FLO-373]]/[[FLO-65]] (context/breadcrumbs → U3). Adjacent, NOT absorbed:
[[FLO-797]] (link-type classification — later facet), [[FLO-401]] (unlinked
references — later tab candidate), [[FLO-833]] (search surface — sibling
BlockRefList consumer), [[FLO-887]] (ToC sidebar door).

## Verification per unit

Completion gate per `lint-discipline.md` §4 (full suites, quoted output) ·
U1/U4 logic unit-tested with **synthetic PII-free fixtures**
(`test-fixtures-no-pii.md` — the prototype ran on real data; tests must not)
· runtime verification in the dev app (port 33333) per unit with UI ·
fresh-context verifier subagent per loop protocol.

## Prior art / references

- Live prototype (U1+U4+U3 behaviors proven against real data):
  claude.ai artifact `17fc808e…` + `~/.floatty/artifacts/backlinks-live.html`
- Design playground (visual language, zoom-state switcher):
  claude.ai artifact `fe688a78…` + `~/.floatty/artifacts/backlinks-drawer.html`
- Facet model: `~/.floatty/artifacts/floatty-qmd-graph-explorer.html` (Apr 30)
- Write-side conventions: `~/.claude/skills/outline-revisions`
- Recon anchors: `useBacklinkNavigation.ts:110-143` (the scan),
  `LinkedReferences.tsx:35-40` (page guard), `Outliner.tsx:981` (mount),
  `backlinkClassify.ts` (wire-contract twin, symmetry harness),
  `usePaneStore.ts:48` (PaneHost kinds), FLO-668 standalone Outliner mount
- `docs/design/2026-07-12-revamp-spine.md` §P2 · discovery-surfaces track
  (this track is its de-facto Phase 0 — needs only the slice MOUNT, which
  FLO-668 built)
