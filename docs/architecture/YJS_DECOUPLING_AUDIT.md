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
