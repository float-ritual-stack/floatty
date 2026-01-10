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
