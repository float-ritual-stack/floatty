---
paths:
  - "src/**/*.{ts,tsx}"
---

# Y.Doc Architecture Patterns

These patterns apply to all Y.Doc/CRDT code in floatty.

## 1. Y.Doc is Source of Truth

Tantivy (and any future search index) is for **discovery**, Y.Doc is for **retrieval**.

```typescript
Query → Tantivy → [block_ids] → Y.Doc → [full blocks with metadata]
```

**Never** return search results directly from Tantivy. Always hydrate from Y.Doc.

## 2. Metadata Lives in Y.Doc

Block metadata (markers, outlinks, etc.) must be stored in `block.metadata`, not just in search indexes.

```typescript
// ✅ CORRECT - metadata is CRDT-synced
block.metadata = {
  markers: [{ type: 'ctx', value: 'search' }],
  outlinks: ['Page Name']
};

// ❌ WRONG - metadata only in Tantivy
// Doesn't sync to other clients, lost if index rebuilt
tantivy.index({ id, metadata: { ... } });
```

**Why**: Metadata must travel with the block via CRDT sync. Other clients need it immediately.

## 3. Wrap Y.Doc Observers, Don't Replace

Y.Doc's `observeDeep()` already provides an event pattern. Build on it.

```typescript
// ✅ CORRECT - wrap existing observer
blocksMap.observeDeep(events => {
  updateSignals(events);  // Existing behavior
  changeEmitter.emit(transformToBlockChange(events));  // NEW
});

// ❌ WRONG - separate event system
const eventBus = new EventBus();  // Duplicates Y.Doc's observer
```

## 4. Origin Prevents Infinite Loops

All Y.Doc transactions must carry an Origin tag. Hooks filter by origin to prevent re-triggering.

```typescript
// When a hook writes metadata:
store.updateBlockMetadata(id, { ... }, Origin.Hook);

// Other hooks check:
if (origin === Origin.Hook) return;  // Don't process hook-generated changes
```

**Origin values**: `User`, `Hook`, `Remote`, `Agent`, `BulkImport`

## 5. Debounce at the Right Layer

| Layer | Timing | Why |
|-------|--------|-----|
| Input (BlockItem) | 150ms | Batch keystrokes |
| Sync (useSyncedYDoc) | 50ms | Batch server sync |
| Hooks (ChangeEmitter) | 1-2s | Batch metadata extraction |
| Index (TantivyWriter) | 2-5s | Batch expensive commits |

Don't add debouncing at random points. Each layer has a purpose.

## 6. Blur/Remote-Update Race Condition

**Problem**: User blurs a block (triggering flush), but a remote update arrives between blur and flush. The local flush overwrites the remote change.

```typescript
// ❌ WRONG - blind overwrite on blur
const handleBlur = () => {
  flushContentUpdate();  // Overwrites any remote changes
};

// ✅ CORRECT - use edit token to detect stale writes
let localEditToken = 0;

const handleInput = () => {
  localEditToken = Date.now();
  debouncedUpdate(id, content, localEditToken);
};

const handleBlur = () => {
  const tokenAtBlur = localEditToken;
  flushContentUpdate((id, content, token) => {
    // Only write if no remote update since we started editing
    const block = store.getBlock(id);
    if (block.lastRemoteUpdate > token) {
      // Remote won - merge or discard local
      return;
    }
    store.updateBlockContent(id, content);
  });
};
```

**Why**: CRDTs handle concurrent edits, but blind overwrites bypass conflict resolution. Track when local edits started to detect if remote changes should take precedence.

**Correctness note**: For text, prefer Y.Text with positional ops over content replacement. This pattern is for cases where replacement is unavoidable.

## 7. Multi-Pane Echo Prevention

**Problem**: Block is open in two panes. Edit in pane A triggers observer, which updates pane B's DOM. But pane B's observer then fires, echoing back to pane A.

```typescript
// ❌ WRONG - all panes react to all changes
blocksMap.observeDeep(events => {
  events.forEach(event => {
    updateAllPaneDisplays(event);  // Echo loop
  });
});

// ✅ CORRECT - tag edits with source pane, filter on receive
const handleInput = (paneId: string) => {
  yDoc.transact(() => {
    blockMap.set('content', content);
  }, { origin: Origin.User, sourcePane: paneId });
};

blocksMap.observeDeep(events => {
  events.forEach(event => {
    const { origin, sourcePane } = event.transaction.origin ?? {};

    // Skip if this pane originated the edit
    if (sourcePane === currentPaneId && origin !== Origin.Remote) {
      return;
    }

    updateDisplay(event);
  });
});
```

