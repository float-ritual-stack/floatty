# Architecture Review & Scaling Recommendations
**Date**: 2026-01-08  
**Context**: Stress test with 6 concurrent turtle agents creating 3,278 new blocks (42% growth to 9,882 blocks)  
**Symptom**: New tab load "chuuuuugs" - UI freezes during initial render

---

## Executive Summary

Floatty is architecturally **sound** - the headless-first design, CRDT sync, and handler registry are excellent foundations. Tonight's stress test revealed the **classic N-body problem**: every component touches every block on every render. The pain isn't the architecture - it's the **absence of lazy loading and spatial indexing**.

**Quick Wins** (1-2 weeks each):
1. Virtual scrolling for 10K+ blocks
2. Block query API (search without downloading everything)
3. Subtree lazy loading

**Important Foundations** (2-4 weeks each):
4. Backlink index (client-side first, then server)
5. Block-level WebSocket subscriptions
6. Smarter CRDT compaction

---

## What Tonight's Stress Test Revealed

### The Numbers

```
Start:  6,604 blocks (11,016 lines, 584KB export)
End:    9,882 blocks (15,687 lines, 895KB export)
Growth: +3,278 blocks (+42.4%) in ~4 hours

CRDT Layer:
- 1 snapshot (5.6 MB)
- 95 deltas (~47KB total)
- Peak: 8 updates/second during turtle work

Pain Point:
- Fresh tab load downloads ALL 9,882 blocks
- Renders ALL blocks (no virtualization)
- Computes backlinks on client (O(n²) for wikilinks)
```

### The User Experience

**Current behavior on new tab open:**
1. GET `/api/v1/blocks` → **600KB+ JSON**
2. Y.applyUpdate with full state → **5.6 MB CRDT snapshot**
3. Outliner renders 9,882 BlockItem components
4. Each component:
   - Parses inline tokens (`**bold**`, `*italic*`, `` `code` ``)
   - Checks if collapsed
   - Computes indentation level
   - Sets up keyboard handlers

**Result**: 5-10 second freeze on my machine with 10K blocks.

---

## Current Architecture (The Good Parts)

### ✅ Headless-First Design

```
┌──────────┐  ┌──────────┐  ┌──────────┐
│ Desktop  │  │   CLI    │  │  Agent   │
└────┬─────┘  └────┬─────┘  └────┬─────┘
     └──────┬──────┴───────┬──────┘
            │  HTTP/WS     │
      ┌─────▼──────────────▼─────┐
      │    floatty-server        │
      └──────────┬───────────────┘
           ┌─────▼─────┐
           │  SQLite   │
           └───────────┘
```

**This is PERFECT**. Don't touch it. The multi-client architecture is the right abstraction.

### ✅ CRDT with Append-Only WAL

Yjs + SQLite persistence with occasional compaction is textbook. The 5.6MB→47KB delta compression ratio (99.2%!) proves it works.

### ✅ Handler Registry (Planned)

From `FLOATTY_HANDLER_REGISTRY.md` - this is the right way to make execution portable between Tauri and Axum.

### ✅ Hook System (Planned)

The middleware pattern from `FLOATTY_HOOK_SYSTEM.md` is spot-on for extensibility.

---

## The Bottlenecks (What Needs Fixing)

### 🔴 1. No Virtual Scrolling

**Problem**: Outliner renders all 9,882 blocks on mount, even if only 50 are visible.

**Impact**: 
- Initial render: O(n) component creation
- Memory: ~10KB per BlockItem × 9882 = ~100MB DOM
- Scroll performance: Browser struggles with massive tree

**Solution**: Virtual scrolling with tree-aware windowing

```typescript
// src/components/VirtualOutliner.tsx (NEW)

interface VirtualOutlinerProps {
  paneId: string;
  visibleHeight: number;  // Container height in px
}

function VirtualOutliner(props: VirtualOutlinerProps) {
  // Only render blocks in viewport + buffer
  const [scrollTop, setScrollTop] = createSignal(0);
  
  const visibleBlocks = createMemo(() => {
    const ITEM_HEIGHT = 32; // avg block height
    const BUFFER = 10;      // render extra blocks above/below
    
    const startIdx = Math.max(0, Math.floor(scrollTop() / ITEM_HEIGHT) - BUFFER);
    const endIdx = Math.min(
      flattenedBlocks().length,
      Math.ceil((scrollTop() + props.visibleHeight) / ITEM_HEIGHT) + BUFFER
    );
    
    return flattenedBlocks().slice(startIdx, endIdx);
  });
  
  return (
    <div 
      style={{ height: `${flattenedBlocks().length * 32}px` }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <For each={visibleBlocks()}>
        {(block) => <BlockItem block={block} />}
      </For>
    </div>
  );
}
```

