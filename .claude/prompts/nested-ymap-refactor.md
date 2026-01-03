# Nested Y.Map Block Storage Refactor

## The Problem You're Solving

**Current state**: Blocks stored as plain JSON objects in Y.Map
```typescript
blocksMap.set(blockId, { id, content, childIds: [...], ... });  // Plain object
```

**Why this is bad**:
1. Every property change rewrites the ENTIRE block (9 fields overwritten for 1 change)
2. childIds is a plain array - last-write-wins on conflict, not CRDT-safe
3. Rust has to `value.to_string(&txn).parse::<serde_json::Value>()` - double serialization

**Target state**: Each block is a nested Y.Map with Y.Array for childIds
```typescript
const blockMap = new Y.Map();
blockMap.set('childIds', new Y.Array());  // CRDT array
blocksMap.set(blockId, blockMap);         // Nested Y.Map
```

---

## READ THESE FILES FIRST

Before writing ANY code, you MUST read and understand:

| File | Why | Key Lines |
|------|-----|-----------|
| `src/hooks/useBlockStore.ts` | The code you're changing | 41-50 (setValueOnYMap), 60-77 (toBlock), 79-91 (blockToPlainObject), 144-161 (observer) |
| `src/hooks/useSyncedYDoc.ts` | Sync pipeline | 202-210 (UndoManager), 223-227 (update handler) |
| `src-tauri/floatty-server/src/api.rs` | Rust reading | 196-229 (get_blocks iteration), 252-255 (JSON parse hack) |
| `src-tauri/src/ctx_parser.rs` | Shows HashMap insert pattern | 289-298 |

---

## CURRENT IMPLEMENTATION (verified)

### How blocks are stored (useBlockStore.ts:199-201)
```typescript
const newBlock = createBlock(newId, '', beforeBlock.parentId);
blocksMap.set(newId, blockToPlainObject(newBlock));  // Plain object
```

### How properties are updated (useBlockStore.ts:41-50)
```typescript
function setValueOnYMap(blocksMap, blockId, key, value) {
  const existing = blocksMap.get(blockId);
  if (existing instanceof Y.Map) {
    existing.set(key, value);  // ← Direct nested update (not currently used)
  } else {
    // ← CURRENT PATH: rewrite entire object
    const updated = { ...existing, [key]: value };
    blocksMap.set(blockId, updated);
  }
}
```

### How blocks are read (useBlockStore.ts:60-77)
```typescript
function toBlock(value) {
  return {
    id: getValue(value, 'id'),
    childIds: getValue(value, 'childIds') || [],  // Handles Y.Array OR plain array
    // ... other fields
  };
}

function getValue(obj, key) {
  if (obj instanceof Y.Map) {
    const val = obj.get(key);
    if (val instanceof Y.Array) return val.toArray();  // ← Already handles Y.Array!
    if (val instanceof Y.Map) return val.toJSON();
    return val;
  }
  // Fallback for plain objects
  return obj?.[key];
}
```

### How Rust reads blocks (floatty-server/src/api.rs:196-229)
```rust
for (key, value) in blocks_map.iter(&txn) {
    // THE HACK: Parse stringified JSON
    if let Ok(block_json) = value.to_string(&txn).parse::<serde_json::Value>() {
        let content = block_json.get("content").and_then(|v| v.as_str());
        // ...
    }
}
```

---

## THE GOTCHAS (things that will bite you)

### 1. Observer granularity
The `blocksMap.observe()` fires on **key-level changes only**. If you store blocks as nested Y.Maps, you need **deep observation**:
```typescript
// Current: Only fires when blocksMap.set(blockId, ...) is called
blocksMap.observe(handler);

// Needed: Also fire when blockMap.set('content', ...) is called on nested map
blocksMap.observeDeep(handler);  // ← Different API, different event shape
```

**YMapEvent vs YEvent[]**: `observe` gives `YMapEvent`, `observeDeep` gives array of events for nested changes.

