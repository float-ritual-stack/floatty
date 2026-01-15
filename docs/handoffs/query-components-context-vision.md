# Query, Components & Context Vision

**Status**: 🔍 Design Complete, Implementation Pending
**Session**: 2026-01-15
**Branch**: `claude/floatty-handoff-document-HHOBj`

## Executive Summary

This document captures architectural vision for extending Floatty with:

1. **Query/Filter System** - Block querying via Tantivy and in-memory filters
2. **Component Registry** - MDX-like `:::Component` syntax for rich embedded views
3. **Context Directive System** - TTL-based context control (`ctx::N [[Page]]`)
4. **Unified Context Stream** - Aggregating context from outline, Claude Code, and EVNA
5. **Tool Use** - LLM-driven block manipulation

All features leverage the existing EventBus/Hook/ProjectionScheduler architecture.

---

## Key Architectural Decisions

### 1. Two Query Syntaxes

| Syntax | Engine | Use Case |
|--------|--------|----------|
| `filter:: include(x) exclude(y)` | In-memory, EventBus-reactive | Live filtering, Roam-style |
| `query:: tags:x status:y group:z` | Tantivy + Y.Doc fetch | Search, grouping, Kanban source |

**Rationale**: Simple filtering doesn't need Tantivy overhead. Complex queries with grouping justify the async fetch.

### 2. Context Directive Naming

Renamed from hypothetical `skip::` to `ctx::` family:

| Directive | Meaning | Implementation |
|-----------|---------|----------------|
| `ctx:: [[Page]]` | Include once (TTL: 1) | ttlDirectiveHook decrements after send |
| `ctx::N [[Page]]` | Include for N turns | Counter in session state |
| `ctx::always [[Page]]` | Always include | TTL: Infinity |
| `ctx::never [[Page]]` | Permanent exclusion | Negative TTL / exclusion set |

### 3. Component Registry Pattern

```markdown
:::ComponentName
prop1: value
prop2:
  - item1
  - item2
:::
```

Built-in components planned:
- **Kanban** - Query-driven cards with drag-drop metadata updates
- **SystemStatus** - Shell command dashboard
- **Poll** - Quick voting with metadata persistence
- **Chart** - Data visualization from query results
- **Mermaid** - Diagram rendering

### 4. Unified Context Stream

Three sources with deduplication:

```
┌──────────────────┐     ┌─────────────────┐     ┌──────────────────┐
│  Outline blocks  │     │  Claude Code    │     │  EVNA MCP        │
│  (ctx:: prefixed)│     │  (file watcher) │     │  (REST polling)  │
└────────┬─────────┘     └────────┬────────┘     └────────┬─────────┘
         │                        │                       │
         └────────────────────────┼───────────────────────┘
                                  │
                           ┌──────▼──────┐
                           │  Dedup by   │
                           │  content    │
                           │  hash       │
                           └──────┬──────┘
                                  │
                           ┌──────▼──────┐
                           │  Priority:  │
                           │  outline >  │
                           │  cc > evna  │
                           └─────────────┘
```

### 5. Hook Priority Map

| Priority | Hook | Purpose |
|----------|------|---------|
| 0 | sendContextHook | Build conversation messages |
| 2 | ttlDirectiveHook | Parse ctx:: directives, manage TTL |
| 5 | wikilinkExpansionHook | Expand [[wikilinks]] to content |
| 6 | queryExpansionHook | Expand query:: blocks to results |
| 8 | backlinkContextHook | Inject relevant backlinks |
| 10 | tokenEstimationHook | Warn on large context |
| 20 | toolInjectionHook | Add tools based on visible components |
| 100 | loggingHook | Audit trail |

### 6. ProjectionScheduler Handlers

| Handler | Debounce | Purpose |
|---------|----------|---------|
| tantivy-index | 3000ms | Batch index to Tantivy |
| backlink-index | 1500ms | Build reverse link index |

---

## Reference Implementations Analyzed

### FLOAT Block V2.3 (Drafts.app)

Key patterns directly portable to Floatty:

```javascript
// TTLManager class - tracks directive state
class TTLManager {
  ttlCounters = {}   // pageId -> remaining uses
  permanentInclude   // Set of always-include pages
  permanentExclude   // Set of never-include pages

  processDirective(directive) {
    // Parse ctx::N [[Page]] format
    // Update counters/sets
  }

  decrementTTLs() {
    // Called after each /send
    // Removes entries at 0
  }

  shouldInclude(pageId) {
    // Check against all state
  }
}
```

Other patterns:
- Section extraction by heading (for partial page inclusion)
- Link grouping (specific pages beat general)
- Debug shadow drafts (for troubleshooting context)

### float-janky-shack-door (React prototype)

- Component registry with `:::` syntax
- Kanban with metadata-driven columns
- Drag-drop updates to block metadata
- YAML-like props parsing

---

## Data Flow Architecture

### /send Command Flow

