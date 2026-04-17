---
name: floatty-interactive-view
description: Architectural constraints for building interactive floatty views (kanban, tree, calendar, graph) inside the `render::` door. Use when adding a view that needs drag, click-to-edit, keyboard navigation, or any interaction that mutates the outline. Enforces the spec-declares-verbs / host-dispatches-verbs pattern — prevents the patch-stacking failure mode that burned FLO-587 units 5b–5f. Invoke BEFORE writing component code for any new view that isn't purely display-only.
allowed-tools: Read Grep Glob Bash(ls *) Bash(test *) Bash(git log *) Bash(git blame *)
---

# Floatty Interactive View

A floatty interactive view is a `render::` door spec that renders a block
subtree with interactive verbs — drag to reparent, click to edit, arrow
keys to navigate. The architectural contract is:

- **Spec declares verbs.** Every interaction becomes a named entry in the
  spec element's `on` map (`on.activate`, `on.drag`, `on.navOut`) OR a
  chirp emission from the component.
- **Host dispatches verbs.** One dispatcher resolves verb → mutation, via
  the existing chirp pipeline into `useBlockStore` (writes) or
  `BlockOutputView.onChirp` (focus/nav).
- **Door handlers may exist — but they never call store methods.** The
  invariant the door must uphold is: *the outcome of any interaction is
  a chirp emission, never a direct mutation.* Imperative code inside a
  component is allowed when the interaction needs it (pointer drag with
  `elementFromPoint`, caret positioning during edit, input focus
  orchestration) — but the decision it reaches must be emitted as a
  verb, not dispatched as a store call.

This skill exists because FLO-587 unit 5b–5f spent ~90 minutes
rediscovering what this pattern prevents. Every anti-pattern below is a
commit hash from that stack. Skill-as-memorial.

## When to Use

- Building any new `render::` view that isn't purely display-only
- Adding interactivity to an existing view (drag, edit, navigate)
- Fixing a view whose handlers are in multiple files (door + host)
- Pattern-matching a new view against TableView, kanban, or future Tree /
  Calendar / Graph views

## When NOT to Use

- Pure display-only specs (demo, stats, prompt) — no interaction to encode
- `artifact::` iframes — those run in a sandboxed iframe with postMessage
- Output-block views (search results, img-view) — different mount pattern,
  governed by `output-block-patterns.md`

## The Rule

**No direct store mutation inside a door component.** If a handler in
`components.tsx` calls `store.updateBlockContent`, `store.moveBlock`,
or any other `useBlockStore` method directly, stop — the handler must
emit a chirp verb instead, routed through the host dispatcher. Handlers
themselves are fine when the interaction needs them (drag with
`elementFromPoint`, focus orchestration, input blur detection) —
see `dispatch-wiring.md` "When the Pattern Breaks Down." The invariant
is on the *outcome*, not the presence of handlers.

## Required Reads (in this order, before writing any code)

1. **ADR-002 — Projections Not Source**
   `apps/floatty/docs/adrs/ADR-002-projections-not-source.md`
   The invariant: renderers project, they don't hold truth. Verbs dispatch
   to `useBlockStore`; the spec's `state` is a projection surface, not a
   source.
2. **ADR-003 — Agent Role Boundaries**
   `apps/floatty/docs/adrs/ADR-003-agent-role-boundaries.md`
   Renderer role explicitly says no mutation logic inside the door. The
   verb-dispatch pattern IS what makes this enforceable.
3. **TableView — the working same-shape precedent**
   `apps/floatty/src/components/BlockDisplay.tsx:277` (the `TableView`
   function — the file has no separate `TableBlockDisplay.tsx`). Read:
   - The `TableViewProps` interface at `:186-201` (`isFocused`,
     `onNavigateOut`) — those props are the verb bridge.
   - `handleTableKeyDown` at `:488-567` — internal arrow nav, only fires
     `onNavigateOut('up' | 'down')` at row boundaries.
   - `<table tabindex={0} onKeyDown={handleTableKeyDown}>` at `:642-647`
     — **one focusable root**, not per-cell.
   - The `<input>` cell editor at `:702` — native input, NOT a
     contentEditable div. Nested contentEditable is unreliable in WKWebView.
