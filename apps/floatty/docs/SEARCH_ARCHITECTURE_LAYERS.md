# Search Architecture: Layers & Feature Flows

> **STATUS: PARTIALLY ASPIRATIONAL** — Part 1 (Current State) is accurate as of v0.11.4.
> Parts 2-4 describe planned Tantivy integration, Hook Registry dispatch, and full-text search
> architecture that **does not yet exist** (Tantivy is absent from Cargo.toml).
> For current search state, see [`SEARCH_ARCHITECTURE_SNAPSHOT.md`](SEARCH_ARCHITECTURE_SNAPSHOT.md).

**Generated**: 2026-01-10
**Purpose**: Clear documentation for agents executing work units without full context
**Status**: Authoritative reference for implementation decisions

---

## Executive Summary

This document describes the architecture for floatty's search system. It clearly separates:

1. **Current State** - What exists in code today
2. **Target State** - What we're building
3. **Layers** - Separation of concerns
4. **Feature Flows** - Practical examples showing data movement

**Key insight**: Y.Doc observers already provide an event-like pattern. We wrap and extend them, not replace them.

---

## Part 1: Current State (What Exists)

### 1.1 Y.Doc Block Store

**Location**: `src/hooks/useBlockStore.ts`

```
┌─────────────────────────────────────────────────────────────┐
│                     YDocStore (Singleton)                    │
├─────────────────────────────────────────────────────────────┤
│  blocksMap: Y.Map<Y.Map>    ← Nested Y.Maps for each block  │
│  rootBlockIds: Y.Array      ← Ordered root block IDs        │
├─────────────────────────────────────────────────────────────┤
│  Mutation Methods:                                          │
│    createBlock(parentId, content) → id                      │
│    updateBlockContent(id, content)                          │
│    deleteBlock(id)                                          │
│    moveBlock(id, newParentId, position)                     │
├─────────────────────────────────────────────────────────────┤
│  Observer Pattern (ALREADY EXISTS):                         │
│    blocksMap.observeDeep(events => { ... })                 │
│    ↳ Fires on ANY block change                              │
│    ↳ Has access to transaction.origin                       │
└─────────────────────────────────────────────────────────────┘
```

**Code Reference** (`useBlockStore.ts:221-245`):
```typescript
// Observer pattern ALREADY fires on changes
blocksMap.observeDeep(events => {
  events.forEach(event => {
    // Can access event.transaction.origin
    // Currently used for: updating SolidJS signals
  });
});
```

### 1.2 Origin Filtering (Partial)

**Location**: `src/hooks/useSyncedYDoc.ts:221`

```typescript
// Currently: string comparison, not enum
if (origin === 'remote' || isApplyingRemoteGlobal) return;
```

**Gap**: Origin is a string, not a typed enum. Only filters 'remote'.

### 1.3 Debounce Layers (Already Two)

