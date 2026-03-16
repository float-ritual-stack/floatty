# Composing → Committed: Codebase Evaluation Report

## Context

Evaluation of current codebase state against a composing→committed editing model where Y.Doc writes only happen on explicit commit gestures (blur, Enter, structural ops), not during active typing. This is a terrain map, not an implementation plan.

---

## 1. The Hot Path Audit

### March 8 Audit: STILL ACCURATE

No regressions. PRs #172/#173 (search-work) modified Rust backend search metadata only — zero keystroke hot path changes.

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

**No new consumers found.** Grep for `updateBlockContent` confirms only these callers: BlockItem (debounced), useEditingActions (merge content + remove_spaces), useExecutionAction (handler output).

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

### Summary table:

| Operation | Flushes first? | Single transaction? | Reads from | Notes |
|-----------|---------------|---------------------|------------|-------|
| `splitBlock` | YES (`flushContentUpdate()` at useEditingActions.ts:114) | YES (useBlockStore.ts:1003-1025) | **Y.Doc** (store.blocks[id].content at line 979) | Reads committed content. Flush ensures content is committed first. |
| `splitBlockToFirstChild` | YES (useEditingActions.ts:123) | YES (useBlockStore.ts:1059-1073) | **Y.Doc** (store.blocks[id].content at line 1042) | Same pattern as splitBlock. |
| `merge_with_previous` | YES (useEditingActions.ts:180) | **NO — 3 separate calls** | **Y.Doc** (block.content, prevBlock.content at lines 184-185) | `liftChildrenToSiblings()` + `updateBlockContent()` + `deleteBlock()` = 3 transactions. **Breaks atomic undo.** |
| `indentBlock` | NO | YES (useBlockStore.ts:1339-1356) | N/A (structural only, no content) | Pure tree reparenting. No content read. |
| `outdentBlock` | NO | YES (useBlockStore.ts:1368-1389) | N/A (structural only, no content) | Pure tree reparenting. |
| `deleteBlock` | NO | YES (useBlockStore.ts:1098-1118) | N/A | Recursive delete in single transaction. |
| `deleteBlocks` | NO | YES (useBlockStore.ts:1156-1179) | N/A | Multi-select delete, single transaction. |
| `moveBlockUp` | NO | Delegates to `moveBlock()` → YES | N/A | May fall through to `outdentBlock()` (useBlockStore.ts:1475). |
| `moveBlockDown` | NO | Delegates to `moveBlock()` → YES | N/A | May fall through to `outdentBlock()` (useBlockStore.ts:1529). |
| `remove_spaces` | NO | Direct `updateBlockContent()` call | **DOM** (`contentRef.innerText` at useEditingActions.ts:157) | Reads from DOM, writes to Y.Doc. No flush. |

### Critical finding: merge is NOT atomic

`merge_with_previous` (useEditingActions.ts:177-217) executes three separate Y.Doc operations:
1. `liftChildrenToSiblings()` — own transaction
2. `updateBlockContent()` — own transaction
3. `deleteBlock()` — own transaction

This creates 3 undo steps. `Cmd+Z` after merge only undoes the delete, leaving orphaned content in the previous block. **This is a pre-existing bug** that exists regardless of composing→committed.

### Content source analysis for composing→committed:

- **splitBlock/splitBlockToFirstChild**: Read from `state.blocks[id].content` (Y.Doc/store). The `flushContentUpdate()` call ensures DOM content is written to Y.Doc before the read. **Post-refactor: structural ops would need to read composing content from DOM directly**, since Y.Doc may be stale during composing. The flush call already handles this — it's the right pattern.

- **merge_with_previous**: Also reads from store after flush. Same pattern works.

- **remove_spaces**: Reads directly from DOM (`contentRef.innerText`), then writes to Y.Doc. **This already works in a composing→committed model** since it reads DOM truth. But it does NOT flush first, so the debounce may race. Minor issue.

- **indent/outdent/moveBlock/delete**: No content reads. Pure structural. No impact from composing→committed.

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

- `stopUndoCaptureBoundary()` exported at useSyncedYDoc.ts:67-68 — **NOT called anywhere in the codebase currently.** It exists as infrastructure.

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

3. **queueMicrotask chain** (useEditingActions.ts:205-213): `merge_with_previous` uses double `queueMicrotask` for cursor placement at merge point. Waits for Y.Doc batch + SolidJS effects.

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

`state.lastUpdateOrigin` (useBlockStore.ts:476) is a single global signal set by every Y.Doc transaction. The content sync effect reads it via `untrack()` (line 603), but the effect STILL re-runs because `block()` is reactive and observer updates `setState('blocks', key, block)` for every changed block.

**Impact**: With 1000 blocks, a content commit causes observer → setState for 1 block → `block()` accessor fires in that one BlockItem → effect runs. The `untrack()` on origin prevents the effect from running in ALL BlockItems. This is correct and efficient.

**Post-refactor**: No change needed. Fewer commits = fewer effect runs.

### Dragon 2: merge_with_previous is 3 transactions

As documented in section 3. Three separate Y.Doc transactions = three undo entries. Pre-existing issue. Composing→committed makes this MORE visible because the content flush + structural ops should be atomic. **Recommendation: combine into single transaction when implementing.**

### Dragon 3: remove_spaces reads DOM without flushing

`useEditingActions.ts:157` reads `contentRef.innerText` directly, then calls `updateBlockContent()`. No `flushContentUpdate()` first. If there's a pending 150ms debounce, two writes race: the debounce fires its stale content AFTER remove_spaces writes new content. **The debounce wins (it fires after), clobbering the spaces removal.**

**Current mitigation**: The debounce captures args at call time (line 81: `pendingArgs = args`), so the old content with spaces would be what fires. But `updateBlockContent` in remove_spaces writes the spaceless version immediately. Then the debounce fires with old content. **This is a latent bug.**

**Post-refactor**: remove_spaces should cancel the debounce and write directly, or the composing model eliminates this class of bug by not having a background debounce.

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

`useEditingActions.ts:149`: `document.execCommand('insertText', false, '  ')` — this goes through the DOM → input event → `updateContentFromDom()` → debounce → Y.Doc. It does NOT bypass the debounce. **Compatible with composing→committed** since it's just another DOM mutation.

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

**The risks**: merge atomicity (3 transactions), remove_spaces race, reconnect-authority data loss during composing, and undo granularity changes need explicit handling.

**The deletable code**: The content sync effect (BlockItem.tsx:599-675) shrinks but doesn't disappear — undo/redo/remote still need DOM sync. The debouncer infrastructure (`createDebouncedUpdater`, `debouncedUpdateContent`, `flushContentUpdate`, `cancelContentUpdate`) gets replaced with a commit function.

**lens:: readiness**: The composing→committed boundary helps lens reads but complicates lens writes. Block-level granularity is correct for the current Y.Map-string storage model.