**Wins**:
- Render 50-100 blocks instead of 10,000
- Constant memory footprint
- Instant tab opens

**Library Options**:
- `@tanstack/virtual` (framework-agnostic)
- `solid-virtual` (SolidJS-specific)
- Roll your own (simple case)

**Complexity**: Medium (2-3 days for basic, 1 week for tree-aware)

---

### 🔴 2. No Query API

**Problem**: Agents/CLI must `GET /api/v1/blocks` (600KB) to find blocks by content.

**From tonight's stress test**:
```bash
# What turtles did to find ctx:: markers:
curl http://127.0.0.1:8765/api/v1/blocks | jq '.blocks[] | select(.blockType == "ctx")'

# Downloaded 9,882 blocks to find 59 ctx:: markers!
```

**Solution**: Add search endpoints

```rust
// floatty-server/src/api.rs

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,           // Content search
    block_type: Option<String>,  // Filter by type
    parent_id: Option<String>,   // Filter by parent
    limit: Option<usize>,        // Max results
}

async fn search_blocks(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<Block>>> {
    // Query the Y.Doc blocksMap
    let blocks = state.store.search(&query)?;
    Ok(Json(blocks))
}
```

**Endpoints to add**:
```
GET /api/v1/blocks/search?q=ctx::2026-01-07
GET /api/v1/blocks/search?type=ctx&limit=100
GET /api/v1/blocks/:id/children?depth=2
GET /api/v1/blocks/:id/tree?max_depth=5
```

**Wins**:
- Turtles download 5KB instead of 600KB
- Agents can query without full state sync
- Enables "show me children of X" workflows

**Complexity**: Low (1-2 days)

**Priority**: **HIGH** - This is what `API_IMPROVEMENTS.md` is asking for

---

### 🔴 3. No Lazy Subtree Loading

**Problem**: Y.Doc sync loads entire state on connect. Can't defer loading of collapsed subtrees.

**Current flow**:
```
Desktop opens → GET /api/v1/state → 5.6MB snapshot → All blocks in memory
```

**Better flow**:
```
Desktop opens → GET /api/v1/roots → Just root IDs
User expands block → GET /api/v1/blocks/:id/children → Load on demand
```

**Implementation**:

```typescript
// src/hooks/useBlockStore.ts (MODIFIED)

interface BlockState {
  blocks: Record<string, Block>;
  rootIds: string[];
  loadedSubtrees: Set<string>;  // Track which subtrees are loaded
  isInitialized: boolean;
}

const lazyLoadChildren = async (blockId: string) => {
  if (state.loadedSubtrees.has(blockId)) return; // Already loaded
  
  const children = await httpClient.getChildren(blockId, { depth: 1 });
  
  batch(() => {
    for (const child of children) {
      setState('blocks', child.id, child);
    }
    setState('loadedSubtrees', (prev) => new Set([...prev, blockId]));
  });
};
```

**Challenges**:
- CRDT assumes full state sync (design tension)
- Need "stub" blocks for unloaded children
- Complexity with undo/redo across lazy boundaries

**Alternative**: Keep Y.Doc full sync, but defer **rendering** via virtual scroll

**Complexity**: High (1-2 weeks, tricky CRDT implications)

**Priority**: Medium (virtual scroll gives 80% of benefit with 20% of complexity)

---

### 🟡 4. No Backlink Index

**Problem**: No `[[wikilink]]` syntax yet, but when added, computing backlinks client-side = O(n²).

**From ARCHITECTURE.md**:
> ❌ No `[[wiki-link]]` syntax  
> ❌ No backlink tracking

**When you add wikilinks**, you'll need:

```rust
// floatty-server/src/backlinks.rs (NEW)

struct BacklinkIndex {
    // blockId → Set<blockIds that reference it>
    links_to: HashMap<String, HashSet<String>>,
}

impl BacklinkIndex {
    fn rebuild(&mut self, blocks: &HashMap<String, Block>) {
        self.links_to.clear();
        for block in blocks.values() {
            for target in extract_wikilinks(&block.content) {
                self.links_to.entry(target).or_default().insert(block.id.clone());
            }
        }
    }
    
    fn get_backlinks(&self, block_id: &str) -> Vec<String> {
        self.links_to.get(block_id).cloned().unwrap_or_default().into_iter().collect()
    }
}
```

**Start client-side**:
```typescript
// src/hooks/useBacklinks.ts (NEW)
export function useBacklinks() {
  const [index, setIndex] = createSignal<Map<string, Set<string>>>(new Map());
  
  createEffect(() => {
    const blocks = blockStore.blocks;
    const newIndex = new Map();
    
    for (const block of Object.values(blocks)) {
      for (const link of extractWikilinks(block.content)) {
        if (!newIndex.has(link)) newIndex.set(link, new Set());
        newIndex.get(link)!.add(block.id);
      }
    }
    
    setIndex(newIndex);
  });
  
  return (blockId: string) => index().get(blockId) || new Set();
}
```

**Then migrate to server** when client-side index becomes slow (>50K blocks).

**Complexity**: Low (client), Medium (server with CRDT updates)

**Priority**: Low (no wikilinks yet), but **plan for it** in Block schema

---

### 🟡 5. No Block-Level WebSocket Subscriptions

**Problem**: Desktop gets WebSocket broadcasts for ALL block changes, even in collapsed trees you're not viewing.

**Current**:
```typescript
ws.onmessage = (event) => {
  const update = base64ToBytes(event.data);
  Y.applyUpdate(doc, update);  // Apply ALL updates
};
```

**Better** (when you have 100K+ blocks):
```typescript
// Client subscribes to specific blocks
ws.send(JSON.stringify({
  type: 'subscribe',
  blockIds: ['root-1', 'root-2', ...visibleRoots]
}));

// Server only broadcasts updates for subscribed blocks
```

**Complexity**: Medium (1 week, requires subscription tracking in server)

**Priority**: Low (premature optimization until 50K+ blocks)

---

### 🟡 6. CRDT Compaction Strategy

**Current**: Append-only with manual compaction.

**From `ctx_markers.db`**:
- Update #1: 5.6 MB snapshot
- Updates #2-96: 47KB deltas (0.8% of snapshot size!)

**The problem**: When to compact?

**Strategy options**:

1. **Time-based**: Compact every 24 hours
2. **Delta count**: Compact after 1000 updates
3. **Size-based**: Compact when deltas exceed 10% of snapshot size

**Recommendation**: Hybrid

```rust
// floatty-server/src/compaction.rs (NEW)

struct CompactionPolicy {
    max_deltas: usize,        // e.g., 1000
    max_delta_ratio: f64,     // e.g., 0.10 (10% of snapshot)
    min_interval_hours: u64,  // e.g., 6
}

async fn should_compact(&self, doc_key: &str) -> bool {
    let updates = self.db.get_ydoc_updates(doc_key)?;
    if updates.len() < 2 {
        return false; // Need at least snapshot + 1 delta
    }
    
    let snapshot_size = updates[0].len();
    let delta_size: usize = updates[1..].iter().map(|u| u.len()).sum();
    let delta_ratio = delta_size as f64 / snapshot_size as f64;
    
    let last_compact = self.db.get_last_compact_time(doc_key)?;
    let hours_since = (now() - last_compact).as_hours();
    
    updates.len() > self.max_deltas 
        || delta_ratio > self.max_delta_ratio
        || hours_since > self.min_interval_hours
}
```

**Complexity**: Low (1-2 days)

**Priority**: Medium (nice-to-have, current compaction works)

---

## Recommended Roadmap

### Phase 1: Immediate Wins (1-2 weeks)

**Goal**: Fresh tab opens in <500ms with 10K blocks

0. **Handler registry consolidation** (2-3 days) - DO THIS FIRST
   - Create `src/lib/handlers/` directory with registry pattern
   - Extract sh/ai/daily handlers into separate files
   - Unify BlockItem.tsx dispatch (remove hardcoded checks)
   - **Why first**: Pattern is solidifying NOW, clean up before it spreads
   - **Result**: Adding door:: or new handlers = 2 files touched
   - See `docs/architecture/HANDLER_REGISTRY_IMPLEMENTATION.md`

