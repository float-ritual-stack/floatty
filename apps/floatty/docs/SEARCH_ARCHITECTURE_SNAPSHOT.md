# Floatty Search Architecture Snapshot

**Generated**: 2026-01-10 ~6:30 AM EST
**Session**: ~7 hours (10:50PM → 6:30AM)
**Passes**: Desktop Daddy ×3, Claude Code Cowboy ×2, GPT ×1
**Status**: Ratchet-checked against codebase

---

## Mental Model

```
Tantivy = agent's index, not its brain
Y.Doc = source of truth
```

Search finds candidates fast, returns stable IDs. System retrieves full blocks via Y.Doc and acts.

---

## 1. IMPLEMENTED (Code Exists)

### 1.1 Y.Doc Block Store

**File**: `src/hooks/useBlockStore.ts`

```typescript
// Blocks as nested Y.Maps (lines 132-161)
const blockMap = new Y.Map<unknown>();
blockMap.set('id', block.id);
blockMap.set('content', block.content);
// ... other fields

// childIds as Y.Array (line 154)
const childIdsArr = new Y.Array<string>();
blockMap.set('childIds', childIdsArr);
```

**File**: `src/hooks/useSyncedYDoc.ts`

```typescript
// Origin filtering - STRING, not enum (line 221)
if (origin === 'remote' || isApplyingRemoteGlobal) return;

// Server sync debounce: 50ms (line 127)
const DEFAULT_SYNC_DEBOUNCE = 50;
```

### 1.2 Input Debouncing

**File**: `src/components/BlockItem.tsx`

```typescript
// Input debounce: 150ms (line 18)
const UPDATE_DEBOUNCE_MS = 150;

// Debounced Y.Doc updates (lines 93-96)
const { debounced: debouncedUpdateContent, flush, cancel } =
  createDebouncedUpdater((id, content) => {
    store.updateBlockContent(id, content);
  }, UPDATE_DEBOUNCE_MS);
```

**Actual flow**:
```
Keystroke → DOM immediate → 150ms debounce → store.updateBlockContent()
                                                      ↓
                                            50ms debounce → HTTP sync
```

### 1.3 Block Type Detection

**File**: `src/lib/blockTypes.ts` (lines 28-56)

```typescript
export function parseBlockType(content: string): BlockType {
  if (lower.startsWith('sh::')) return 'sh';
  if (lower.startsWith('ai::')) return 'ai';
  if (lower.startsWith('ctx::')) return 'ctx';
  // ... 19 types total
}
```

Types are **derived from content prefix at runtime**, not stored.

### 1.4 Inline Token Parsing

**File**: `src/lib/inlineParser.ts`

Parses:
- `[[wikilinks]]` with bracket counting (lines 196-280)
- `ctx::` prefix, timestamps, `[key::value]` tags (lines 119-194)
- Markdown inline: `**bold**`, `*italic*`, `` `code` ``

```typescript
// Wikilink extraction exists (line 196+)
function parseWikilinks(content: string): InlineToken[] { ... }

// ctx:: token types (lines 150-176)
type: 'ctx-prefix' | 'ctx-timestamp' | 'ctx-tag'
```

### 1.5 Handler Registry

**File**: `src/lib/handlers/registry.ts`

```typescript
class HandlerRegistry {
  register(handler: BlockHandler): void
  findHandler(content: string): BlockHandler | null
  isExecutableBlock(content: string): boolean
}

// Exported as singleton instance (line 58)
export const registry = new HandlerRegistry();
```

Usage: `import { registry } from '../lib/handlers'` then `registry.findHandler(...)`

Registered: `shHandler`, `aiHandler`, `dailyHandler`

### 1.6 Rust Services Pattern

**Location**: `src-tauri/src/services/`

| Service | Purpose |
|---------|---------|
| `ctx.rs` | Marker queries from SQLite |
| `execution.rs` | Shell & AI block execution |
| `workspace.rs` | Layout persistence |
| `hooks.rs` | Shell hooks (OSC 133/1337) |
| `clipboard.rs` | Image clipboard |

### 1.7 Rust Persistence

**File**: `src-tauri/floatty-core/src/persistence.rs`

```sql
-- Y.Doc updates (append-only)
CREATE TABLE ydoc_updates (
  id INTEGER PRIMARY KEY,
  doc_key TEXT,
  update_data BLOB,
  created_at INTEGER
);
```

**File**: `src-tauri/src/db.rs`

