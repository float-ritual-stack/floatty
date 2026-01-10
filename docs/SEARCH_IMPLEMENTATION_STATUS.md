# Search Architecture Implementation Status

**Last Updated**: 2026-01-10
**Current Phase**: Phase 0 (Not Started)
**Reference**: `docs/SEARCH_ARCHITECTURE_LAYERS.md` (authoritative)

---

## Progress

### Phase 0: Origin Tagging
- [ ] **Unit 0.1**: Origin Enum - Define Origin type in floatty-core
- [ ] **Unit 0.2**: Origin in Y.Doc - Tag transactions with origin

### Phase 1: Change Emitter (Refined)
- [ ] **Unit 1.1**: BlockChange Types - Define event types only
- [ ] **Unit 1.2**: Y.Doc Observer Wrapper - Tap observeDeep, transform events
- [ ] **Unit 1.3**: Debounce + Dedupe - Batch before dispatch

### Phase 1.5: Hook Registry (NEW - was collapsed)
- [ ] **Unit 1.5.1**: Hook Interface - Trait definition with priority
- [ ] **Unit 1.5.2**: Registry Implementation - Registration, dispatch loop
- [ ] **Unit 1.5.3**: Origin Filtering - Hooks specify accepted origins
- [ ] **INTEGRATION**: Wire emitter to registry

### Phase 2: Metadata Extraction (Tracer Bullet)
- [ ] **Unit 2.1**: Metadata Schema - Define BlockMetadata types (TS + Rust)
- [ ] **Unit 2.2**: MetadataHook - Registered hook, extracts :: markers
- [ ] **Unit 2.3**: Wikilink Extraction - Extend MetadataHook for [[links]]
- [ ] **Unit 2.4**: PageNameIndex + Hook - Fast autocomplete structure ← **VALIDATES ARCHITECTURE**

### Phase 3: Tantivy Integration
- [ ] **Unit 3.1**: Tantivy Setup - Add dependency, define schema
- [ ] **Unit 3.2**: Writer Actor - Async queue for concurrent writes
- [ ] **Unit 3.3**: TantivyIndexHook - Registered async hook
- [ ] **Unit 3.4**: Search Service - Query primitives (search, facets)
- [ ] **Unit 3.5**: Tauri Commands - Expose to frontend

---

## Blockers

*None currently*

---

## Decision Log

| Date | Unit | Decision | Rationale |
|------|------|----------|-----------|
| 2026-01-10 | Planning | Block-level indexing with page_id facet | Enables precise jumps while allowing page grouping |
| 2026-01-10 | Planning | Tantivy over SQLite FTS | Facets, explain, Rust-native |
| 2026-01-10 | Planning | 150ms input + 1-2s search debounce | Different latency budgets |
| 2026-01-10 | Planning | Tracer bullet = metadata extraction | Validates hook pattern before Tantivy |
| 2026-01-10 | Planning | Separate Hook Registry from Emitter | Emitter emits, Registry dispatches, Hooks process |
| 2026-01-10 | Planning | Metadata in Y.Doc (CRDT) | Travels with sync, no separate storage |
| 2026-01-10 | Planning | Reuse TS inlineParser | Don't recreate wikilink parsing in Rust |

---

## Key Documents

| Document | Purpose |
|----------|---------|
| `SEARCH_ARCHITECTURE_LAYERS.md` | **Authoritative** - Current state, target state, feature flows |
| `SEARCH_ARCHITECTURE_SNAPSHOT.md` | Ratchet-checked facts about existing code |
| `SEARCH_WORK_UNITS.md` | Work unit prompts and templates |

---

## Handoff Index

| Unit | Handoff File | Status |
|------|--------------|--------|
| 0.1 | `handoffs/unit-0.1.md` | Not started |
| 0.2 | `handoffs/unit-0.2.md` | Not started |
| 1.1 | `handoffs/unit-1.1.md` | Not started |
| 1.2 | `handoffs/unit-1.2.md` | Not started |
| 1.3 | `handoffs/unit-1.3.md` | Not started |
| 1.5.1 | `handoffs/unit-1.5.1.md` | Not started |
| 1.5.2 | `handoffs/unit-1.5.2.md` | Not started |
| 1.5.3 | `handoffs/unit-1.5.3.md` | Not started |
| 2.1 | `handoffs/unit-2.1.md` | Not started |
| 2.2 | `handoffs/unit-2.2.md` | Not started |
| 2.3 | `handoffs/unit-2.3.md` | Not started |
| 2.4 | `handoffs/unit-2.4.md` | Not started |
| 3.1 | `handoffs/unit-3.1.md` | Not started |
| 3.2 | `handoffs/unit-3.2.md` | Not started |
| 3.3 | `handoffs/unit-3.3.md` | Not started |
| 3.4 | `handoffs/unit-3.4.md` | Not started |
| 3.5 | `handoffs/unit-3.5.md` | Not started |

---

## Collapsed Pieces (Fixed)

The original plan collapsed these concepts. Now properly separated:

| Original | Problem | Fixed |
|----------|---------|-------|
| "Change Emitter" did everything | Mixed emission + dispatch + batching | Split into 1.1-1.3 + 1.5.x |
| No Hook Registry | Hooks were implicit | Explicit Phase 1.5 |
| Metadata in Tantivy only | Not CRDT-synced | Stored in block.metadata (Y.Doc) |

---

## Next Actions

1. Read `docs/SEARCH_ARCHITECTURE_LAYERS.md` for context
2. Start Unit 0.1: Origin Enum
3. Use prompt from `docs/SEARCH_WORK_UNITS.md`
4. Follow entry/exit protocol