**Why**: Without source tagging, local edits echo through the observer back to the editing pane, causing cursor jumps and duplicate processing.

**Correctness note**: Remote changes (`origin === Origin.Remote`) should always update all panes - they came from another client, not local echo.

## 8. ID-Based Lookups (Not Index Scans)

**Problem**: Finding a block by scanning `childIds` array is O(n). With large outlines, this causes lag.

```typescript
// ❌ WRONG - linear scan to find block
const findBlock = (id: string): Block | null => {
  for (const rootId of rootBlockIds) {
    const result = scanTree(rootId, id);  // O(n) per lookup
    if (result) return result;
  }
  return null;
};

// ✅ CORRECT - Y.Map gives O(1) lookup by ID
const getBlock = (id: string): Block | null => {
  const blockMap = blocksMap.get(id);  // O(1)
  if (!blockMap) return null;
  return mapToBlock(blockMap);
};

// For relationships, maintain index maps
const parentIndex = new Map<string, string>();  // childId → parentId

blocksMap.observeDeep(events => {
  events.forEach(event => {
    if (event.path.includes('childIds')) {
      rebuildParentIndex();  // Amortized O(1) per edit
    }
  });
});
```

**Why**: Y.Map is already a hash map. Use it directly instead of scanning arrays. For relationships not stored in Y.Doc (like parent lookups), maintain a derived index that updates on changes.

**Correctness note**: Index maps are derived state - they can be rebuilt from Y.Doc at any time. Don't persist them; regenerate on load.

## 9. Granular Field Mutations

**Problem**: Replacing entire block objects causes unnecessary CRDT traffic and can overwrite concurrent field edits.

```typescript
// ❌ WRONG - replace entire block
const updateBlock = (id: string, updates: Partial<Block>) => {
  const block = getBlock(id);
  const newBlock = { ...block, ...updates };
  blocksMap.set(id, blockToMap(newBlock));  // Replaces all fields
};

// ✅ CORRECT - mutate individual fields
const updateBlockContent = (id: string, content: string) => {
  const blockMap = blocksMap.get(id);
  if (!blockMap) return;

  yDoc.transact(() => {
    blockMap.set('content', content);  // Only touches 'content'
  }, origin);
};

const updateBlockMetadata = (id: string, metadata: BlockMetadata) => {
  const blockMap = blocksMap.get(id);
  if (!blockMap) return;

  yDoc.transact(() => {
    // Merge metadata fields, don't replace
    const existing = blockMap.get('metadata') ?? {};
    blockMap.set('metadata', { ...existing, ...metadata });
  }, origin);
};
```

**Why**: CRDT conflict resolution works at the field level. If client A updates `content` and client B updates `collapsed` simultaneously, both should win. Replacing the whole object makes one overwrite the other.

**Correctness note**: Use separate transactions for unrelated field updates. Group related fields (like `metadata` sub-fields) in a single transaction for atomicity.

## 10. Surgical Y.Array Mutations (FLO-280)

**Problem**: Y.Array operations like `delete(0, length)` then `push(newItems)` create fresh CRDT operations with new `(clientId, clock)` tuples. When two docs with divergent operation histories merge (bidirectional resync, crash recovery), both sets of insert operations survive — because the CRDT correctly preserves them as distinct operations. Result: duplicated childIds entries.

```typescript
// ❌ WRONG - delete-all-then-push creates divergent CRDT ops that duplicate on merge
const childIds = [...currentChildIds, newId];
const arr = blockMap.get('childIds') as Y.Array<string>;
arr.delete(0, arr.length);  // Creates N delete ops
arr.push(childIds);          // Creates N insert ops (new clientId+clock!)

// ✅ CORRECT - surgical mutation creates minimal CRDT ops
const arr = blockMap.get('childIds') as Y.Array<string>;
arr.insert(atIndex, [newId]);  // ONE insert op
// OR
arr.delete(idx, 1);           // ONE delete op
```

**Helpers** (in `useBlockStore.ts`):

