# Floatty Architecture Vision: Query, Components, and Context Systems

> Consolidated from architecture session 2026-01-15
> Status: DESIGN COMPLETE, IMPLEMENTATION PENDING

## Executive Summary

This document captures the architectural vision for extending Floatty with:
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

**filter::** is for immediate, reactive filtering of visible blocks. Results update live as blocks change.

**query::** is for structured search with grouping/aggregation. Results are snapshots that can be refreshed.

### 2. Context Directive Naming

Renamed from `skip::` to `ctx::` family for consistency with the consciousness siphon:

| Syntax | TTL | Behavior |
|--------|-----|----------|
| `ctx:: [[Page]]` | 1 | Include once, then drop |
| `ctx::N [[Page]]` | N | Include for N conversation turns |
| `ctx::always [[Page]]` | Infinity | Always include |
| `ctx::never [[Page]]` | 0 | Permanent exclusion |

Context directives control what gets included in AI conversations. TTL counts down with each message exchange.

### 3. Component Registry Pattern

MDX-inspired syntax for embedded rich components:

```markdown
:::Kanban
source: query:: status:* type:task
columns:
  - todo: "To Do"
  - doing: "In Progress"
  - done: "Done"
:::
```

Components render inline within the outliner. They're backed by the same block system but display as interactive widgets.

**Built-in components**:
- `:::Kanban` - Board view from query results
- `:::SystemStatus` - Health dashboard (daemons, services)
- `:::Poll` - Voting interface
- `:::Chart` - Data visualization
- `:::Mermaid` - Diagram rendering

### 4. Unified Context Stream

Three sources converge for AI context:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Outline        │    │  Claude Code    │    │  EVNA           │
│  (ctx:: blocks) │    │  (file watcher) │    │  (MCP polling)  │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                      │
         └──────────────────────┼──────────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │  ContextStream        │
                    │  (dedup by content    │
                    │   hash, priority      │
                    │   order)              │
                    └───────────────────────┘
```

Priority when duplicates: `outline > claude_code > evna`

### 5. Hook Priority Map

| Priority | Hook | Purpose |
|----------|------|---------|
| 0 | sendContextHook | Build conversation messages |
| 2 | ttlDirectiveHook | Parse ctx:: directives, decrement TTL |
| 5 | wikilinkExpansionHook | Expand [[wikilinks]] to content |
| 6 | queryExpansionHook | Expand query:: blocks to results |
| 8 | backlinkContextHook | Inject relevant backlinks |
| 10 | tokenEstimationHook | Warn on large context |
| 20 | toolInjectionHook | Add tools based on visible components |
| 100 | loggingHook | Audit trail |

### 6. ProjectionScheduler Handlers

| Handler | Debounce | Purpose |
|---------|----------|---------|
| tantivy-index | 3000ms | Batch index updates to Tantivy |
| backlink-index | 1500ms | Build reverse link index |
| ctx-extraction | 2000ms | Extract ctx:: markers from changes |

---

## Reference Implementations Analyzed

### FLOAT Block V2.3 (Drafts.app)

Production-tested patterns directly portable to Floatty:

**TTLManager class**:
```javascript
class TTLManager {
  constructor(conversation) {
    this.conversation = conversation;
    this.ttlMap = new Map(); // target -> { ttl, addedAtTurn }
  }

  processDirective(directive) {
    const { target, ttl } = parseCtxDirective(directive);
    this.ttlMap.set(target, {
      ttl: ttl,
      addedAtTurn: this.conversation.turnCount
    });
  }

  getActiveReferences() {
    const currentTurn = this.conversation.turnCount;
    return [...this.ttlMap.entries()]
      .filter(([_, data]) => {
        if (data.ttl === 'always') return true;
        if (data.ttl === 'never') return false;
        return data.addedAtTurn + data.ttl > currentTurn;
      })
      .map(([target, _]) => target);
  }
}
```

**Key learnings**:
- Section extraction by heading works well
- Link grouping: specific beats general (per-page beats global)
- Debug shadow drafts invaluable for troubleshooting

### float-janky-shack-door (React prototype)

Component registry pattern validated:

```typescript
const componentRegistry = {
  'Kanban': KanbanComponent,
  'SystemStatus': SystemStatusComponent,
  'Poll': PollComponent,
};