```
                 CURRENT DEBOUNCE ARCHITECTURE
┌─────────────────────────────────────────────────────────────┐
│                                                              │
│  Keystroke                                                   │
│     │                                                        │
│     ▼                                                        │
│  ┌─────────────────────────────────────┐                    │
│  │  Layer 1: Input Debounce (150ms)    │                    │
│  │  Location: BlockItem.tsx            │                    │
│  │  Purpose: Batch keystrokes          │                    │
│  └─────────────────────────────────────┘                    │
│     │                                                        │
│     ▼  store.updateBlockContent()                           │
│  ┌─────────────────────────────────────┐                    │
│  │  Layer 2: Sync Debounce (50ms)      │                    │
│  │  Location: useSyncedYDoc.ts         │                    │
│  │  Purpose: Batch server sync         │                    │
│  └─────────────────────────────────────┘                    │
│     │                                                        │
│     ▼  HTTP to floatty-server                               │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Key files**:
- `src/components/BlockItem.tsx:18` - `UPDATE_DEBOUNCE_MS = 150`
- `src/hooks/useSyncedYDoc.ts:127` - `DEFAULT_SYNC_DEBOUNCE = 50`

### 1.4 Token Parsing (Already Exists)

**Location**: `src/lib/inlineParser.ts`

Already parses:
- `[[wikilinks]]` with bracket counting (lines 196-280)
- `[[Target|Alias]]` alias syntax
- `ctx::` prefix and `[key::value]` tags (lines 150-176)
- Markdown: `**bold**`, `*italic*`, `` `code` ``

**Exports available**:
```typescript
parseAllInlineTokens(content: string): InlineToken[]
hasWikilinkPatterns(content: string): boolean
hasCtxPatterns(content: string): boolean
```

### 1.5 Block Type Detection (Already Exists)

**Location**: `src/lib/blockTypes.ts:28-56`

```typescript
export function parseBlockType(content: string): BlockType {
  if (lower.startsWith('sh::')) return 'sh';
  if (lower.startsWith('ai::')) return 'ai';
  if (lower.startsWith('ctx::')) return 'ctx';
  // ... 19 types total
}
```

Types are **derived from content at runtime**, not stored.

### 1.6 Handler Registry (Frontend Pattern to Mirror)

**Location**: `src/lib/handlers/registry.ts`

```typescript
class HandlerRegistry {
  register(handler: BlockHandler): void
  findHandler(content: string): BlockHandler | null
  isExecutableBlock(content: string): boolean
}
```

**This is the pattern we want for metadata hooks** - registered handlers with prefix matching.

### 1.7 Metadata Field (Exists, Unused)

**Location**: `src/lib/blockTypes.ts:12-26`

```typescript
export interface Block {
  // ... other fields ...
  metadata?: Record<string, unknown>;  // EXISTS but unused
}
```

**Gap**: Field exists but nothing populates or reads it.

### 1.8 Services Pattern (Rust Backend)

**Location**: `src-tauri/src/services/`

| Service | Purpose | Pattern |
|---------|---------|---------|
| `ctx.rs` | SQLite queries | Pure business logic |
| `execution.rs` | Shell/AI execution | Async + channels |
| `workspace.rs` | Layout persistence | State management |

**Pattern**: Services are pure Rust business logic. Tauri commands are thin adapters.

---

## Part 2: Target State (What We're Building)

### 2.1 Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           TARGET ARCHITECTURE                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   LAYER 6: FRONTEND UI                                                   │
│   ├── Autocomplete dropdown ([[)                                         │
│   ├── Search results panel                                               │
│   └── Backlinks panel                                                    │
│                                                                          │
│   ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│   LAYER 5: TAURI COMMANDS (thin adapters)                               │
│   ├── search_blocks(query, filters) → Results                           │
│   ├── get_autocomplete(prefix) → Suggestions                            │
│   └── get_backlinks(block_id) → [BlockId]                               │
│                                                                          │
│   ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│   LAYER 4: SEARCH SERVICE (Tantivy queries)                             │
│   ├── SearchService::search(query) → [Hit]                              │
│   ├── SearchService::facets(query) → Counts                             │
│   └── Uses Tantivy index, returns stable IDs                            │
│                                                                          │
│   ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│   LAYER 3: INDEX WRITER (async actor)                                   │
│   ├── Receives batched BlockChange events                               │
│   ├── Updates Tantivy index                                             │
│   └── Handles concurrent writes safely                                  │
│                                                                          │
│   ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│   LAYER 2: HOOK REGISTRY (NEW)                                          │
│   ├── Registered handlers with priority ordering                        │
│   ├── MetadataHook: extracts :: markers, [[wikilinks]]                  │
│   ├── IndexHook: queues updates for Tantivy                             │
│   └── Each hook can be sync or async                                    │
│                                                                          │
│   ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│   LAYER 1: CHANGE EMITTER (wraps Y.Doc observers)                       │
│   ├── Taps into blocksMap.observeDeep()                                 │
│   ├── Transforms Y.Doc events → typed BlockChange                       │
│   ├── Filters by Origin (prevents loops)                                │
│   └── Debounces + dedupes before dispatching                            │
│                                                                          │
│   ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│   LAYER 0: Y.DOC STORE (source of truth)                                │
│   ├── blocksMap: Y.Map<Y.Map>                                           │
│   ├── Origin-tagged transactions                                        │
│   └── All mutations flow through here                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Key Separations (What Was Collapsed)

**CRITICAL**: The original plan collapsed these distinct concepts:

| Concept | Responsibility | Why Separate |
|---------|---------------|--------------|
| **Change Emitter** | Transform Y.Doc events → typed BlockChange | Pure event translation |
| **Hook Registry** | Dispatch events to registered handlers | Priority ordering, sync/async |
| **Metadata Hook** | Extract markers/wikilinks → block.metadata | One of many hooks |
| **Index Hook** | Queue updates for Tantivy | Another hook (lower priority) |

**Wrong**: "Change Emitter" that also does batching and dispatching
**Right**: Emitter emits, Registry dispatches, Hooks process

### 2.3 Origin Enum (Prevents Infinite Loops)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    User,       // Human keystroke or click
    Hook,       // System hook (metadata extraction)
    Remote,     // CRDT sync from server/peer
    Agent,      // AI agent action
    BulkImport, // Batch operations
}
```