4. **useBlockDrag — the working drag implementation**
   `apps/floatty/src/hooks/useBlockDrag.ts:377-420`
   The outline's block drag works in Tauri's webview. Note: it uses
   **pointer events** (`pointerdown` / `pointermove` / `pointerup`), NOT
   HTML5 DnD (`dragstart` / `dragover` / `drop`). Pointer events are the
   safe default. Critical details:
   - `setPointerCapture(pointerId)` on source
   - `moveEvent.preventDefault()` inside `pointermove`
   - `document.body.classList.add('block-dragging')` + CSS rule
     `body.block-dragging { user-select: none; cursor: grabbing !important }`
5. **chirpWriteHandler — where verbs land on the host side**
   `apps/floatty/src/lib/chirpWriteHandler.ts`
   The switch statement is the verb dispatcher for write verbs today
   (`create-child`, `upsert-child`, `update-block`, `move-block`). New
   verbs get a case here. The `ChirpWriteStore` interface names the
   subset of `useBlockStore` the dispatcher needs.
6. **Catalog actions — where verb names live**
   `apps/floatty/doors/render/catalog.ts` (search for `actions:`).
   The `actions` map is the source of truth for verb names +
   Zod-typed params. json-render's `ActionProvider` resolves the action
   handler at render time.

After reading those six, invoke the `pattern-fit-check` skill with the
reference as TableView (`:277`) and the target as your new view.
Answer the four invariant questions before writing code.

## Reactive Re-Projection (CRITICAL — FLO-587, 2026-04-17)

**The spec generator is pure data → spec. It runs ONCE unless you wire a
subscription.** An interactive view that doesn't subscribe to Y.Doc
changes is a frozen snapshot — user drags a card, outline updates, view
doesn't re-render. Kanban looked broken this way for 4+ hours until we
found `refresh()` was defined-but-never-called.

**The contract:** every interactive view MUST subscribe via
`ctx.server.subscribeBlockChanges(handler, { fields: [...] })` after its
initial render. The handler pulses (no args) — the view re-generates
its spec from current store state and calls `setOutputWithTitle` again.

**Reference implementation** — `apps/floatty/doors/render/render.tsx`
in the `expand/kanban` branch:

```typescript
const refresh = () => {
  const spec = generate(blockRef, storeActions);
  setOutputWithTitle({ spec: normalizeSpec(spec, ctx), ... });
};

// Initial render
refresh();

// Subscribe — per-block+cmd key so re-execution doesn't stack
const subKey = `${blockId}:${cmd}`;
renderSubscriptions.get(subKey)?.();  // unsub prior
const unsubscribe = ctx.server.subscribeBlockChanges(refresh, {
  fields: ['childIds', 'content', 'parentId'],
});
renderSubscriptions.set(subKey, unsubscribe);
```

**Field filter matters.** Metadata-only updates (outlinks, markers,
`updatedAt`) shouldn't trigger re-projections — they don't change what
renders. Filter to `['childIds', 'content', 'parentId']` unless your
view actually depends on other fields.

**Re-execution discipline.** If the door can re-execute for the same
block (Enter on a `render:: kanban` block re-runs), track subscriptions
in a module-level `Map<key, () => void>` and unsubscribe-then-resubscribe
on each execution. Otherwise you stack N subscriptions and `refresh`
runs N times per change.

**Anti-pattern:** a comment that says "reactivity lives in the view
layer (see XYZ)" without actually wiring it. If you wrote `refresh()`
and never call it from a subscription, you have a frozen view. See FM-12.

## The Verb Vocabulary

Base verbs — every interactive view should speak these. See
`references/verb-catalog.md` for Zod schemas and param shapes.

| Verb | Emitted when | Host dispatches to |
|---|---|---|
| `update-block` | Inline editor commits (blur / Enter) — direct write | `store.updateBlockContent(blockId, content)` |
| `move-block` | Drag-drop, reorder, reparent | `store.moveBlock` with surgical Y.Array ops |
| `focus-sibling` | Keyboard navigation exits the view at a boundary | `findPrev/NextVisibleBlock` + `props.onFocus` |
| `activate-block` | User "activates" without editing (Enter on header, preview) | View-specific; default = navigate |

