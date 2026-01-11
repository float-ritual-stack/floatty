# Floatty Architecture Snapshot
**Generated**: 2026-01-09
**Purpose**: Pattern analysis for Desktop Daddy comparison with pi-mono and vibe-kanban

---

## 1. Block Store Architecture

### Current Y.Doc Structure

**File**: `src/hooks/useSyncedYDoc.ts` (lines 113-116)

```typescript
// Singleton Y.Doc pattern
const sharedDoc = new Y.Doc();
let sharedDocLoaded = false;
let sharedDocError: string | null = null;

export function getSharedDoc(): Y.Doc {
  return sharedDoc;
}
```

**File**: `src/hooks/useBlockStore.ts` (lines 196-197)

The Y.Doc contains two top-level structures:

```typescript
const blocksMap = doc.getMap('blocks');      // All blocks as nested Y.Maps
const rootIdsArr = doc.getArray<string>('rootIds');  // Top-level block order
```

Each block is a **nested Y.Map** (not plain object) enabling granular CRDT updates:

```typescript
// Lines 133-161: blockToYMap() - complete structure
const blockMap = new Y.Map<unknown>();
blockMap.set('id', block.id);
blockMap.set('parentId', block.parentId);
blockMap.set('content', block.content);
blockMap.set('type', block.type);
blockMap.set('metadata', block.metadata);
blockMap.set('collapsed', block.collapsed);
blockMap.set('createdAt', block.createdAt);
blockMap.set('updatedAt', block.updatedAt);
blockMap.set('output', block.output);
blockMap.set('outputType', block.outputType);
blockMap.set('outputStatus', block.outputStatus);

// CRITICAL: childIds as Y.Array for CRDT-safe ordered lists
const childIdsArr = new Y.Array<string>();
if (block.childIds.length > 0) {
  childIdsArr.push(block.childIds);
}
blockMap.set('childIds', childIdsArr);
```

### Mutation Pattern: `setValueOnYMap()`

**File**: `src/hooks/useBlockStore.ts` (lines 65-95)

```typescript
function setValueOnYMap(blocksMap: Y.Map<unknown>, blockId: string, key: string, value: unknown): void {
  const existing = blocksMap.get(blockId);

  if (existing instanceof Y.Map) {
    if (key === 'childIds') {
      // CRDT-safe: mutate existing Y.Array IN PLACE
      const childIdsArr = existing.get('childIds');
      if (childIdsArr instanceof Y.Array) {
        const newChildIds = value as string[];
        childIdsArr.delete(0, childIdsArr.length);  // Clear
        if (newChildIds.length > 0) {
          childIdsArr.push(newChildIds);            // Replace
        }
      }
    } else {
      // Granular field update - only this field changes
      existing.set(key, value);
    }
  }
}
```

**Key**: Only modified fields update; parent block's other properties remain untouched. Minimizes delta size.

### Observer Attachment: Ref-Counted Singleton

**File**: `src/hooks/useSyncedYDoc.ts` (lines 136-246)

**Problem solved**: Multiple Outliner panes calling `useSyncedYDoc()` would attach 3x handlers → 3x duplicate work.

```typescript
// Module-level state
let handlerRefCount = 0;
let moduleUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;

function attachHandler() {
  handlerRefCount++;
  if (handlerRefCount === 1) {  // Only first subscriber attaches
    moduleUpdateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || isApplyingRemoteGlobal) return;  // Filter remote
      queueUpdateModule(update);
    };
    sharedDoc.on('update', moduleUpdateHandler);
  }
}

function detachHandler() {
  handlerRefCount--;
  if (handlerRefCount === 0 && moduleUpdateHandler) {  // Only last detaches
    sharedDoc.off('update', moduleUpdateHandler);
    moduleUpdateHandler = null;
  }
}
```

### Persistence Strategy: 3-Layer

| Layer | Location | Purpose |
|-------|----------|---------|
| **localStorage** | Browser | Crash recovery backup (1s debounce) |
| **SQLite** | `~/.floatty/ctx_markers.db` | Append-only update log (server-side) |
| **HTTP/WebSocket** | floatty-server:8765 | Real-time sync + reconciliation |

