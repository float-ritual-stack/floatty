# EventBus & Hook System Migration Review

> Review conducted 2026-01-15. Analysis of existing patterns that could leverage the EventBus/Hook architecture.

## Executive Summary

The EventBus and Hook system is **production-ready** with comprehensive test coverage (500+ lines of tests). The architecture provides:

1. **EventBus** (sync lane) - Immediate reactions for UI updates, validation
2. **ProjectionScheduler** (async lane) - Batched expensive operations (search, backlinks)
3. **HookRegistry** - Execution lifecycle hooks (before/after handler execution)

**Current state**: The Y.Doc observer in `useBlockStore.ts` is correctly emitting events to both lanes. One hook (`sendContextHook`) is implemented as a reference pattern.

**Opportunity**: Several existing patterns use ad-hoc polling, O(n) scans, or inline processing that could be migrated to use this architecture for better performance and consistency.

---

## Architecture Overview

```
Y.Doc Update (useBlockStore.ts:251-374)
      │
      ├──► EventBus (sync) ──► immediate reactions
      │    - UI updates
      │    - Validation
      │    - State synchronization
      │
      └──► ProjectionScheduler (async) ──► batched operations
           - Search indexing (2-5s batches)
           - Backlink extraction (1-2s batches)
           - Metadata persistence
```

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/events/eventBus.ts` | Sync pub/sub, priority-ordered handlers |
| `src/lib/events/projectionScheduler.ts` | Async batching with configurable flush intervals |
| `src/lib/events/types.ts` | Origin enum, BlockEvent, EventEnvelope, EventFilters |
| `src/lib/hooks/hookRegistry.ts` | Execution lifecycle hooks |
| `src/lib/hooks/types.ts` | HookEvent, HookContext, HookResult, HookFilters |
| `src/hooks/useBlockStore.ts:250-374` | Y.Doc observer emitting to both lanes |
| `src/lib/handlers/executor.ts` | Hook-aware handler execution |

### Origin System

Origin tags prevent infinite loops and enable source filtering:

```typescript
const Origin = {
  User: 'user',           // Local typing
  Remote: 'remote',       // CRDT sync
  Hook: 'hook',           // Hook-generated
  Undo: 'undo',           // Y.UndoManager
  BulkImport: 'bulk_import',
  Api: 'api',
  System: 'system',
  Executor: 'executor',   // Handler output
};
```

---

## Migration Candidates

### 1. Backlinks/Wikilinks - HIGH PRIORITY

**Location**: `src/hooks/useBacklinkNavigation.ts:110-135`

**Current pattern**: `findBacklinks()` performs O(n) scan of all blocks on every LinkedReferences render.

```typescript
// Current - O(n) per call
export function findBacklinks(pageName: string): Block[] {
  const { blocks } = blockStore;
  for (const block of Object.values(blocks)) {
    const targets = extractAllWikilinkTargets(block.content);
    // ... check each target
  }
}
```

**Recommended migration**:

1. Create `block:create` and `block:update` hook to extract wikilinks to metadata
2. Store in `block.metadata.outlinks: string[]`
3. Build reverse index via ProjectionScheduler
4. Replace O(n) scan with O(1) metadata lookup

```typescript
// Hook: Extract outlinks on content change
const wikilinkExtractionHook: Hook = {
  id: 'wikilink-extraction',
  event: ['block:create', 'block:update'],
  filter: HookFilters.hasWikilinks(),
  priority: 50,
  handler: (ctx) => {
    const targets = extractAllWikilinkTargets(ctx.content);
    // Store in metadata (triggers Y.Doc observer → re-emits)
    // Note: Hook should NOT modify directly - return context for executor
    return { context: { outlinks: targets } };
  },
};