The `edit-block` entry in `references/verb-catalog.md` describes the
view-state verb ("enter edit mode on block X"); the actual write verb
that commits the edit is `update-block` with `{ blockId, content }`,
already registered in `chirpWriteHandler.ts`.

A new view extends this only if it has a genuinely new interaction —
`expand/collapse` for tree, `resize` for calendar event. Adding a
verb requires updating `references/verb-catalog.md` + Zod schema in
`catalog.ts` + handler case in `chirpWriteHandler.ts`.

## Two-Way Binding Pattern (useBoundProp → chirp)

For inline edits, json-render provides `useBoundProp` which reads/writes
to spec state. The bridge to the outline is a separate concern — here
is the full path:

```text
KanbanCard.commit()
  → setValue(newContent)                              // useBoundProp setter
  → StateProvider.set('/cards/<blockId>/content', ...) // writes spec state
  → onStateChange([{path, value}])                    // StateProvider fires
  → handleRenderStateChange(changes, props.onChirp)   // render.tsx translates
  → onChirp('update-block', { blockId, content })     // DoorHost prop
  → BlockOutputView handler → isChirpWriteVerb → handleChirpWrite
  → store.updateBlockContent(blockId, content)        // outline mutates
```

**Every link in this chain must be wired.** If `setValue` fires but the
outline doesn't update, instrument each hop: StateProvider callback,
handleRenderStateChange path match, onChirp presence, isChirpWriteVerb
membership, chirpWriteHandler case.

**Binding path convention:** use `/cards/<blockId>/content` for card
content. The regex in `handleRenderStateChange` only matches that exact
shape. A binding path like `/items/<id>/text` would fall through as a
silent no-op. Extend the regex if you need a new shape.

## Keyboard Navigation & Boundary Crossing (FLO-587, 2026-04-17)

Views own in-view arrow nav. At view boundaries (top of first column,
bottom of last, past leftmost/rightmost column, etc.), focus must exit
to the outline block before/after the view — otherwise users get
trapped inside the view.

**In-view nav:** a `findNeighbor(direction)` helper that walks the
view's DOM (e.g. `querySelectorAll('[data-kanban-card-id]')`) and
returns the next focusable element or `null` at a boundary. Reference:
`apps/floatty/doors/render/components.tsx` `findNeighbor` in
KanbanCard.

**Boundary crossing:** emit the `focus-sibling` verb with
`{ direction: 'up' | 'down' | 'left' | 'right', fromBlockId }`. The
host dispatches to `findPrev/NextVisibleBlock(blockId, paneId)` + the
BlockOutputView's `props.onFocus(nextBlockId)` callback. `props.onFocus`
transfers focus to the next BlockItem via pane state — SolidJS effect
in that BlockItem sees `isFocused() === true` and calls
`contentRef?.focus()`.

**Dispatcher location:** `focus-sibling` is NOT a store write — it's
host-level focus coordination. Handle it in the DoorHost `onChirp`
handler in `apps/floatty/src/components/BlockOutputView.tsx` (BEFORE
the `isChirpWriteVerb` check), NOT in `chirpWriteHandler.ts`. This
keeps the store-write dispatcher tight (only verbs that mutate
useBlockStore) and keeps focus verbs in the view-host layer where
focus state actually lives.

**Reference implementation (verb form):** kanban emits focus-sibling
in `components.tsx` `onCardKeyDown` at Arrow{Up,Down,Left,Right}
boundaries. BlockOutputView dispatches. This is the first production
reference for the verb.

**Reference implementation (prop-callback form, non-door):** TableView
uses the same bridge but via a prop-callback because it's a
host-rendered block type, not a door view:

- `apps/floatty/src/components/BlockDisplay.tsx:488-567` —
  `handleTableKeyDown` detects cell boundaries and calls
  `props.onNavigateOut('up' | 'down')`
- `apps/floatty/src/components/BlockItem.tsx:887-895` — the bridge
  callback: `findPrev/NextVisibleBlock` + `props.onFocus(nextBlockId)`

