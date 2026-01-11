# Floatty Search Architecture: Work Unit Plan

**Generated**: 2026-01-10
**Methodology**: Isolated work units with handoff documents
**Principle**: Each unit starts fresh, delivers testable value, documents decisions

---

## Work Unit Structure

Every work unit follows this lifecycle:

```text
┌─────────────────────────────────────────────────────────────────┐
│  PHASE: ENTRY                                                   │
├─────────────────────────────────────────────────────────────────┤
│  1. Read handoff document from previous unit                    │
│  2. Code review: understand current state                       │
│  3. Verify preconditions are met                                │
│  4. Create todo list for this unit                              │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  PHASE: IMPLEMENTATION                                          │
├─────────────────────────────────────────────────────────────────┤
│  1. Implement changes (smallest working increment)              │
│  2. Write tests as you go                                       │
│  3. Update documentation inline                                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  PHASE: EXIT                                                    │
├─────────────────────────────────────────────────────────────────┤
│  1. Run full test suite - must pass                             │
│  2. Code review: look for simplification opportunities          │
│  3. Address any blocking issues                                 │
│  4. Log architectural decisions made                            │
│  5. Review upcoming work - flag any approach changes needed     │
│  6. Write handoff document for next unit                        │
│  7. Commit with clear message                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Work Unit Index

| Unit | Name | Depends On | Delivers | Est. Size | Status |
|------|------|------------|----------|-----------|--------|
| 0.1 | Origin Enum | None | Type definition | Small | ✅ Done |
| 0.2 | Origin in Y.Doc | 0.1 | Tagged transactions | Small | ⏭️ Obviated |
| 0.3 | API Origin + Metadata | 0.1 | API accepts origin, exposes metadata | Medium | ✅ Done |
| 1.1 | BlockChange Types | 0.3 | Event types | Small | ✅ Done |
| 1.2 | Change Emitter | 1.1 | Broadcast channel + emit | Medium | ✅ Done |
| 1.3 | Debounce + Dedupe | 1.2 | Batched changes | Small | ✅ Done |
| 1.5.1 | Hook Interface | 0.3 | Trait definition | Small | ✅ Done |
| **1.5.2** | **Registry Implementation** | 1.5.1 | Registration + dispatch | Medium | **✅ Done** |
| 1.5.3 | Origin Filtering | 1.5.2 | Loop prevention | Small | ⏭️ Merged into 2.1 |
| 2.1 | Metadata Schema | 1.3 + 1.5.3 | Type definitions | Small | ✅ Done |
| 2.2 | Marker Extraction | 2.1 | :: parser hook + wikilinks | Medium | ✅ Done |
| 2.3 | Wikilink Extraction | 2.2 | [[]] parser hook | Medium | ⏭️ Merged into 2.2 |
| 2.2.3 | Hook System Wiring | 2.2 | Runtime hook chain | Medium | ✅ Done |
| 2.4 | PageNameIndex | 2.2.3 | Autocomplete structure | Small | ✅ Done |
| 3.1 | Tantivy Setup | 2.4 | Index + schema | Medium | ✅ Done |
| 3.2 | Writer Actor | 3.1 | Bounded channel + backpressure | Medium | ✅ Done |
| 3.3 | TantivyIndexHook | 3.2 | Delete+Add update logic | Medium | ✅ Done |
| 3.4 | Search Service | 3.3 | Query primitives | Medium | ✅ Done |
| 3.5 | Search API Endpoint | 3.4 | Frontend API | Small | ✅ Done |

---

## Unit 0.1: Origin Enum

### Entry Prompt

```markdown
# Work Unit 0.1: Origin Enum

## Context
You are implementing the Origin enum for floatty's search architecture.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md

## Preconditions
- None (first unit)

## Deliverable
Add Origin enum to floatty-core that tags the source of Y.Doc mutations.

## Entry Checklist
- [ ] Read SEARCH_ARCHITECTURE_SNAPSHOT.md
- [ ] Code review: src-tauri/floatty-core/src/lib.rs
- [ ] Code review: src-tauri/floatty-core/src/store.rs
- [ ] Understand current Y.Doc transaction pattern

## Implementation
1. Create src-tauri/floatty-core/src/origin.rs
2. Define Origin enum: User, Hook, Remote, Agent, BulkImport
3. Add derive macros: Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize
4. Export from lib.rs
5. Add unit tests

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] No clippy warnings
- [ ] Code review: any simplification opportunities?
- [ ] Document: any decisions made?
- [ ] Write handoff for Unit 0.2
```

### Exit Template

```markdown
# Handoff: Unit 0.1 → Unit 0.2

## Completed
- Origin enum at floatty-core/src/origin.rs
- Variants: User, Hook, Remote, Agent, BulkImport
- Exported from lib.rs

## Decisions Made
- [Decision]: [Rationale]

## Files Changed
- floatty-core/src/origin.rs (new)
- floatty-core/src/lib.rs (export added)

