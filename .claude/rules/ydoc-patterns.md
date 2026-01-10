# Y.Doc Architecture Patterns

These patterns apply to all Y.Doc/CRDT code in floatty.

## 1. Y.Doc is Source of Truth

Tantivy (and any future search index) is for **discovery**, Y.Doc is for **retrieval**.

```
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