Door views can't take direct props from the host (they're bundled JS
loaded at runtime), so doors use chirps. Host-rendered blocks can use
either pattern; prop-callback is lighter if you don't need verb-level
declarativeness.

**Anti-pattern:** letting the arrow key bubble when `findNeighbor`
returns null, hoping the outline's nav-shim catches it. Kanban tried
that until 2026-04-17; focus got stuck on the boundary card. The
boundary case must be explicit — either emit the verb or call the
callback.

**Escape key convention:** TableView calls `onNavigateOut('up')` on
Escape (default upward). Kanban currently just blurs on Escape; adopt
TableView's convention if your view uses Escape for "exit."

## Drag Drop Zone Design (FLO-587, 2026-04-17)

Lessons from shipping kanban drag:

1. **Drop zones must cover empty column space, not just cards.** If
   your drop detection only fires on `elementFromPoint → closest(card)`,
   users dropping between cards or at the bottom of a column get
   "drop: no target" and nothing happens. Fall back to
   `closest(column)` and compute `targetIndex = siblings.length`.

2. **Source must fade/indicate during drag.** Tauri webview has no
   native drag ghost. Set `ref.style.opacity = '0.4'` on drag-started
   and remove in cleanup. Without this, users can't see what they're
   moving — they overshoot and drop on same-column cards.

3. **Exclude source from sibling index calculation.** When computing
   the insert index in a target column, filter the source element out
   of `querySelectorAll('[data-kanban-card-id]')`. Otherwise dropping
   on your own neighbor computes an index that, after `adjustedTarget`
   math in `moveBlock`, equals your old position → legitimate
   no-op reject → user experience is "drag doesn't work."

4. **Distinct highlight styles per drop target type.** Card-relative
   drops (above/below) use `inset box-shadow`. Column empty-space drops
   use dashed `outline`. Different visuals = different feedback to
   user about what the drop will do.

## Required Outputs Contract

Before shipping a new view, verify:

- [ ] Spec element declares verbs in an `on:` map (no handlers in door)
- [ ] Every verb used is in `catalog.ts:actions` with Zod-typed params
- [ ] Matching case exists in `chirpWriteHandler.ts` (or a new
      `verbDispatcher.ts` if the pattern grows)
- [ ] Component under test in `kanban.test.ts` pattern — assert the
      spec shape (elements, bindings, on), not the handler dispatch
- [ ] DOM probe via `tauri-mcp-server` post-deploy confirms: component
      renders, verb dispatch logs fire, outline reflects mutation via
      `/api/v1/blocks/<id>`
- [ ] Zero direct `store.*` calls inside door components (grep
      `doors/.*/components.tsx` for `store\.`; imperative handlers
      are allowed, but every mutation outcome must go through
      `emitChirp(...)` or a spec `on:` verb)

## Anti-Patterns (from FLO-587 session, 2026-04-16)

Every rule here cites a commit hash where cowboy discovered it the hard
way. Skill-as-memorial. Read `references/failure-modes.md` for full
detail + reproducer steps.

1. **Don't ship fixes without reading the last diagnostic log.**
   Unit 5e (`b738a83`) added dragstart / click / nav-shim logs. Unit 5f
   (`7f8ee48`) shipped a full rewrite without reading any of them. Three
   log reads across the full session returned only `nav-shim installed`
   — every interaction event claim was unmeasured speculation.

2. **Don't encode hypotheses as source comments.**
   Unit 5f commented in `components.tsx` that "HTML5 DnD is suppressed
   by Tauri 2's native drag-drop interception." This was false, falsified
   by Evan's "outline drag works" observation (outline also runs inside
   the same webview). The comment is a lie now present in source until
   revert. Unverified claims go in commit messages, not in code.

3. **Don't add handlers in two files.**
   Units 5a–5f ended with drag/edit/focus handlers scattered across
   `components.tsx` (door), `BlockItem.tsx` (host),
   `useDoorChirpListener.ts` (dispatch bridge), and inline CSS injected
   from door init. Every fix stumbled on handler collisions between
   door and host. Verbs in spec + dispatch in one file eliminates this.