function ComponentBlock({ type, props, children }) {
  const Component = componentRegistry[type];
  if (!Component) return <UnknownComponent type={type} />;
  return <Component {...props}>{children}</Component>;
}
```

**Key learnings**:
- YAML-like props parsing straightforward
- Drag-drop in Kanban updates block metadata
- Components need access to block store for queries

---

## Existing Infrastructure (per Migration Review)

### Already Implemented and Working

| Component | Location | Status |
|-----------|----------|--------|
| EventBus (sync lane) | `src/lib/events/eventBus.ts` | Working |
| ProjectionScheduler (async lane) | `src/lib/events/projectionScheduler.ts` | Working |
| HookRegistry | `src/lib/hooks/hookRegistry.ts` | Working |
| Y.Doc observer emitting to both lanes | `useBlockStore.ts:250-374` | Working |
| sendContextHook | `src/lib/handlers/hooks/sendContextHook.ts` | Reference impl |
| Handler executor with hook lifecycle | `src/lib/handlers/executor.ts` | Working |

### Migration Candidates Identified

| Component | Current State | Priority | Target |
|-----------|---------------|----------|--------|
| Backlinks | O(n) scan | HIGH | O(1) index via ProjectionScheduler |
| Context Sidebar | Polling Tauri commands | HIGH | EventBus subscription |
| Block move events | Not emitted | MEDIUM | Add to Y.Doc observer |
| Search index | Direct Tantivy | MEDIUM | ProjectionScheduler handler |

---

## Target File Structure

```
src/lib/
├── filter/              # filter:: parser and matcher
│   ├── parser.ts        # Parse filter:: syntax
│   ├── matcher.ts       # In-memory block matching
│   └── index.ts
├── query/               # query:: parser (Tantivy integration)
│   ├── parser.ts        # Parse query:: syntax
│   ├── executor.ts      # Execute against Tantivy
│   └── index.ts
├── components/          # Component registry
│   ├── registry.ts      # Component registration
│   ├── parser.ts        # Parse :::Component blocks
│   └── index.ts
├── context/             # Unified context stream
│   ├── stream.ts        # Context aggregation
│   ├── ttlManager.ts    # TTL tracking
│   ├── sources/
│   │   ├── outline.ts   # ctx:: block extraction
│   │   ├── claudeCode.ts # File watcher integration
│   │   └── evna.ts      # MCP polling
│   └── index.ts
├── routing/             # Routing engine
│   ├── engine.ts        # Route matching
│   ├── transformer.ts   # Block transformations
│   └── index.ts
├── projections/         # Async handlers
│   ├── tantivy.ts       # Tantivy indexing
│   └── backlinks.ts     # Backlink index
├── handlers/hooks/      # Execution hooks
│   ├── sendContext.ts
│   ├── ttlDirective.ts
│   ├── wikilinkExpansion.ts
│   ├── queryExpansion.ts
│   ├── tokenEstimation.ts
│   └── toolInjection.ts
└── tools/               # LLM tool definitions
    ├── registry.ts
    ├── blockTools.ts    # create, update, move, delete
    └── index.ts

src/components/
├── FilterBlock.tsx      # Renders filter:: blocks
├── QueryBlock.tsx       # Renders query:: blocks
├── ComponentBlock.tsx   # Dynamic component renderer
└── embedded/
    ├── Kanban.tsx
    ├── SystemStatus.tsx
    ├── Poll.tsx
    └── Chart.tsx