**Rule**: Hooks with `Origin::Hook` do NOT trigger other hooks.

### 2.4 Hook Interface

```rust
pub trait BlockHook: Send + Sync {
    /// Hook identifier for logging/debugging
    fn name(&self) -> &'static str;

    /// Priority (lower = earlier). Built-in hooks use 0-100.
    fn priority(&self) -> i32;

    /// Should this hook run synchronously before returning?
    fn is_sync(&self) -> bool;

    /// Origins this hook responds to (None = all)
    fn accepts_origins(&self) -> Option<Vec<Origin>>;

    /// Process a batch of changes
    fn process(&self, changes: &[BlockChange], store: &YDocStore);
}
```

**Built-in hooks**:
| Hook | Priority | Sync | Purpose |
|------|----------|------|---------|
| MetadataHook | 10 | true | Extract markers to block.metadata |
| PageNameIndexHook | 20 | true | Update autocomplete index |
| TantivyIndexHook | 50 | false | Queue for Tantivy writer |

### 2.5 Metadata Storage (Y.Doc, Not Just Tantivy)

**CRITICAL**: Extracted metadata lives in Y.Doc, not just Tantivy.

```typescript
// Block.metadata is CRDT-synced
block.metadata = {
  markers: [
    { type: 'ctx', value: 'working on search' },
    { type: 'project', value: 'floatty' }
  ],
  outlinks: ['Page One', 'Meeting Notes'],
  isStub: false
};
```

**Why**:
- Metadata travels with block via CRDT sync
- Frontend can read without Tauri call
- Backlinks computed from outlinks (no separate storage)

### 2.6 Where Tantivy Fits

```
Tantivy = DISCOVERY layer, not source of truth

┌────────────────────────────────────────────────────────────┐
│  Query: "meeting notes about floatty"                      │
│                    │                                        │
│                    ▼                                        │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Tantivy Search                                      │  │
│  │  - BM25 text search                                  │  │
│  │  - Facet filtering (type:ctx, marker:project)        │  │
│  │  - Returns: [block_id_1, block_id_2, ...]            │  │
│  └─────────────────────────────────────────────────────┘  │
│                    │                                        │
│                    ▼                                        │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Y.Doc Retrieval                                     │  │
│  │  - Get full block by ID                              │  │
│  │  - Get neighbors for context                         │  │
│  │  - Already have metadata (CRDT-synced)               │  │
│  └─────────────────────────────────────────────────────┘  │
│                    │                                        │
│                    ▼                                        │
│  ┌─────────────────────────────────────────────────────┐  │
│  │  Frontend Render                                     │  │
│  │  - Display results with context                      │  │
│  │  - Click to navigate                                 │  │
│  └─────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

---

## Part 3: Feature Flow Examples

### 3.1 Flow: User Types `[[New Page]]`

```
STEP 1: Input
─────────────────────────────────────────────────────────────
  User types "[[New Page]]" in block B1

  BlockItem.tsx:handleInput() fires immediately
    ↓
  debouncedUpdateContent(B1, "[[New Page]]") queued  [150ms debounce]
    ↓
  After 150ms: store.updateBlockContent(B1, "[[New Page]]")

STEP 2: Y.Doc Mutation
─────────────────────────────────────────────────────────────
  useBlockStore.ts:updateBlockContent()
    ↓
  yDoc.transact(() => {
    blockMap.set('content', '[[New Page]]');
  }, Origin.User);  // ← NEW: Origin tagging

STEP 3: Change Emitter (Layer 1)
─────────────────────────────────────────────────────────────
  blocksMap.observeDeep() fires
    ↓
  ChangeEmitter transforms event:
    BlockChange::ContentChanged {
      id: "B1",
      old_content: "",
      new_content: "[[New Page]]",
      origin: Origin::User
    }
    ↓
  Debounce + dedupe (1-2 seconds)
    ↓
  Dispatch to HookRegistry