## Tests Added
- origin.rs: basic enum tests

## Next Unit Setup
Unit 0.2 should:
- Import Origin into store.rs
- Add origin parameter to mutation methods
- Tag existing callers appropriately

## Blockers for Next Unit
- None / [List any]

## Approach Changes Needed
- None / [List any revisions to plan]
```

---

## Unit 0.2: Origin in Y.Doc

**Status**: ⏭️ Obviated - TypeScript origin tagging completed in commit 5b5227a.
See handoff `docs/handoffs/unit-0.1.md` for details.

The original goal was to add origin tagging to Y.Doc transactions. This was already done on the TypeScript side (all 18 `_doc.transact()` calls now pass `'user'` origin). The Rust side only receives pre-encoded updates via `apply_update()`, so there are no Rust mutation methods to tag.

---

## Unit 0.3: API Origin + Metadata

**Discovered**: 2026-01-10 during architecture exploration
**Surfaced by**: Gap analysis comparing current API vs multi-agent vision
**Impact**: Blocks agent writes being distinguishable from user writes; blocks metadata storage/retrieval

**Size**: Medium
**Scope**: floatty-server/src/api.rs, floatty-core/src/block.rs

### Entry Prompt

```markdown
# Work Unit 0.3: API Origin + Metadata

## Context
You are adding origin parameter and metadata field support to the floatty-server REST API.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 0.1

## Preconditions
- Unit 0.1 complete: Origin enum exists

## Deliverable
API accepts origin param on block mutations, exposes metadata field in responses and PATCH.

## Entry Checklist
- [ ] Read Unit 0.1 handoff
- [ ] Code review: api.rs CreateBlockRequest, UpdateBlockRequest structs
- [ ] Code review: block.rs Block struct (metadata field)
- [ ] Verify Origin enum is exported and usable

## Implementation
1. Uncomment or add `metadata: Option<serde_json::Value>` in Block struct
2. Add `origin: Option<String>` to CreateBlockRequest
3. Add `origin: Option<String>` to UpdateBlockRequest
4. Parse origin string to Origin enum (default: Origin::User)
5. Add metadata to BlockDto response
6. Add PATCH support for metadata field updates
7. Wire origin through to Y.Doc transactions

## Exit Checklist
- [ ] POST /api/v1/blocks accepts `{"origin": "agent", "content": "..."}`
- [ ] GET /api/v1/blocks/:id returns metadata field (null if empty)
- [ ] PATCH /api/v1/blocks/:id can update metadata
- [ ] Origin flows to Y.Doc transaction (verified via observer)
- [ ] `cargo test -p floatty-server` passes
- [ ] `cargo test -p floatty-core` passes

## Handoff
Unit 1.1 (BlockChange Types) can now:
- Include origin in change events
- Include metadata in change events
- Distinguish Agent vs User vs Remote sources
```

---

## Unit 1.1: Change Emitter Interface

### Entry Prompt

```markdown
# Work Unit 1.1: Change Emitter Interface

## Context
You are defining the BlockChange event types for the emitter system.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 0.3

## Preconditions
- Unit 0.3 complete: API accepts origin, exposes metadata

## Deliverable
Type definitions for block change events that downstream systems can subscribe to.

## Entry Checklist
- [ ] Read Unit 0.2 handoff
- [ ] Code review: What block fields exist? (block.rs)
- [ ] Code review: What changes are possible? (store.rs methods)

## Implementation
1. Create src-tauri/floatty-core/src/events.rs
2. Define BlockChange enum:
   - Created { id, origin }
   - ContentChanged { id, old_content, new_content, origin }
   - Moved { id, old_parent, new_parent, origin }
   - Deleted { id, origin }
3. Define BlockChangeBatch for grouped updates
4. Add unit tests

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Types are ergonomic to use
- [ ] Code review: any simplification opportunities?
- [ ] Document: any decisions made?
- [ ] Write handoff for Unit 1.2
```

---

## Unit 1.2: Store Integration

### Entry Prompt

```markdown
# Work Unit 1.2: Store Emitter Integration

## Context
You are wiring the change emitter into YDocStore.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 1.1

## Preconditions
- Unit 1.1 complete: BlockChange types exist

## Deliverable
YDocStore emits BlockChange events when mutations occur.

## Entry Checklist
- [ ] Read Unit 1.1 handoff
- [ ] Verify BlockChange types compile
- [ ] Code review: store.rs - identify all mutation points
- [ ] Decide: channel type (broadcast? mpsc?)

## Implementation
1. Add broadcast channel to YDocStore
2. Emit BlockChange from each mutation method
3. Add subscribe() method to get receiver
4. Test that events fire correctly

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Events fire for all mutation types
- [ ] Multiple subscribers can receive
- [ ] Code review: any simplification opportunities?
- [ ] Document: channel choice rationale
- [ ] Write handoff for Unit 1.3
```

---

## Unit 1.3: Debounce + Dedupe

### Entry Prompt

```markdown
# Work Unit 1.3: Debounce and Dedupe