| Helper | CRDT ops | Use case |
|--------|----------|----------|
| `insertChildId(blocksMap, parentId, childId, atIndex)` | 1 insert | Add child at position |
| `appendChildId(blocksMap, parentId, childId)` | 1 insert | Add child at end |
| `removeChildId(blocksMap, parentId, childId)` | 1 delete | Remove by value |
| `insertChildIds(blocksMap, parentId, ids, atIndex)` | 1 insert | Bulk add (e.g., liftChildren) |
| `clearChildIds(blocksMap, blockId)` | 1 delete | Intentional full wipe |
| `swapChildIds(blocksMap, parentId, idxA, idxB)` | 4 ops | Adjacent swap (2 del + 2 ins) |

**Why**: `rootIds` (a Y.Array at root level) already used surgical mutations (`rootIds.insert()`, `rootIds.delete()`). The childIds Y.Arrays nested inside block Y.Maps were the only place using destructive rebuild. Harmonizing them prevents CRDT duplication.

**Safety net**: `deduplicateChildIds()` in `useSyncedYDoc.ts` runs on startup and after resync to catch any pre-existing or edge-case duplicates.

**Correctness note**: For reads that need an index (e.g., `childIds.indexOf(id)` to calculate insert position), read the array into a plain JS array first. The surgical helpers handle the Y.Array write.

## 11. Batch Transactions for Bulk Operations (FLO-322)

**Problem**: Creating N blocks individually produces 2N Y.Doc transactions (create + updateContent each). Each transaction fires `observeDeep`, EventBus, hook processing, and SolidJS reactivity. 100 blocks = 200 observer fires, 200 undo entries.

```typescript
// ❌ WRONG - per-block transactions
for (const parsed of blocks) {
  const id = store.createBlockAfter(afterId);  // Transaction 1
  store.updateBlockContent(id, parsed.content); // Transaction 2
  afterId = id;
}
// 100 blocks = 200 transactions, 200 undo entries, 200 observer fires

// ✅ CORRECT - single batch transaction
const ids = store.batchCreateBlocksAfter(afterId, ops); // 1 transaction
// 100 blocks = 1 transaction, 1 undo entry, 1 observer fire
```

**Batch API** (in `useBlockStore.ts`):

| Method | Use case |
|--------|----------|
| `batchCreateBlocksAfter(afterId, ops)` | Paste: siblings after cursor |
| `batchCreateBlocksInside(parentId, ops)` | Handler output: children at end |
| `batchCreateBlocksInsideAtTop(parentId, ops)` | Handler output: children at top |

All use `'bulk_import'` origin by default → slim observer path (skips sync EventBus, enqueues to async ProjectionScheduler for deferred metadata extraction).

**Undo correctness**: Single transaction = single undo step. `Cmd+Z` removes entire paste at once.

**Two-lane hook processing**: `BulkImport` skips sync EventBus (keeps rendering fast) but enqueues `block:create` events to async ProjectionScheduler. Metadata (ctx:: markers, [[wikilink]] outlinks) populates in background. `Remote`/`ReconnectAuthority` skip both lanes (metadata already extracted when blocks were originally created).

## 12. yjs Observer API (Don't Return-Capture)

**The trap**: yjs `observeDeep()` returns `void`, not an unsubscribe function. This is different from most JS observer/subscribe patterns.

```typescript
// ❌ WRONG - observeDeep returns void
const unobserve = blocksMap.observeDeep(handler);
unobserve(); // TypeError: unobserve is not a function

// ✅ CORRECT - use unobserveDeep with the same handler reference
const handler = (events: Y.YEvent<any>[]) => { ... };
blocksMap.observeDeep(handler);
// Later:
blocksMap.unobserveDeep(handler);
```

**Rule**: Keep a reference to the handler function. Pass the same reference to both `observeDeep()` and `unobserveDeep()`.

## 13. Pre-Flight Validation for Structural Mutations

**Problem**: Removing a block from its parent before validating the insertion destination creates orphan risk. If `indexOf` returns -1 or the destination container doesn't exist, the block is already detached.

```typescript
// ❌ WRONG - remove before validating destination
removeChildId(blocksMap, parentId, id);  // Block detached!
const gpChildIds = getChildIds(blocksMap, grandparentId);
const parentIndex = gpChildIds.indexOf(parentId);
// If parentIndex is -1, block is orphaned

// ✅ CORRECT - validate THEN mutate
let insertIndex = -1;
if (grandparentId) {
  const gpData = blocksMap.get(grandparentId);
  if (!gpData) return;  // Bail — no mutation happened
  const gpChildIds = (getValue(gpData, 'childIds') as string[]) || [];
  insertIndex = gpChildIds.indexOf(parentId);
  if (insertIndex < 0) return;  // Bail — no mutation happened
}
removeChildId(blocksMap, parentId, id);  // Safe — destination verified
insertChildId(blocksMap, grandparentId, id, insertIndex + 1);
```