**HTTP Client** (`src/lib/httpClient.ts:53-108`):
- `getState()` - Full Y.Doc snapshot
- `getStateVector()` - For delta calculation
- `applyUpdate(update, txId)` - Push delta with echo prevention ID

**WebSocket** (`src/hooks/useSyncedYDoc.ts:385-496`):
- Real-time broadcast from server
- Echo prevention via `txId` matching
- Exponential backoff reconnection

---

## 2. Terminal/Outliner Integration

### PTY Lifecycle: terminalManager Singleton

**File**: `src/lib/terminalManager.ts` (lines 92-96)

```typescript
class TerminalManager {
  private instances = new Map<string, TerminalInstance>();
  private callbacks = new Map<string, TerminalCallbacks>();
  private disposing = new Set<string>();  // Guards race conditions

  async attach(id: string, container: HTMLElement, cwd?: string): Promise<TerminalInstance>
  async dispose(id: string)
  fit(id: string)
  setCallbacks(id: string, callbacks: TerminalCallbacks)
}

export const terminalManager = new TerminalManager();  // Singleton
```

**Why singleton outside SolidJS**: Framework reactivity caused terminals to re-initialize on tab switch. Moving lifecycle outside eliminates this bug class.

### PTY Batching Pattern (4000+ redraws/sec)

**File**: `src-tauri/plugins/tauri-plugin-pty/src/lib.rs` (lines 205-277)

```rust
// BATCHER THREAD: Greedy slurp pattern
thread::spawn(move || {
    let mut pending_data: Vec<u8> = Vec::with_capacity(65536);

    loop {
        // 1. Blocking wait for first chunk (0 CPU when idle)
        let first_chunk = match rx.recv() {
            Ok(d) => d,
            Err(_) => break,
        };
        pending_data.extend_from_slice(&first_chunk);

        // 2. Greedy non-blocking slurp - grab ALL queued
        loop {
            match rx.try_recv() {
                Ok(more_data) => {
                    pending_data.extend_from_slice(&more_data);
                    if pending_data.len() > 65536 { break; }  // Safety cap
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        // 3. Send via IPC Channel (base64 - 60% faster than JSON array)
        if !pending_data.is_empty() {
            let payload = general_purpose::STANDARD.encode(&pending_data);
            on_data.send(payload);
            pending_data.clear();
        }
    }
});
```

**Critical rules**:
- Reader thread blocks on PTY (0 CPU idle)
- Batcher blocks on channel (0 CPU idle)
- Base64 encoding (NOT JSON arrays)
- Tauri Channels (NOT `window.emit()`)
- No sync work in batcher thread

### Terminal-Y.Doc Sync: NONE (Deliberate)

Terminal output flows **only** to xterm display. Block output goes through handler system:

**File**: `src/lib/handlers/sh.ts` (lines 1-95)

```typescript
export const shHandler: BlockHandler = {
  prefixes: ['sh::', 'term::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const rawOutput = await invoke('execute_shell_command', { command });

    // Create NEW Y.Doc blocks with output:: prefix
    const outputId = actions.createBlockInsideAtTop(blockId);
    actions.updateBlockContent(outputId, `output::${message}`);
  }
};
```

### Input Routing: Pure `determineKeyAction()`

**File**: `src/hooks/useBlockInput.ts` (lines 88-216)

```typescript
// Testable pure function - no DOM
export function determineKeyAction(
  key: string,
  shiftKey: boolean,
  action: string | null,
  deps: {
    block: Block | undefined;
    cursorAtStart: boolean;
    cursorAtEnd: boolean;
    cursorOffset: number;
    // ... more context
  }
): KeyboardAction {
  // Returns typed action: split_block, execute_block, zoom_in, etc.
}

// Return types (lines 57-78)
export type KeyboardAction =
  | { type: 'execute_block' }
  | { type: 'split_block'; newId: string | null; offset: number }
  | { type: 'zoom_in' }
  | { type: 'zoom_out' }
  | { type: 'navigate_up'; prevId: string | null }
  // ... 10+ more
```

**Pattern**: Pure logic extraction enables 32 keyboard behavior tests without DOM.

