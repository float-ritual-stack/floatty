# Composing → Committed: Codebase Evaluation Report

## Context

Evaluation of current codebase state against a composing→committed editing model where Y.Doc writes only happen on explicit commit gestures (blur, Enter, structural ops), not during active typing. This is a terrain map, not an implementation plan.

> **Line number advisory (2026-03-16)**: Line references throughout this document are approximate. BlockItem.tsx lines have drifted ~3 lines since the original March 8 audit. Sections 3 and 8 (Dragons 2, 3) were updated to reflect merge atomicity and flush coverage fixes. Use function/variable names (not line numbers) for reliable navigation.

---

## 1. The Hot Path Audit

### March 8 Audit: MOSTLY ACCURATE (reviewed 2026-03-16)

Core hot path unchanged. Line numbers have drifted by ~3 lines in BlockItem.tsx (consistent with small insertions). `updateBlockContent` callers have expanded significantly since March 8 (see updated note below), but all new callers are handler output paths — the keystroke hot path is the same.

**Current hot path (keystroke → Y.Doc → DOM):**

| Step | File | Lines | What |
|------|------|-------|------|
| 1. Input | `BlockItem.tsx` | 804-806 | `handleInput()` → `updateContentFromDom()` |
| 2. DOM read | `BlockItem.tsx` | 767-802 | Reads `innerText`, sets `displayContent` signal, calls debouncer |
| 3. Debounce | `BlockItem.tsx` | 69-108 | `createDebouncedUpdater()` — 150ms delay (`UPDATE_DEBOUNCE_MS` line 31) |
| 4. Y.Doc write | `useBlockStore.ts` | 626-635 | `updateBlockContent()` — single transaction: content + type + updatedAt |
| 5. Observer | `useBlockStore.ts` | 396-608 | `_blocksObserver` — maps origin, builds events, emits to EventBus + ProjectionScheduler |
| 6. DOM sync | `BlockItem.tsx` | 599-675 | Content sync effect — origin-aware gate prevents echo |

**Key constants:**
- `UPDATE_DEBOUNCE_MS = 150` (BlockItem.tsx:31)
- Sync debounce = 50ms (useSyncedYDoc)
- ProjectionScheduler flush = 2000ms

**No new consumers found.** Grep for `updateBlockContent` shows callers across: BlockItem (debounced input), useBlockInput/useEditingActions (merge, remove_spaces), useExecutionAction/executor (handler output), pasteHandler, tvResolver, backlinkNavigation, and many command handlers (search, eval, conversation, backup, send, help, info, pick, commandDoor, doorSandbox). Most of these are handler output paths — they write results back to blocks. The hot-path consumer is still BlockItem's debounced updater.

### IME Composition gate
`isComposing()` signal (BlockItem.tsx:179) gates `updateContentFromDom()` at line 790 — skips Y.Doc update during CJK input, final character syncs on `compositionend`.

---

## 2. The Notification System State

### Three systems, current state:

| System | File | Subscribers | Fires on keystroke? |
|--------|------|-------------|---------------------|
| **EventBus** (sync) | `eventBus.ts` | ctxRouterHook, outlinksHook, funcRegistry, FilterBlockDisplay | YES — every 150ms debounce commit |
| **ProjectionScheduler** (async) | `projectionScheduler.ts` | Currently 0 registered projections in prod (infrastructure ready, no consumers) | YES — enqueued but no handlers |
| **ctxEvents** (FLO-423) | N/A | N/A — no evidence of migration started | N/A |

### EventBus subscribers in detail:

1. **ctxRouterHook** (`hooks/ctxRouterHook.ts:134`) — Extracts `ctx::` markers from content, stores in `block.metadata.markers`. Fires on `block:create` and `block:update`. Has early-exit: `hasCtxPatterns(content)` check skips most blocks. **Currently fires on every 150ms debounce.** Only needs commit-time.

2. **outlinksHook** (`hooks/outlinksHook.ts:109`) — Extracts `[[wikilink]]` targets, stores in `block.metadata.outlinks`. Same trigger pattern as ctxRouterHook. `hasWikilinkPatterns()` early-exit. **Currently fires every 150ms.** Only needs commit-time.