1. **Virtual scrolling** (3-5 days)
   - Use `@tanstack/virtual` or `solid-virtual`
   - Tree-aware windowing (render visible + buffer)
   - Preserve focus/selection across virtual boundaries

2. **Search API** (2 days)
   - `GET /api/v1/blocks/search`
   - `GET /api/v1/blocks/:id/children`
   - Support query params: `?type=`, `?q=`, `?limit=`

3. **Query optimization** (1 day)
   - Cache flattened block list for virtual scroll
   - Debounce Y.Doc observers (batch UI updates)

**Expected result**: 
- Handler ceremony reduced from 4-7 files to 2 files
- Tab opens render 50-100 blocks instead of 10,000
- Turtle agents query without downloading full state
- Smooth scrolling even with 50K blocks

---

### Phase 2: Foundations (2-4 weeks)

**Goal**: Architecture supports 100K blocks + multi-user

4. **Backlink index** (client-side) (3-5 days)
   - Add `[[wikilink]]` parser to `inlineParser.ts`
   - Build client-side index on Y.Doc changes
   - UI: Backlinks panel below editor
   - **Defer server-side** until >50K blocks

5. **Handler registry - Rust backend** (5-7 days)
   - From `FLOATTY_HANDLER_REGISTRY.md`
   - Frontend registry done in Phase 1
   - Now: Make handlers Tauri-or-Axum agnostic
   - Enables server-side execution for CI/agents

6. **Hook system** (5-7 days)
   - From `FLOATTY_HOOK_SYSTEM.md`
   - Middleware for pre/post execution
   - Enables plugins (webhooks, logging, etc.)

**Expected result**:
- Wikilinks work smoothly with backlinks
- Agents can trigger server-side execution
- Plugin system for extensibility

---

### Phase 3: Advanced (4-8 weeks)

**Goal**: Scale to 500K blocks, multi-user collab

7. **Lazy subtree loading** (1-2 weeks)
   - Stub blocks for unloaded children
   - Load on expand (HTTP request)
   - Tricky CRDT reconciliation

8. **Block-level WS subscriptions** (1 week)
   - Subscribe to visible subtrees only
   - Server tracks subscriptions per client
   - Reduces broadcast bandwidth

9. **Server-side backlink index** (1 week)
   - Migrate from client to server
   - Incremental index updates on CRDT changes
   - `GET /api/v1/blocks/:id/backlinks`

10. **Full-text search with Tantivy** (1-2 weeks)
    - Integrate Tantivy (Rust full-text search, ~500KB compiled)
    - Fuzzy matching for typo tolerance
    - Background indexing on Y.Doc updates
    - `GET /api/v1/blocks/search?q=full+text+query&fuzzy=true`
    - **Why Tantivy over FTS5**: Built-in fuzzy search, better tokenization, handles 500K+ docs easily

11. **Persistent terminal sessions** (2-3 weeks)
    - Decouple PTY from desktop lifetime (tmux-style)
    - Sessions persist on floatty-server, not client
    - Desktop/CLI can attach/detach to running sessions
    - Enables agent workflows: spawn long-running command, close floatty, results captured
    - **Use case**: Tonight's turtle agents could spawn from within floatty, close UI, agents keep running

**Expected result**:
- Handles 500K+ blocks with typo-tolerant search
- Multi-user collaboration without lag
- Terminal sessions outlive client connections
- Agent orchestration from within outline

---

## Code Smells to Address

### 1. Singleton Y.Doc with Global Observers

**Location**: `useSyncedYDoc.ts:47-52`

```typescript
const sharedDoc = new Y.Doc();
let sharedDocLoaded = false;
// ... singleton pattern
```

**Why it works now**: Single-user desktop app.

**Why it'll break**: Multi-window or multi-user scenarios.

**Fix**: Move Y.Doc to a context provider per-window.

**Priority**: Low (single-user for now)

---

### 2. No `metadata` Field Usage

**From ARCHITECTURE.md**:
> - ❌ No alias/title system  
> - `metadata` field: Every block has optional `metadata?: Record<string, any>` - currently unused

**Recommendation**: Define metadata schema early