---

## 3. Layout Management

### Split Pane: Binary Tree Structure

**File**: `src/lib/layoutTypes.ts` (lines 1-50)

```typescript
// Leaf node - terminal or outliner pane
export interface PaneLeaf {
  type: 'leaf';
  id: string;
  leafType?: 'terminal' | 'outliner';
  cwd?: string;
  ephemeral?: boolean;  // FLO-136: Preview mode
}

// Split node - two children
export interface PaneSplit {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;  // 0.1-0.9
  children: [LayoutNode, LayoutNode];
}

export type LayoutNode = PaneLeaf | PaneSplit;
```

**Pure manipulation functions** (all immutable):
- `findNode(root, id)` - Locate by ID
- `replaceNode(root, id, replacement)` - Immutable replacement
- `removeNode(root, id)` - Remove + promote sibling
- `findAdjacentPane(root, paneId, direction)` - Navigation

### Resize Operations

**File**: `src/components/ResizeOverlay.tsx` (lines 50-239)

```typescript
const RESIZE_THROTTLE_MS = 50;  // 20 events/sec max

const handlePointerDown = (e: PointerEvent) => {
  isDragging = true;
  layoutStore.setDraggingSplitId(props.splitId);
  terminalManager.setDragging(true);  // Suppress fit() during drag
  document.body.classList.add('resizing');  // Disable terminal pointer events
};

const onWindowPointerMove = (e: PointerEvent) => {
  const rawRatio = (currentPos - offset - parentStart) / parentSize;
  const clampedRatio = Math.max(0.1, Math.min(0.9, rawRatio));
  layoutStore.setRatio(props.tabId, props.splitId, clampedRatio);

  // Throttled resize event dispatch
  if (now - lastResizeDispatch > RESIZE_THROTTLE_MS) {
    window.dispatchEvent(new Event('resize'));  // Triggers terminal fit
  }
};
```

### Terminal Manager: Drag-Aware fit() Suppression

**File**: `src/lib/terminalManager.ts` (lines 560-674)

```typescript
setDragging(dragging: boolean) {
  if (dragging) {
    // Save scroll positions BEFORE drag
    for (const [id, instance] of this.instances) {
      this.savedScrollPositions.set(id, instance.term.buffer.active.viewportY);
    }
    this.isDragging = true;
  } else if (this.isDragging) {
    // Delay restoration for 150ms to let layout settle
    this.restorationTimeout = setTimeout(() => {
      for (const [id, savedY] of this.savedScrollPositions) {
        instance.fitAddon.fit();
        // Double-rAF for xterm sync
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            inst.term.scrollToLine(Math.min(savedY, maxScroll));
          });
        });
      }
      this.isDragging = false;
    }, 150);
  }
}

fit(id: string) {
  if (this.isDragging) return;  // Skip during drag
  // ... fit logic
}
```

### State: Local Only (NOT synced to Y.Doc)

Layout state is **app-local**, not collaborative:
- Stored in SolidJS reactive store (`useLayoutStore`)
- Persisted via SQLite (debounced 500ms)
- Separate from Y.Doc block tree

---

## 4. CRDT Patterns

### Granular Updates via Nested Y.Map

**File**: `src/hooks/useBlockStore.ts` (lines 129-161)

- Each block is a Y.Map (not plain object)
- `childIds` stored as nested Y.Array
- `setValueOnYMap()` updates only the modified field
- Delta updates are minimal (single field, not full block)

### Origin Filtering

**File**: `src/hooks/useSyncedYDoc.ts` (lines 217-254)

```typescript
moduleUpdateHandler = (update: Uint8Array, origin: unknown) => {
  if (origin === 'remote' || isApplyingRemoteGlobal) return;  // Skip remote
  queueUpdateModule(update);
};

// When applying server state:
Y.applyUpdate(sharedDoc, serverState, 'remote');  // Tagged as remote
```

### Update Batching: 50ms Debounce

**File**: `src/hooks/useSyncedYDoc.ts` (lines 122-149)