3. **funcRegistry** (`funcRegistry.ts:222`) — Rebuilds `func::` prefix index. Has its own 500ms debounce internally. Fires on create/update/delete. **Already debounced, but fires on keystroke events.** Only needs commit-time.

4. **FilterBlockDisplay** (`views/FilterBlockDisplay.tsx:175`) — Re-queries filter results on block changes. Has its own debounce (`REQUERY_DEBOUNCE_MS`). **Fires on keystroke events.** Could benefit from commit-only, though user expectation for live filter results might argue otherwise.

### Origin filtering in observer (useBlockStore.ts:406-467):

| Origin | Sync EventBus | ProjectionScheduler | Observer path |
|--------|--------------|---------------------|---------------|
| User | YES | YES | Normal (full event building) |
| Hook | YES | YES | Normal |
| Executor | YES | YES | Normal |
| Remote | NO | NO | Bulk (state sync only) |
| ReconnectAuthority | NO | NO | Bulk |
| BulkImport | NO | YES (create events only) | Bulk |

**Key finding:** ALL User-origin transactions emit to EventBus. Every 150ms debounce triggers all 4 subscribers. Moving to commit-only would reduce EventBus fire rate from "every 150ms while typing" to "on blur/Enter/structural op."

### Impact on downstream systems if commit-only:

- **ctxRouterHook**: Trivial — markers only meaningful in committed content. Delay is invisible.
- **outlinksHook**: Trivial — outlinks extracted on commit. Backlinks pane won't show transient wikilinks (good).
- **funcRegistry**: Trivial — func definitions change rarely, already debounced 500ms.
- **FilterBlockDisplay**: Minor concern — live filter results would lag until commit. Probably acceptable.
- **Tantivy indexing**: Not yet connected to EventBus/ProjectionScheduler in prod. Infrastructure ready. Would naturally be commit-only.

---

## 3. Structural Operations Inventory

### Summary table (updated 2026-03-16):

| Operation | Flushes first? | Single transaction? | Reads from | Notes |
|-----------|---------------|---------------------|------------|-------|
| `splitBlock` | YES (`flushContentUpdate()`) | YES | **Y.Doc** (store.blocks[id].content) | Reads committed content. Flush ensures content is committed first. |
| `splitBlockToFirstChild` | YES (`flushContentUpdate()`) | YES | **Y.Doc** (store.blocks[id].content) | Same pattern as splitBlock. |
| `merge_with_previous` | YES (`flushContentUpdate()`) | YES — single `mergeBlocks()` transaction | **Y.Doc** (block.content, prevBlock.content) | `mergeBlocks()` wraps lift children + content merge + delete in one `_doc.transact()`. Single undo step. |
| `indentBlock` | YES (`flushContentUpdate()`) | YES | N/A (structural only) | Pure tree reparenting. Flush prevents stale debounce after reparent. |
| `outdentBlock` | YES (`flushContentUpdate()`) | YES | N/A (structural only) | Pure tree reparenting. Same flush rationale. |
| `deleteBlock` | YES (`cancelContentUpdate()`) | YES | N/A | Recursive delete. Cancel (not flush) — no point committing content for a dying block. |
| `deleteBlocks` | NO (multi-select path) | YES | N/A | Multi-select delete, single transaction. |
| `moveBlockUp` | YES (`flushContentUpdate()`) | Delegates to `moveBlock()` → YES | N/A | May fall through to `outdentBlock()`. |
| `moveBlockDown` | YES (`flushContentUpdate()`) | Delegates to `moveBlock()` → YES | N/A | May fall through to `outdentBlock()`. |
| `remove_spaces` | YES (`flushContentUpdate()`) | Direct `updateBlockContent()` call | **DOM** (`contentRef.innerText`) | Flush cancels pending debounce before DOM read + Y.Doc write. No more race. |
| `create_block_before` | YES (`flushContentUpdate()`) | YES | N/A | Commit current content before creating sibling. |
| `create_block_inside` | YES (`flushContentUpdate()`) | YES | N/A | Commit current content before creating child. |
| `create_trailing_block` | YES (`flushContentUpdate()`) | YES | N/A | Commit current content before creating block at tree end. |

