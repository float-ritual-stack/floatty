# Yjs Decoupling Audit: contentEditable ↔ Y.Doc Impedance Gap

**Date**: 2026-03-09
**Status**: Current-state audit for Composing → Committed migration
**Context**: Block Lifecycle Future State (BBS: techcraft/2026-03-09)

---

## Executive Summary

The current architecture syncs contentEditable ↔ Y.Doc on a 150ms debounce during active editing. This creates a three-layer feedback loop: DOM input → debounced Y.Doc write → observer fires → signal updates → content sync effect → DOM update (with cursor save/restore). The entire cursorUtils.ts module (320 lines) exists solely to survive this round-trip. The proposed Composing → Committed model eliminates the round-trip entirely — editing is local, persistence is a discrete commit.

**What we can delete**: ~500 lines of sync spaghetti across 3 files.
**What we keep**: cursorUtils.ts (still needed for split offset calculation), inlineParser.ts, EventBus/hooks.
**What we move**: Metadata extraction from per-keystroke observer to commit boundary middleware.

---

## 1. Current State: Where Yjs Binds to contentEditable

### The Hot Path (every keystroke)

```
User types character
    ↓
BlockItem.tsx:738 — onInput fires
    ↓
BlockItem.tsx:701 — updateContentFromDom()
    ├── contentRef.innerText → local string (immediate)
    ├── setDisplayContent(content)  ← overlay update (immediate)
    ├── setHasLocalChanges(true)    ← dirty flag
    └── debouncedUpdateContent(id, content)  ← 150ms timer
    ↓
[150ms later, or on blur/Enter/paste]
    ↓
useBlockStore.ts:626 — updateBlockContent()
    └── _doc.transact(() => {
          setValueOnYMap(blocksMap, id, 'content', content);
          setValueOnYMap(blocksMap, id, 'type', parseBlockType(content));
          setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
        }, 'user');
    ↓
useBlockStore.ts:470 — _blocksObserver fires (observeDeep)
    ├── blockEventBus.emit(envelope)              [SYNC: hooks run]
    ├── blockProjectionScheduler.enqueue(envelope) [ASYNC: search index]
    └── SolidJS store signals update
    ↓
BlockItem.tsx:563 — content sync effect runs
    ├── if (hasLocalChanges && !isAuthoritative) return;  ← race guard
    ├── if (!isFocused || !isUserOrigin) {
    │     setDisplayContent(storeContent);
    │     contentRef.innerText = storeContent;
    │     if (wasFocused) setCursorAtOffset(contentRef, savedOffset);
    │   }
    ↓
useSyncedYDoc.ts:537 — Y.Doc 'update' event fires
    └── queueUpdateModule(update)  ← 50ms sync debounce → POST /api/v1/update
```

### Files Involved in the Hot Path

| File | Lines | Role | Deletable? |
|------|-------|------|-----------|
| `src/components/BlockItem.tsx` | 560-639 | Content sync effect (Y.Doc → DOM) | **YES** — entire effect |
| `src/components/BlockItem.tsx` | 67-106 | `createDebouncedUpdater` | **YES** — no mid-edit debounce needed |
| `src/components/BlockItem.tsx` | 701-736 | `updateContentFromDom` | **SIMPLIFY** — remove Y.Doc write, keep displayContent |
| `src/components/BlockItem.tsx` | 642-662 | `handleBlur` | **REPLACE** — becomes commit trigger |
| `src/lib/cursorUtils.ts` | 1-320 | DOM walk offset ↔ character index | **KEEP** — still needed for splitBlock offset |
| `src/hooks/useBlockStore.ts` | 626-635 | `updateBlockContent` | **KEEP** — called at commit, not per-keystroke |
| `src/hooks/useBlockStore.ts` | 470-608 | `_blocksObserver` → EventBus | **KEEP** — still fires on commit |
| `src/hooks/useSyncedYDoc.ts` | 537-546 | `moduleUpdateHandler` | **KEEP** — syncs commits to server |

### The Sync Spaghetti (content sync effect, BlockItem.tsx:560-639)

This is the most complex single effect in the codebase. It exists because Y.Doc updates during editing must be reflected back to the DOM without destroying the cursor. Line-by-line:

```typescript
createEffect(() => {                              // L563: Runs on ANY store change
  const currentBlock = block();                    // L564: Read block from store
  const origin = store.lastUpdateOrigin;           // L567: Global origin signal

  // L573-575: Authoritative bypass (reconnect, undo)
  const isAuthoritative = origin === 'reconnect-authority' || isUndoManager(origin);

  // L585-591: Race condition guard — skip if local edit pending
  if (hasLocalChanges()) {
    if (!isAuthoritative) return;
    cancelContentUpdate();          // Kill pending debounce
    setHasLocalChanges(false);      // Clear dirty flag
  }

  // L605: The gate — skip if focused + user origin (echo prevention)
  const shouldSync = !isFocusedNow || !isUserOrigin;

  // L618-636: THE IMPEDANCE GAP
  if (shouldSync && domContent !== storeContent) {
    const savedOffset = isFocusedNow ? getAbsoluteCursorOffset(contentRef) : -1;  // SAVE
    contentRef.innerText = storeContent;                                           // NUKE DOM
    if (savedOffset >= 0) setCursorAtOffset(contentRef, clampedOffset);            // RESTORE
  }
});
```

**Why this effect is necessary today**: Every 150ms, a Y.Doc transaction fires, observer runs, store updates, and this effect re-evaluates. Without it, remote updates, undo, and reconnect wouldn't reach the DOM. The focus gate + dirty flag + origin check are all protecting against the fact that local edits and Y.Doc writes coexist during the same editing session.

**Why this effect dies in the new model**: During Composing, Y.Doc is not written to. No observer fires. No store update triggers this effect. The effect only needs to run on phase transition: Committed → Composing (load content into DOM) and on external updates to non-focused blocks (which is just `contentRef.innerText = storeContent` without cursor save/restore).

---

## 2. The Impedance Gap: Cursor Mapping

### cursorUtils.ts — The DOM ↔ String Translation Layer

The entire module exists because contentEditable represents text as a tree of nodes (`<br>`, `<div>`, text nodes) while Y.Doc stores flat strings with `\n`. Two functions must agree perfectly:

**`getAbsoluteCursorOffset(element)`** (L73-121): Walks DOM tree counting text + structural newlines. Resolves element-node positions (child index, not char offset). Special-cases `(root, childCount)` for end-of-content.

**`setCursorAtOffset(element, offset)`** (L211-289): Reverse walk — given a character offset, find the DOM node + local offset. Handles `<br>` vs `<div>` boundaries. Clamps to prevent IndexSizeError.

**These functions are called from**:
1. `BlockItem.tsx:621` — save cursor before DOM nuke during sync
2. `BlockItem.tsx:635` — restore cursor after DOM nuke during sync
3. `useBlockInput.ts` — various keyboard operations (split offset calculation)
4. `useCursor.ts:58,64` — thin wrapper exposing `getOffset()` / `setOffset()`

**In the new model**: Cases 1-2 disappear (no mid-edit sync). Case 3 stays (splitBlock needs cursor offset). Case 4 simplifies (only used for split, not for sync restoration).

### What Gets Deleted

The **cursor save/restore during sync** pattern (BlockItem.tsx:618-636) is the primary consumer. This is ~20 lines, but the entire content sync effect (~80 lines) exists to support it. Additionally:

- `hasLocalChanges` signal and all its guards (~15 lines)
- `cancelContentUpdate` in authoritative path (~5 lines)
- The `lastUpdateOrigin` dependency and origin-based gating (~20 lines)
- The `shouldSync` gate logic (~10 lines)

### What Stays

- `getAbsoluteCursorOffset` — needed by `splitBlock()` to know where Enter was pressed
- `setCursorAtOffset` — needed to place cursor in new block after split
- `isCursorAtContentStart/End` — needed for navigation decisions (merge, exit block)
- `getContentLength` — needed for boundary detection

---

## 3. The "Karen" Extraction: Metadata at Commit Time

### Current State: Metadata Fires Per-Keystroke (via 150ms debounce)

```
User types → 150ms → Y.Doc write → observer → EventBus.emit()
                                                     ↓
                                    ctxRouterHook (priority 50, sync)
                                    outlinksHook (priority 50, sync)
                                                     ↓
                                    parseAllInlineTokens(content)
                                    extract markers / wikilinks
                                    blockStore.updateBlockMetadata()
                                                     ↓
                                    ProjectionScheduler.enqueue()
                                    (2s batch → search index)
```

**Problem**: Hooks run synchronously on the EventBus during observer processing. Every debounced keystroke triggers full inline parsing. For a block with `ctx::2026-03-08 [project::floatty] [[some page]]`, this means:
- `parseAllInlineTokens()` runs (regex + bracket counting)
- Two hooks extract independently (each calls the parser)
- Two `updateBlockMetadata()` calls (each a Y.Doc transaction)
- Each metadata write fires the observer again (filtered by origin='hook')

### Proposed: Karen as Commit Middleware

In the Composing → Committed model, metadata extraction runs exactly **once per commit**, not per keystroke.

