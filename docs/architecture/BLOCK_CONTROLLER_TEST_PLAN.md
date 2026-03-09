# Block Controller Test Plan

**Date**: 2026-03-09
**Status**: Test specifications for Composing → Committed migration
**Context**: YJS_DECOUPLING_AUDIT.md §6.5 found zero test coverage on deleted code paths. This plan covers the new code.

---

## A. BlockController

### A1. beginComposing — loads committed content

**Preconditions**: Block "b1" exists in Y.Doc with content "hello world". Controller is idle (composingContent is null).

**Actions**: Call `controller.beginComposing("b1")`.

**Expected**:
- Returns "hello world" (the committed content from Y.Doc)
- `controller.isComposing("b1")` returns true
- `composingContent()` signal returns "hello world"

### A2. commit — writes to Y.Doc, returns CommitResult

**Preconditions**: Block "b1" committed content is "hello". Controller is composing with content "hello world".

**Actions**: Call `controller.commit("b1", "hello world")`.

**Expected**:
- Y.Doc block "b1" content is now "hello world"
- Y.Doc transaction used origin `'user'`
- `controller.isComposing("b1")` returns false
- `composingContent()` signal returns null
- Returns `CommitResult` with `{ content: "hello world", metadataChanged: false }`

### A3. commit no-op — content unchanged

**Preconditions**: Block "b1" committed content is "hello". Controller is composing with content "hello" (unchanged).

**Actions**: Call `controller.commit("b1", "hello")`.

**Expected**:
- No Y.Doc transaction fires (content identical — skip write)
- `controller.isComposing("b1")` returns false
- `composingContent()` signal returns null

### A4. cancelComposing — reverts signal, no Y.Doc write

**Preconditions**: Block "b1" committed content is "hello". Controller is composing with content "hello world".

**Actions**: Call `controller.cancelComposing("b1")`.

**Expected**:
- No Y.Doc transaction fires
- `composingContent()` signal returns null
- Block "b1" in Y.Doc still has content "hello"

### A5. forceCommit — synchronous commit for reconnect

**Preconditions**: Block "b1" committed content is "hello". Controller is composing with content "hello world".

**Actions**: Call `controller.forceCommit()` (no args — commits whichever block is composing).

**Expected**:
- Y.Doc block "b1" content is "hello world"
- Commit is synchronous (no microtask, no rAF — same call stack)
- `composingContent()` signal returns null
- Returns the block ID that was committed ("b1")

### A6. forceCommit — no-op when not composing

**Preconditions**: Controller is idle.

**Actions**: Call `controller.forceCommit()`.

**Expected**:
- No Y.Doc transaction fires
- Returns null (nothing was composing)

### A7. discard — clears composing without Y.Doc write

**Preconditions**: Block "b1" committed content is "hello". Controller is composing with content "hello world".

**Actions**: Call `controller.discard()`.

**Expected**:
- No Y.Doc transaction fires
- `composingContent()` signal returns null
- Block "b1" in Y.Doc still has content "hello" (composing changes lost)

### A8. isComposing — reactive per-instance

**Preconditions**: Two BlockController instances (pane A, pane B) for the same block "b1".

**Actions**:
1. Pane A calls `controllerA.beginComposing("b1")`
2. Check both controllers

**Expected**:
- `controllerA.isComposing("b1")` returns true
- `controllerB.isComposing("b1")` returns false (independent instance)

### A9. commit triggers metadata extraction via processCommit

**Preconditions**: Block "b1" content is "plain text". Controller composing with "ctx::2026-03-09 [project::floatty]".

**Actions**: Call `controller.commit("b1", "ctx::2026-03-09 [project::floatty]")`.

**Expected**:
- Y.Doc block "b1" has content AND metadata updated in a single transaction
- `metadata.markers` includes `{ markerType: 'ctx', value: '2026-03-09' }` and `{ markerType: 'project', value: 'floatty' }`
- CommitResult has `metadataChanged: true`

### A10. commit with content change but no metadata change

**Preconditions**: Block "b1" content is "ctx::2026-03-09 [project::floatty] notes". Controller composing with "ctx::2026-03-09 [project::floatty] more notes".

**Actions**: Call `controller.commit("b1", "ctx::2026-03-09 [project::floatty] more notes")`.

**Expected**:
- Y.Doc content updated
- Metadata NOT written (markers unchanged — same ctx::, same project tag)
- CommitResult has `metadataChanged: false`

---

## B. processCommit (Karen middleware)

### B1. Single parse extracts markers + outlinks

**Input**: `{ nextContent: "ctx::2026-03-09 [project::floatty] see [[Design Doc]]", previousContent: "", previousMetadata: {} }`

**Expected**:
- `markers` includes ctx marker and project tag
- `outlinks` includes `"Design Doc"`
- Only ONE call to `parseAllInlineTokens` (verify via spy)