### ~~Critical finding: merge is NOT atomic~~ RESOLVED (2026-03-16)

`merge_with_previous` now calls `mergeBlocks(targetId, sourceId)` in useBlockStore.ts, which wraps the full operation — lifting source children via `liftChildrenToSiblings` logic, merging content (previously done by `updateBlockContent()`), and deleting the source block (previously `deleteBlock()`) — in a single `_doc.transact(() => { ... }, 'user')`. This produces one undo step. `Cmd+Z` after merge reverts the entire operation atomically.

The previous code called `liftChildrenToSiblings()` + `updateBlockContent()` + `deleteBlock()` as three separate transactions creating three undo entries. Fixed by inlining the sub-operations into `mergeBlocks()` using the existing surgical Y.Array helpers.

### Content source analysis for composing→committed:

- **splitBlock/splitBlockToFirstChild**: Read from `state.blocks[id].content` (Y.Doc/store). The `flushContentUpdate()` call ensures DOM content is written to Y.Doc before the read. **Post-refactor: structural ops would need to read composing content from DOM directly**, since Y.Doc may be stale during composing. The flush call already handles this — it's the right pattern.

- **merge_with_previous**: Also reads from store after `flushContentUpdate()`. Same pattern works. Now atomic (single `mergeBlocks()` transaction).

- **remove_spaces**: Reads directly from DOM (`contentRef.innerText`), then writes to Y.Doc. Now calls `flushContentUpdate()` first, cancelling any pending debounce before the DOM read + Y.Doc write. The race where a stale debounce could clobber the spaces removal is eliminated.

- **indent/outdent/moveBlock/delete**: No content reads. Pure structural. All now call `flushContentUpdate()` (or `cancelContentUpdate()` for delete) before mutating, preventing stale debounced writes from clobbering post-mutation state.

---

## 4. Undo Landscape

### UndoManager Configuration (useSyncedYDoc.ts:1619-1629)

```typescript
sharedUndoManager = new Y.UndoManager([blocksMap, rootIds], {
  trackedOrigins: new Set([null, undefined, 'user', 'user-drag']),
});
```

- **Scope**: `blocksMap` + `rootIds` (both Y.Doc structures)
- **Tracked origins**: `null`, `undefined`, `'user'`, `'user-drag'`
- **NOT tracked**: `'remote'`, `'hook'`, `'executor'`, `'bulk_import'`, `'system'`, `'reconnect-authority'`
- **Created after initial state load** to prevent undoing past loaded state
- **Cleared on creation** (`sharedUndoManager.clear()` at line 1629)

### Undo Granularity

**Current**: Every 150ms debounce commit = one undo entry. Y.UndoManager has built-in capture merging (500ms window by default in yjs), so rapid typing may merge into fewer entries. But there's no explicit `stopCapturing()` usage except:

- `stopUndoCaptureBoundary()` exported at useSyncedYDoc.ts:67-68 — called by `moveBlock()` in useBlockStore.ts (drag-and-drop undo isolation). Not yet used for content commit boundaries.

**Practical effect**: While typing, undo granularity is ~150ms intervals (debounce rate), coalesced by yjs's internal merge window. Structural operations (split, delete, indent) create their own entries because they're separate transactions.

### Undo + Composing implications

**Current risk**: User types "hello world" → debounce fires at "hello" → user continues to "hello world" → debounce fires again. Two undo entries for one logical edit session.

**Post-refactor opportunity**: With composing→committed, a commit on blur would be ONE undo entry for the entire editing session. `stopCapturing()` before commit would ensure clean boundaries.

### Undo + Structural operations

When user presses Enter (split): `flushContentUpdate()` fires → Y.Doc write (content) → then `splitBlock()` fires → Y.Doc write (split). These are **separate transactions** and **separate undo entries** unless yjs merges them within its capture window (500ms). The user would need `Cmd+Z` twice: once to undo the split, once to undo the content. **This is the current behavior and would need attention in composing→committed** since the content write and structural op should be ONE transaction.