4. **Don't assume Tauri 2 behavior from docs — verify against a working
   sibling in the repo.**
   The hypothesis "Tauri 2 suppresses HTML5 DnD" was plausible from
   Tauri 2 release notes. The live counter-example was `useBlockDrag.ts`
   — pointer-based, works fine. Pattern-fit-check compares your target
   against a working same-codebase reference, not external docs.

5. **Don't patch contentEditable inheritance without checking title mode.**
   Unit 5b wrapped the door output in `contenteditable="false"` to
   isolate from an inherited contentEditable — but `isRenderTitleMode()`
   at `BlockItem.tsx:181` already hides contentEditable when a render
   block has a title. The wrapper was patching a non-problem. MCP DOM
   probe showed `isContentEditable: false` on the wrapper's parent in
   title mode. Verify with a DOM probe BEFORE adding isolation wrappers.

6. **Don't edit `tauri.conf.json` without reproducing the failure first.**
   A mid-session commit added `dragDropEnabled: false` speculatively.
   This would have broken Finder→terminal file-drop (the
   `tauri://drag-drop` listener in `App.tsx:178`). Caught and reverted
   only because the user named the working counter-example. Config
   edits need a reproducer before they ship.

7. **Don't stack patches across session turns without a measurement
   checkpoint.**
   Five units (5b, 5c, 5d, 5e, 5f) shipped before a single log read.
   Each built on the previous wrong inference. The correct rhythm:
   one change → measure → one more change. Not: five changes → measure.

8. **Don't pivot on user input without first reading latest logs.**
   When Evan said "I can drag and drop nodes of the outliner", cowboy
   pivoted directly to a pointer-events rewrite without reading what
   5e had captured. A 30-second `read_logs` call would have ended the
   hypothesis loop. Measurement before pivoting.

## Workflow

```text
1. Read required files (6, in order).
2. Invoke `pattern-fit-check` skill. Write four answers.
3. Draft spec shape: element types, bindings, on-map.
4. Draft verb catalog additions (if any new verbs).
5. Draft dispatcher cases.
6. Write component as pure presentation (no handlers).
7. Deploy with scripts/build-door.sh <door-name> (validates
   manifest, compiles, deploys BOTH index.js + door.json to
   BOTH dev + release profiles — see FM-9).
8. Measure via tauri-mcp-server:
   - DOM renders the component
   - Verb dispatch logs fire on interaction
   - `/api/v1/blocks/<id>` reflects the mutation
9. If logs contradict expectations, STOP. Revert to step 3.
   Do not stack a fix on a wrong measurement.
```

Step 9 is the discipline. It's what 5b–5f skipped.

## Deploy Command

Use the skill's deploy script — it's the only path that catches
the FM-9 class of bug (missing manifest → "Unknown door"):

```bash
bash .claude/skills/floatty-interactive-view/scripts/build-door.sh <door-name>
```

What it does:
- Validates `apps/floatty/doors/<name>/door.json` (structure +
  required fields: id, name, prefixes, version)
- Warns if manifest `id` doesn't match the directory name
- Compiles `<name>.tsx` via `scripts/compile-door-bundle.mjs`
- Deploys BOTH `door.json` AND `index.js` to BOTH
  `~/.floatty-dev/doors/<name>/` AND `~/.floatty/doors/<name>/`
- Verifies both files exist after copy (fails loud if not)
- Pings the backend health endpoint (informational)

Fails loud on: missing source dir, missing/invalid manifest,
compile errors, missing target files. This is the full fail-loud
pipeline — do not fall back to raw `compile-door-bundle.mjs` +
manual `cp` calls. That path is exactly what burned us in FM-9.

## Files

- `references/verb-catalog.md` — base verb vocabulary, Zod schemas
- `references/dispatch-wiring.md` — host-side verb dispatch pattern
- `references/failure-modes.md` — FLO-587 anti-pattern expansions with
  commit citations

## Related Skills

- `pattern-fit-check` — use for the four-question invariant match
  against TableView / useBlockDrag references
- `floatty-improve-prompt` — use to frame a rough request before
  invoking this skill
- `door-component-development` (global) — general door pre-flight;
  this skill is the interactive-view specialization
