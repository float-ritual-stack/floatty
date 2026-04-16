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
  spec element's `on` map (`on.activate`, `on.drag`, `on.navOut`).
- **Host dispatches verbs.** One dispatcher resolves verb → mutation, via
  the existing chirp pipeline into `useBlockStore`.
- **Door has zero handlers.** Components are pure presentation. Never
  `onClick`, `onDragStart`, `onPointerDown` inside the door — those are
  verbs the spec declares, not handlers the door owns.

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

**No handler function inside a door component.** If you find yourself
writing `onClick` / `onDragStart` / `onPointerDown` inside `components.tsx`,
stop — the component needs a verb declaration on the spec element, and a
matching handler on the host dispatcher. See
`references/dispatch-wiring.md`.

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

## The Verb Vocabulary

Base verbs — every interactive view should speak these. See
`references/verb-catalog.md` for Zod schemas and param shapes.

| Verb | Emitted when | Host dispatches to |
|---|---|---|
| `edit-block` | User activates a block for inline editing (click, Enter) | `store.updateBlockContent` when editor commits |
| `move-block` | Drag-drop, reorder, reparent | `store.moveBlock` with surgical Y.Array ops |
| `focus-sibling` | Keyboard navigation exits the view at a boundary | `findPrev/NextVisibleBlock` + `props.onFocus` |
| `activate-block` | User "activates" without editing (Enter on header, preview) | View-specific; default = navigate |

A new view extends this only if it has a genuinely new interaction —
`expand/collapse` for tree, `resize` for calendar event. Adding a
verb requires updating `references/verb-catalog.md` + Zod schema in
`catalog.ts` + handler case in `chirpWriteHandler.ts`.

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
- [ ] Zero `onPointerDown` / `onClick` / `onDragStart` inside the door
      bundle (grep to prove)

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

```
1. Read required files (6, in order).
2. Invoke `pattern-fit-check` skill. Write four answers.
3. Draft spec shape: element types, bindings, on-map.
4. Draft verb catalog additions (if any new verbs).
5. Draft dispatcher cases.
6. Write component as pure presentation (no handlers).
7. Deploy door bundle only.
8. Measure via tauri-mcp-server:
   - DOM renders the component
   - Verb dispatch logs fire on interaction
   - `/api/v1/blocks/<id>` reflects the mutation
9. If logs contradict expectations, STOP. Revert to step 3.
   Do not stack a fix on a wrong measurement.
```

Step 9 is the discipline. It's what 5b–5f skipped.

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
