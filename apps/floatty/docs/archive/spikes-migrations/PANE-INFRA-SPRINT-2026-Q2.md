# Pane Infrastructure Sprint — 2026 Q2

**Status**: Roadmap — sprint scope approval ticket. No code changes here.
**Created**: 2026-04-23
**Deliverables**: follow-up PRs A–D (listed below), none of which ship user-facing features.

---

## 1. Why this sprint now

The next round of planned features — starting with a sidebar-pinned outline shelf
([[2026-04-23]] daily note `## exploratory/design/iteration`) — all want the same
structural primitive: *a pane zoomed to a block, hosted outside any tab's layout tree*.

Today, "a pane exists" implicitly means "a pane is a leaf in some `TabLayout.root`."
Pane creation has exactly one path (`layoutStore.splitPane`) and pane lookup has one
function (`findTabIdByPaneId`) that linear-scans every tab's layout tree and returns
null when the pane isn't tab-hosted.

Six known or plausible near-term features want non-tab-hosted panes:

1. Sidebar-pinned outline shelf (the motivating ask).
2. Floating NSPanel pane (already spiked behind `togglePanel` / Cmd+Shift+P).
3. Terminal pane pins (survive tab switches — same shape as sidebar pins).
4. Command-bar result preview (a transient zoomed pane).
5. Daily-view drawer (a sidebar-hosted outline view).
6. FLO-137's aspirational "pinned-pane state" (tab-hosted, orthogonal, but coexists).

Each will re-hit the same coupling. Point-fixing each feature means N copies of the
"find or fall back to active tab" decision, N copies of the implicit pane-creation
assumption, N divergent opinions on what a non-tab pane's host *is*. One sprint, one
decoupling, N unblocked.

This is a **boring-by-design** sprint. No user-facing change, no new UX, no new
Y.Doc shape. Legibility and a small new surface area so the next wave of features
lands cleanly.

---

## 2. What evolved vs what's still load-bearing

Before proposing a refactor, I walked the relevant files. The coupling is narrower
than it first looks — `<Outliner>` itself is already decoupled from the pane layout
DOM, and `paneStore` already uses a paneId-keyed model without per-pane registration.
This keeps the sprint small.

### Already decoupled (no refactor, just document)

- **`<Outliner paneId={id}>`** — zero coupling to `.pane-layout-leaf` / pane placeholder
  DOM. Reads and writes `paneStore` by id. Mounts cleanly in flow layout.
  Reference: `apps/floatty/src/components/Outliner.tsx:37-52` — `props.paneId` is the
  sole identity input; all reactive reads are paneId-keyed.
- **`paneStore` state dicts** (`collapsed`, `zoomedRootId`, `focusedBlockId`,
  `navigationHistory`, `fullWidth`) — all paneId-keyed. No registration step; a pane
  "exists" implicitly on first write. Reference: `apps/floatty/src/hooks/usePaneStore.ts`.
- **`paneStore.removePane(paneId)`** — explicit state-cleanup API already exists.
  Reference: `apps/floatty/src/hooks/usePaneStore.ts:410-445`.
- **`paneStore.zoomTo` / `setFocusedBlockId` / history navigation** — work for any
  paneId without any layout lookup.

### The actual coupling (the refactor target)

- **`findTabIdByPaneId`** — `apps/floatty/src/hooks/useLayoutStore.ts:524-533`.
  Linear scan over every tab's layout tree. Returns null on miss. Verified by grep:
  27 occurrences across 8 files (`navigation.ts`, `usePaneLinkStore.ts`,
  `useBacklinkNavigation.ts`, `useLayoutStore.ts`, `PaneLinkOverlay.tsx`,
  `LinkedReferences.tsx`, `Outliner.tsx`, `BlockItem.tsx`). Some call sites already
  fall back to `tabStore.activeTabId()` on null (e.g. `navigation.ts` —
  `findTabIdByPaneId(excludePaneId) ?? tabStore.activeTabId() ?? null`). Others bail
  silently. **Nullability is unchecked-by-convention, not unchecked-by-type.**