```typescript
const DEFAULT_SYNC_DEBOUNCE = 50;

function queueUpdateModule(update: Uint8Array) {
  sharedPendingUpdates.push(update);
  scheduleFlushModule();  // Debounced 50ms
  scheduleBackup();       // Debounced 1000ms (localStorage)
}
```

### Transaction Batching

**File**: `src/hooks/useBlockStore.ts` (lines 286-295)

```typescript
const updateBlockContent = (id: string, content: string) => {
  _doc.transact(() => {
    setValueOnYMap(blocksMap, id, 'content', content);
    setValueOnYMap(blocksMap, id, 'type', parseBlockType(content));
    setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
  });  // Coalesced into single update event
};
```

### Conflict Resolution: CRDT-Native (No App Logic)

- `observeDeep` watches all nesting levels
- `toBlock()` extracts fresh state from Y.Doc
- Projects to SolidJS store for UI
- CRDT layer handles concurrent edits automatically
- Undo manager excludes 'remote' origin

---

## 5. Recent Changes (Last 10 PRs)

### Wave 1: Frontend Handler Registry (PR #77, Jan 8)
- **Change**: Reduced handler boilerplate from 4-7 files → 2 files
- **New**: `src/lib/handlers/` directory with centralized registry
- **Pattern**: Type-safe `BlockHandler` interface with `execute()` method

### Wave 2: Backend Modularization (PR #76, Jan 8)
- **Change**: `lib.rs` reduced 52% (778 → 370 lines)
- **Pattern**: Business logic → `services/`, Tauri wrappers → `commands/`
- **New dirs**: `src-tauri/src/services/`, `src-tauri/src/commands/`

### Wave 3: Structured Logging (PR #75, Jan 8)
- **Framework**: `tracing` crate + JSON output
- **Location**: `~/.floatty/logs/floatty-YYYY-MM-DD.jsonl`
- **Purpose**: Observability for 10K+ block stress tests

### Bug Fixes (PRs #74, #73, #72, #71)
- Text selection no longer bleeds across block boundaries
- Cursor/text sync with focus-based styling
- CSS containment rules fix (text vanishing)
- Multiple display layer debug fixes

### Technical Debt Status
- **TODOs**: 1 minor (`BlockItem.tsx:50` - AUTO-EXECUTE feature request)
- **FIXMEs**: 0
- **HACKs**: 0

---

## 6. Current Bottlenecks

### ✅ RESOLVED: Input Lag (Fixed 2026-01-10)

**File**: `src/components/BlockItem.tsx` (lines 510-527)

```typescript
const handleInput = (e: InputEvent) => {
  const target = e.target as HTMLDivElement;
  const content = target.innerText || '';

  // DOM is already updated by contentEditable (immediate feedback)
  // Debounce Y.Doc/store update to reduce sync overhead
  // Cursor/selection remain live (not affected by this debounce)
  debouncedUpdateContent(props.id, content);  // 150ms debounce
};
```

**Solution implemented**:
- `createDebouncedUpdater()` utility with flush/cancel capabilities
- DOM updates remain immediate (contentEditable handles it)
- Y.Doc/store updates debounced to 150ms
- Flush on blur ensures content is saved when focus leaves
- Cancel on unmount prevents stale updates
- Cursor/caret tracking remains live (not debounced)

### HIGH PRIORITY: Full Tree Walk per Keystroke

**File**: `src/components/Outliner.tsx` (lines 37-57)

```typescript
const getVisibleBlockIds = createMemo(() => {
  const result: string[] = [];
  const walk = (id: string) => {
    result.push(id);
    if (!collapsed) {
      for (const childId of block.childIds) walk(childId);
    }
  };
  for (const rootId of rootsToWalk) walk(rootId);
  return result;
});  // Re-runs on ANY block change
```

**Impact**: O(n) tree traversal per keystroke with 10K blocks.

**Recommendation**: Virtual scrolling (render 50-100 blocks only).

**Virtual Scrolling Architecture (Future)**:
- Fixed item height assumption: 24px (collapsed block), variable when expanded
- Viewport buffer: 20 items above/below visible area for smooth scrolling
- Measure phase: First render calculates block heights, caches for reuse
- Integration with zoom: Virtual root changes when zoomed into subtree
- Integration with collapse: Collapsed blocks skip children entirely
- Performance target: Maintain 60fps during fast scroll with 10K+ blocks
- Implementation path: React-window or custom virtualizer with Y.Doc integration

