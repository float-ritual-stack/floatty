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

## The five shared primitives (build once, everything composes)

| # | Primitive | Where it gets built | Who consumes it |
|---|---|---|---|
| P1 | **Reactive store-reading view component** — views read the block store directly; SolidJS fine-grained reactivity IS the invalidation. No subscriptions, no spec regen, no persisted output. | [[FLO-897]] kanban rebuild (pattern already proven by BlockItem / pin shelf / TableView) | kanban, lens, transclusion mounts, ToC |
| P2 | **Derived-index primitive** — mark-dirty in observeDeep → rAF-coalesced rebuild → swap-signal publish. Generic over key type. | backlinks slice 1 (U1, `target → ids`), instantiated again as `(marker,val) → ids` | backlinks, chips, query views, query-fed columns |
| P3 | **BlockRefList** — row renderer (crumbs, kind dots, facets, sorts, churn, slice+dial). Row-generic: backlinks are just the first rows. | backlinks slice 3 (U3) | backlinks, `?[[query]]` results, FLO-833 search, unlinked refs |
| P4 | **Field projection renderer** — one block property, displayed + optionally interactive. Write path = content splice on source (markers are derived from content — soil-audit blocker until the derived-vs-authored fork is decided). | FLO-375 track when it builds | inline `![[id:field]]` chips, kanban card fields (FLO-861), properties panels |
| P5 | **Scope/slice mount** — render a subtree from an arbitrary root with local nav boundaries (synthetic paneId, `kind:'transclusion'`-style host, floorId). | FLO-375/FLO-329 whichever builds first (FLO-668 + pin shelf are the shipped 80%) | transclusion, lens, board-scope, drawer's expand-in-place |

Gates that sit under the family (from the 2026-08-13 soil audit —
`.float/work/transclusion/2026-08-13-projection-soil-audit.md`):

- **[[FLO-374]] effective markers** gates every marker-reading predicate
  (query views, query-fed columns, honest card fields). The starved organ,
  three receipts.
- **Markers: derived vs authored** — the data-model fork; every interactive
  property write funnels into it.
- **ID lifecycle (tombstone/alias)** gates trusting `![[blockId]]` embeds —
  mergeBlocks kills ids during normal typing.
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
   thin compositions — each mostly picks axes and glues primitives.

Anti-goal, stated so it survives: do NOT build a "generic view framework"
up front. Each track builds its primitive at need, generically shaped
(row-generic, key-generic, scope-generic), per the guardrails already banked
in the backlinks design doc and FLO-897. The spine is a direction, not a
cathedral.

## Pointers

- Grammar + unification: `.float/work/transclusion/2026-08-13-projection-soil-audit.md` §The unification
- Backlinks: `docs/design/2026-08-11-backlinks-drawer.md`
- Compost threads: [[FLO-375]] comments (transclusion deltas), [[FLO-890]]
  (filter:: autopsy + rebuild requirements), [[FLO-897]] (kanban rungs)
- Prior spine: `docs/design/2026-07-12-revamp-spine.md`