```sql
-- ctx:: markers
CREATE TABLE ctx_markers (
  id TEXT PRIMARY KEY,
  raw_line TEXT,
  status TEXT,  -- 'pending' | 'parsing' | 'parsed' | 'failed'
  parsed TEXT,  -- JSON
  ...
);
```

### 1.8 Block Interface

**File**: `src/lib/blockTypes.ts` (lines 12-26)

```typescript
export interface Block {
  id: string;
  parentId: string | null;
  childIds: string[];
  content: string;
  type: BlockType;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;  // EXISTS but unused
  output?: unknown;
  outputType?: string;  // 'daily-view', 'kanban-view', etc.
  outputStatus?: 'running' | 'complete' | 'error';
}
```

### 1.9 Block Store Methods

**File**: `src/hooks/useBlockStore.ts`

Mutation methods (lines 880-920):
```typescript
// Core mutations
createBlock(parentId, content) → id
updateBlockContent(id, content)
deleteBlock(id)
moveBlock(id, newParentId, position)

// Output handling (for sh::, ai::, daily:: execution)
setBlockOutput(id, output, outputType, status = 'complete')
setBlockStatus(id, status)  // For loading indicators
```

---

## 2. NOT IMPLEMENTED (Verified Absent)

| Component | Status | Evidence |
|-----------|--------|----------|
| **Tantivy** | Not in Cargo.toml | `grep -r "tantivy" src-tauri/` returns nothing |
| **SQLite FTS** | Not enabled | No FTS3/FTS5 tables in schema |
| **Search service** | Missing | No `src-tauri/src/services/search.rs` |
| **Search command** | Missing | No search in `src-tauri/src/commands/` |
| **Search endpoint** | Missing | No `/api/v1/search` in floatty-server |
| **EventBus** | Missing | All events via Y.Doc observers |
| **Origin enum** | Missing | Uses string `'remote'` comparison |
| **Backlinks index** | Missing | Only inline parsing, no reverse lookup |
| **sequence_position** | Missing | Not computed or stored |

---

## 3. DECIDED DIRECTION (North Stars)

These constrain future implementation but no code exists.

### 3.1 Tantivy Over Alternatives

| Option | Rejected Because |
|--------|------------------|
| SQLite FTS5 | No facets, no explain, weaker ranking |
| In-memory scan | O(n) doesn't scale to 50K blocks |
| External service | Adds deployment complexity |

**Tantivy wins**: Facets, fast fields, explain capability, Rust-native.

### 3.2 Split-Brain Architecture

| Layer | Owns | Example |
|-------|------|---------|
| Y.Doc | Truth | Block content, structure |
| Tantivy | Discovery | Find candidates, rank, filter |
| Store | Retrieval | Get full block by ID |

**Principle**: Store just enough in Tantivy to render "result cards" without pulling full documents.

### 3.3 Intent-Aware Search

| Intent | Budget | Result Shape |
|--------|--------|--------------|
| Autocomplete | <50ms | Inline suggestions |
| Archaeology | ≤2s | Narrative + evidence |
| Lateral | ≤1.5s | Convergence map |
| Turtle | ≤5s staged | Hotspots + surprise |

### 3.4 Serpentine > Tree

Writing is a serpent through bullets, not a hierarchy.

| Field | Signal For |
|-------|-----------|
| `parent_id`, `depth` | Display context only |
| `sequence_position` | **Search relevance**, locality |

### 3.5 Chirp vs Request

| | Chirp | Request |
|-|-------|---------|
| Trigger | Threshold/ambient | Explicit query |
| Attention | Non-blocking | Demands response |
| Example | Autocomplete | "What did I do on issue 264" |

---

## 4. PROPOSED SCHEMA (Direction, Not Final)

```rust
// IDENTITY
doc_id: STRING | STORED           // Block ID (bridge to Y.Doc)
block_type: STRING | FAST         // "sh" | "ai" | "ctx" | "text"

// DISPLAY (result cards)
title: TEXT | STORED              // First line or header
content: TEXT                     // Tokenized, NOT stored
updated_at: u64 | FAST

// SERPENTINE (locality)
sequence_position: u64 | FAST     // Global document ordering
prev_block_id: STRING | STORED
next_block_id: STRING | STORED
context_window: TEXT | STORED     // N blocks before/after

// TREE (display only)
parent_id: STRING | STORED
depth: u64 | FAST
is_stub: BOOL | FAST              // Empty page placeholder

// FACETS
type_facet: FACET                 // /type/header, /type/bullet
marker_facet: FACET               // /marker/ctx, /marker/project

// WIKILINKS
outlinks: STRING | STORED         // [[target]] names
```