// ProjectionScheduler: Build reverse index
blockProjectionScheduler.register(
  'backlink-index',
  async (envelope) => {
    for (const event of envelope.events) {
      if (event.block?.content.includes('[[')) {
        const targets = extractAllWikilinkTargets(event.block.content);
        backlinkIndex.update(event.blockId, targets);
      }
    }
  },
  { filter: EventFilters.hasWikilinks() }
);
```

**Impact**: LinkedReferences becomes O(1) instead of O(n).

---

### 2. Context Sidebar Polling - HIGH PRIORITY

**Location**: `src/components/ContextSidebar.tsx:114-127`

**Current pattern**: Uses `setInterval` polling every 2 seconds to fetch ctx:: markers from Rust backend.

```typescript
// Current - polling every 2s regardless of changes
createEffect(() => {
  if (!props.visible) return;
  const interval = setInterval(fetchMarkers, 2000);
  onCleanup(() => clearInterval(interval));
});
```

**Recommended migration**:

1. Keep Rust backend for file watching and Ollama parsing (already correct)
2. Add EventBus subscription for ctx:: marker blocks created in outliner
3. Tauri event bridge: when Rust watcher finds new marker, emit to frontend EventBus
4. Sidebar subscribes to EventBus instead of polling

```typescript
// EventBus subscription instead of polling
const ctxSidebarSubscription = blockEventBus.subscribe(
  (envelope) => {
    // Refetch markers when ctx:: blocks change
    void fetchMarkers();
  },
  {
    filter: EventFilters.contentPrefix('ctx::'),
    name: 'ctx-sidebar-refresh',
  }
);

// Tauri bridge (in lib.rs):
// - When watcher detects new marker, call window.emit('ctx-marker-added')
// - Frontend listens and emits to EventBus
```

**Impact**: Eliminates polling, reacts instantly to changes.

---

### 3. Block Move Events - MEDIUM PRIORITY

**Location**: `src/hooks/useBlockStore.ts` - Block operations

**Current pattern**: `block:move` events are defined in types but not emitted.

```typescript
// types.ts defines block:move, but useBlockStore doesn't emit it
export type BlockEventType =
  | 'block:create'
  | 'block:update'
  | 'block:delete'
  | 'block:move';  // Not emitted!
```

**Recommended migration**: Add `block:move` event emission to:
- `indentBlock()` - when parentId changes
- `outdentBlock()` - when parentId changes
- `moveBlockUp()` / `moveBlockDown()` - when position in childIds changes

```typescript
// In useBlockStore.ts, after updating parentId:
blockEvents.push({
  type: 'block:move',
  blockId: id,
  block: newBlock,
  previousBlock: oldBlock,
  changedFields: ['parentId'],
});
```

**Impact**: Enables hooks/projections to react to structural changes (e.g., outline export, hierarchy validation).

---

### 4. Search Index Batching - MEDIUM PRIORITY

**Location**: `src/lib/handlers/search.ts`

**Current pattern**: Handler calls Tauri `invoke('search', ...)` directly on execution.

**Recommended migration**: Add ProjectionScheduler handler for indexing:

```typescript
blockProjectionScheduler.register(
  'tantivy-index',
  async (envelope) => {
    const blockIds = envelope.events
      .filter(e => e.type !== 'block:delete')
      .map(e => e.blockId);

    if (blockIds.length > 0) {
      await invoke('index_blocks', { blockIds });
    }

    const deletedIds = envelope.events
      .filter(e => e.type === 'block:delete')
      .map(e => e.blockId);

    if (deletedIds.length > 0) {
      await invoke('remove_from_index', { blockIds: deletedIds });
    }
  },
  {
    filter: EventFilters.any(
      EventFilters.creates(),
      EventFilters.updates(),
      EventFilters.deletes()
    ),
    name: 'tantivy-indexer',
  }
);
```

**Impact**: Index writes batched every 2-5s instead of per-keystroke.

---

### 5. Changed Fields Detection - LOW PRIORITY

**Location**: `src/hooks/useBlockStore.ts:340-347`

**Current pattern**: `changedFields` is noted as TODO.

```typescript
// TODO: Could compute changedFields by comparing block vs prevBlock
blockEvents.push({
  type: 'block:update',
  blockId: key,
  block,
  previousBlock: prevBlock,
  // changedFields not populated
});
```

**Recommended migration**: Compute `changedFields` array:

```typescript
function computeChangedFields(prev: Block, curr: Block): BlockChangeField[] {
  const fields: BlockChangeField[] = [];
  if (prev.content !== curr.content) fields.push('content');
  if (prev.type !== curr.type) fields.push('type');
  if (prev.collapsed !== curr.collapsed) fields.push('collapsed');
  if (prev.parentId !== curr.parentId) fields.push('parentId');
  // ... etc
  return fields;
}

