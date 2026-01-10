# Floatty Search Architecture: Work Unit Plan

**Generated**: 2026-01-10
**Methodology**: Isolated work units with handoff documents
**Principle**: Each unit starts fresh, delivers testable value, documents decisions

---

## Work Unit Structure

Every work unit follows this lifecycle:

```
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

| Unit | Name | Depends On | Delivers | Est. Size |
|------|------|------------|----------|-----------|
| 0.1 | Origin Enum | None | Type definition | Small |
| 0.2 | Origin in Y.Doc | 0.1 | Tagged transactions | Small |
| 1.1 | Change Emitter Interface | 0.2 | Event types | Small |
| 1.2 | Store Integration | 1.1 | Emitter at boundary | Medium |
| 1.3 | Debounce + Dedupe | 1.2 | Batched changes | Small |
| 2.1 | Metadata Schema | 1.3 | Type definitions | Small |
| 2.2 | Marker Extraction | 2.1 | :: parser hook | Medium |
| 2.3 | Wikilink Extraction | 2.2 | [[]] parser hook | Medium |
| 2.4 | PageNameIndex | 2.3 | Autocomplete structure | Small |
| 3.1 | Tantivy Setup | 2.4 | Index + schema | Medium |
| 3.2 | Writer Actor | 3.1 | Concurrent write handling | Medium |
| 3.3 | Search Service | 3.2 | Query primitives | Medium |
| 3.4 | Tauri Commands | 3.3 | Frontend API | Small |

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

### Entry Prompt

```markdown
# Work Unit 0.2: Origin in Y.Doc Transactions

## Context
You are adding Origin tagging to Y.Doc transactions.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 0.1

## Preconditions
- Unit 0.1 complete: Origin enum exists

## Deliverable
All Y.Doc mutations carry an Origin tag for downstream filtering.

## Entry Checklist
- [ ] Read Unit 0.1 handoff
- [ ] Verify Origin enum exists and compiles
- [ ] Code review: store.rs mutation methods
- [ ] Code review: How is 'remote' currently handled?

## Implementation
1. Add `origin: Origin` parameter to YDocStore mutation methods
2. Store origin in transaction (Yrs TransactionMut has origin field)
3. Update all callers to pass appropriate Origin
4. Verify existing 'remote' filtering still works

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] `cargo test -p floatty-server` passes
- [ ] Existing frontend still works (manual test)
- [ ] Code review: any simplification opportunities?
- [ ] Document: any decisions made?
- [ ] Write handoff for Unit 1.1
```

---

## Unit 1.1: Change Emitter Interface

### Entry Prompt

```markdown
# Work Unit 1.1: Change Emitter Interface

## Context
You are defining the BlockChange event types for the emitter system.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 0.2

## Preconditions
- Unit 0.2 complete: Origin tagging works

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

### Entry Prompt

```markdown
# Work Unit 2.3: Wikilink Extraction Hook

## Context
You are implementing [[wikilink]] extraction for backlinks.
Read: docs/SEARCH_ARCHITECTURE_SNAPSHOT.md
Read: Handoff from Unit 2.2

## Preconditions
- Unit 2.2 complete: Marker extraction works

## Deliverable
Wikilinks extracted to block.metadata.outlinks.

## Entry Checklist
- [ ] Read Unit 2.2 handoff
- [ ] Code review: inlineParser.ts wikilink parsing
- [ ] Understand nested [[outer [[inner]]]] handling

## Implementation
1. Extend metadata hook to extract [[targets]]
2. Handle aliases: [[Target|Display]]
3. Handle nested brackets
4. Write to metadata.outlinks array

## Exit Checklist
- [ ] `cargo test -p floatty-core` passes
- [ ] Typing `[[Page Name]]` populates metadata.outlinks
- [ ] Nested brackets handled correctly
- [ ] Code review: reuse inlineParser logic?
- [ ] Write handoff for Unit 2.4
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

## Units 3.x: Tantivy Integration

*(Prompts follow same structure - available on request)*

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

## Summary

This methodology ensures:

1. **Isolation**: Each unit can run in fresh context
2. **Testability**: Clear entry/exit criteria with test requirements
3. **Traceability**: Handoff documents capture decisions
4. **Adaptability**: Exit review can modify future approach
5. **Quality**: Code review + simplification pass built in

**Next step**: Create `docs/handoffs/` directory and start Unit 0.1.
