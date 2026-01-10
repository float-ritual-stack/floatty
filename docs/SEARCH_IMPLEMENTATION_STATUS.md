# Search Architecture Implementation Status

**Last Updated**: 2026-01-10
**Current Phase**: Phase 0 (Not Started)

---

## Progress

### Phase 0: Origin Tagging
- [ ] **Unit 0.1**: Origin Enum - Define Origin type in floatty-core
- [ ] **Unit 0.2**: Origin in Y.Doc - Tag transactions with origin

### Phase 1: Change Emitter
- [ ] **Unit 1.1**: Change Emitter Interface - Define BlockChange types
- [ ] **Unit 1.2**: Store Integration - Wire emitter into YDocStore
- [ ] **Unit 1.3**: Debounce + Dedupe - Batch changes before downstream

### Phase 2: Metadata Extraction (Tracer Bullet)
- [ ] **Unit 2.1**: Metadata Schema - Define BlockMetadata types
- [ ] **Unit 2.2**: Marker Extraction - Extract :: markers to metadata
- [ ] **Unit 2.3**: Wikilink Extraction - Extract [[links]] to metadata
- [ ] **Unit 2.4**: PageNameIndex - Fast autocomplete structure ← **VALIDATES ARCHITECTURE**

### Phase 3: Tantivy Integration
- [ ] **Unit 3.1**: Tantivy Setup - Add dependency, define schema
- [ ] **Unit 3.2**: Writer Actor - Concurrent write handling
- [ ] **Unit 3.3**: Search Service - Query primitives
- [ ] **Unit 3.4**: Tauri Commands - Expose to frontend

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

---

## Handoff Index

| Unit | Handoff File | Status |
|------|--------------|--------|
| 0.1 | `handoffs/unit-0.1.md` | Not started |
| 0.2 | `handoffs/unit-0.2.md` | Not started |
| ... | ... | ... |

---

## Next Actions

1. Start Unit 0.1: Origin Enum
2. Use prompt from `docs/SEARCH_WORK_UNITS.md`
3. Follow entry/exit protocol