### B2. metadataChanged=false for non-metadata edit

**Input**: `{ nextContent: "hello world updated", previousContent: "hello world", previousMetadata: { markers: [], outlinks: [] } }`

**Expected**:
- `metadataChanged` is false
- `markers` is `[]`, `outlinks` is `[]`

### B3. metadataChanged=true when project tag added

**Input**: `{ nextContent: "ctx::2026-03-09 [project::floatty]", previousContent: "ctx::2026-03-09", previousMetadata: { markers: [{ markerType: 'ctx', value: '2026-03-09' }], outlinks: [] } }`

**Expected**:
- `metadataChanged` is true (new project tag)
- `markers` has 2 entries (ctx + project)

### B4. metadataChanged=true when project tag removed

**Input**: `{ nextContent: "plain text now", previousContent: "ctx::2026-03-09 [project::floatty]", previousMetadata: { markers: [...], outlinks: [] } }`

**Expected**:
- `metadataChanged` is true (markers cleared)
- `markers` is `[]`

### B5. Empty content — no crash

**Input**: `{ nextContent: "", previousContent: "hello", previousMetadata: {} }`

**Expected**:
- Returns `{ content: "", markers: [], outlinks: [], metadataChanged: true/false depending on previous }`
- No exception thrown

### B6. Nested brackets in wikilink

**Input**: `{ nextContent: "see [[link [with] brackets]]", previousContent: "", previousMetadata: {} }`

**Expected**:
- `outlinks` includes `"link [with] brackets"` (bracket-counting parser handles nesting)

### B7. Aliased wikilink extraction

**Input**: `{ nextContent: "see [[Target|Display Name]]", previousContent: "", previousMetadata: {} }`

**Expected**:
- `outlinks` includes `"Target"` (the target, not the alias)

### B8. Multiple wikilinks deduplicated

**Input**: `{ nextContent: "[[Page A]] and [[Page A]] again", previousContent: "", previousMetadata: {} }`

**Expected**:
- `outlinks` is `["Page A"]` (deduplicated)

### B9. Pure function — no side effects

**Input**: Any valid input.

**Expected**:
- No Y.Doc writes (pure function returns data, caller writes)
- No EventBus emissions
- No DOM access
- Deterministic: same input always produces same output

---

## C. Simplified Content Sync Effect

### C1. Non-composing block — store change updates DOM

**Setup**: Block "b1" rendered in DOM. composingContent is null. Store content changes from "hello" to "hello world" (remote update).

**Expected**:
- `contentRef.innerText` becomes "hello world"
- `displayContent()` becomes "hello world"

### C2. Composing block — store change does NOT touch DOM

**Setup**: Block "b1" rendered. composingContent is "hello worl" (user typing). Remote update changes store content.

**Expected**:
- `contentRef.innerText` unchanged (still shows composing content)
- `displayContent()` unchanged (still shows composing content)
- No cursor jump

### C3. Composing block commits — next store change syncs DOM

**Setup**: Block "b1" composing. commit() fires. Store now matches committed content.

**Expected**:
- After commit, composingContent is null
- Next store-triggered effect run: if DOM differs from store, DOM updates

### C4. Remote update to non-focused block — immediate

**Setup**: Block "b2" NOT focused, composingContent is null. Remote update changes content.

**Expected**:
- DOM updates on same effect cycle (no RAF delay for unfocused blocks)

### C5. Multi-pane: composing in pane A, committed view in pane B

**Setup**: Block "b1" has two BlockItem instances (pane A, pane B). Pane A is composing "hello world".

**Actions**:
1. Pane A commits "hello world"
2. Y.Doc transaction fires
3. Observer updates store

**Expected**:
- Pane B's content sync effect runs (composingContent is null in pane B's controller)
- Pane B's DOM updates to "hello world"
- Pane A's DOM untouched by the effect (commit already set content; composingContent just cleared to null, sync effect sees DOM already matches store)

---

## D. Flush Point Migration

One test per flush point from §6.1. Each verifies that `controller.commit()` makes store current before the structural operation reads from it.

### D1. execute_block — commit before handler runs

**Setup**: Block content in DOM is "sh:: echo hi". composingContent is "sh:: echo hi". Store (Y.Doc) has "sh:: echo ".

**Actions**: Press Enter (triggers execute_block action).

**Expected**:
- `controller.commit()` fires first
- Store content becomes "sh:: echo hi"
- Handler receives "sh:: echo hi" (not stale "sh:: echo ")

### D2. split_block — commit before split reads offset

**Setup**: Block content "hello world". Cursor at offset 5. composingContent is "hello world". Store has "hello".

**Actions**: Press Enter at offset 5 (triggers split_block).