---

## 5. Focus and Cursor Management

### Full Focus Lifecycle (BlockItem.tsx:527-576)

1. **Trigger**: `isFocused()` memo changes → effect runs
2. **Cursor hint consumed** synchronously (line 533): `paneStore.consumeFocusCursorHint(paneId)` — returns `'start'` | `'end'` | `null`, destroyed after read
3. **RAF scheduled** (line 535): actual focus deferred to next frame
4. **Block selection mode check** (line 538): skips if outliner container has focus
5. **Scroll lock** (line 544): `.scroll-locked` CSS class added before focus
6. **Focus + cursor** (lines 546-551): `contentRef.focus({preventScroll: true})`, then `placeCursorAtEnd/Start()`
7. **Scroll unlock** (line 556): `setTimeout(0)` removes class, then `scrollIntoView({block:'nearest'})`

### focusCursorHint lifecycle (usePaneStore.ts:514-538)

- Stored in plain object `focusCursorHints: Record<string, 'start' | 'end'>`
- Set by navigation actions (ArrowUp/Down set 'end'/'start')
- **Consumed once** via `consumeFocusCursorHint()` — deletes after read
- Used only by BlockItem.tsx focus effect

### Cursor restoration patterns:

1. **Content sync effect** (BlockItem.tsx:657-672): `getAbsoluteCursorOffset()` → DOM update → `setCursorAtOffset()`. Only when `shouldSync && isFocusedNow && domContent !== storeContent`. Handles undo/redo/remote updates on focused block.

2. **Double-rAF** (useEditingActions.ts:80-82): `moveBlockUp`/`moveBlockDown` use two `requestAnimationFrame` calls before re-focusing contentRef. Waits for Y.Doc update + SolidJS reconciliation.

3. **queueMicrotask chain** (useBlockInput.ts:648-655 and useEditingActions.ts:203-210): `merge_with_previous` uses double `queueMicrotask` for cursor placement at merge point. Waits for Y.Doc batch + SolidJS effects. Handled in both useBlockInput.ts (direct path) and useEditingActions.ts (action dispatch path).

4. **Paste double-rAF** (BlockItem.tsx:752-758): After batch block creation, two rAFs before focusing the new block.

### Dependencies on content sync effect:

The content sync effect (lines 599-675) depends on:
- `getAbsoluteCursorOffset()` / `setCursorAtOffset()` — for save/restore when focused block syncs
- `block()` reactive read — triggers on Y.Doc observer state changes
- `store.lastUpdateOrigin` — via `untrack()` (not a dependency, read imperatively)
- `hasLocalChanges()` signal — gates to prevent overwriting pending edits