**Pattern**: For any operation that moves a block (outdent, merge-lift, reparent):
1. Resolve ALL destination lookups (`indexOf`, `blocksMap.get`)
2. Verify ALL return non-null/non-negative
3. THEN begin mutations

**Clarification vs Rule #8**: Rule #8 prohibits scanning arrays to *find* a block (use `blocksMap.get(id)` instead). The `indexOf` calls here are different — they compute *sibling position* after block identity is already resolved via ID-based lookup. `indexOf` on a `childIds` array is the correct way to determine where a known-valid block sits among its siblings.

**Also guard ancestry**: Operations that delete a block (merge, delete) should check `isDescendant()` to prevent deleting an ancestor of a referenced block. `mergeBlocks` and `moveBlock` both use this.

**Reference implementations**: `_outdentBlockSimple`, `outdentBlock` adopt path, `mergeBlocks` `liftOk` flag.

## 14. Transaction Authority Rules (v0.9.5)

Inside `_doc.transact()`, Y.Doc is the **only** source of truth. Reactive state (`state.blocks[id]`) is a rendering convenience — it may be stale after WebSocket updates arrive between SolidJS reconciliation cycles.

**Rules**:

1. **Read from Y.Doc inside transactions, not reactive state**: Use `blocksMap.get(id)` with `instanceof Y.Map` / `Y.Array` checks, not `state.blocks[id].childIds`.

2. **Validate before mutate**: All lookups (`blocksMap.has()`, `indexOf()`, `instanceof`) must succeed BEFORE any `blocksMap.set()` or `setValueOnYMap()` call. If validation fails, return early — empty transactions emit no update events.

3. **Defer block creation**: `blocksMap.set(newId, blockToYMap(newBlock))` goes AFTER confirming the insertion target exists and the reference block is in the correct parent's childIds. Creating a block before confirming its home = orphan-by-creation.

4. **Descendant walks use Y.Map/Y.Array**: `deleteBlock` and `deleteBlocks` walk `blocksMap.get(id) → Y.Map → .get('childIds') → Y.Array` to collect descendants. Never `state.blocks[id].childIds` — misses remotely-added children.

5. **Track success**: Use a `let success = false` flag outside the transaction, set `success = true` at the end of the happy path. Return `success ? newId : ''` so callers know if the operation actually happened.

6. **Every bail-out gets a diagnostic counter**: When a validation fails inside a transaction, call the appropriate `record*()` from `syncDiagnostics.ts`. Silent bail-outs hide root causes.

```typescript
// ❌ WRONG - reads from reactive state, creates block before validation
_doc.transact(() => {
  const blocksMap = _doc.getMap('blocks');
  blocksMap.set(newId, blockToYMap(newBlock));  // Created before validation!
  const childIds = state.blocks[parentId].childIds;  // Reactive state!
  insertChildId(blocksMap, parentId, newId, childIds.indexOf(afterId) + 1);
}, 'user');

// ✅ CORRECT - reads from Y.Doc, defers creation, tracks success
let success = false;
_doc.transact(() => {
  const blocksMap = _doc.getMap('blocks');
  if (!blocksMap.has(parentId)) { recordParentValidationFailure(); return; }
  const parentData = blocksMap.get(parentId);
  const childIds = (getValue(parentData, 'childIds') as string[]) || [];
  const afterIndex = childIds.indexOf(afterId);
  if (afterIndex < 0) return;
  blocksMap.set(newId, blockToYMap(newBlock));  // After validation
  insertChildId(blocksMap, parentId, newId, afterIndex + 1);
  success = true;
}, 'user');
return success ? newId : '';
```

**Why empty transactions are safe**: yjs `transact()` only emits an update event if mutations occurred. A transaction that returns early without mutating anything is a no-op — no sync traffic, no observer fires.

**Origin values**: `'user'`, `'executor'`, `'hook'`, `'system'`, `'bulk_import'`, `'reconnect-authority'`, `'gap-fill'`, `'user-drag'`