### 2. childIds must be Y.Array, created ONCE
```typescript
// WRONG: Creates new Y.Array on every update
blockMap.set('childIds', new Y.Array(['a', 'b']));

// RIGHT: Get existing Y.Array, mutate it
const childIds = blockMap.get('childIds');  // Y.Array
childIds.push(['newChild']);  // Mutate in place
```

### 3. UndoManager tracks by Map reference
The UndoManager in useSyncedYDoc.ts (line 206) is configured for `doc.getMap('blocks')`.
Nested Y.Maps should work, but **test undo/redo thoroughly**.

### 4. Rust yrs reading pattern changes
```rust
// OLD: Parse JSON string
let block_json: Value = value.to_string(&txn).parse()?;

// NEW: Value IS a MapRef, access fields directly
let block_map: MapRef = blocks_map.get(&txn, &id)?;
let content = block_map.get(&txn, "content").map(|v| v.to_string(&txn));
let child_ids: ArrayRef = block_map.get(&txn, "childIds")?;
```

### 5. ctx_parser.rs uses HashMap insert
Line 289-298 shows Rust inserting blocks with `HashMap<String, Any>`. This creates plain objects, not nested Y.Maps. Need to change to create nested MapRef.

---

## IMPLEMENTATION PLAN

### Phase 1: Frontend - Create nested Y.Maps

**File: `src/hooks/useBlockStore.ts`**

1. Replace `blockToPlainObject()` with `blockToYMap()`:
```typescript
function blockToYMap(block: Block, doc: Y.Doc): Y.Map<unknown> {
  const blockMap = new Y.Map();
  blockMap.set('id', block.id);
  blockMap.set('content', block.content);
  blockMap.set('parentId', block.parentId);
  blockMap.set('collapsed', block.collapsed);
  blockMap.set('createdAt', block.createdAt);
  blockMap.set('updatedAt', block.updatedAt);

  // childIds as Y.Array
  const childIds = new Y.Array();
  childIds.push(block.childIds);
  blockMap.set('childIds', childIds);

  return blockMap;
}
```

2. Update all `blocksMap.set(id, blockToPlainObject(...))` calls to use `blockToYMap()`

3. Update `setValueOnYMap()` to handle childIds specially:
```typescript
function setValueOnYMap(blocksMap, blockId, key, value) {
  const existing = blocksMap.get(blockId);
  if (!(existing instanceof Y.Map)) {
    console.error('Block not a Y.Map:', blockId);
    return;
  }

  if (key === 'childIds') {
    // Mutate existing Y.Array
    const childIds = existing.get('childIds') as Y.Array<string>;
    childIds.delete(0, childIds.length);  // Clear
    childIds.push(value);  // Replace with new array
  } else {
    existing.set(key, value);
  }
}
```

4. Change observer from `observe` to `observeDeep`:
```typescript
_blocksObserver = (events: Y.YEvent<any>[]) => {
  batch(() => {
    for (const event of events) {
      // Handle both top-level and nested changes
      const path = event.path;
      if (path.length === 0) {
        // Top-level: block added/removed
        // ... existing logic
      } else {
        // Nested: property changed on existing block
        const blockId = path[0] as string;
        const block = toBlock(blocksMap.get(blockId));
        if (block) setState('blocks', blockId, block);
      }
    }
  });
};
blocksMap.observeDeep(_blocksObserver);
```

### Phase 2: Backend - Read nested Y.Maps

**File: `src-tauri/floatty-server/src/api.rs`**

1. Update `get_blocks()` to read from nested MapRef:
```rust
for (key, value) in blocks_map.iter(&txn) {
    // Value should now be a MapRef
    if let yrs::Value::YMap(block_map) = value {
        let content = block_map.get(&txn, "content")
            .map(|v| v.to_string(&txn))
            .unwrap_or_default();

        let child_ids: Vec<String> = block_map.get(&txn, "childIds")
            .and_then(|v| match v {
                yrs::Value::YArray(arr) => Some(
                    arr.iter(&txn).map(|v| v.to_string(&txn)).collect()
                ),
                _ => None,
            })
            .unwrap_or_default();

        // ... build BlockDto
    }
}
```