```typescript
interface BlockMetadata {
  title?: string;           // For [[wikilinks]] resolution
  aliases?: string[];       // Alternative names
  tags?: string[];          // #tags for filtering
  executionTime?: number;   // ms for sh::/ai:: blocks
  lastExecuted?: number;    // Unix timestamp
  createdBy?: string;       // User ID for multi-user
}
```

**Priority**: Medium (prevents future schema migrations)

---

### 3. Client-Side Backlink Computation

**Current**: None (wikilinks not implemented).

**Future problem**: When added, computing backlinks in `Outliner.tsx` = re-scan all blocks on every render.

**Fix**: See Phase 2, item 4 above.

---

## Architecture Principles to Preserve

### ✅ "Headless-First"

Desktop is one client among many. Keep the API-first design.

### ✅ "Handlers Travel"

From `FLOATTY_MULTI_CLIENT.md`:
> Handler trait works in Tauri today, Axum tomorrow.

This is gold. Don't couple execution logic to Tauri.

### ✅ "Shacks Not Cathedrals"

From your notes:
> Build to understand, not to perfect. Fast iteration over premature abstraction.

The current architecture proves this works. Keep iterating.

### ✅ "The :: Syntax is Sacred"

`sh::`, `ai::`, `ctx::`, `daily::` - this is your DSL. Protect it. Everything else can change.

---

## What NOT to Do

### ❌ Don't Rewrite to Another Framework

SolidJS fine-grained reactivity is **perfect** for this use case. The performance problem isn't the framework - it's the lack of virtualization.

### ❌ Don't Add a Separate Database

SQLite + Y.Doc is the right stack. Adding Postgres/Mongo would be premature.

### ❌ Don't Optimize CRDT Sync

The 99.2% compression ratio (5.6MB → 47KB) proves Yjs is working. Focus on UI bottlenecks first.

### ❌ Don't Build Sub-Documents Yet

From your notes, you're thinking about sub-documents for lazy loading. **Resist this**. Virtual scroll gives 80% of the benefit with 5% of the complexity.

### ✅ DO Add Tantivy for Full-Text Search

**Why it's worth 500KB**:
- Built-in fuzzy matching ("ctx:: 2026-01-07" matches "ctx 2026-01-7")
- Proper tokenization for code/markdown
- Handles 500K+ documents easily (designed for this scale)
- Written in Rust (zero-copy integration with floatty-server)
- Incremental indexing (add/update/delete without full rebuild)

**Integration path**:
```rust
// floatty-server/Cargo.toml
[dependencies]
tantivy = "0.22"

// floatty-server/src/search.rs (NEW)
use tantivy::schema::*;
use tantivy::{Index, IndexWriter};

struct BlockSearchIndex {
    index: Index,
    writer: IndexWriter,
    // Schema: id, content, block_type, parent_id, created_at
}

impl BlockSearchIndex {
    fn index_block(&mut self, block: &Block) {
        let doc = doc!(
            self.schema.id => block.id,
            self.schema.content => block.content,
            self.schema.block_type => block.type_,
        );
        self.writer.add_document(doc);
    }
    
    fn search(&self, query: &str, fuzzy: bool) -> Vec<BlockId> {
        let query_parser = QueryParser::for_index(&self.index, vec![self.schema.content]);
        if fuzzy {
            query_parser.set_fuzzy(1); // Levenshtein distance = 1
        }
        // ... search and return results
    }
}
```

**Hook into Y.Doc updates**:
```rust
// When Y.Doc block changes, update Tantivy index
fn on_block_updated(block: &Block) {
    search_index.delete_by_term(Term::from_field_text(id_field, &block.id));
    search_index.index_block(block);
    search_index.writer.commit(); // Or batch commits
}
```

**API endpoint**:
```rust
GET /api/v1/blocks/search?
    q=ctx::2026-01-07    // Search query
    &fuzzy=true          // Enable fuzzy matching
    &type=ctx            // Filter by block type
    &limit=50            // Max results
```

**Wins**:
- Typo tolerance (your use case!)
- Fast even with 500K blocks
- No need for external Elasticsearch/Meilisearch
- Ships with floatty-server binary (no separate service)

### ✅ DO Add Persistent Terminal Sessions

**The problem tonight**: Agents spawned in floatty terminal die when you close the tab.

**The solution**: Move PTY ownership to floatty-server (tmux-style).