**Expected**:
- `controller.commit()` fires first
- Store content becomes "hello world"
- `splitBlock("b1", 5)` reads "hello world" from store
- Results in blocks "hello" and " world"

### D3. split_to_child — commit before child split

**Setup**: Same as D2 but block has children and cursor at end of expanded parent.

**Expected**: Same commit-first pattern. Split creates first child with remainder content.

### D4. merge_with_previous — both blocks committed

**Setup**: Block "b1" content "hello" (committed). Block "b2" content "world" (composing, store has "wor").

**Actions**: Press Backspace at start of "b2" (triggers merge_with_previous).

**Expected**:
- `controller.commit()` fires for b2
- Store b2 content becomes "world"
- Merge reads `prevBlock.content.length` (5) for cursor positioning
- Merged content: "hello\nworld"
- Cursor at offset 5

### D5. handleBlur — commit on focus loss

**Setup**: Block "b1" composing with "hello world". Store has "hello".

**Actions**: Focus leaves block (blur fires).

**Expected**:
- `controller.commit()` fires
- Store content becomes "hello world"
- composingContent() becomes null

### D6. handlePaste — commit before structured paste reads store

**Setup**: Block "b1" composing with empty string "". Store has "leftover".

**Actions**: Paste multi-line markdown.

**Expected**:
- `controller.commit()` fires first
- Store content becomes "" (empty)
- `handleStructuredPaste` correctly detects empty block → uses first pasted block as content

### D7. onCleanup — commit on unmount

**Setup**: Block "b1" composing with "unsaved work". Component about to unmount.

**Actions**: Component unmount triggers onCleanup.

**Expected**:
- `controller.commit()` fires
- Store content becomes "unsaved work"
- No data loss

### D8. Export blur cascade — commit via blur handler

**Setup**: Block "b1" composing with "some notes". User presses Cmd+Shift+M (markdown export).

**Actions**: Outliner.tsx blurs activeElement → triggers handleBlur → triggers commit.

**Expected**:
- Blur cascades to handleBlur
- `controller.commit()` fires
- Export reads committed content from store

---

## E. Reconnect + Undo Integration

### E1. Reconnect during composing — force-commit preserves keystrokes

**Setup**: Block "b1" composing with "hello world". Store has "hello" (last commit). Server has "hello" (in sync).

**Actions**:
1. WebSocket reconnects
2. `performBidirectionalResync()` is about to apply server state

**Expected**:
- `controller.forceCommit()` fires BEFORE server state applied
- Store content becomes "hello world" (user's keystrokes)
- Server state applied via `Y.applyUpdate(doc, serverState, 'reconnect-authority')`
- CRDT merge: user's "hello world" wins (newer timestamp)
- composingContent is null
- Content sync effect runs → DOM shows "hello world"

### E2. Reconnect during composing — server has different content

**Setup**: Block "b1" composing with "local edit". Server state has "server edit" for same block.

**Actions**: Same as E1.

**Expected**:
- forceCommit writes "local edit" to Y.Doc
- Server state applied — CRDT field-level last-write-wins
- User's commit is newer → "local edit" wins
- DOM shows "local edit"

### E3. Undo during composing — discards uncommitted

**Setup**: Block "b1" last committed content "hello". Currently composing "hello world" (uncommitted).

**Actions**: User presses Cmd+Z.

**Expected**:
- Outliner.tsx undo handler fires
- `controller.discard()` clears composingContent to null (NOT commit)
- `undo()` fires on Y.Doc UndoManager
- UndoManager reverts to state BEFORE "hello" was committed (e.g., "hi")
- Content sync effect runs (composingContent is null) → DOM shows "hi"

### E4. Undo AFTER commit — UndoManager reverses commit

**Setup**: Block "b1" was committed with "hello world". No composing state. UndoManager has "hello world" commit on stack.

**Actions**: User presses Cmd+Z.

**Expected**:
- No composing to discard (controller.discard() is no-op)
- `undo()` reverses the commit transaction
- Store content reverts to previous value
- Content sync effect runs → DOM updates

### E5. Undo during composing — then type again

**Setup**: Same as E3. After undo, block shows "hi".

**Actions**: User types "!" making it "hi!".

**Expected**:
- New composing phase begins: composingContent is "hi!"
- Y.Doc still has "hi" (from undo result)
- On next commit, "hi!" is written

### E6. Redo after undo-during-composing

**Setup**: E3 completed. Block shows "hi" (undo result). No new typing.

**Actions**: User presses Cmd+Shift+Z (redo).

**Expected**:
- `redo()` fires
- UndoManager re-applies the "hello" commit
- Store content becomes "hello"
- Content sync effect runs → DOM shows "hello"
- The uncommitted "hello world" is permanently lost (expected — it was never committed)