## Context
You are adding batching to prevent per-keystroke overhead.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 1.2

## Preconditions
- Unit 1.2 complete: Events emitting

## Deliverable
A BatchedChangeCollector that dedupes by block ID and flushes on interval.

## Entry Checklist
- [ ] Read Unit 1.2 handoff
- [ ] Code review: existing debounce patterns (BlockItem.tsx)
- [ ] Decide: flush interval (1s? 2s?)

## Implementation
1. Create BatchedChangeCollector in events.rs
2. Collect changes, dedupe by block ID (keep latest)
3. Flush on interval OR on threshold
4. Expose as wrapper around raw channel

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Rapid changes coalesce correctly
- [ ] Flush triggers on interval
- [ ] Code review: any simplification opportunities?
- [ ] Document: timing decisions
- [ ] Write handoff for Unit 2.1
```

---

## Unit 2.1: Metadata Schema

### Entry Prompt

```markdown
# Work Unit 2.1: Metadata Schema

## Context
You are defining the structure for extracted block metadata.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 1.3

## Preconditions
- Unit 1.3 complete: Change batching works

## Deliverable
TypeScript and Rust types for block.metadata field.

## Entry Checklist
- [ ] Read Unit 1.3 handoff
- [ ] Code review: existing Block interface (blockTypes.ts)
- [ ] Code review: existing inlineParser.ts (what's already extracted?)

## Implementation
1. Define BlockMetadata interface (TypeScript):
   - markers: { type: string, value?: string }[]
   - outlinks: string[]  // [[wikilink]] targets
   - isStub: boolean
2. Mirror in Rust (block.rs)
3. Update Block interface to use typed metadata

## Exit Checklist
- [ ] `npm run test` passes
- [ ] `cargo test` passes
- [ ] Types align between TS and Rust
- [ ] Code review: any simplification opportunities?
- [ ] Write handoff for Unit 2.2
```

---

## Unit 2.2: Marker Extraction

### Entry Prompt

```markdown
# Work Unit 2.2: Marker Extraction Hook

## Context
You are implementing :: marker extraction that populates block.metadata.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 2.1

## Preconditions
- Unit 2.1 complete: Metadata schema defined

## Deliverable
A subscriber that extracts :: markers and writes to block.metadata.

## Entry Checklist
- [ ] Read Unit 2.1 handoff
- [ ] Code review: inlineParser.ts ctx:: parsing
- [ ] Code review: blockTypes.ts parseBlockType()
- [ ] Plan: which markers to extract (ctx::, project::, etc.)

## Implementation
1. Create metadata_hook.rs in floatty-core
2. Subscribe to BlockChange::ContentChanged
3. Parse content for :: markers
4. Write to block.metadata (with Origin::Hook)
5. Verify no infinite loop (Origin filtering)

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Typing `ctx::test` populates metadata.markers
- [ ] No infinite loop (check logs)
- [ ] Code review: any simplification opportunities?
- [ ] Document: marker patterns supported
- [ ] Write handoff for Unit 2.3
```

---

## Unit 2.3: Wikilink Extraction

**Status**: ⏭️ Merged into Unit 2.2 - wikilink parsing was natural to include with marker parsing.
See handoff `docs/handoffs/unit-2.2.md` for details.

---

## Unit 2.2.3: Hook System Wiring

### Entry Prompt

```markdown
# Work Unit 2.2.3: Hook System Wiring

## Context
You are wiring the hook system so hooks actually run at runtime.
All infrastructure exists but nothing connects:
- HookRegistry never instantiated
- MetadataExtractionHook never registered
- ChangeEmitter has no subscribers

Read: docs/handoffs/unit-2.2.md
Read: floatty-core/src/hooks/mod.rs
Read: floatty-core/src/emitter.rs

## Preconditions
- Unit 2.2 complete: MetadataExtractionHook exists, parsing functions work

## Deliverable
Hook system runs at runtime:
1. HookRegistry created at startup
2. MetadataExtractionHook registered
3. Block changes trigger hook dispatch
4. Cold start populates metadata (BulkImport origin)

## Entry Checklist
- [ ] Read Unit 2.2 handoff
- [ ] Verify MetadataExtractionHook compiles and tests pass
- [ ] Review floatty-server/src/main.rs startup sequence
- [ ] Review emitter.rs broadcast channel pattern

## Implementation
1. Create `floatty-core/src/hooks/system.rs`:
   - `fn initialize_hook_system(store: Arc<YDocStore>) -> HookSystem`
   - `HookSystem` owns registry + spawns emitter subscriber task
2. In `initialize_hook_system()`:
   - Create HookRegistry
   - Register MetadataExtractionHook
   - Create ChangeEmitter subscriber task that calls registry.dispatch()
3. Add cold-start rehydration:
   - After Y.Doc loads, iterate all blocks
   - Emit `BlockChange::ContentChanged` with `Origin::BulkImport`
   - Hooks process these, populating metadata
4. Integrate into floatty-server/src/main.rs:
   - Call `initialize_hook_system()` after store creation
   - Hold HookSystem for lifetime of server
5. Add integration test: create block → verify metadata populated

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] `cargo test -p floatty-server` passes
- [ ] floatty-server startup creates HookRegistry with MetadataExtractionHook
- [ ] Block creation triggers MetadataExtractionHook
- [ ] Restart loads blocks with populated metadata (cold start)
- [ ] Write handoff for Unit 2.4
```

### Exit Template

```markdown
# Handoff: Unit 2.2.3 - Hook System Wiring

