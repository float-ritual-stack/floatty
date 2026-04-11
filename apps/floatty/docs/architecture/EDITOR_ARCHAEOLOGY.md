# Editor Archaeology: Neovim, Roam, Obsidian

**Source**: Gemini synthesis, 2026-01-11
**Purpose**: Architectural patterns for floatty's terminal/outliner hybrid

---

## The Core Tensions

| Axis | Neovim | Roam/Logseq | Obsidian |
|------|--------|-------------|----------|
| **Main Thread Budget** | Owned by C/Rust kernel. UI is reactive. | Shared. Keystroke latency tied to Datalog/File sync. | Owned by Editor. Indexing backgrounded. |
| **Source of Truth** | In-memory buffer (C/Rust) | Graph Database (EAV) | Local File (Markdown) |
| **Extension Boundary** | Msgpack-RPC (strict isolation) | Direct API (shared memory) | Hybrid API (shared/worker) |
| **Index Mechanism** | None (state-based) | Runtime Datalog scans | Eventually-consistent MetadataCache |

---

## Patterns to STEAL

### 1. Headless RPC Core (Neovim)

Separate terminal PTY and outliner Y.js state into headless Rust process. Communicate via binary protocol.

**Why**: High-frequency terminal data doesn't saturate browser main thread.

**floatty status**: ✅ Already doing this (floatty-server + Tauri channels)

### 2. Atomic Notification Batching (Neovim)

Implement `redraw` + `flush` pattern. Accumulate DOM changes, apply in single SolidJS batch.

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│ PTY Output  │ -> │  Batcher    │ -> │ flush event │ -> UI update
│ (greedy)    │    │ (slurp)     │    │ (commit)    │
└─────────────┘    └─────────────┘    └─────────────┘
```

**Why**: User never sees intermediate states. No micro-stuttering.

**floatty status**: ✅ Already doing this (greedy slurp batching in PTY)

### 3. Eventually-Consistent Metadata Cache (Obsidian)

Don't perform O(n) scans on main thread. Background SQLite index, incrementally updated.

**Why**: Heavy metadata extraction never blocks editor.

**floatty status**: ✅ Tantivy search index is exactly this pattern

### 4. Lazy Block ID Suffixes (Obsidian)

Only add `^uuid` suffix when block is explicitly linked. Otherwise rely on implicit Y.js hierarchy.

**Why**: Minimizes file pollution. Most blocks never get linked.

**floatty status**: 🔄 Currently using UUIDs for all blocks. Consider lazy pattern for export.

### 5. Coroutine-based Async Bridges (Neovim)

Use Rust async for I/O, expose to UI/scripting via await-able model.

```lua
-- Neovim pattern: coroutine.yield() + coroutine.resume()
-- floatty pattern: Rust async + Tauri commands + JS Promises
```

**Why**: UI can await results without freezing.

**floatty status**: ✅ Tauri commands are async by default

---

## Patterns to AVOID

### 1. Synchronous File Flushing (Logseq)

Writing entire page to disk on every keystroke = primary cause of stutter.

**floatty approach**: Y.js handles sync. File persistence is checkpoint, not every keystroke.

### 2. Runtime-only Datalog Queries (Roam)

Re-walking entire graph for backlinks on every render doesn't scale to 100k+ blocks.

**floatty approach**: Tantivy index + SQLite for queries. Never walk full tree at render time.

### 3. Monolithic Main Thread (Logseq/Roam)

Query engine and editor kernel sharing single JavaScript heap = death.

**floatty approach**: Rust kernel owns state. SolidJS is projection layer only.

---

## Patterns to INVERT

### 1. Proactive vs Reactive Indexing

Traditional: Index after change persisted to file.
**floatty**: Index during Y.js delta. Since Y.js emits granular deltas, update SQLite rows in real-time.

**Result**: Search and backlinks are "instant" - no 2-second polling window.

### 2. Block-First Duality

Roam: Pages are special Blocks.
**floatty**: Terminal first, Outliner is structured view of terminal state/history.

**Result**: Terminal performance never compromised by outliner complexity.

---

## Key Technical Details

### Neovim's Msgpack-RPC Constraints

- Responses must return in **reverse order** of requests (stack unwinding)
- All messages processed in **exact order received**
- UI attaches via `nvim_ui_attach` - explicit opt-in to drawing

### Roam's Dual Pointer Pattern

Every block has:
- `:block/children` - immediate descendants
- `:block/parents` - ALL ancestors (for fast path queries)
- `:block/page` - direct page reference (skip hierarchy walk)

**Cost**: Moving a block triggers write-amplification (update ancestor lists for entire subtree).

### Obsidian's MetadataCache

- IndexedDB stores paragraph/line/hierarchy mappings
- Index lags 1-2 seconds behind edits (intentional)
- External file changes trigger incremental re-index of that file only
- Block IDs (`^37066d`) only generated on explicit link creation

---

## floatty Architecture Validation

This archaeology **validates** our current architecture:

| Pattern | floatty Implementation |
|---------|------------------------|
| Headless kernel | floatty-server (Rust) |
| Binary protocol | Tauri channels, base64 batching |
| Atomic flush | Greedy slurp + batch commit |
| Eventually-consistent index | Tantivy search, HookRegistry dispatch |
| CRDT truth layer | Y.js / yrs |
| File durability | Y.js persistence to disk |

---

## Open Questions

1. **Lazy Block IDs**: Should we adopt Obsidian's `^uuid` suffix pattern for export/longevity?
2. **Dual Pointers**: Should we add ancestor caching like Roam for faster path queries?
3. **MetadataCache polling**: Our hook-based approach is more reactive - is 0-lag indexing causing issues?

---

## Source References

- Neovim API docs: https://neovim.io/doc/user/api.html
- Neovim UI events: https://neovim.io/doc/user/api-ui-events.html
- Roam data structure: https://www.zsolt.blog/2021/01/Roam-Data-Structure-Query.html
- Obsidian MetadataCache: https://docs.obsidian.md/Reference/TypeScript+API/MetadataCache
- Logseq performance issues: https://discuss.logseq.com/t/keyboard-lag-while-typing/4998