```
User leaves block (blur / Enter / pause)
    ↓
BlockController.commit(blockId, domContent)
    ↓
Karen.process(blockId, previousContent, nextContent)
    ├── parseAllInlineTokens(nextContent)           [ONE parse]
    ├── extractMarkers(tokens) → markers[]
    ├── extractOutlinks(tokens) → outlinks[]
    ├── diffMetadata(previous, next)                [skip if unchanged]
    └── return { content, metadata, changed }
    ↓
Y.Doc.transact(() => {
    setContent(blockId, nextContent);
    if (metadata.changed) setMetadata(blockId, metadata);
}, 'user');
    ↓
EventBus: blockCommitted { blockId, previous, next }
    ↓
ProjectionScheduler: search index, backlinks (async)
```

### Files to Centralize

| Current Location | Current Trigger | New Location | New Trigger |
|-----------------|----------------|--------------|-------------|
| `ctxRouterHook.ts` | EventBus subscriber (sync, per keystroke) | `Karen.extractMarkers()` | Commit middleware (once) |
| `outlinksHook.ts` | EventBus subscriber (sync, per keystroke) | `Karen.extractOutlinks()` | Commit middleware (once) |
| `inlineParser.ts` | Called by both hooks + BlockDisplay | `Karen.parse()` + `BlockDisplay` | Commit + display (separate) |
| `eventBus.ts` subscribers | `blockEventBus.subscribe()` in `registerHandlers()` | `BlockController.commit()` | Single call site |

### The Karen Interface (Skeleton)

```typescript
// src/lib/commitMiddleware.ts

import { parseAllInlineTokens, hasCtxPatterns, hasWikilinkPatterns } from './inlineParser';
import type { BlockMetadata, Marker, InlineToken } from './blockTypes';

export interface CommitInput {
  blockId: string;
  previousContent: string;
  nextContent: string;
  previousMetadata: BlockMetadata;
}

export interface CommitOutput {
  content: string;
  metadata: BlockMetadata;
  metadataChanged: boolean;
  tokens: InlineToken[];  // Cache for display layer
}

/**
 * Karen: synchronous commit middleware.
 * Runs once at the Composing → Committed boundary.
 * Deterministic, pure, no side effects.
 */
export function processCommit(input: CommitInput): CommitOutput {
  const { nextContent, previousMetadata } = input;

  // Single parse pass (shared by marker + outlink extraction)
  const tokens = parseAllInlineTokens(nextContent);

  // Extract markers (ctx::, [project::], [mode::], etc.)
  const markers = hasCtxPatterns(nextContent)
    ? extractMarkers(tokens)
    : [];

  // Extract outlinks ([[wikilinks]])
  const outlinks = hasWikilinkPatterns(nextContent)
    ? extractOutlinks(tokens)
    : [];

  const metadata: BlockMetadata = {
    ...previousMetadata,
    markers,
    outlinks,
    extractedAt: Date.now(),
  };

  const metadataChanged = !markersEqual(previousMetadata.markers, markers)
    || !outlinksEqual(previousMetadata.outlinks, outlinks);

  return { content: nextContent, metadata, metadataChanged, tokens };
}

function extractMarkers(tokens: InlineToken[]): Marker[] {
  // Lifted from ctxRouterHook.ts:31-64
  return tokens
    .filter(t => t.type === 'ctx-prefix' || t.type === 'ctx-timestamp' || t.type === 'ctx-tag')
    .map(toMarker);
}

function extractOutlinks(tokens: InlineToken[]): string[] {
  // Lifted from outlinksHook.ts:29-42
  return [...new Set(
    tokens.filter(t => t.type === 'wikilink').map(t => t.content)
  )];
}
```

### Display Layer: Already Decoupled

`BlockDisplay.tsx:120` already uses `createMemo(() => parseAllInlineTokens(props.content))` for the overlay. This reads from `displayContent` signal, not from Y.Doc. In the new model, `displayContent` is updated immediately on input (same as today), so the display layer needs zero changes.

---

## 4. Proposed Delta: 5 Refactoring Steps

### Step 1: Introduce BlockController (the commit boundary)

**New file**: `src/lib/blockController.ts`

```typescript
export interface BlockController {
  /** Enter composing phase — load committed content into DOM */
  beginComposing(blockId: string): string;

  /** Commit composing content to Y.Doc (blur, Enter, pause) */
  commit(blockId: string, domContent: string): CommitResult;

  /** Check if a block is currently being composed */
  isComposing(blockId: string): boolean;

  /** Cancel composing — revert DOM to committed state */
  cancelComposing(blockId: string): void;
}
```

This is a thin orchestrator. `commit()` calls Karen's `processCommit()`, then writes to Y.Doc in a single transaction. No debounce — commit is synchronous and immediate.