```
User types /send message
         │
         ▼
  ┌──────────────────┐
  │  /send handler   │
  │  (registry.ts)   │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │  Hook Pipeline   │
  │  (priority order)│
  └────────┬─────────┘
           │
    ┌──────┼──────┬──────┬──────┐
    ▼      ▼      ▼      ▼      ▼
  ttl    wikilink query backlink token
  hook   hook    hook   hook    hook
    │      │      │      │      │
    └──────┼──────┴──────┴──────┘
           │
           ▼
  ┌──────────────────┐
  │  Context Builder │
  │  (deduplicated)  │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │  LLM API Call    │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │  Response Handler│
  │  + Tool Executor │
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────┐
  │  TTL Decrement   │
  │  (post-send)     │
  └──────────────────┘
```

### Block Change Flow

```
Block Edit (Y.Doc mutation)
         │
         ▼
  ┌──────────────────┐
  │  observeDeep     │
  │  (useBlockStore) │
  └────────┬─────────┘
           │
     ┌─────┴─────┐
     │           │
     ▼           ▼
 ┌────────┐  ┌──────────────────┐
 │EventBus│  │ProjectionScheduler│
 │(sync)  │  │(async, debounced) │
 └───┬────┘  └─────────┬────────┘
     │                 │
     ▼                 ▼
 Immediate        Batched writes:
 reactions:       - Tantivy index
 - UI signals     - Backlink index
 - filter:: eval
```

---

## File Structure (Target)

```
src/lib/
├── events/           # EventBus, ProjectionScheduler (EXISTS)
├── handlers/
│   ├── registry.ts   # Handler registration (EXISTS)
│   └── hooks/        # Hook implementations
│       ├── sendContext.ts     # (EXISTS as reference)
│       ├── ttlDirective.ts    # (NEW)
│       ├── wikilinkExpansion.ts # (NEW)
│       ├── queryExpansion.ts  # (NEW)
│       ├── backlinkContext.ts # (NEW)
│       └── toolInjection.ts   # (NEW)
├── filter/           # (NEW)
│   ├── parser.ts     # filter:: syntax parser
│   └── matcher.ts    # Block matching logic
├── query/            # (NEW)
│   ├── parser.ts     # query:: syntax parser
│   └── executor.ts   # Tantivy integration
├── components/       # (NEW)
│   ├── registry.ts   # Component registration
│   ├── parser.ts     # :::Component::: parser
│   └── built-in/     # Kanban, SystemStatus, etc.
├── context/          # (NEW)
│   ├── ttlManager.ts # TTL tracking
│   ├── unifiedStream.ts # Multi-source aggregation
│   └── dedup.ts      # Content hash deduplication
├── routing/          # (NEW)
│   └── engine.ts     # Route matching for tool responses
└── tools/            # (NEW)
    ├── registry.ts   # Tool definitions
    └── executor.ts   # Tool execution

src/components/
├── FilterBlock.tsx   # (NEW)
├── QueryBlock.tsx    # (NEW)
├── ComponentBlock.tsx # (NEW)
└── embedded/         # (NEW)
    ├── Kanban.tsx
    ├── SystemStatus.tsx
    └── ...
```

---

## Implementation Phases

### Phase 1: Foundation (EXISTS - verify state)

- EventBus and ProjectionScheduler
- Basic hook system
- Tantivy indexing (via floatty-server)

### Phase 2: Filter System

- `filter::` parser
- In-memory block matching
- EventBus subscription for live updates
- FilterBlock component

### Phase 3: Context Directives

- `ctx::` parser
- TTLManager
- ttlDirectiveHook
- Integration with /send

### Phase 4: Component Registry

- `:::` syntax parser
- Registry pattern
- Built-in components (Kanban first)
- ComponentBlock renderer

### Phase 5: Query System

- `query::` parser
- Tantivy query builder
- Grouping logic
- QueryBlock component

### Phase 6: Unified Context Stream

- Claude Code watcher integration
- EVNA polling
- Deduplication layer
- Context sidebar migration

### Phase 7: Tool Use

- Tool registry
- Injection hook
- Executor integration
- Routing for responses

---

## Open Questions for Implementation

1. **Tantivy Status**: Is indexing working? What fields are indexed?
2. **Hook System**: How many hooks exist beyond sendContextHook?
3. **Handler Registry**: What prefixes are registered? How does execution work?
4. **Context Sidebar**: Is it still polling? Should it migrate to EventBus?
5. **Backlinks**: O(n) scan or indexed?
6. **Block Metadata**: What fields currently exist?

---

## Success Criteria

Each phase should:

1. Pass all existing tests (`npm run test`)
2. Not regress PTY performance
3. Follow existing patterns (don't reinvent)
4. Have new test coverage
5. Update CLAUDE.md if architectural changes

---

ctx::2026-01-15 [project::floatty] [mode::architecture-vision] Query/Components/Context vision document created