STEP 4: Hook Registry (Layer 2)
─────────────────────────────────────────────────────────────
  HookRegistry.dispatch(changes)
    ↓
  Sort hooks by priority:
    [MetadataHook(10), PageNameIndexHook(20), TantivyIndexHook(50)]
    ↓
  For each hook:
    - Check accepts_origins() → MetadataHook accepts User, not Hook
    - If sync: process() and wait
    - If async: spawn task

STEP 5: Metadata Hook (Priority 10, Sync)
─────────────────────────────────────────────────────────────
  MetadataHook.process([change])
    ↓
  Parse content for [[wikilinks]]:
    outlinks = ["New Page"]
    ↓
  Update block.metadata via store:
    store.updateBlockMetadata(B1, {
      outlinks: ["New Page"]
    }, Origin::Hook);  // ← Hook origin prevents re-trigger

STEP 6: PageNameIndex Hook (Priority 20, Sync)
─────────────────────────────────────────────────────────────
  PageNameIndexHook.process([change])
    ↓
  Check if "New Page" exists under pages::
    - If not: add to stub_pages set (for autocomplete)
    ↓
  Autocomplete now includes "New Page (stub)"

STEP 7: Tantivy Index Hook (Priority 50, Async)
─────────────────────────────────────────────────────────────
  TantivyIndexHook.process([change])
    ↓
  Queue index update:
    IndexUpdate::Update {
      doc_id: "B1",
      content: "[[New Page]]",
      outlinks: ["New Page"],
      block_type: "text",
      updated_at: now()
    }
    ↓
  Writer actor processes queue (batched)
    ↓
  Tantivy index updated (searchable)