**Impact**: New file, ~80 lines. No existing code changes yet.

### Step 2: Remove the 150ms debounce from BlockItem input

**File**: `src/components/BlockItem.tsx`

**Change**: `updateContentFromDom()` no longer calls `debouncedUpdateContent()`. It only updates `displayContent` signal (for the overlay) and sets a local dirty flag. Y.Doc is NOT written.

```typescript
// BEFORE (current)
const updateContentFromDom = () => {
  const content = contentRef.innerText;
  setHasLocalChanges(true);
  setDisplayContent(content);
  debouncedUpdateContent(props.id, content);  // ← DELETE THIS
};

// AFTER (new)
const updateContentFromDom = () => {
  const content = contentRef.innerText;
  setComposingContent(content);       // Local-only
  setDisplayContent(content);         // Overlay update (immediate)
};
```

**Impact**: Delete `createDebouncedUpdater` call (~5 lines), `flushContentUpdate` references become `controller.commit()`.

### Step 3: Replace blur handler with commit trigger

**File**: `src/components/BlockItem.tsx`

**Change**: `handleBlur` becomes the commit boundary.

```typescript
// BEFORE
const handleBlur = () => {
  flushContentUpdate();                    // Force Y.Doc write
  if (contentRef.innerText !== block.content) {
    contentRef.innerText = block.content;  // Sync DOM to store
  }
};

// AFTER
const handleBlur = () => {
  const composing = composingContent();
  if (composing !== null && composing !== block().content) {
    controller.commit(props.id, composing);  // Single Y.Doc write
  }
  setComposingContent(null);                 // Exit composing phase
};
```

**Impact**: Simpler blur handler (~15 lines → ~8 lines). No race conditions — commit is synchronous.

### Step 4: Gut the content sync effect

**File**: `src/components/BlockItem.tsx`

**Change**: The 80-line content sync effect (L560-639) reduces to ~15 lines. No cursor save/restore. No dirty flag. No origin gating.

```typescript
// AFTER: Simple committed content sync for non-composing blocks
createEffect(() => {
  const currentBlock = block();
  if (!contentRef || !currentBlock) return;

  // If this block is being composed locally, don't touch DOM
  if (composingContent() !== null) return;

  // Sync committed content to DOM (remote updates, undo, reconnect)
  if (contentRef.innerText !== currentBlock.content) {
    contentRef.innerText = currentBlock.content;
  }
  if (displayContent() !== currentBlock.content) {
    setDisplayContent(currentBlock.content);
  }
});
```