**Post-refactor impact**: If Y.Doc is only written on commit, the content sync effect fires less often. The cursor save/restore path only matters for undo/redo/remote updates on focused blocks. The `hasLocalChanges` guard becomes less critical (Y.Doc won't change during composing from local user).

---

## 6. cursorUtils.ts Consumers

### Complete consumer map:

**Content sync effect (REDUCIBLE):**
- `BlockItem.tsx:657` — `getAbsoluteCursorOffset()` — save cursor before DOM sync
- `BlockItem.tsx:671` — `setCursorAtOffset()` — restore cursor after DOM sync

**Focus lifecycle (SURVIVES):**
- `BlockItem.tsx:34-62` — `placeCursorAtEnd()` / `placeCursorAtStart()` — imported helpers wrapping setCursorAtOffset
- `BlockItem.tsx:550-551` — consumed in focus effect via placeCursor helpers

**Keyboard actions (SURVIVES):**
- `useBlockInput.ts` — `isCursorAtContentStart()` / `isCursorAtContentEnd()` — merge/navigation boundary checks
- `useBlockInput.ts` — `getAbsoluteCursorOffset()` — split offset calculation
- `BlockItem.tsx:783` — `getAbsoluteCursorOffset()` — autocomplete trigger position

**Editing actions (SURVIVES):**
- `useEditingActions.ts:9` — `setCursorAtOffset()` — cursor placement after merge
- `useEditingActions.ts:171` — cursor positioning after remove_spaces

### Deletability analysis:

- **Safe to simplify**: The content sync effect's cursor save/restore (lines 657, 671) fires less often in composing→committed. Still needed for undo/redo/remote, so not deletable, but the effect body can be simpler.
- **NOT deletable**: Everything else — focus lifecycle, keyboard actions, editing actions all use cursorUtils independent of the content sync path.
- **Bottom line**: cursorUtils.ts stays. The ~80 line content sync effect (599-675) is what gets simplified, not the utility functions it calls.

---

## 7. Foundation Work Already Done

### ProjectionScheduler: READY

`projectionScheduler.ts` — singleton instance (`blockProjectionScheduler`), 2s flush interval, filter support, drain-until-stable semantics. **Already wired into the observer** (useBlockStore.ts:605). Currently has 0 registered projections in prod, but the infrastructure is complete.

**Alignment with composing→committed**: ProcessCommit's async metadata extraction (ctx:: markers, outlinks, tantivy reindex) maps directly to ProjectionScheduler projections. Register handlers for each concern, enqueue on commit.

### Two-lane event system: READY

Observer (useBlockStore.ts:601-605) already splits into:
- EventBus (sync lane) — for immediate UI reactions
- ProjectionScheduler (async lane) — for batched expensive operations

BulkImport already uses async-only path (lines 447-463). The commit-time pattern would be: structural ops → EventBus (sync), content changes → ProjectionScheduler (async).

### Origin filtering: READY

Full origin taxonomy in `types.ts:27-46`. Observer routes by origin. Hooks filter by origin. The composing→committed model could add a `'commit'` origin or reuse `'user'`.

### BlockIndexData: DOES NOT EXIST

No `BlockIndexData` type found. The `Block` type (from `blockTypes.ts`) is the primary data structure. Metadata stored as `block.metadata: Record<string, unknown>`.

### Hook system: PARTIALLY BUILT

Three hooks exist:
- `ctxRouterHook.ts` — EventBus subscriber, extracts ctx:: markers
- `outlinksHook.ts` — EventBus subscriber, extracts [[wikilink]] outlinks
- `sendContextHook.ts` — NOT an EventBus subscriber, called directly by /send handler

No generic hook registry or lifecycle manager. Each hook manually subscribes.

### FLO-368 / FLO-491: NO REFERENCES FOUND

No code references to these FLO numbers. Cannot determine current state.

---

## 8. Dragons and Surprises

### Dragon 1: lastUpdateOrigin is GLOBAL

`state.lastUpdateOrigin` (useBlockStore.ts:476) is a single global signal set by every Y.Doc transaction. The content sync effect in BlockItem.tsx reads it via `untrack()` (~line 606), but the effect STILL re-runs because `block()` is reactive and observer updates `setState('blocks', key, block)` for every changed block.

**Impact**: With 1000 blocks, a content commit causes observer → setState for 1 block → `block()` accessor fires in that one BlockItem → effect runs. The `untrack()` on origin prevents the effect from running in ALL BlockItems. This is correct and efficient.

**Post-refactor**: No change needed. Fewer commits = fewer effect runs.

### ~~Dragon 2: merge_with_previous is 3 transactions~~ RESOLVED (2026-03-16)

`merge_with_previous` now uses `mergeBlocks()` — a single `_doc.transact()` wrapping `liftChildrenToSiblings` logic + content merge (previously `updateBlockContent()`) + source deletion (previously `deleteBlock()`). Single undo step. See section 3.

### ~~Dragon 3: remove_spaces reads DOM without flushing~~ RESOLVED (2026-03-16)

`remove_spaces` now calls `flushContentUpdate()` before reading DOM and writing to Y.Doc. The flush cancels any pending debounce, eliminating the race where stale debounced content could overwrite the spaces removal.

### Dragon 4: Reconnect-authority during composing

If WebSocket reconnect fires while user is mid-keystroke with unflushed changes, `reconnect-authority` origin bypasses `hasLocalChanges` guard (BlockItem.tsx:622). The authoritative state overwrites DOM content.

**Current mitigation**: `cancelContentUpdate()` + `setHasLocalChanges(false)` (lines 625-626) prevent stale flush from firing afterward. User sees their typing replaced with server state. **This is correct but surprising behavior.**

**Post-refactor**: Same issue exists. Composing content not yet committed to Y.Doc would be lost on reconnect-authority. Need a "composing content recovery" path or user notification.

### Dragon 5: Multi-pane same-block echo

No `sourcePane` tagging exists in current Y.Doc transactions. Origin is just `'user'` string. If block is open in two panes:
- Edit in pane A → debounce → Y.Doc write → observer → effect in pane B
- Pane B's effect checks `isFocusedNow` — if B is NOT focused, it syncs DOM
- If B IS focused (somehow, e.g., split view both editable), the `isUserOrigin` gate prevents sync

**Post-refactor**: Composing→committed eliminates most of this concern. Content only propagates on commit, not on every keystroke. Multi-pane echo prevention is simpler when writes are infrequent.

### Dragon 6: Content sync effect references block() reactively

The content sync effect (BlockItem.tsx:599) has `const currentBlock = block()` on line 600. This is reactive. ANY field change on the block (not just content) re-runs the effect. A metadata-only change from a hook would trigger the effect, which then compares `domContent !== storeContent` and does nothing — but the effect still runs.

**Post-refactor**: Less of an issue. With hooks firing only on commit, metadata changes happen less frequently during active editing.

### Dragon 7: insert_spaces uses execCommand

`useEditingActions.ts:157`: `document.execCommand('insertText', false, '  ')` — this goes through the DOM → input event → `updateContentFromDom()` → debounce → Y.Doc. It does NOT bypass the debounce. **Compatible with composing→committed** since it's just another DOM mutation. (Note: useEditingActions.ts is at `src/hooks/blockInput/useEditingActions.ts`.)

### Dragon 8: Timing assumptions in cursor restoration

The double-rAF and queueMicrotask patterns assume Y.Doc writes happen synchronously. In composing→committed, structural ops that include a content commit + structural change in one transaction should still trigger synchronous observer → SolidJS update. **No change needed** as long as the transaction is synchronous (which Y.Doc transactions are).

### Dragon 9: lens:: implications

For the future `lens::` concept:
- **Helps**: Block-level commit boundary means a lens projection can observe committed state without interference from mid-composition transients. Clean read boundary.
- **Helps**: Async metadata extraction means lens match criteria update eventually, not on every keystroke. Prevents flicker.
- **Hinders**: Multi-pane editing of same block (lens target) needs the composing→committed model to handle "two composing states for one block." Only one pane can be composing at a time, or each pane needs independent composing state that reconciles on commit.
- **Hinders**: Write-back from lens view to source block requires knowing the source block's composing state. If source is being edited, lens write-back creates a conflict that Y.Doc can't resolve (since we're not using Y.Text).

---

## Summary: What the Terrain Says

**The good**: Infrastructure for composing→committed largely exists. ProjectionScheduler, two-lane events, origin filtering, and the `hasLocalChanges` guard already implement half the model. The debounce is the main thing to remove.

**The structural change**: Replace `createDebouncedUpdater` + 150ms timer with explicit commit triggers. The `flushContentUpdate()` pattern already exists for structural ops — generalize it.

**The risks**: ~~merge atomicity (3 transactions)~~ fixed, ~~remove_spaces race~~ fixed, reconnect-authority data loss during composing, and undo granularity changes need explicit handling.

**The deletable code**: The content sync effect (BlockItem.tsx:599-675) shrinks but doesn't disappear — undo/redo/remote still need DOM sync. The debouncer infrastructure (`createDebouncedUpdater`, `debouncedUpdateContent`, `flushContentUpdate`, `cancelContentUpdate`) gets replaced with a commit function.

**lens:: readiness**: The composing→committed boundary helps lens reads but complicates lens writes. Block-level granularity is correct for the current Y.Map-string storage model.