**Completed**: [timestamp]
**Status**: ✅ Complete

## What Was Done
- Created hooks/system.rs with initialize_hook_system()
- HookRegistry created and MetadataExtractionHook registered at startup
- ChangeEmitter subscriber wired to registry dispatch
- Cold-start rehydration emits BulkImport changes for existing blocks

## Files Changed
- floatty-core/src/hooks/system.rs (NEW)
- floatty-core/src/hooks/mod.rs (export)
- floatty-core/src/lib.rs (re-export)
- floatty-server/src/main.rs (integration)

## Tests Added
- Integration test: block creation triggers hook
- Integration test: cold start rehydrates metadata

## Setup for Next Unit
Unit 2.4 (PageNameIndex) can now:
- Subscribe to ChangeEmitter for block changes
- Read metadata.outlinks populated by MetadataExtractionHook
- Build page name index at startup via cold start mechanism

## Blockers for Next Unit
- None expected
```

---

## Unit 2.4: PageNameIndex

### Entry Prompt

```markdown
# Work Unit 2.4: PageNameIndex (Tracer Bullet Complete)

## Context
You are building the autocomplete data structure.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 2.3

## Preconditions
- Unit 2.3 complete: Wikilinks extract to metadata.outlinks

## Deliverable
A fast HashSet-based structure for [[ autocomplete.

## Entry Checklist
- [ ] Read Unit 2.3 handoff
- [ ] Code review: How are pages:: blocks identified?
- [ ] Plan: existing vs referenced page tracking

## Implementation
1. Create PageNameIndex in floatty-core
2. Track: existing (blocks under pages::) + referenced (from outlinks)
3. Update on BlockChange events
4. Expose search(prefix) method
5. Wire to frontend autocomplete

## Exit Checklist
- [ ] `npm run test` passes
- [ ] `cargo test` passes
- [ ] [[ autocomplete shows suggestions
- [ ] Stubs marked as "(stub)" or similar
- [ ] TRACER BULLET VALIDATION: metadata extraction → autocomplete works
- [ ] Write handoff for Unit 3.1
```

---

## Unit 1.5.1: Hook Interface

### Entry Prompt

```markdown
# Work Unit 1.5.1: Hook Interface

## Context
You are defining the BlockHook trait for floatty's hook registry.
Read: docs/SEARCH_ARCHITECTURE_LAYERS.md (Section 2.4)

## Preconditions
- Unit 0.3 complete: Origin enum exists, API accepts origin param

## Deliverable
A Rust trait defining the interface for block change hooks.

## Entry Checklist
- [ ] Read SEARCH_ARCHITECTURE_LAYERS.md
- [ ] Code review: src/lib/handlers/registry.ts (frontend pattern to mirror)
- [ ] Understand priority ordering requirements

## Implementation
1. Create src-tauri/floatty-core/src/hooks/mod.rs
2. Define BlockHook trait:
   - `fn name(&self) -> &'static str`
   - `fn priority(&self) -> i32` (lower = earlier)
   - `fn is_sync(&self) -> bool`
   - `fn accepts_origins(&self) -> Option<Vec<Origin>>`
   - `fn process(&self, changes: &[BlockChange], store: &YDocStore)`
3. Export from lib.rs
4. Add unit tests for trait bounds

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Trait is object-safe (can use `Box<dyn BlockHook>`)
- [ ] Code review: any simplification opportunities?
- [ ] Document: any decisions made?
- [ ] Write handoff for Unit 1.5.2
```

---

## Unit 1.5.2: Registry Implementation

### Entry Prompt

```markdown
# Work Unit 1.5.2: Registry Implementation

## Context
You are implementing the HookRegistry that dispatches to registered hooks.
Read: Handoff from Unit 1.5.1

## Preconditions
- Unit 1.5.1 complete: BlockHook trait exists

## Deliverable
A HookRegistry struct that registers hooks and dispatches changes in priority order.

## Entry Checklist
- [ ] Read Unit 1.5.1 handoff
- [ ] Verify BlockHook trait compiles
- [ ] Code review: How will hooks be registered at startup?

## Implementation
1. Create HookRegistry struct in hooks/mod.rs
2. Implement `register(&mut self, hook: Box<dyn BlockHook>)`
3. Implement `dispatch(&self, changes: &[BlockChange], store: &YDocStore)`
   - Sort hooks by priority
   - For each hook: check accepts_origins, then process
   - Sync hooks block, async hooks spawn
4. Add integration tests

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Multiple hooks can be registered
- [ ] Priority ordering works correctly
- [ ] Code review: any simplification opportunities?
- [ ] Write handoff for Unit 1.5.3
```

---

## Unit 1.5.3: Origin Filtering

### Entry Prompt

```markdown
# Work Unit 1.5.3: Origin Filtering (Loop Prevention)

## Context
You are implementing origin-based filtering to prevent infinite hook loops.
Read: docs/.claude/rules/ydoc-patterns.md (Pattern 4)

## Preconditions
- Unit 1.5.2 complete: HookRegistry dispatches to hooks

## Deliverable
Hooks can specify which origins they respond to, preventing loops.

## Entry Checklist
- [ ] Read Unit 1.5.2 handoff
- [ ] Read ydoc-patterns.md Pattern 4 (Origin Prevents Infinite Loops)
- [ ] Understand: Hook writes should use Origin::Hook

## Implementation
1. Update dispatch() to filter by accepts_origins()
2. Ensure hooks that write to store use Origin::Hook
3. Add loop prevention test:
   - Register a dummy hook that writes to store
   - Verify hook does NOT receive its own write event
4. Document the origin contract in code comments

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Test: Register hook that writes to store; verify it does NOT receive its own write event
- [ ] Code review: any simplification opportunities?
- [ ] Write handoff for Unit 2.1
```

---

## Unit 3.1: Tantivy Setup

### Entry Prompt

```markdown
# Work Unit 3.1: Tantivy Setup

## Context
You are setting up the Tantivy search index infrastructure.
Read: docs/SEARCH_ARCHITECTURE_LAYERS.md

## Preconditions
- Unit 2.4 complete: PageNameIndex works (tracer bullet validated)

## Deliverable
Tantivy dependency added, index created, schema defined.

## Entry Checklist
- [ ] Read SEARCH_ARCHITECTURE_LAYERS.md (Part 2.6)
- [ ] Add tantivy to Cargo.toml
- [ ] Decide: index location (~/.floatty/search_index/)

## Implementation
1. Add `tantivy = "0.22"` to floatty-core/Cargo.toml
2. Define Schema:
   - `block_id`: STRING | STORED | INDEXED (Primary Key for deletes)
   - `content`: TEXT (Standard tokenizer)
   - `block_type`: STRING | FAST (For facet filtering)
   - `parent_id`: STRING | STORED (For context retrieval)
   - `updated_at`: DATE | FAST (For recency sorting)
3. Create index directory at ~/.floatty/search_index/
4. Implement IndexManager struct:
   - `open_or_create(path) -> Index`
   - Handle schema migrations (for future)
5. Add tests for index creation

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Index can be created and reopened
- [ ] Schema includes block_id as indexed STRING (required for deletions)
- [ ] Code review: any simplification opportunities?
- [ ] Write handoff for Unit 3.2
```

---

## Unit 3.2: Writer Actor

### Entry Prompt

```markdown
# Work Unit 3.2: Writer Actor

## Context
You are implementing the async writer actor for Tantivy index updates.
Read: Handoff from Unit 3.1

## Preconditions
- Unit 3.1 complete: Index and schema exist

## Deliverable
A TantivyWriter actor that handles concurrent writes with backpressure.

## Entry Checklist
- [ ] Read Unit 3.1 handoff
- [ ] Verify index can be opened
- [ ] Understand: Updates in Tantivy are Delete + Add

## Implementation
1. Create TantivyWriter struct wrapping IndexWriter
2. Implement Actor pattern using **bounded mpsc channel** (capacity: 1000)
   - Bounded channel provides backpressure during bulk indexing
   - Prevents OOM if 10k blocks pasted at once
3. Define message types:
   - `AddOrUpdate { id, doc }` → delete_term + add_document
   - `Delete { id }` → delete_term only
   - `Commit` → writer.commit()
4. Implement handle_message loop:
   - `AddOrUpdate`: `writer.delete_term(Term::from_field_text(block_id_field, id))` then `writer.add_document(doc)`
   - `Delete`: `writer.delete_term(Term::from_field_text(block_id_field, id))`
   - `Commit`: `writer.commit()`
5. Spawn actor on app startup
6. Add tests for message handling

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Channel is bounded (capacity specified)
- [ ] Delete uses Term-based deletion by block_id
- [ ] Updates are atomic Delete + Add
- [ ] Code review: any simplification opportunities?
- [ ] Write handoff for Unit 3.3
```

---

## Unit 3.3: TantivyIndexHook

### Entry Prompt

```markdown
# Work Unit 3.3: TantivyIndexHook

## Context
You are implementing the async hook that queues index updates.
Read: Handoff from Unit 3.2

## Preconditions
- Unit 3.2 complete: Writer actor running
- Unit 1.5.3 complete: Hook registry with origin filtering

## Deliverable
A registered hook that maps BlockChange events to index operations.

## Entry Checklist
- [ ] Read Unit 3.2 handoff
- [ ] Verify writer actor can receive messages
- [ ] Understand: This hook is async (is_sync = false)

## Implementation
1. Create TantivyIndexHook implementing BlockHook
   - priority: 50 (after metadata hooks)
   - is_sync: false (async)
   - accepts_origins: Some(vec![User, Remote, Agent, BulkImport]) — NOT Hook
2. Map BlockChange to Index Operations:
   - `Created` → AddOrUpdate (delete any stale, add new)
   - `ContentChanged` → AddOrUpdate (atomic delete + add)
   - `Deleted` → Delete
   - `Moved` → No-op (unless path is indexed)
3. Send messages to writer actor channel
4. Register hook at startup
5. Add integration tests

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Hook is registered with priority 50
- [ ] ContentChanged triggers Delete + Add (not just Add)
- [ ] Deleted blocks are removed from index
- [ ] Code review: any simplification opportunities?
- [ ] Write handoff for Unit 3.4
```

---

## Unit 3.4: Search Service

### Entry Prompt

```markdown
# Work Unit 3.4: Search Service

## Context
You are implementing the query interface for Tantivy search.
Read: Handoff from Unit 3.3

## Preconditions
- Unit 3.3 complete: Index is being updated by hook

## Deliverable
SearchService with query primitives.

## Entry Checklist
- [ ] Read Unit 3.3 handoff
- [ ] Verify some blocks are indexed
- [ ] Understand: Return IDs only, hydrate from Y.Doc

## Implementation
1. Create SearchService in services/search.rs
2. Implement query methods:
   - `search(query: &str, limit: usize) -> Vec<SearchHit>`
   - `search_with_filters(query, filters, limit) -> Vec<SearchHit>`
3. SearchHit contains: block_id, score, snippet
4. Use QueryParser with content field
5. Add facet filtering by block_type
6. Add tests with sample indexed data

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Search returns relevant results
- [ ] Filters work correctly
- [ ] Code review: any simplification opportunities?
- [ ] Write handoff for Unit 3.5
```

---

## Unit 3.5: Tauri Commands

### Entry Prompt

```markdown
# Work Unit 3.5: Tauri Commands

## Context
You are exposing the search service to the frontend.
Read: Handoff from Unit 3.4

## Preconditions
- Unit 3.4 complete: SearchService works

## Deliverable
Tauri commands for frontend search access.

## Entry Checklist
- [ ] Read Unit 3.4 handoff
- [ ] Code review: existing Tauri command patterns in commands/

## Implementation
1. Create commands/search.rs
2. Add commands (thin adapters to SearchService):
   - `search_blocks(query, filters, limit) -> Vec<SearchResult>`
   - `get_block_context(id, radius) -> BlockContext`
3. Wire into lib.rs tauri::generate_handler!
4. Add frontend types in src/lib/searchTypes.ts
5. Test from frontend devtools

## Exit Checklist
- [ ] `npm run test` passes
- [ ] `cargo test` passes
- [ ] Commands callable from frontend
- [ ] End-to-end: type in block → searchable
- [ ] PHASE 3 COMPLETE: Full search working
- [ ] Write handoff summarizing Phase 3
```

---

## Session Prompt Template

Use this prompt to start ANY work unit:

```markdown
# floatty Search Architecture: Work Unit [X.Y]

You are implementing [Unit Name] for floatty's search architecture.

## Required Reading (do this FIRST)
1. Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
2. Read: docs/handoffs/unit-[PREV].md (if exists)
3. Code review files listed in Entry Checklist

## Your Deliverable
[One sentence describing what this unit delivers]

## Entry Protocol
1. Read required documents
2. Perform code review (grep, read, understand)
3. Verify preconditions are met
4. Create todo list
5. Begin implementation

## Exit Protocol
1. Run `npm run test` - must pass
2. Run `cargo test` - must pass
3. Code review your changes - simplify where possible
4. Check for blocking issues
5. Log decisions to handoff document
6. Review next unit - flag any approach changes
7. Write handoff document
8. Commit with clear message
9. Push to feature branch

## On Failure
If tests fail or blockers emerge:
1. Document the issue in handoff
2. DO NOT proceed to next unit
3. Flag for human review

## Context Window Management
This unit should be completable in ONE session.
If scope creeps, split into sub-units and document.
```

---

## Handoff Document Template

Create at `docs/handoffs/unit-X.Y.md`:

```markdown
# Handoff: Unit [X.Y] - [Name]

**Completed**: [timestamp]
**Status**: ✅ Complete / ⚠️ Partial / ❌ Blocked

## What Was Done
- [Bullet list of changes]

## Files Changed
- path/to/file.rs (description)
- path/to/file.ts (description)

## Tests Added
- test_name: what it verifies

## Decisions Made
| Decision | Options Considered | Choice | Rationale |
|----------|-------------------|--------|-----------|
| ... | ... | ... | ... |

## Blockers Encountered
- None / [Description + suggested resolution]

## Simplifications Made
- [Any refactoring done during review]

## Setup for Next Unit
Next unit ([X.Y+1]) should:
- [Specific setup or context needed]

## Approach Changes
Based on learnings, suggest changes to:
- [ ] No changes needed
- [ ] Unit [Z]: [change description]
- [ ] Overall plan: [change description]
```

---

## Orchestration Prompt

Use this to manage the overall project:

```markdown
# floatty Search Architecture: Orchestration

You are managing the search architecture implementation.

## Current State
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: docs/handoffs/ (all files, most recent first)

## Your Role
1. Determine which unit is next
2. Verify preconditions are met
3. Generate entry prompt for next unit
4. After unit completes, verify exit criteria
5. If blocked, determine resolution path

## Progress Tracking
Update docs/SEARCH_IMPLEMENTATION_STATUS.md with:
- [ ] Unit 0.1: Origin Enum
- [ ] Unit 0.2: Origin in Y.Doc
- [ ] Unit 1.1: Change Emitter Interface
- [ ] Unit 1.2: Store Integration
- [ ] Unit 1.3: Debounce + Dedupe
- [ ] Unit 2.1: Metadata Schema
- [ ] Unit 2.2: Marker Extraction
- [ ] Unit 2.3: Wikilink Extraction
- [ ] Unit 2.4: PageNameIndex (TRACER BULLET)
- [ ] Unit 3.1: Tantivy Setup
- [ ] Unit 3.2: Writer Actor
- [ ] Unit 3.3: Search Service
- [ ] Unit 3.4: Tauri Commands

## Decision Log
Accumulate decisions from handoffs into:
docs/SEARCH_ADR.md (Architecture Decision Records)
```

---

## Gap Discovery Protocol

When a gap is discovered during work unit execution:

1. **Document Immediately**
   - Add to "Discovered Gaps" section at end of this doc
   - Include: when discovered, what surfaced it, impact assessment

2. **Assess Impact**

   | Impact Level | Action |
   |--------------|--------|
   | Blocks current work | Stop, escalate, add as prerequisite unit |
   | Blocks upcoming units | Insert new unit, update dependencies |
   | Enables future capability | Add to Phase 3+ or create new phase |
   | Nice-to-have | Log in Discovered Gaps, continue |

3. **If Adding New Unit**
   - Update Work Unit Index table
   - Update all downstream unit dependencies
   - Write full Entry/Exit Protocol
   - Update handoff from previous unit

4. **Capture Context**
   ```text
   mcp__evna-remote__active_context(
     capture="ctx::{date} @ {time} [project::floatty] [mode::gap-capture] {summary}",
     project="floatty"
   )
   ```

5. **Use /floatty:gap Command**
   For guided gap capture: `/floatty:gap {description}`

---

## Summary

This methodology ensures:

1. **Isolation**: Each unit can run in fresh context
2. **Testability**: Clear entry/exit criteria with test requirements
3. **Traceability**: Handoff documents capture decisions
4. **Adaptability**: Exit review can modify future approach
5. **Quality**: Code review + simplification pass built in

**Next step**: Create `docs/handoffs/` directory and start Unit 0.1.

---

## Discovered Gaps

Gaps identified during work unit execution. These may become future units or inform architectural decisions.

### Gap: Rust YDocStore Mutation Methods

**Discovered**: 2026-01-10 during Unit 0.1 exploration
**Surfaced by**: Fresh session code review

**Current State**:
The Rust YDocStore in `floatty-core/src/store.rs` only has `apply_update()` which receives pre-encoded Y.Doc updates from the frontend. There are no block-level mutation methods like `create_block()`, `update_block()`, `delete_block()`.

**Impact**:
Limits "headless" to "server holds state" rather than "server can act". External agents/APIs cannot create blocks - they must go through a connected frontend.

**Architecture Implications**:
```text
Current:   TypeScript Y.Doc → mutations → sync → Rust apply_update()
Headless:  Rust Y.Doc → mutations → sync → TypeScript + Other clients
               ↑
           API / Agent / External tool
```

**Suggested Resolution**:
Potential Unit 0.3 to add:
- `create_block(id, content, parent_id, origin) -> Result<()>`
- `update_block(id, content, origin) -> Result<()>`
- `delete_block(id, origin) -> Result<()>`

These would use the Origin enum defined in Unit 0.1.

**Status**: Documented, not blocking current search work. Origin enum is still valid scaffolding regardless of where mutations originate.

**Notes**: The current TypeScript-driven architecture is simpler and may be sufficient for v1. Rust mutation methods would enable true headless operation but add complexity.

### Gap: Frontend Origin Exposure

**Discovered**: 2026-01-10 during undo/redo debugging
**Surfaced by**: BlockItem sync effect couldn't distinguish user echo vs undo
**Status**: ✅ Resolved in commit 9fa7338

**Problem**: Y.Doc observer in `useBlockStore` wasn't capturing transaction origin. BlockItem sync effect blocked ALL updates when focused, including undo/redo.

**Solution implemented**:
- `useBlockStore`: Added `lastUpdateOrigin` to state, captured in Y.Doc observer
- `BlockItem`: Origin-aware sync gate - 'user' skipped when focused, undo/remote always sync

**Pattern established**:
```text
Focused + user origin  → skip (handleInput handles it)
Focused + non-user     → sync (undo, remote are authoritative)
Not focused            → sync always
```

**Files changed**: `useBlockStore.ts`, `WorkspaceContext.tsx`, `BlockItem.tsx`, `useSyncedYDoc.ts`

---

### Gap: Cold Start Index Rehydration

**Discovered**: 2026-01-10 during gap analysis
**Surfaced by**: Architecture review - hooks only fire on mutations
**Status**: Open - add to Phase 3 planning

**Problem**: Hooks fire on `BlockChange` events. On app startup, Y.Doc loads from persistence but no mutations occur. Indexes (PageNameIndex, Tantivy) remain empty until user edits blocks.

**Impact**: Search returns nothing after restart until blocks are touched.

**Suggested Resolution**: Add startup rehydration logic (Unit 2.5 or part of Unit 3.1):
1. After Y.Doc loads, iterate all blocks
2. Extract metadata + outlinks
3. Populate indexes before hook pipeline activates

---

### Gap: Backend-Driven Layout Events

**Discovered**: 2026-01-10 during gap analysis
**Surfaced by**: Agent integration vision - agents need to show results
**Status**: Open - Phase 3+ (not blocking search work)

**Problem**: Layout lives only in frontend `useLayoutStore` (SQLite local). Backend agents cannot request pane operations like "open this block in a split".

**Impact**: Agents can mutate data but cannot present it to user. Blocks "Answer vs Chirp" distinction.

**Suggested Resolution**: Unit 3.5 expansion - add `PushLayoutEvent` channel:
```rust
// Server can push layout requests
PushLayoutEvent::OpenPane { block_id, mode: SplitRight }
```

Frontend subscribes and applies to layoutStore.

---

### Gap: API Origin + Metadata

**Discovered**: 2026-01-10 during architecture exploration
**Surfaced by**: Gap analysis comparing floatty-server API vs multi-agent vision
**Status**: ✅ Resolved → Unit 0.3 added

**Current State**:
- POST/PATCH /api/v1/blocks doesn't accept `origin` param
- Block.metadata field exists in struct but not exposed in API
- Cannot distinguish Agent vs User writes via API

**Impact**:
- Agents writing blocks appear as User origin
- Metadata (markers, wikilinks) cannot be stored/retrieved via API
- Hook filtering can't distinguish API-sourced vs frontend-sourced mutations

**Resolution**:
Created Unit 0.3 with Entry/Exit Protocol. Dependencies updated (1.1 and 1.5.1 now depend on 0.3).

---

### Gap: Hook System Wiring

**Discovered**: 2026-01-10 during Unit 2.2 exit review
**Surfaced by**: Verification that HookRegistry is never instantiated
**Status**: BLOCKING - requires new Unit 2.2.3

**Current State**:
All hook infrastructure exists but is never connected:
- `HookRegistry` - defined in `hooks/mod.rs`, never created
- `MetadataExtractionHook` - defined in `metadata_extraction.rs`, never registered
- `ChangeEmitter` - defined in `emitter.rs`, never has subscribers
- `YDocStore::update_block_metadata()` - ready but hooks never call it

**Evidence**: Zero calls to `registry.register()` outside test files.

**Impact**:
- Metadata extraction never runs
- Block content changes don't populate `metadata.markers` or `metadata.outlinks`
- PageNameIndex (Unit 2.4) has nothing to index
- Search can't work until this is fixed

**Architecture Flow (Currently Broken)**:
```text
Block Change → ??? → HookRegistry.dispatch() → MetadataExtractionHook → metadata
                ↑
            MISSING: Nothing creates registry or wires the chain
```

**Suggested Resolution**:
Insert Unit 2.2.3 (Hook System Wiring):
1. Create `hooks/system.rs` with `initialize_hook_system()`
2. Register `MetadataExtractionHook` at startup
3. Wire emitter to registry
4. Add cold-start rehydration (emit BulkImport changes after Y.Doc load)
5. Integrate into `floatty-server/src/main.rs`

**Related Gap**: Cold Start Index Rehydration should be part of this unit.