No cursor save/restore needed — if we're not composing, the block isn't focused (or if it is, it's about to enter composing via focus handler).

**Impact**: Delete ~65 lines. Delete `hasLocalChanges` signal. Delete `cancelContentUpdate`. Delete `isAuthoritative` logic.

### Step 5: Move hooks to commit middleware

**Files**: `ctxRouterHook.ts`, `outlinksHook.ts`, `handlers/index.ts`

**Change**: Instead of subscribing to EventBus and running on every Y.Doc observer fire, metadata extraction runs inside `BlockController.commit()` via Karen.

```typescript
// BlockController.commit()
commit(blockId: string, domContent: string): CommitResult {
  const block = store.getBlock(blockId);

  // Karen: synchronous metadata extraction (ONE parse pass)
  const result = processCommit({
    blockId,
    previousContent: block.content,
    nextContent: domContent,
    previousMetadata: block.metadata ?? {},
  });

  // Single Y.Doc transaction: content + metadata
  doc.transact(() => {
    store.setContent(blockId, result.content);
    if (result.metadataChanged) {
      store.setMetadata(blockId, result.metadata);
    }
  }, 'user');

  return result;
}
```

**Impact**: `ctxRouterHook.ts` and `outlinksHook.ts` can be simplified to pure functions (no EventBus subscription, no origin filtering, no equality-check guards). The EventBus subscription code (~40 lines per hook) becomes dead code.

**Caveat**: Remote/agent writes still need metadata extraction. Keep the EventBus path for `origin !== 'user'` writes, or add Karen processing to the server-side update handler. This is a follow-up concern, not blocking.

---

## 5. Migration Risk Assessment

### What Breaks During Migration

| Concern | Risk | Mitigation |
|---------|------|-----------|
| Undo/redo across composing boundary | Medium | Test: Cmd+Z while composing (DOM undo), then Cmd+Z after commit (Y.Doc undo). Boundary must hand off cleanly. |
| Remote updates to composing block | Low | If remote updates content of block being edited, current model overwrites. New model: composing wins, merge on commit. |
| Paste with flush | Low | `handlePaste` currently calls `flushContentUpdate()` before structured paste. New: call `controller.commit()` first. |
| Split block offset | Low | `splitBlock()` uses cursor offset from cursorUtils — still works, offset calculation doesn't depend on Y.Doc. |
| Multi-pane echo | Low | Currently prevented by origin + focus gate. New model: composing is local, no observer fires, no echo possible. |
| Keyboard flush points | Medium | 5 places in `useBlockInput.ts` call `flushContentUpdate()` before structural operations. Each becomes `controller.commit()`. |

### What Gets Simpler

- **No race conditions**: Composing is local. No debounce timer racing with blur. No dirty flag. No origin gating.
- **No cursor restoration**: DOM is never nuked during editing. Cursor lives in native contentEditable.
- **Browser undo works**: No Y.Doc transactions during composing means browser undo stack is clean.
- **Hooks run once**: Metadata parsed once at commit, not once per debounced keystroke.
- **Content sync effect**: 80 lines → 15 lines. No special cases.

### What's Not Covered Here

- **Pause timeout**: The future state mentions a pause timer that auto-commits. This is straightforward (setTimeout on last input, clear on new input, fire commit on timeout). Not architecturally complex.
- **Armed/Executed states**: Executable blocks (`sh::`, `ai::`) have additional lifecycle phases. The commit boundary is the same; the execution trigger is a separate concern.
- **Server-side Karen**: When agents write via REST API, metadata extraction should happen server-side. Currently hooks handle this via the observer on `origin='remote'`. Migration path: add Karen to the Rust server's update handler.
- **Filter-as-selector**: The Future State doc describes filters as selectors over committed state. This audit covers the editing side; filter architecture is a separate workstream.

---

## Appendix: File-Level Impact Summary

| File | Lines Today | Change | Lines After |
|------|-------------|--------|-------------|
| `BlockItem.tsx` | ~740 | Gut sync effect, remove debounce, simplify blur | ~650 |
| `cursorUtils.ts` | 320 | No change (still needed for split) | 320 |
| `useCursor.ts` | 96 | No change | 96 |
| `useBlockStore.ts` | ~700 | No change (commit calls same methods) | ~700 |
| `useBlockInput.ts` | ~700 | Replace `flushContentUpdate` → `controller.commit` | ~700 |
| `ctxRouterHook.ts` | 166 | Extract pure function, delete EventBus subscription | ~60 |
| `outlinksHook.ts` | 141 | Extract pure function, delete EventBus subscription | ~50 |
| `useSyncedYDoc.ts` | ~700 | No change (syncs commits, not keystrokes) | ~700 |
| **NEW: blockController.ts** | 0 | New file | ~80 |
| **NEW: commitMiddleware.ts** | 0 | New file (Karen) | ~100 |

**Net delta**: ~-170 lines deleted, ~+180 lines added. Roughly neutral in LOC, but the new code is straightforward orchestration vs. the deleted code which was defensive race-condition handling.

---

## 6. Follow-Up: Integration Edge Cases

The 5 refactoring steps above describe the straight-line keystroke→commit→sync path. This section enumerates the corners: flush points, multi-pane composing, authoritative overrides, agent writes, and test blast radius.

### 6.1 Flush Point Inventory

Every call to `flushContentUpdate()` in the codebase. In the new model, each becomes either `controller.commit()` or is eliminated.

| # | File | Line | Structural Operation | Why It Flushes First | Migration Note |
|---|------|------|---------------------|---------------------|----------------|
| 1 | `useBlockInput.ts` | 496 | `execute_block` — runs handler (sh::, ai::, etc.) | Handler reads `block.content` from store; stale debounce = stale content | `controller.commit()` — handler needs committed content |
| 2 | `useBlockInput.ts` | 553 | `split_block` — splits at cursor offset | `splitBlock(id, offset)` reads Y.Doc content to slice; offset is relative to stored content | `controller.commit()` — split offset is meaningless against uncommitted content |
| 3 | `useBlockInput.ts` | 562 | `split_to_child` — splits content, second half becomes first child | Same as split_block; reads content + offset | `controller.commit()` — same reasoning |
| 4 | `useBlockInput.ts` | 619 | `merge_with_previous` — Backspace at start merges two blocks | Reads `block.content` and `prevBlock.content` to concatenate; reads `prevBlock.content.length` for cursor positioning | `controller.commit()` — merge reads both blocks' committed content |
| 5 | `BlockItem.tsx` | 648 | `handleBlur` — focus leaves block | Ensures pending keystrokes reach Y.Doc before focus transitions; downstream code may read store immediately | **Eliminated** — composing state auto-commits on blur via `blockController.commit()` in blur handler |
| 6 | `BlockItem.tsx` | 673 | `handlePaste` — structured paste (FLO-128) | `handleStructuredPaste` reads `store.blocks[id]` to check if block is empty; stale = wrong code path | `controller.commit()` — paste handler needs committed content to decide empty-block vs append behavior |
| 7 | `BlockItem.tsx` | 202 | `onCleanup` — component unmount | Prevents data loss when block unmounts with pending debounce | **Eliminated** — `blockController.commit()` in cleanup. If composingContent is null, no-op. |
| 8 | `Outliner.tsx` | 533, 545 | Export keybinds (Cmd+Shift+M/J/B) | Triggers `activeEl.blur()` which cascades to `handleBlur` → flush | **Indirect** — blur handler calls `controller.commit()`. No separate flush needed. |

**Ordering dependencies**:
- Flush points 1–4 share a pattern: flush → read store → mutate tree. In the new model: commit → read store → mutate tree. The ordering is identical; only the mechanism changes.
- Flush point 4 (merge) has an additional dependency: `prevBlock.content.length` is captured as cursor offset AFTER flush. In the new model, commit writes composing content to Y.Doc, then the store is current. Same ordering, same result.

**Not a flush point but related**: `remove_spaces` (useBlockInput.ts:609) calls `store.updateBlockContent()` directly (no debounce, no flush). In the new model this is a direct commit — the controller handles it since the block is focused and composing.

### 6.2 Composing Scope: Per-Block Per-Pane

**Question**: Is composing state per-block, per-pane, or global?

**Answer**: Per-block per-pane. Here's why:

1. **Focus is per-pane**: `focusedBlockId` is a `Record<string, string | null>` keyed by paneId (usePaneStore.ts:38). Each pane tracks its own focused block independently.

2. **BlockItem instances are per-pane**: Each pane renders its own `<BlockItem>` tree. If block "abc" is visible in Pane A and Pane B, there are TWO BlockItem instances, each with its own `contentRef`, `isFocused` memo, and `hasLocalChanges` signal.

3. **Composing state lives in BlockItem**: The debounced updater, `hasLocalChanges` signal, and `contentRef` are all instance-scoped (BlockItem.tsx:174, 194). In the new model, `blockController` replaces these — and it's created per-BlockItem instance, so it's automatically per-block per-pane.

**Multi-pane scenario**: Block "abc" open in Pane A (composing) and Pane B (committed view).
- Pane A user types → `composingContent` holds uncommitted text in Pane A's controller
- Pane B sees committed content from Y.Doc (no composingContent — its controller is idle)
- Pane A commits → Y.Doc transaction → observer fires → Pane B's content sync effect runs → Pane B DOM updates
- This is exactly how it works today with the debounce model. The 15-line replacement effect handles Pane B correctly because Pane B is never focused+user-origin — it always passes the `shouldSync` gate.

**Edge case**: Same block focused in BOTH panes simultaneously (user clicks between panes rapidly).
- Today: both panes race debounced updates. Last writer wins (Y.Doc field-level last-write-wins).
- New model: same behavior. Each pane's controller commits independently. Y.Doc's CRDT semantics resolve.
- **No new risk** — the race already exists. The composing model doesn't make it worse.

### 6.3 Reconnect + Undo During Composing

The current 80-line content sync effect has two "authoritative" paths that bypass normal gating (BlockItem.tsx:573–575):

```typescript
const isAuthoritative =
  origin === 'reconnect-authority' ||
  (origin && typeof origin === 'object' && 'undo' in origin);
```

When `isAuthoritative` is true AND `hasLocalChanges()` is true, the effect cancels the debounce, clears the dirty flag, and forces DOM sync (BlockItem.tsx:586–590).

#### 6.3a Reconnect during composing

**What happens today**: WebSocket reconnects → `performBidirectionalResync()` (useSyncedYDoc.ts:402) → `Y.applyUpdate(sharedDoc, serverState, 'reconnect-authority')` → observer fires → content sync effect detects `isAuthoritative` → cancels pending debounce → overwrites DOM with server content → cursor restored via save/restore.

**What should happen in the new model**: **Force-commit composing content, then apply authoritative update.**

Rationale:
- **Discard composing** loses user keystrokes since last commit. Reconnect is common (laptop sleep, network blip). Losing 2 seconds of typing on every reconnect is unacceptable.
- **Queue authoritative** creates split-brain: composing content diverges from Y.Doc, and the user sees stale state until commit. Defeats the purpose of reconnect.
- **Force-commit first** writes composing content to Y.Doc BEFORE the server state arrives. CRDT merge resolves any conflicts. User's keystrokes survive. Server state also survives. This is what CRDTs are for.

**Implementation**: `blockController.forceCommit()` → then Y.Doc applies reconnect state. The commit must be synchronous (within the same microtask as the reconnect apply) to ensure the CRDT merge sees both states.

**Risk**: If the server state contains a different version of the same block's content, CRDT last-write-wins applies at the field level. The user's commit timestamp is newer (they just typed it), so their content wins. This is correct — the server state is from before the reconnect gap.

#### 6.3b Undo during composing

**What happens today**: User presses Cmd+Z → `sharedUndoManager.undo()` → Y.Doc reverses the last tracked transaction → observer fires with UndoManager instance as origin → content sync effect detects `isAuthoritative` → cancels pending debounce → overwrites DOM with undo result → cursor restored.

**What should happen in the new model**: **Discard composing content, apply undo.**

Rationale:
- **Force-commit first** would commit the current text, then undo it immediately. The undo stack now has the committed version on top, which is what the user just typed. Cmd+Z twice to undo the pre-commit state. This is confusing — undo should undo, not "save then undo the save."
- **Queue undo** makes no sense — user expects immediate response.
- **Discard composing** is correct: the user pressed Cmd+Z while typing. They want to undo. Discarding uncommitted keystrokes and reverting to the Y.Doc undo target is the right behavior. The composing content was never committed, so nothing is lost from the CRDT perspective.

**Implementation**: `blockController.discard()` → clear composingContent signal → let Y.Doc undo apply → content sync effect shows undo result. The discard must happen BEFORE the undo's observer fires, or the sync effect won't trigger (composingContent still blocks it).

**Practical concern**: UndoManager tracked origins are `[null, undefined, 'user', 'user-drag']` (useSyncedYDoc.ts:1625). The composing model's commit uses `'user'` origin, so commits ARE tracked. Each commit is one undo step. Undo during composing = discard uncommitted + revert last commit. Two keystrokes (Cmd+Z, Cmd+Z) to get to pre-last-commit state. This matches user expectation.

#### Summary

| Authoritative event | During composing | Action | Why |
|---------------------|-----------------|--------|-----|
| Reconnect (`'reconnect-authority'`) | `composingContent !== null` | Force-commit, then apply server state | Preserve user keystrokes; CRDT merge handles conflicts |
| Undo (UndoManager instance) | `composingContent !== null` | Discard composing, apply undo | User intent is "undo," not "save then undo" |

### 6.4 Agent Write Path

**Question**: Can `processCommit()` from commitMiddleware.ts be called for ALL write sources, eliminating ctxRouterHook/outlinksHook EventBus subscriptions?

**Current origin-gated EventBus emission** (useBlockStore.ts:590–602):

```typescript
if (blockEvents.length > 0 &&
    origin !== Origin.Remote &&           // Skip: metadata already extracted on remote client
    origin !== Origin.ReconnectAuthority && // Skip: same reason
    origin !== Origin.BulkImport) {         // Skip: handled by async ProjectionScheduler
  blockEventBus.emit(envelope);  // Sync lane: hooks run here
}
```

Origins that DO emit to EventBus: `'user'`, `'executor'`, `'user-drag'`, `'hook'`, `null/undefined`.
Origins that DON'T: `'remote'`, `'reconnect-authority'`, `'bulk_import'`.

**Can processCommit() replace EventBus for all origins?**

**No — but it can replace it for the `'user'` origin, which is the only one that matters for the composing model.** Here's why:

1. **`'user'` origin** (keyboard input, paste): This is the composing→commit path. `processCommit()` handles metadata extraction at commit time. **Replaces EventBus for this origin.**

2. **`'executor'` origin** (handler output, e.g., `ai::` writes back): The executor calls `updateBlockContent(id, content)` or `updateBlockContentFromExecutor(id, content)`. This goes directly to Y.Doc — no composing phase, no blockController. The EventBus STILL needs to fire for this origin so hooks extract metadata from handler-written content.

3. **`'hook'` origin** (metadata writes by hooks themselves): Hooks filter this out (`if origin === 'hook' return`). No change needed.

4. **`'user-drag'` origin**: Block moves. Hooks may need to re-extract if parentage changes outlinks. EventBus still needed.

**Conclusion**: The EventBus survives for non-user origins. `processCommit()` handles the user-typing path only. The ctxRouterHook and outlinksHook EventBus subscriptions cannot be fully deleted — they still serve `'executor'` and `'user-drag'` origins.

**Revised architecture**:

```
User typing → composing → commit → processCommit() → metadata extraction
                                                     (replaces hook for 'user' origin)

Executor/Agent → updateBlockContent() → Y.Doc → observer → EventBus → hooks
                                                           (unchanged)
```

**Migration note**: The audit's appendix claims ctxRouterHook.ts goes from 166→~60 lines and outlinksHook.ts from 141→~50 lines ("extract pure function, delete EventBus subscription"). This is WRONG — the EventBus subscription must remain for non-user origins. The pure extraction functions can still be shared between `processCommit()` and the hooks, but the hooks themselves survive as EventBus subscribers. Revised line counts: ctxRouterHook.ts ~166→~120, outlinksHook.ts ~141→~100 (extract shared pure functions, keep subscriptions).

### 6.5 Test Blast Radius

Grep results across all test files for affected code paths.

#### Test files examined

| File | Tests | Focus |
|------|-------|-------|
| `useBlockInput.test.ts` | 35 | `determineKeyAction()` pure function |
| `BlockItem.test.tsx` | 3 | Context injection, click handling, collapse arrow |
| `cursorUtils.test.ts` | 29 | DOM offset calculation, boundary detection |
| `pasteHandler.test.ts` | 12 | `handleStructuredPaste()` with mocked store actions |
| `useBlockStore.batch.test.ts` | 8 | Batch transaction API |
| `ctxRouterHook.test.ts` | 7 | EventBus → metadata extraction |
| `outlinksHook.test.ts` | 7 | EventBus → wikilink extraction |
| `executor.test.ts` | ~5 | Handler execution with mocked `updateBlockContent` |
| `funcRegistry.test.ts` | ~6 | Handler registry with mocked `updateBlockContent` |

#### Categorization

**[PASSES] — 93 tests unaffected**:

- `useBlockInput.test.ts` (35 tests): Tests `determineKeyAction()`, a pure function that returns action objects. Doesn't touch debounce, flush, or sync. **Zero changes needed.**
- `cursorUtils.test.ts` (29 tests): Tests DOM offset math. Audit confirms cursorUtils.ts is unchanged. **Zero changes needed.**
- `pasteHandler.test.ts` (12 tests): Tests `handleStructuredPaste()` with mocked `updateBlockContent`. The mock stays the same — paste handler calls store methods directly, not the debounced path. **Zero changes needed.**
- `useBlockStore.batch.test.ts` (8 tests): Tests batch Y.Doc transactions. No debounce or flush involvement. **Zero changes needed.**
- `executor.test.ts` (~5 tests): Mocks `updateBlockContent` directly. **Zero changes needed.**
- `funcRegistry.test.ts` (~4 tests): Mocks `updateBlockContent` directly. **Zero changes needed.**

**[ADAPTS] — 10 tests need setup/assertion changes**:

- `BlockItem.test.tsx` (3 tests): Tests render with mock stores. Currently creates `createMockBlockStore()` — needs to also provide a mock `blockController` or equivalent. Test assertions on click/collapse behavior are unchanged; only the provider setup changes.
- `ctxRouterHook.test.ts` (7 tests): Tests EventBus → metadata extraction. The EventBus subscription remains (per 6.4), but the pure extraction function is shared with `processCommit()`. Tests need to verify the pure function works correctly when called from BOTH paths (EventBus and commit middleware). New tests needed for `processCommit()` calling the pure function.

**[BREAKS] — 7 tests test deleted code paths**:

- `outlinksHook.test.ts` (7 tests): Tests EventBus → outlinks extraction. Same situation as ctxRouterHook — EventBus subscription remains, but the tests currently exercise the full EventBus→hook→metadata pipeline. If the pure function is extracted, tests should be restructured to test:
  1. Pure extraction function (unit test, new)
  2. EventBus subscription routing (integration test, adapted from existing)
  3. `processCommit()` calling extraction (new)

Wait — re-examining: the EventBus subscription in outlinksHook survives per 6.4. These tests exercise that subscription. They don't test deleted code. **Revised: [ADAPTS], not [BREAKS].**

**Revised counts**:

| Category | Count | Notes |
|----------|-------|-------|
| PASSES | 93 | Pure functions, store operations, cursor math |
| ADAPTS | 17 | BlockItem setup (3), ctxRouterHook (7), outlinksHook (7) — setup changes, shared pure function extraction |
| BREAKS | 0 | No tests directly exercise the deleted content sync effect or debounce machinery |

**Gap**: There are NO tests for:
- The 80-line content sync effect (BlockItem.tsx:563–639)
- The `createDebouncedUpdater` function
- The `handleBlur` DOM sync
- The `hasLocalChanges` dirty flag gating
- The authoritative origin bypass

This is actually good news for migration — the most complex deleted code has zero test coverage. No tests break. But it also means the NEW code (blockController, commitMiddleware, simplified sync effect) needs tests written from scratch to cover what was previously untested.