- **`layoutStore.splitPane`** — the only "create a pane" path. Works by coincidence
  (panes don't require explicit registration), but means any non-tab pane creator
  has no symmetric API to call.
- **`useSidebarDoorStore` BUILTIN** — hardcoded literal
  `const BUILTIN: SidebarDoorInfo[] = [{ id: 'ctx', label: 'ctx' }]`
  (`apps/floatty/src/hooks/useSidebarDoorStore.ts:21`). Adding a new builtin sidebar
  tab requires editing this literal. Small, cheap to generalize.
- **Keybind registry drift** — `apps/floatty/src/lib/keybinds.ts` (declarative, 201
  lines) and the tinykeys block in `apps/floatty/src/components/Outliner.tsx` have
  no cross-check. CLAUDE.md flags the keybind table as "known stale." Cmd+Shift+P
  is already consumed by `togglePanel` (`keybinds.ts:125`), but feature docs have
  re-proposed it — this is the drift surfacing before it causes a collision.

---

## 3. Proposed architecture after the sprint

```
            BEFORE                                  AFTER
┌─────────────────────────────┐      ┌─────────────────────────────────┐
│  layoutStore.layouts[tabId] │      │  paneStore.getPaneHost(paneId)  │
│    = source of truth for    │      │    → { kind:'tab', tabId }      │
│    "which panes exist"      │      │      | { kind:'sidebar' }       │
│                             │      │      | { kind:'floating' }      │
│  findTabIdByPaneId:         │      │                                 │
│    O(tabs × panes) scan     │      │  findTabIdByPaneId:             │
│    returns null on miss     │      │    O(1) registry lookup         │
│    (nullability unchecked)  │      │    null means "not tab-hosted"  │
│                             │      │    — explicit, typed            │
│  splitPane: only pane       │      │                                 │
│    creation path            │      │  paneStore.registerPane(        │
│                             │      │    id, host)                    │
│                             │      │    splitPane calls this;        │
│                             │      │    sidebar shelf calls this     │
└─────────────────────────────┘      └─────────────────────────────────┘
```

**Pane identity stops implying tab membership.** Tab membership becomes one
`PaneHost` variant among several. Everything that currently works keeps working;
everything that currently can't work gets a path.

---

## 4. Sprint items

Each item is independently shippable and reviewable. Items 1 and 3 ship together
in one PR because the Outliner contract docs naturally accompany the registry.

### Item 1 — Pane host registry (the main one)

Add to `paneStore`:

- `registerPane(paneId, host)` where
  `host: { kind: 'tab'; tabId: string } | { kind: 'sidebar' } | { kind: 'floating' }`
- `getPaneHost(paneId)` — O(1) lookup
- `unregisterPane(paneId)` — symmetric cleanup

Backed by a reactive Map (or a plain Record keyed by paneId if a Map feels heavy
for SolidJS reactivity). Implementation detail to settle in the PR, not here.

**Files**:

- `apps/floatty/src/hooks/usePaneStore.ts` — add registry state + API
- `apps/floatty/src/hooks/useLayoutStore.ts` —
  - `splitPane` calls `registerPane(newPaneId, { kind: 'tab', tabId })`
  - `closePane` / `removePane` paths call `unregisterPane`
  - `findTabIdByPaneId` rewrites to
    `getPaneHost(paneId)?.kind === 'tab' ? host.tabId : null`
- `apps/floatty/src/hooks/usePaneStore.test.ts` — new tests for registration,
  lookup, symmetric cleanup, and the "sidebar-host panes return null" case

**Acceptance**:

- All existing tests green.
- `findTabIdByPaneId` returns identical results for every tab-hosted pane.
- New test proves `{ kind: 'sidebar' }` panes return null without scanning any
  layout tree.
- New test proves `unregisterPane` called without a prior `registerPane` is a
  safe no-op.

### Item 2 — Navigation-funnel nullability audit

Each of the 27 `findTabIdByPaneId` occurrences gets a per-site decision:

- **(a)** null = sidebar/floating pane → fall back to
  `tabStore.activeTabId()`. Document with a one-line comment.
- **(b)** null = genuinely invalid (pane was deleted mid-navigation, etc.) →
  bail with the existing behavior. Document with a one-line comment.

Not a behavior refactor — a **legibility pass** that lands the
sidebar-compatibility contract explicitly at every call site. After this item,
adding a non-tab pane elsewhere in the app doesn't break navigation/linking,
and every future reviewer can see which stance a call site takes without
guessing.

Touches 8 files, roughly 15-ish lines of edits each (comment + occasional small
guard tweak where the existing code silently trusted null).

**Acceptance**:

- All 27 call sites have an explicit stance documented inline.
- No behavior change detectable in existing tests.
- Spot-check in a manual test harness: mount a fake `{ kind: 'sidebar' }` pane
  in the registry and confirm navigation calls from that pane resolve to the
  active tab instead of crashing.

### Item 3 — `<Outliner>` standalone contract docs

The Outliner already mounts standalone. This item just lands the contract so
future consumers know:

- Add ~6-line header comment to `apps/floatty/src/components/Outliner.tsx`:
  "Mounts standalone in flow layout; no coupling to PaneLayout DOM. `paneId`
  is the sole identity input."
- Add one row to the Key File Inventory table in `.claude/rules/architecture.md`
  calling out the standalone property.

**No code change.** Pure legibility. Ships in the same PR as Item 1.

### Item 4 — Sidebar builtin-tabs registry (small)

Replace the hardcoded `BUILTIN` literal in `useSidebarDoorStore` with a small
registration function `registerBuiltinSidebarTab(id, label, component)`. Ships
alongside a trivial refactor of the existing `ctx` registration so it uses the
new API.

**Files**:

- `apps/floatty/src/hooks/useSidebarDoorStore.ts`
- `apps/floatty/src/components/SidebarDoorContainer.tsx` (may need a small
  adjustment depending on where component registration lands)

**Why it's in this sprint**: future pin-shelf and daily-drawer features will
want to register their own sidebar tabs without editing the store's module-level
literal. Cheap enough to include now; cut cleanly from sprint if scope pressure
appears.

**Acceptance**: the existing `ctx` tab renders identically and all sidebar tests
stay green.

### Item 5 — Keybind collision guardrail (optional, recommend defer)

CLAUDE.md flags the keybind table as stale. The minimum viable guardrail is a
unit test that parses `keybinds.ts` entries plus the tinykeys binding strings in
`Outliner.tsx` and fails on collision. Cmd+Shift+P is today's canary — consumed
by `togglePanel`, re-proposed by aspirational feature specs.

This is *not* a full keybind registry rewrite. Just a test that fails loud when
two layers fight.

**Recommendation: defer.** The pin-shelf feature can audit keybinds by hand at
the point of adding a binding (grep both sources per CLAUDE.md's existing rule).
Full keybind unification is its own sprint. Filing as a follow-on ticket is the
cleaner move.

If included anyway: one test file
(`apps/floatty/src/lib/keybinds.collision.test.ts`). Small, but opens the question
of what the authoritative registry is — which is too big a question for this
boring-by-design sprint.

---

## 5. Out of scope (explicitly)

- **Any user-facing feature.** No pin shelf, no floating panel, no new UX. This
  sprint exists so those land cleanly next — not to ship them.
- **Floating panel / drawer / terminal-pin implementations.** The host registry
  *enables* them. Each is a separate feature ticket.
- **Full keybind registry unification.** Item 5 is the collision guardrail only,
  and is recommended for deferral.
- **`useLayoutStore` internal reshape.** The layout tree stays. Only the "layout
  tree is the pane-existence source of truth" assumption goes.
- **Y.Doc persistence of pane state.** Panes stay session-ephemeral. If a future
  feature wants persisted pins, that's a separate design — not this sprint.
- **Changing the sidebar's cross-tab persistence model.** Given invariant, not a
  lever.

---

## 6. Motivating use cases the sprint unblocks

Each of these goes from "discover all the places that assume pane=tab-leaf" to
"straightforward plumbing":

1. **Sidebar pinned outline shelf** (the immediate ask). Pins are
   `{ kind: 'sidebar' }` panes zoomed to a block id. Pin list is local/ephemeral;
   content is Y.Doc via block reference. *"A pin is just a zoomed pane that
   lives in a sidebar tab."*
2. **Floating NSPanel pane.** `{ kind: 'floating' }` panes formalize what the
   `togglePanel` spike is already doing ad-hoc.
3. **Command-bar result preview.** A transient zoomed pane; `{ kind: 'transient' }`
   or a future extension point.
4. **FLO-137 pinned-pane state.** Orthogonal to this sprint but coexists cleanly:
   FLO-137 adds a *state* to tab-hosted panes (PINNED/NORMAL/PREVIEW for wikilink
   click behavior); sidebar host adds a *host kind*. No interference.
5. **Daily-view drawer.** A sidebar-hosted Outliner zoomed to today's daily note
   page. Once the host registry and the builtin-tabs registry land, this is
   roughly 100 lines of new code instead of a feature investigation.

---

## 7. Sprint execution plan

**This PR** (the roadmap itself): roadmap memo only. Reviewer approves sprint
scope. No code changes.

**Follow-up PRs**, one per item, in order:

| PR | Items | Notes |
| --- | --- | --- |
| A | Item 1 + Item 3 | Host registry + Outliner contract docs. Combined because the docs describe the contract the registry enforces. |
| B | Item 2 | Navigation-funnel nullability audit. Can be parallel to PR A but reviews cleaner after A lands. |
| C | Item 4 | Sidebar builtin-tabs registry. Small, standalone. |
| D | Item 5 | Keybind collision guardrail. **Recommend defer** → filed as follow-on ticket instead. |

Then the sidebar-pin-shelf feature ships on top of A+B+C.

---

## 8. Verification

At roadmap approval time, no running code to verify. For the downstream PRs:

- **PR A**: all existing tests pass; new `usePaneStore.test.ts` cases cover host
  registration, lookup, symmetric cleanup; integration test mounts a fake
  `{ kind: 'sidebar' }` pane and verifies `findTabIdByPaneId` returns null
  without scanning layouts.
- **PR B**: no behavior change detectable in existing tests; manual harness test
  confirms navigation from a non-tab pane resolves correctly.
- **PR C**: `ctx` tab renders identically; existing sidebar tests green.
- **PR D** (if not deferred): collision test passes at HEAD, fails when a
  duplicate binding is introduced.

---

## 9. Open questions (for reviewer)

1. **Reactive Map vs Record for the host registry?** Implementation detail —
   flagging for the PR A review.
2. **Does `{ kind: 'floating' }` carry any payload** (window id, position),
   or is it a bare discriminator for this sprint? Recommend **bare** — the
   floating-panel feature can extend the variant when it ships.
3. **Is Item 4 in scope or cut?** Cheap to include, but the sprint is cleaner
   without it if reviewers prefer a tighter focus. Defaulting to *include*.
4. **Defer Item 5 as recommended?** Defaulting to *yes* — file as follow-on.

---

## 10. Related docs

- `AUDIT_2026-03.md` — prior architecture survey (naming precedent for this memo)
- `RUST_MODULARIZATION_GUIDE.md` — scoped-refactor-plan precedent
- `EXPAND_COLLAPSE_NAVIGATION.md` — navigation funnel (the 27-site audit target)
- `FLO-137-PINNED-PANES-SPEC.md` — different "pinned" concept; orthogonal
- `.claude/rules/architecture.md` — file inventory (Item 3 edits this)
- `.claude/rules/pane-drag-drop-patterns.md` — pane drag infra (not reused here,
  but referenced by future sidebar-shelf design)