### MEDIUM: Resize Event Spam

**File**: `src/components/ResizeOverlay.tsx` (line 189)

```typescript
window.dispatchEvent(new Event('resize'));  // 20x/sec during drag
```

**Impact**: Fires 60+ ResizeObserver callbacks during 3s drag.

### MEDIUM: fit() Called on ALL Terminals

**File**: `src/lib/terminalManager.ts` (line 591)

```typescript
for (const [id, savedY] of this.savedScrollPositions) {
  instance.fitAddon.fit();  // Even invisible panes
}
```

**Recommendation**: Skip fit() for panes not in active tab.

### LOWER: Y.Doc Serialization Every Keystroke

**File**: `src/hooks/useSyncedYDoc.ts` (lines 293-308)

```typescript
const state = Y.encodeStateAsUpdate(sharedDoc);  // CPU-intensive
localStorage.setItem(YDOC_BACKUP_KEY, bytesToBase64(state));
```

**Impact**: Serializes entire doc (5.6MB at 10K blocks) every keystroke (debounced 1s).

**Recommendation**: Move to Worker thread.

---

## 7. Discrepancies Found

### Comment vs Implementation Alignment: ✅ GOOD
No major discrepancies found between comments and actual code behavior.

### Singleton Patterns: ✅ CORRECTLY IMPLEMENTED
- Y.Doc singleton with ref-counting
- terminalManager singleton outside SolidJS
- HTTP client singleton with initialization guard

### Observer Ref-Counting: ✅ CORRECT
`handlerRefCount` properly guards against duplicate handlers from multiple panes.

---

## 8. Pattern Harvest for Desktop Daddy

### Patterns to KEEP (Working Well)
1. **Greedy Slurp PTY batching** - 4000+ redraws/sec
2. **Nested Y.Map for blocks** - Granular CRDT updates
3. **Origin filtering** - Prevents sync loops
4. **terminalManager singleton** - Lifecycle outside framework
5. **Pure `determineKeyAction()`** - Testable keyboard logic
6. **Ref-counted handlers** - Prevents duplicate work

### Patterns to EXTRACT (Useful for pi-mono/vibe-kanban)
1. **Handler registry pattern** - `BlockHandler` interface with `execute()`
2. **Services/Commands split** - Business logic decoupled from UI framework
3. **WebSocket + HTTP hybrid sync** - Real-time + crash recovery
4. **Transaction batching** - `doc.transact()` for multi-field updates

### Patterns to EVOLVE (Current Bottlenecks)
1. ~~**No input debouncing**~~ → ✅ FIXED: 150ms debounce with flush/cancel
2. **Full tree walk** → Virtual scrolling or incremental visibility
3. **fit() all terminals** → Skip invisible panes
4. **Sync on keystroke** → Worker thread for serialization

---

## Summary for Pattern Analysis

| Area | Status | Key Pattern |
|------|--------|-------------|
| Block Store | ✅ Solid | Nested Y.Map, setValueOnYMap(), ref-counted handlers |
| Terminal Integration | ✅ Solid | Greedy slurp, singleton outside SolidJS |
| Layout Management | ✅ Solid | Immutable binary tree, drag-aware fit suppression |
| CRDT Sync | ✅ Solid | Origin filtering, transaction batching, 50ms debounce |
| Input Performance | ✅ Fixed | 150ms debounce with flush/cancel; O(n) visibility still pending |
| Resize Performance | ⚠️ Needs Work | Event spam, fit() on all terminals |

**Stress Test Results** (from 2026-01-08 6-agent test):
- 6,604 → 9,882 blocks (+42% in 4 hours)
- CRDT snapshot: 5.6 MB, deltas: 47KB (99.2% compression)
- Fresh tab load: 5-10s freeze (no virtual scrolling)

**Architectural Verdict**: Foundation is sound. Pain points are absence of lazy loading/virtualization, not design flaws.