**Architecture**:
```
Current (bad):
  Desktop UI → spawns PTY → owns process lifetime
  Close UI → PTY dies → process dies

New (good):
  Desktop UI → requests session from server → attaches to PTY
  Close UI → PTY persists on server → process keeps running
  Reopen UI → reattach to same session → see output
```

**Implementation**:
```rust
// floatty-server/src/sessions.rs (NEW)

struct TerminalSession {
    id: String,
    pty: PtyPair,           // Master/slave PTY
    pid: u32,               // Child process ID
    created_at: DateTime,
    last_attached: DateTime,
    subscribers: Vec<ClientId>, // WebSocket clients attached
}

struct SessionManager {
    sessions: HashMap<String, TerminalSession>,
}

impl SessionManager {
    fn create_session(&mut self, cmd: &str) -> SessionId {
        let pty = spawn_pty(cmd)?;
        let id = uuid::Uuid::new_v4().to_string();
        
        // PTY output → buffer for late joiners
        let (tx, rx) = mpsc::channel();
        spawn_output_reader(pty.master, tx);
        
        self.sessions.insert(id.clone(), TerminalSession { ... });
        id
    }
    
    fn attach(&mut self, session_id: &str, client: ClientId) {
        // Stream buffered output + live output to client
    }
    
    fn detach(&mut self, session_id: &str, client: ClientId) {
        // Remove client from subscribers, session keeps running
    }
}
```

**API**:
```
POST /api/v1/sessions
  { "command": "python turtle_agent.py" }
  → { "session_id": "abc123" }

WS /api/v1/sessions/:id/attach
  → stream of PTY output

POST /api/v1/sessions/:id/input
  { "data": "user input" }

DELETE /api/v1/sessions/:id
  → kill session
```

**Desktop changes**:
```typescript
// src/lib/terminalManager.ts (MODIFIED)

// Instead of spawning PTY locally:
invoke('spawn_pty', { cmd })

// Request session from server:
const sessionId = await httpClient.createSession({ command: cmd });
const ws = new WebSocket(`ws://127.0.0.1:8765/api/v1/sessions/${sessionId}/attach`);
ws.onmessage = (event) => {
  terminal.write(event.data); // Display output
};
```

**The magic**: Close floatty desktop, session keeps running on server. Reopen, reattach, see all output.

**Use case from tonight**:
```typescript
// In floatty outline, create block:
sh:: python turtle_alpha.py --archaeology --continuous

// Execute → creates persistent session on server
// Close floatty desktop → turtle keeps running
// Come back 2 hours later → reattach → see all discoveries
```

**Bonus**: Multiple clients can attach to same session (pair programming, monitoring).

**Complexity**: Medium-High (2-3 weeks)
- PTY ownership refactor (biggest change)
- Session lifecycle management
- Output buffering for late joiners
- WebSocket attach/detach

**Priority**: High (enables agent orchestration workflows you're already doing)

---

## Testing Strategy for Scale

### Stress Test Harness

```bash
# Generate N blocks via API
for i in {1..10000}; do
  curl -X POST http://127.0.0.1:8765/api/v1/blocks \
    -d "{\"content\": \"Test block $i\", \"parentId\": null}"
done

# Measure tab open time
time open http://localhost:1420  # Tauri webview
```

### Benchmarks to Track

| Metric | Current (10K blocks) | Target (100K blocks) |
|--------|---------------------|---------------------|
| Fresh tab open | 5-10s | <500ms |
| Scroll FPS | 20-30 | 60 |
| Search query | N/A (no API) | <100ms |
| CRDT sync | 5.6MB initial | Same (with lazy load) |

---

## Summary

**The architecture is solid.** Tonight's stress test didn't reveal design flaws - it revealed the **absence of lazy loading**.

**Top 3 priorities**:
1. **Virtual scrolling** (3-5 days) - Biggest UX win
2. **Search API** (2 days) - Unblocks agent workflows
3. **Backlink index** (3-5 days) - Enables wikilinks

With these three, floatty scales to 50K blocks comfortably. Everything else is premature optimization.

**The meta-insight**: You built a CRDT-backed outliner with multi-client architecture in a "shacks not cathedrals" way, and tonight you **successfully tested it with 6 concurrent agents**. That's remarkable. The pain you're feeling now is the pain of success - you need to optimize for scale because the foundation **works**.

🐢 *Turtle Alpha & Beta signing off* ✨
