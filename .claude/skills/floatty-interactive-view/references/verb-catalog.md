# Verb Catalog

The interactive-view verb vocabulary. Every new view declares from this
set; new verbs get added here BEFORE code changes them.

## Base Verbs

### `update-block` (the write verb)

Direct content write — commits an edit to a block's content. This is
the verb that chirpWriteHandler actually handles; use this for edit
commits from your view.

**Params (Zod):**
```ts
z.object({
  blockId: z.string(),
  content: z.string(),
})
```

**Dispatcher action:**
- `store.updateBlockContent(blockId, content)` via `chirpWriteHandler.ts`
  case `'update-block'`.
- Already wired in `isChirpWriteVerb()` — no host changes needed.

**Two paths to emit:**

1. **Direct chirp** (simplest, for views without json-render state):
   ```typescript
   emitChirp(ref, 'update-block', { blockId, content });
   ```

2. **Via useBoundProp + StateProvider** (for json-render-wired specs):
   Bind the element to a state path, use `setValue` to write, and
   `handleRenderStateChange` translates `/cards/<id>/content` state
   writes to `update-block` chirps. See **Two-Way Binding Pattern**
   in `SKILL.md`. Path-regex convention: use `/cards/<blockId>/content`
   for card content, or extend the regex in `handleRenderStateChange`
   for new shapes.

### `edit-block` (view-state verb; not a write)

User activates a block for inline text editing (click, Enter on focused
card, dbl-click, etc). This is a **view-state** intent, not a write.
It signals "enter edit mode for block X." The actual content commit
uses `update-block` above.

**Params (Zod):**
```ts
z.object({
  blockId: z.string(),
})
```

**Dispatcher action:**
- In practice, `edit-block` is handled entirely inside the view
  component — flip a local `editing` signal, render an `<input>`,
  on commit emit `update-block`. There is no host-side `edit-block`
  verb today; it's a view-local convenience.
- If you genuinely need the host to know about edit state (e.g. to
  prevent parallel edits across panes), add a case in
  `chirpWriteHandler.ts` and document it here.

**Note on editing UI:** the editor element must be a native `<input>` or
`<textarea>`, NOT a contentEditable div. Nested `contentEditable=true`
inside a `contentEditable=false` wrapper is unreliable in WKWebView
(documented in the FLO-587 5b → 5f failure modes). See TableView's cell
editor at `apps/floatty/src/components/BlockDisplay.tsx:702` — real
input element.

### `move-block`

Drag-drop, reorder, reparent. The semantics of "move" — one block goes
to a new parent at a new index.

**Params (Zod):**
```ts
z.object({
  blockId: z.string(),          // source block being moved
  targetParentId: z.string().nullable(),  // null = move to root
  targetIndex: z.number().int().nonnegative(),
})
```

**Dispatcher action:**
- `store.moveBlock(blockId, targetParentId, targetIndex, { origin: 'user-drag' })`
- Surgical Y.Array mutation; full hook chain fires; CRDT sync broadcasts.
- Host reads back the envelope via EventBus subscription to re-project
  if needed (idempotent: unchanged cards don't re-render thanks to
  SolidJS signal diffing).

**Drag implementation constraint:** use pointer events, NOT HTML5 DnD.
Pattern-match `apps/floatty/src/hooks/useBlockDrag.ts:377-420`. The
outline's drag works in Tauri's webview because it uses pointer events.
HTML5 DnD in Tauri 2 may or may not work — don't rely on it without
measurement. Required elements:

- `setPointerCapture(e.pointerId)` on pointerdown
- `moveEvent.preventDefault()` inside pointermove
- `document.body.classList.add('<view>-dragging')` + matching CSS
  `body.<view>-dragging { user-select: none !important; cursor: grabbing !important }`

### `focus-sibling`

Keyboard navigation exits the view at a boundary. View's internal arrow
nav calls this when there's no more room to move inside.

**Params (Zod):**
```ts
z.object({
  direction: z.enum(['up', 'down', 'left', 'right']),
  fromBlockId: z.string(),
})
```

**Dispatcher action:**
- Host calls `findPrevVisibleBlock` / `findNextVisibleBlock` on the
  outline pane containing the view
- `props.onFocus(nextBlockId)` + `paneStore.setFocusCursorHint(paneId,
  direction === 'up' ? 'end' : 'start')`
- Left/right currently treated as no-op (views can override if they
  have column-style left/right semantics that wrap into prev/next
  outline blocks).

**Reference impl:** TableView's `onNavigateOut` at
`apps/floatty/src/components/BlockItem.tsx:887-895`. This verb is the
declarative version of that prop.

### `activate-block`

User "activates" without editing — Enter on a header, click on a
preview card, etc. Default dispatch = navigate into the block.

**Params (Zod):**
```ts
z.object({
  blockId: z.string(),
  mode: z.enum(['navigate', 'zoom', 'execute']).default('navigate'),
})
```

**Dispatcher action:**
- `navigate` (default): `navigateToBlock(blockId)` via `src/lib/navigation.ts`
- `zoom`: `paneStore.zoomTo(paneId, blockId)`
- `execute`: `executeHandler(block.content, …)` — for command-like
  blocks

## Extending the Vocabulary

Rules for adding a new verb:

1. **Does it exist already?** Check this file + `catalog.ts:actions`
   first. Don't invent `reparent-block` when `move-block` covers it.
2. **Is it view-specific or general?** A verb belongs here if >1 view
   would use it (`expand-collapse` for Tree + CollapsibleCalendar).
   View-specific interactions go in the view's own catalog section.
3. **Add Zod schema in `catalog.ts` first.** Before writing component
   code. The schema is the contract.
4. **Add dispatcher case in `chirpWriteHandler.ts`.** Or a new
   `verbDispatcher.ts` if the switch is getting large.
5. **Document here.** Three sections: params, dispatcher action, any
   implementation constraints (like "must use pointer events").

## Anti-Vocabulary

Verbs that sound reasonable but are NOT part of this contract:

- `delete-block`: destructive, requires confirmation UX, different
  chirp pattern. Not a view-level verb; views should `focus-sibling`
  away from a block they want deleted, and let the user press Backspace
  on it in the outline.
- `create-child`: already exists as a chirp write verb for
  artifact / eval doors that spawn child blocks. Views don't
  spawn blocks — they project existing ones. If your view needs
  create, you're probably building an editor, not a projection.
- `select-range`: views don't manage selection. The outline's
  block-selected state is a single-owner. If a view needs multi-select
  semantics, it's a different problem — talk to Evan.