```

---

## Implementation Phases

### Phase 1: Foundation
- Tantivy projection handler (if not already using ProjectionScheduler)
- Backlink index migration (O(n) → O(1))
- filter:: parser and matcher

### Phase 2: Components
- Component registry
- ComponentBlock renderer
- Built-in components (Kanban first, then SystemStatus)

### Phase 3: Context
- TTL hooks (ctx::N directive)
- Unified context stream
- Context sidebar migration to EventBus

### Phase 4: Routing
- Routing engine implementation
- Transform handler integration

### Phase 5: Tools
- Tool registry
- Tool injection hook
- Executor integration for tool responses

---

## Open Questions for Codebase Exploration

1. **Tantivy state**: What is the current state of Tantivy integration? Is indexing happening via ProjectionScheduler or directly?

2. **Context Sidebar data flow**: How is ContextSidebar currently fetching data? Confirm polling pattern vs EventBus.

3. **Existing hooks**: What hooks exist beyond sendContextHook? Are there lifecycle hooks for block:create/update/delete?

4. **Block metadata**: Is `block.metadata` being used? What fields are currently stored?

5. **Handler registry**: How does the current handler registry work? What prefixes are registered?

6. **Terminal architecture**: What's the terminal/PTY architecture for future tool use integration?

7. **Component patterns**: Are there any existing component rendering patterns beyond BlockItem?

---

## Data Flow Diagrams

### Filter Block Data Flow

```
User types: filter:: include(sh) exclude(ai)
                        │
                        ▼
              ┌─────────────────┐
              │  FilterParser   │
              │  (sync)         │
              └────────┬────────┘
                       │ ParsedFilter
                       ▼
              ┌─────────────────┐
              │  FilterMatcher  │◀──── EventBus: block:change
              │  (reactive)     │
              └────────┬────────┘
                       │ MatchedBlocks[]
                       ▼
              ┌─────────────────┐
              │  FilterBlock    │
              │  Component      │
              └─────────────────┘
```

### Query Block Data Flow

```
User types: query:: type:task status:todo group:project
                        │
                        ▼
              ┌─────────────────┐
              │  QueryParser    │
              │  (sync)         │
              └────────┬────────┘
                       │ ParsedQuery
                       ▼
              ┌─────────────────┐
              │  Tantivy Search │
              │  (async)        │
              └────────┬────────┘
                       │ BlockIds[]
                       ▼
              ┌─────────────────┐
              │  Y.Doc Hydrate  │
              │  (sync)         │
              └────────┬────────┘
                       │ FullBlocks[]
                       ▼
              ┌─────────────────┐
              │  GroupBy        │
              │  (if specified) │
              └────────┬────────┘
                       │ GroupedResults
                       ▼
              ┌─────────────────┐
              │  QueryBlock     │
              │  Component      │
              └─────────────────┘
```

### Context Stream Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     ContextStream                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   OutlineSource        ClaudeCodeSource       EvnaSource        │
│        │                     │                    │              │
│        │ ctx:: blocks        │ jsonl watcher      │ MCP poll     │
│        │                     │                    │              │
│        └─────────────────────┼────────────────────┘              │
│                              ▼                                   │
│                    ┌─────────────────┐                          │
│                    │  Deduplication  │                          │
│                    │  (content hash) │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│                             ▼                                    │
│                    ┌─────────────────┐                          │
│                    │  Priority Sort  │                          │
│                    │  outline > cc > │                          │
│                    │  evna           │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│                             ▼                                    │
│                    ┌─────────────────┐                          │
│                    │  TTL Filter     │                          │
│                    │  (active only)  │                          │
│                    └────────┬────────┘                          │
│                             │                                    │
│                             ▼                                    │
│                       ContextItems[]                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## References

- Hook System Design: `docs/architecture/FLOATTY_HOOK_SYSTEM.md`
- Handler Registry: `docs/architecture/FLOATTY_HANDLER_REGISTRY.md`
- Multi-Client Architecture: `docs/architecture/FLOATTY_MULTI_CLIENT.md`
- Search Architecture: `docs/SEARCH_ARCHITECTURE_LAYERS.md`
- FLOAT Block V2.3 (Drafts): Production TTL/turn extraction implementation
- float-janky-shack-door: React component registry prototype