RESULT: User sees autocomplete, block metadata synced via CRDT
```

### 3.2 Flow: User Opens `[[` Autocomplete

```
STEP 1: Trigger
─────────────────────────────────────────────────────────────
  User types "[["

  BlockItem.tsx detects pattern
    ↓
  Show autocomplete dropdown (immediate, no debounce)
    ↓
  invoke('get_autocomplete', { prefix: '' })

STEP 2: Tauri Command
─────────────────────────────────────────────────────────────
  commands/autocomplete.rs
    ↓
  PageNameIndex.search("")  // All pages
    ↓
  Returns: [
    { name: "Existing Page", is_stub: false },
    { name: "New Page", is_stub: true }
  ]

STEP 3: Frontend Display
─────────────────────────────────────────────────────────────
  Dropdown shows:
    - Existing Page
    - New Page (stub)  ← Visual indicator
    ↓
  User types "new"
    ↓
  Filter locally (no Tauri call)
    ↓
  Show: "New Page (stub)"

STEP 4: Selection
─────────────────────────────────────────────────────────────
  User selects "New Page"
    ↓
  Insert "[[New Page]]" at cursor
    ↓
  Flow continues from 3.1

LATENCY BUDGET: <50ms (chirp, not request)
```

### 3.3 Flow: Full-Text Search "meeting notes"

```
STEP 1: Query Input
─────────────────────────────────────────────────────────────
  User opens search panel
  Types: "meeting notes"

  SearchInput.tsx
    ↓
  Debounce 200ms (search is a "request", not "chirp")
    ↓
  invoke('search_blocks', {
    query: "meeting notes",
    filters: { types: null, markers: null },
    limit: 20
  })

STEP 2: Search Service
─────────────────────────────────────────────────────────────
  services/search.rs
    ↓
  SearchService.search(query, filters, limit)
    ↓
  Build Tantivy query:
    content:"meeting" AND content:"notes"
    ↓
  Execute with TopDocs collector
    ↓
  Return hits with scores:
    [
      { doc_id: "B42", score: 0.85, title: "Meeting Notes..." },
      { doc_id: "B17", score: 0.72, title: "ctx::meeting..." }
    ]

STEP 3: Enrich Results
─────────────────────────────────────────────────────────────
  For each hit.doc_id:
    ↓
  YDocStore.get_block(doc_id)
    ↓
  Already has:
    - Full content
    - metadata.markers
    - metadata.outlinks
    ↓
  Get context (optional):
    YDocStore.get_neighbors(doc_id, 2)

STEP 4: Frontend Display
─────────────────────────────────────────────────────────────
  SearchResults.tsx receives:
    [
      {
        id: "B42",
        title: "Meeting Notes 2026-01-10",
        snippet: "...discussed floatty search...",
        markers: [{ type: 'project', value: 'floatty' }],
        score: 0.85
      },
      ...
    ]
    ↓
  Render result cards
  Click → zoom to block

LATENCY BUDGET: <200ms (archaeology mode allows up to 2s)
```

### 3.4 Flow: Remote CRDT Update (No Hooks)

```
STEP 1: Server Push
─────────────────────────────────────────────────────────────
  floatty-server sends Y.Doc update via WebSocket

  useSyncedYDoc.ts receives update
    ↓
  yDoc.applyUpdate(update)
    ↓
  Transaction origin = 'remote' (or Origin::Remote with enum)

STEP 2: Change Emitter Filters
─────────────────────────────────────────────────────────────
  blocksMap.observeDeep() fires
    ↓
  ChangeEmitter checks origin:
    origin === Origin::Remote → SKIP hooks
    ↓
  Only update local SolidJS signals for display

REASON: Remote peer already extracted metadata.
        block.metadata is CRDT-synced, comes with update.
        No need to re-extract.

STEP 3: Tantivy Index (Special Case)
─────────────────────────────────────────────────────────────
  TantivyIndexHook DOES accept Origin::Remote
    ↓
  Local Tantivy index needs to include remote changes
    ↓
  Queue index update (metadata already extracted)

RESULT: Remote changes display immediately, index stays current
```

---

## Part 4: Corrected Work Unit Plan

### 4.1 What Was Collapsed (Problems)

| Original Plan | Problem |
|---------------|---------|
| "Change Emitter Interface" (1.1) | Mixed event types with dispatch |
| "Store Integration" (1.2) | Emitter AND hooks merged |
| "Debounce + Dedupe" (1.3) | Belongs in emitter, not separate |
| Metadata extraction units | Missing hook registration step |

### 4.2 Corrected Unit Breakdown

```
PHASE 0: ORIGIN TAGGING (unchanged)
├── 0.1: Origin Enum
└── 0.2: Origin in Y.Doc Transactions

PHASE 1: CHANGE EMITTER (refined)
├── 1.1: BlockChange Types        ← Define event types only
├── 1.2: Y.Doc Observer Wrapper   ← Tap observeDeep, transform events
└── 1.3: Debounce + Dedupe        ← Batch before dispatch

PHASE 1.5: HOOK REGISTRY (NEW - was collapsed)
├── 1.5.1: Hook Interface         ← Trait definition, priority
├── 1.5.2: Registry Implementation ← Registration, dispatch loop
└── 1.5.3: Origin Filtering       ← Hooks specify accepted origins

PHASE 2: METADATA EXTRACTION
├── 2.1: Metadata Schema          ← TypeScript + Rust types
├── 2.2: MetadataHook             ← Registered hook, extracts markers
├── 2.3: Wikilink Extraction      ← Extend MetadataHook
└── 2.4: PageNameIndex + Hook     ← PageNameIndexHook registered

PHASE 3: TANTIVY INTEGRATION
├── 3.1: Tantivy Setup
├── 3.2: Writer Actor
├── 3.3: TantivyIndexHook         ← Registered hook (async)
├── 3.4: Search Service
└── 3.5: Tauri Commands
```

### 4.3 Unit Dependency Graph

```
           ┌─────────────────────────────────────────────────┐
           │                                                  │
           │                   0.1 Origin Enum                │
           │                        │                         │
           │                        ▼                         │
           │                   0.2 Origin Y.Doc               │
           │                        │                         │
           │           ┌────────────┴────────────┐           │
           │           ▼                         ▼            │
           │    1.1 BlockChange           1.5.1 Hook         │
           │    Types                     Interface           │
           │           │                         │            │
           │           ▼                         ▼            │
           │    1.2 Observer              1.5.2 Registry      │
           │    Wrapper                   Implementation      │
           │           │                         │            │
           │           ▼                         │            │
           │    1.3 Debounce              1.5.3 Origin        │
           │    + Dedupe                  Filtering           │
           │           │                         │            │
           │           └────────────┬────────────┘           │
           │                        ▼                         │
           │              ┌─────────────────┐                │
           │              │ INTEGRATION     │                │
           │              │ Emitter wired   │                │
           │              │ to Registry     │                │
           │              └─────────────────┘                │
           │                        │                         │
           │           ┌────────────┼────────────┐           │
           │           ▼            ▼            ▼            │
           │    2.1 Metadata   2.4 PageName   3.1 Tantivy    │
           │    Schema         Index          Setup           │
           │           │            │            │            │
           │           ▼            ▼            ▼            │
           │    2.2 Metadata   2.4 PageName   3.3 Index      │
           │    Hook           Hook           Hook            │
           │                                                  │
           └─────────────────────────────────────────────────┘
```

---

## Part 5: Leverage Existing Code

### 5.1 Reuse: inlineParser.ts

**DON'T** recreate wikilink parsing in Rust.

**DO** call existing TypeScript parser from frontend, pass extracted data to Rust.

```typescript
// Frontend extracts metadata using existing parser
import { parseAllInlineTokens } from './lib/inlineParser';

const tokens = parseAllInlineTokens(block.content);
const outlinks = tokens
  .filter(t => t.type === 'wikilink')
  .map(t => t.target);

// Send to Rust with block update
invoke('update_block_metadata', {
  id: block.id,
  metadata: { outlinks }
});
```

**Alternative**: If Rust needs parsing, port the algorithm but reference inlineParser.ts as spec.

### 5.2 Reuse: Handler Registry Pattern

**DON'T** invent new dispatch pattern.

**DO** mirror `src/lib/handlers/registry.ts` for Rust hooks.

```rust
// Rust mirrors the TS pattern
pub struct HookRegistry {
    hooks: Vec<Box<dyn BlockHook>>,
}

impl HookRegistry {
    pub fn register(&mut self, hook: Box<dyn BlockHook>) {
        self.hooks.push(hook);
        self.hooks.sort_by_key(|h| h.priority());
    }

    pub fn dispatch(&self, changes: &[BlockChange], store: &YDocStore) {
        for hook in &self.hooks {
            if hook.accepts(changes[0].origin()) {
                hook.process(changes, store);
            }
        }
    }
}
```

### 5.3 Reuse: Y.Doc Observer

**DON'T** create separate event system.

**DO** wrap existing `blocksMap.observeDeep()`.

```typescript
// Wrap existing observer
blocksMap.observeDeep(events => {
  // Existing: update SolidJS signals
  updateSignals(events);

  // NEW: emit typed BlockChange for hooks
  const changes = events.flatMap(e => transformToBlockChange(e));
  if (changes.length > 0) {
    changeEmitter.emit(changes);
  }
});
```

### 5.4 Reuse: Services Pattern

**DON'T** put business logic in Tauri commands.

**DO** follow existing `src-tauri/src/services/` pattern.

```
src-tauri/src/
├── services/
│   ├── ctx.rs          # Existing: ctx:: queries
│   ├── execution.rs    # Existing: shell/AI execution
│   ├── search.rs       # NEW: Tantivy queries
│   └── hooks.rs        # NEW: Hook registry
├── commands/
│   ├── ctx.rs          # Thin adapter
│   └── search.rs       # NEW: Thin adapter
```

---

## Part 6: Debounce Strategy

### 6.1 Three Debounce Layers

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        COMPLETE DEBOUNCE ARCHITECTURE                    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  LAYER 1: INPUT DEBOUNCE (150ms)                                        │
│  Location: BlockItem.tsx                                                 │
│  Trigger: Every keystroke                                                │
│  Purpose: Batch keystrokes before Y.Doc mutation                        │
│  Output: store.updateBlockContent() call                                │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  LAYER 2: SYNC DEBOUNCE (50ms)                                          │
│  Location: useSyncedYDoc.ts                                             │
│  Trigger: Y.Doc transaction                                              │
│  Purpose: Batch server sync                                              │
│  Output: HTTP POST to floatty-server                                    │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  LAYER 3: HOOK DEBOUNCE (1-2 seconds)                                   │
│  Location: ChangeEmitter (NEW)                                          │
│  Trigger: Y.Doc observer event                                           │
│  Purpose: Batch changes before hook dispatch                             │
│  Output: HookRegistry.dispatch(batch)                                   │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────  │
│                                                                          │
│  LAYER 4: INDEX WRITER BATCH (configurable)                             │
│  Location: TantivyWriter actor (NEW)                                    │
│  Trigger: Index update request                                           │
│  Purpose: Batch Tantivy commits                                         │
│  Output: Tantivy commit()                                                │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Why Different Timings

| Layer | Timing | Why |
|-------|--------|-----|
| Input | 150ms | Fast enough for typing feel, batches bursts |
| Sync | 50ms | Server needs quick updates for collaboration |
| Hooks | 1-2s | Metadata extraction not latency-sensitive |
| Tantivy | 2-5s | Index commits expensive, batch aggressively |

---

## Part 7: What NOT to Build

### 7.1 Anti-Patterns

| Don't | Why | Do Instead |
|-------|-----|------------|
| Separate EventBus class | Y.Doc observers already provide events | Wrap observers |
| Rust wikilink parser | TS parser exists, tested | Reuse or port with TS as spec |
| Store metadata only in Tantivy | Not CRDT-synced | Store in block.metadata (Y.Doc) |
| Sync hooks for Tantivy | Blocks user input | Async hook with queue |
| Complex hook priority system | YAGNI | Simple integer priority |
| Plugin system for hooks | YAGNI for MVP | Hardcoded hooks, extract later |

### 7.2 Phase 5+ (Not Now)

These are explicitly deferred:
- Vector embeddings / semantic search
- Lua hook scripting
- External plugin system
- Real-time collaboration cursors
- Version history / time travel

---

## Summary

### Current → Target

| Current | Target | Gap |
|---------|--------|-----|
| String origin ('remote') | Origin enum | Unit 0.1-0.2 |
| Direct Y.Doc observer | Wrapped observer + emitter | Unit 1.1-1.3 |
| No hook system | Hook registry with priority | Unit 1.5.x |
| Unused metadata field | Populated by MetadataHook | Unit 2.1-2.3 |
| No search | Tantivy integration | Unit 3.x |

### Key Principles

1. **Y.Doc is truth** - Tantivy is discovery, Y.Doc is retrieval
2. **Index is ephemeral** - Nuked and rebuilt from Y.Doc on every startup. Correctness over warm-start speed. See [ADR-005](adrs/ADR-005-search-index-ephemeral.md).
3. **Metadata in CRDT** - block.metadata travels with sync
4. **Wrap, don't replace** - Build on existing observers
5. **Reuse TS parsing** - Don't recreate in Rust
6. **Priority hooks** - Simple ordering, sync/async distinction
7. **Origin prevents loops** - Hook writes don't trigger hooks

---

## Part 8: Claude Code Integration

### 8.1 What Became Rules (Extracted)

These patterns are universally true and live in `.claude/rules/`:

| Rule File | Content |
|-----------|---------|
| `ydoc-patterns.md` | Y.Doc source of truth, metadata in CRDT, wrap observers |
| `do-not.md` | Extended with Y.Doc/Search and Rust Backend anti-patterns |

### 8.2 What Was Deferred (Validate First)

**Search-specific slash commands** (e.g., `/search-unit:start`):
- Defer until Units 0.1 → 1.3 completed manually
- Existing floatty-foundation pattern may need adjustment for search
- Different test suites, scopes, handoff needs

**Scope-guard hooks** (PreToolUse blocking out-of-scope edits):
- Defer until unit boundaries validated through practice
- Adding friction before knowing if scopes are right
- Manual discipline sufficient for initial units

**Skills for search operations**:
- No search exists yet to operate on
- Skills should emerge from repeated patterns, not upfront design

### 8.3 Why This Approach

**Simple primitives that compound** > **Perfect harness upfront**

1. Rules are universal invariants - always apply, low friction
2. Commands should encode validated workflows - not speculative ones
3. Hooks should address observed pain points - not imagined ones

After Phase 0-1:
- Evaluate if handoff format worked
- Identify repeated friction points
- Then extract commands/hooks for those specific patterns

---

### Next Step

Start Unit 0.1: Origin Enum
- Read this document
- Read SEARCH_ARCHITECTURE_SNAPSHOT.md
- Read `.claude/rules/ydoc-patterns.md` (new)
- Follow entry/exit protocol