// Then filters can use:
EventFilters.fieldChanged('content')  // Only react to content changes
EventFilters.fieldChanged('metadata') // Only react to metadata changes
```

**Impact**: Enables more precise filtering, reduces unnecessary handler invocations.

---

### 6. Inline Token Caching - LOW PRIORITY

**Location**: `src/components/BlockDisplay.tsx` and `src/lib/inlineParser.ts`

**Current pattern**: `parseAllInlineTokens()` called in `createMemo` on every block content change.

**Recommended migration**: Cache parsed tokens in metadata:

```typescript
// Hook to cache tokens on content change
const inlineTokenCacheHook: Hook = {
  id: 'inline-token-cache',
  event: 'block:update',
  filter: (block) => block.content.includes('**') ||
                     block.content.includes('*') ||
                     block.content.includes('`') ||
                     block.content.includes('[['),
  priority: 100,  // Run late, after other hooks
  handler: (ctx) => {
    const tokens = parseAllInlineTokens(ctx.content);
    return { context: { inlineTokens: tokens } };
  },
};
```

**Impact**: Only parse when content changes, not on every render. Only pursue if profiling shows parsing is a bottleneck.

---

## Implementation Priority

| Priority | Candidate | Effort | Impact |
|----------|-----------|--------|--------|
| **HIGH** | Backlinks O(1) | Medium | LinkedReferences performance |
| **HIGH** | Context Sidebar event-driven | Medium | Eliminates polling |
| **MEDIUM** | Block Move events | Low | Enables structural hooks |
| **MEDIUM** | Search Index batching | Low | Reduces index writes |
| **LOW** | Changed Fields detection | Low | Precision filtering |
| **LOW** | Inline Token caching | Low | Micro-optimization |

---

## Existing Good Patterns

These are already well-designed and should NOT be changed:

### sendContextHook (`src/lib/handlers/hooks/sendContextHook.ts`)

Reference implementation of an `execute:before` hook:
- Filters by `/send` or `::send` prefix
- Scans document order to build conversation context
- Respects zoom scoping ("zooming is context management")
- Returns context injection, not direct mutations

### Y.Doc Observer (`src/hooks/useBlockStore.ts:250-374`)

Correctly emits to both EventBus and ProjectionScheduler:
- Maps transaction origin to Origin enum
- Captures previous block state for update events
- Batches events within Y.Doc transaction
- Handles auto-execute for external block creation

### Handler Executor (`src/lib/handlers/executor.ts`)

Full hook lifecycle implementation:
- Runs `execute:before` hooks (can abort, modify, inject)
- Passes hook context to handler
- Runs `execute:after` hooks (can post-process)
- Error isolation at each stage

---

## Architecture Constraints

When implementing migrations, observe these patterns from `CLAUDE.md`:

### From ydoc-patterns.md

1. **Y.Doc is source of truth** - Tantivy is for discovery, Y.Doc for retrieval
2. **Metadata lives in Y.Doc** - Store in `block.metadata`, not just indexes
3. **Origin prevents loops** - All transactions need origin tags
4. **Commit at the right boundary** — Input commits at blur/structural op/unmount (FLO-387, no time-based debounce), Sync 50ms debounce, Hooks 1-2s debounce, Index 2-5s debounce

### From do-not.md

1. **Don't recreate parsing** - Reuse `inlineParser.ts` for wikilinks
2. **Don't store metadata only in Tantivy** - Must be in Y.Doc for sync
3. **Don't create separate EventBus** - Wrap Y.Doc `observeDeep()` (already done)
4. **Don't use sync hooks for Tantivy** - Use async with queue

---

## Next Steps

1. **Phase 1**: Implement backlink metadata extraction hook + reverse index
2. **Phase 2**: Add Tauri event bridge for ctx:: markers, remove polling
3. **Phase 3**: Add `block:move` event emission
4. **Phase 4**: Register search index ProjectionScheduler handler

Each phase can be implemented independently and provides immediate value.