---

## 5. PROPOSED QUERY PRIMITIVES

```rust
// Discovery (Tantivy)
search(query, filters, limit) → [Hit]
facets(query, roots) → Counts

// Retrieval (Y.Doc)
get(doc_id) → Block
neighbors(doc_id, n) → [doc_id]
backlinks(doc_id) → [doc_id]
ancestors(doc_id) → [doc_id]
```

---

## 6. PROPOSED PHASE ROADMAP

```
Phase 0: Origin Tagging               ← NEXT
         └─ Add Origin enum (User/Hook/Remote/Agent/BulkImport)
         └─ Tag Y.Doc transactions

Phase 1: Block Change Emitter
         └─ Capture changed block IDs at store boundary
         └─ Dedupe and batch

Phase 2: Metadata Extraction (TRACER BULLET)
         └─ Extract :: markers → block.metadata.markers
         └─ Extract [[wikilinks]] → block.metadata.outlinks
         └─ VALIDATES hook pattern

Phase 3: Tantivy Integration
         └─ Add tantivy to Cargo.toml
         └─ SearchService with writer actor
         └─ Index from Y.Doc, query via primitives

Phase 4: Lua Hooks (Future)
         └─ Configuration layer, not agent runtime
```

---

## 7. OPEN QUESTIONS

| Question | Options | Leaning |
|----------|---------|---------|
| sequence_position generation | DFS reindex vs incremental | Incremental |
| Index location | floatty-server vs Tauri-local | Server (headless) |
| context_window size | 2 vs 5 blocks | 2 |
| Backlinks | Index field vs separate table | Index field |
| Vector/embeddings | MVP vs later | Later (Phase 5+) |
| Stub page handling | Filter in results vs separate index | Filter (is_stub field) |

---

## 8. DISCREPANCIES FOUND

| Document Claim | Actual Code | Resolution |
|----------------|-------------|------------|
| "Origin enum" | String `'remote'` | Phase 0 adds proper enum |
| "EventBus" | Y.Doc observers only | Phase 1 adds emitter |
| "50ms debounce" | Two debounces: 150ms + 50ms | Document both |
| "metadata used" | Field exists, unused | Phase 2 populates it |

---

## 9. TURTLE METHODOLOGY → SEARCH UX

| Poetic | UX Behavior | Implementation |
|--------|-------------|----------------|
| Shutterbug | Know before load | `search(mode: 'recon')` |
| Cats and dicks | Lexical anchors | BM25 on content |
| Taste the soup | Expand around hits | `context_window` field |
| Meet neighbours | Sequence traversal | `sequence_position` range |
| Convergence | Intersect signals | Hits in multiple passes |

---

## 10. FILE INVENTORY

**Implemented**:
```
src/hooks/useBlockStore.ts        # Y.Doc CRDT
src/hooks/useSyncedYDoc.ts        # Server sync
src/lib/blockTypes.ts             # Block interface
src/lib/inlineParser.ts           # Token parsing
src/lib/handlers/                 # Handler registry
src/components/BlockItem.tsx      # Input debouncing
src-tauri/src/services/           # Rust services
src-tauri/floatty-core/           # Y.Doc store
```

**To Create (Phase 3)**:
```
src-tauri/floatty-core/src/search/
├── mod.rs
├── schema.rs
├── service.rs
└── index.rs

src-tauri/src/services/search.rs
src-tauri/src/commands/search.rs
```

---

## Summary

| Category | Status |
|----------|--------|
| Y.Doc/CRDT | ✅ Implemented |
| Debouncing | ✅ Implemented (150ms + 50ms) |
| Token parsing | ✅ Implemented |
| Handler registry | ✅ Implemented |
| Services pattern | ✅ Implemented |
| **Search infrastructure** | ❌ Not started |
| **Origin enum** | ❌ Not started |
| **EventBus/emitter** | ❌ Not started |
| **Tantivy** | ❌ Not in dependencies |

**Next concrete step**: Phase 0 - Add Origin enum and tag Y.Doc transactions.

---

```
┌─────────────────────────────────────────────────────────────────┐
│  RATCHET GUARD                                                  │
├─────────────────────────────────────────────────────────────────┤
│  ✅ = code exists, verified against files                       │
│  ❌ = verified absent from codebase                             │
│  PROPOSED = direction decided, no code                          │
│  OPEN = requires decision before implementation                 │
└─────────────────────────────────────────────────────────────────┘
```