2. Update `create_block()` to create nested MapRef:
```rust
let update = {
    let mut txn = doc_guard.transact_mut();
    let blocks = txn.get_or_insert_map("blocks");

    // Create nested map for block
    let block_map = blocks.insert(&mut txn, id.as_str(), MapPrelim::<_, Any>::new());
    block_map.insert(&mut txn, "id", id.clone());
    block_map.insert(&mut txn, "content", req.content.clone());
    block_map.insert(&mut txn, "parentId", req.parent_id.clone());
    block_map.insert(&mut txn, "collapsed", false);
    block_map.insert(&mut txn, "createdAt", now);
    block_map.insert(&mut txn, "updatedAt", now);

    // Create nested array for childIds
    let child_ids = block_map.insert(&mut txn, "childIds", ArrayPrelim::default());

    txn.encode_update_v1()
};
```

**File: `src-tauri/src/ctx_parser.rs`**

3. Update block insertion (lines 289-298) to match new pattern.

### Phase 3: Nuke existing data

**File: `src-tauri/floatty-core/src/store.rs`**

Add version check on startup:
```rust
const SCHEMA_VERSION: i32 = 2;  // Bump when format changes

pub fn open(db_path: &Path, doc_key: &str) -> Result<Self, StoreError> {
    let persistence = YDocPersistence::open(db_path)?;

    // Check schema version
    let current_version = persistence.get_schema_version()?;
    if current_version < SCHEMA_VERSION {
        log::warn!("Schema upgrade: clearing old data (v{} -> v{})", current_version, SCHEMA_VERSION);
        persistence.clear_all_updates(doc_key)?;
        persistence.set_schema_version(SCHEMA_VERSION)?;
    }

    // ... rest of init
}
```

---

## VERIFICATION STEPS

1. `npm run test` - Frontend tests pass
2. `cargo test -p floatty-core` - Core tests pass
3. `cargo build` - No compile errors
4. Manual test sequence:
   - Delete `~/.floatty/ctx_markers.db`
   - Run `npm run tauri dev`
   - Create block, type content, verify renders
   - Indent/outdent, verify tree structure
   - Collapse/expand, verify state
   - Close app, reopen, verify persistence
   - Run `cargo run -p floatty-server`, curl `/api/v1/blocks`, verify JSON response
   - **Test undo/redo** (Cmd+Z / Cmd+Shift+Z)

---

## ANTI-PATTERNS TO AVOID

❌ Don't assume "this is what the code was designed for" - READ THE CODE FIRST
❌ Don't create new Y.Array on every childIds update - mutate existing
❌ Don't forget to update ctx_parser.rs (Rust writes blocks too)
❌ Don't skip the observeDeep migration - nested changes won't trigger UI updates
❌ Don't test only happy path - test undo, rapid edits, concurrent changes

---

## IF IT BREAKS

When (not if) you hit issues:

1. **Capture the specific failure** - what action, what error, what state
2. **Don't add timeouts or retries** - find root cause
3. **Check observer events** - add logging to see what events fire
4. **Check yrs types** - print `value.kind()` to see what Rust is receiving
5. **If stuck >30 min on same issue** - stop, capture state, ask for fresh eyes

---

## SUCCESS CRITERIA

- [ ] Blocks stored as nested Y.Map (verify with console.log in observer)
- [ ] childIds is Y.Array (verify with `value instanceof Y.Array`)
- [ ] Property updates don't rewrite entire block (verify update size)
- [ ] Rust reads without JSON.parse (no `.parse::<serde_json::Value>()`)
- [ ] Undo/redo works
- [ ] Data persists across restart
- [ ] floatty-server returns correct block data
