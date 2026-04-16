# Floatty: Architecture Philosophy & Mental Models

> How proven patterns from Redux, mIRC, CQRS, and Excel inform Floatty's AI-native architecture.

**Last Updated**: 2026-01-26

---

## Executive Summary

Floatty's architecture is not novel—it's a synthesis of battle-tested patterns:

| Pattern | Era | Scale Proof | Floatty Mapping |
|---------|-----|-------------|-----------------|
| Redux | 2015+ | Facebook, Instagram, Airbnb | EventBus, Hooks, Projections |
| mIRC Scripts | 1995+ | Millions of concurrent users | Event handlers, pattern matching |
| CQRS/Event Sourcing | 2010+ | Banking, trading, audit systems | Y.Doc as event store, read models |
| Excel | 1985+ | Billions of users, universal | Blocks as cells, formulas, charts |

These aren't metaphors—they're architectural blueprints. Floatty implements each pattern directly.

---

## Part 1: Mental Model Mappings

### 1.1 Redux Model

Redux pioneered predictable state management at scale. Floatty implements the same flow:

```
Redux                          Floatty
─────────────────────────────────────────────────────────────────

Store                     →    Y.Doc (via useBlockStore)
  Single source of truth       CRDT-backed, syncs across clients

Action                    →    BlockEvent
  { type, payload }            { type: 'block:update', blockId, block }

dispatch()                →    Handler execution
  Triggers state change        User prefix triggers pipeline

Reducer                   →    Y.Doc transaction
  (state, action) => state     Applies update, emits to observers

Middleware                →    Hooks (execute:before/after)
  Intercept, transform,        Enrich context, validate,
  log, abort                   can abort execution

Selectors                 →    Projections
  Derived state, memoized      backlinkIndex, searchIndex
  Recompute on changes         Recompute on events (batched)

connect()                 →    EventBus.subscribe()
  Component subscribes         Components react to block events
  to store slices
```

**Redux data flow in Floatty:**

```
User types "sh:: ls"
        │
        ▼
    dispatch(action)           →  handlerRegistry.match('sh::')
        │
        ▼
    middleware chain           →  hookRegistry.run('execute:before')
        │                         priority 0 → 2 → 5 → 8 → 10
        ▼
    reducer                    →  handler.execute() → Y.Doc update
        │
        ▼
    new state                  →  Y.Doc emits BlockEvents
        │
        ▼
    selectors recompute        →  ProjectionScheduler updates indexes
        │
        ▼
    connected components       →  EventBus subscribers re-render
    re-render
```

**Why this matters**: Redux has been proven at massive scale. The pattern handles millions of actions per second at companies like Facebook. Floatty inherits this scalability.

---

### 1.2 mIRC Scripts Model

mIRC (1995) pioneered event-driven scripting for real-time systems. Its patterns directly map to Floatty:

```
mIRC                           Floatty
─────────────────────────────────────────────────────────────────

on TEXT:*pattern*:#:{ }   →    Hook with filter
  Event + pattern match        event: 'block:update'
                               filter: (b) => b.content.match(pattern)

alias /command { }        →    Handler with prefix
  User-invoked command         prefixes: ['/command', 'command::']

on JOIN:#channel:{ }      →    Hook on block:create
  React to event               React to new block appearing

$nick, $chan, $1-         →    ctx.block, ctx.store, ctx.content
  Context variables            HookContext properties

/timer N 1 /command       →    ProjectionScheduler
  Delayed/repeated exec        Debounced batch processing

RAW 001-999               →    Origin-tagged events
  Protocol-level events        User, Remote, Executor, Undo
```

**mIRC-style event table for Floatty:**

```
; Pseudo-mIRC syntax showing Floatty's event model

; Handler: User types prefix, expects result
alias sh {
  /shell.execute $1-
  /block.createChild $result
}

alias ai {
  ; Hooks run automatically before this
  /llm.call $hookContext.messages
  /block.streamResponse
}

; Hook: React to pattern, enrich context
on EXECUTE:*:/send*:{
  /hook.sendContext         ; priority 0
  /hook.ttlDirective        ; priority 2
  /hook.wikilinkExpansion   ; priority 5
}

; Hook: React to any block change
on BLOCKUPDATE:*ctx::*:{
  /contextSidebar.refresh
}

; Projection: Background maintenance
on BLOCKUPDATE:*:{
  /timer 3 1 /projection.backlinkIndex.update $blockid
}
```

**Why this matters**: mIRC handled millions of concurrent users with this event model in 1995. The pattern is proven for real-time, multi-user systems—exactly what Floatty is.

---

### 1.3 CQRS / Event Sourcing Model

CQRS (Command Query Responsibility Segregation) separates reads from writes. Event Sourcing stores all changes as immutable events. Floatty implements both:

```
CQRS/ES                        Floatty
─────────────────────────────────────────────────────────────────

Command                   →    Handler
  Intent to change state       sh::, ai::, /send
  Validated, may fail          Hooks can abort

Event                     →    BlockEvent
  Immutable fact               { type: 'block:update', block, previousBlock }
  Stored forever               Y.Doc stores full history

Event Store               →    Y.Doc
  Append-only log              CRDT with complete change history
  Source of truth              Replayable, syncable

Aggregate                 →    Block tree
  Consistency boundary         Block + descendants = unit

Read Model                →    Projection
  Optimized for queries        backlinkIndex, searchIndex
  Eventually consistent        Updated via ProjectionScheduler

Query                     →    filter::, query::, search::
  Read from projection         Never modify state

Command Handler           →    Handler.execute()
  Validates, emits events      Processes prefix, updates Y.Doc

Event Handler             →    Hook (block:create/update/delete)
  Reacts to events             Updates projections
```

**CQRS separation in Floatty:**

```
┌─────────────────────────────────────────────────────────────────┐
│                         WRITE SIDE                               │
│                                                                  │
│   Commands (Handlers)              Events (Y.Doc)                │
│   ───────────────────              ─────────────                 │
│   sh::ls                       →   block:update                  │
│   ai::explain                  →   block:create (response)       │
│   /send                        →   block:update + block:create   │
│                                                                  │
│   Key rule: Commands emit events. They don't query.              │
└─────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Events flow to read side
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                         READ SIDE                                │
│                                                                  │
│   Projections (Indexes)            Queries (Read Handlers)       │
│   ─────────────────────            ──────────────────────        │
│   backlinkIndex                ←   "What links to [[X]]?"        │
│   searchIndex (Tantivy)        ←   search::keyword               │
│   pageNameIndex                ←   Autocomplete [[...           │
│                                                                  │
│   Key rule: Queries read projections. They don't write.          │
└─────────────────────────────────────────────────────────────────┘
```

**Why this matters**: Event sourcing powers banking systems, stock exchanges, and audit-critical infrastructure. It provides complete history, replay capability, and eventual consistency—all of which Floatty gets from Y.Doc.

---

### 1.4 Excel Model ("Components not Pie Charts")

Excel is the most successful end-user programming environment ever created. Floatty applies its principles:

```
Excel                          Floatty
─────────────────────────────────────────────────────────────────

Cell                      →    Block
  Atomic unit (A1, B2)         Atomic unit (block-uuid)

Cell Reference            →    [[Wikilink]]
  =A1 + B2                     [[Project Notes]], [[API/Auth]]

Formula                   →    filter:: / query::
  =SUM(A1:A10)                 filter:: include(status::todo)
  Computes from cells          Computes from blocks

Recalculation             →    EventBus + Projections
  Change A1 → B2 updates       Change block → dependents update
  Automatic propagation        Via subscriptions

Named Range               →    Page (titled root block)
  "SalesData" = A1:A100        "Project Notes" = block + children

Chart                     →    :::Component (Renderer)
  Visual of cell data          Visual of query results
  Pie, Bar, Line               Kanban, Table, Status, Chart

Pivot Table               →    :::Kanban with groupBy
  Group, aggregate, slice      Group blocks by metadata

Conditional Formatting    →    Block type styling
  If value > X, color red      If sh::, terminal style
                               If ctx::, marker style

Sheet                     →    Zoomed view
  Scoped workspace             Zoom into subtree = new scope
```

**Excel formula model in Floatty:**

```
Excel:
┌───────┬──────────────────────────────────────┐
│  A1   │ 100                                  │
│  A2   │ 200                                  │
│  A3   │ =SUM(A1:A2)              → 300       │ ← Formula
│  A4   │ =A3 * 1.1                → 330       │ ← Dependent
│  A5   │ [PIE CHART of A1:A4]                 │ ← Visualization
└───────┴──────────────────────────────────────┘

Floatty:
┌─────────────────────────────────────────────────────────────────┐
│  Block: "status::todo Buy groceries"                             │
│  Block: "status::done Call mom"                                  │
│  Block: "status::todo Fix bug"                                   │
│                                                                  │
│  Block: "filter:: include(status::*)"                            │
│          ↳ [list of matching blocks]              ← Formula      │
│                                                                  │
│  Block: ":::Kanban                                               │
│          source: filter:: include(status::*)                     │
│          groupBy: status                                         │
│          :::"                                                    │
│          ↳ ┌──────────┐ ┌──────────┐            ← Chart          │
│            │   todo   │ │   done   │                             │
│            │──────────│ │──────────│                             │
│            │Buy grocer│ │ Call mom │                             │
│            │Fix bug   │ │          │                             │
│            └──────────┘ └──────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

**Why this matters**: Excel has billions of users. Its reactive formula model is universally understood. Floatty's blocks-as-cells metaphor makes the system immediately intuitive.

---

## Part 2: AI-Native Principles

Building on these proven patterns, Floatty adds AI as a system primitive.

### 2.1 Everything is Redux

```
The entire system is one reducer:

    (world_state, user_intent) => new_world_state

Every interaction—typing, clicking, AI response, file change,
remote sync—is an action dispatched to the world state.

Y.Doc IS the store.
Handlers ARE dispatch().
Hooks ARE middleware.
Projections ARE selectors.
UI IS connect().

There is no escape from this pattern. Embrace it.
```

### 2.2 Every `::` is a Dispatch

The `::` marker is Floatty's universal dispatch syntax:

```
sh::ls                    →  dispatch({ type: 'SHELL', cmd: 'ls' })
ai::explain               →  dispatch({ type: 'AI', prompt: '...' })
ctx::project::floatty     →  dispatch({ type: 'META', key: 'project', val: 'floatty' })
filter::include(x)        →  dispatch({ type: 'QUERY', filter: {...} })
status::todo              →  dispatch({ type: 'TAG', key: 'status', val: 'todo' })
```

**The `::` is the action type delimiter.**
- Everything before `::` = action type
- Everything after `::` = payload

**Taxonomy:**

```
TYPE          EXAMPLES                    CATEGORY
────────────────────────────────────────────────────────────
Execution     sh::, ai::, run::           COMMAND (do something)
Query         filter::, query::, search:: QUERY (read something)
Metadata      ctx::, project::, status::  META (tag something)
Control       ctx::3, ctx::never          DIRECTIVE (configure)
Transform     transform::, fmt::          TRANSFORM (change)
```

### 2.3 LLMs as Fuzzy Compilers

Traditional compilation:
```
Source → Lexer → Parser → AST → Optimizer → Bytecode → VM
```

LLM compilation:
```
Natural Language → Hook Pipeline → LLM → Structured Output → Handler
                   (compiler frontend)  (fuzzy compiler)     (executor)
```

The hook pipeline IS the compiler frontend:

```
Source: "ctx::3 [[API]] explain auth"

Pass 1 (sendContextHook):      Lexing → { messages: [...] }
Pass 2 (ttlDirectiveHook):     Directives → { messages, ttl }
Pass 3 (wikilinkExpansionHook): Resolution → { messages (expanded) }
Pass 4 (backlinkContextHook):  Dependencies → { messages (enriched) }
Pass 5 (tokenEstimationHook):  Optimization → { messages (sized) }

LLM: Fuzzy compilation → Structured response
Handler: Execution → Stream to block
```

### 2.4 Small Dumb Scripts / Smart Orchestrators

```
WRONG: Smart handlers that do everything
─────────────────────────────────────────
aiHandler:
  - Parse context (50 lines)
  - Expand wikilinks (80 lines)
  - Check TTL (40 lines)
  - Estimate tokens (30 lines)
  - Choose model (20 lines)
  - Call LLM (30 lines)
  - Parse response (40 lines)
  - Create blocks (50 lines)
  = 340 lines, untestable, fragile

RIGHT: Dumb scripts, smart orchestration
─────────────────────────────────────────
sendContextHook:    ~60 lines, just builds messages
ttlDirectiveHook:   ~50 lines, just parses TTL
wikilinkHook:       ~70 lines, just expands links
backlinkHook:       ~40 lines, just adds backlinks
tokenHook:          ~30 lines, just counts tokens
aiHandler:          ~50 lines, just calls LLM

Orchestration: hookRegistry.run() composes them
Total: 300 lines, each piece testable
```

**This is UNIX philosophy:**
- Do one thing well
- Compose via pipes (context object)
- Text (blocks) as universal interface

### 2.5 AI as System Primitive

AI isn't a feature. It's a primitive like `if`, `for`, `function`:

```typescript
// Traditional: Exact matching
if (input === 'yes') { approve(); }

// AI primitive: Fuzzy matching
const intent = await ai.classify(input, ['approve', 'reject', 'unclear']);
switch (intent) { ... }

// Traditional: Exact parsing
const data = JSON.parse(text);  // Fails if invalid

// AI primitive: Fuzzy parsing
const data = await ai.extract(text, { name: 'string', age: 'number' });
// Works with "I'm John, 25 years old"
```

In Floatty, AI is woven throughout—not bolted on:

```
Block: "remind me to call mom tomorrow"

Traditional: /remind (.+) (today|tomorrow)/ → Fragile regex
AI-native: ai.extract(text, { task, when }) → Robust understanding
```

### 2.6 Permeable Boundaries

> Personal notes are personal
> Personal systems are personal
> Systems have permeable boundaries
> Even our systems have systems
> Translate at the boundaries

This isn't philosophy—it's **architectural prescription**.

#### The Axioms

| Axiom | Architectural Implication |
|-------|---------------------------|
| Personal notes are personal | No forced structure. Blocks accept any content. |
| Personal systems are personal | Config at `~/.floatty/`, not global. User owns their data. |
| Systems have permeable boundaries | Workspaces isolate (dev/prod). Exports translate out. |
| Even our systems have systems | floatty-server (headless) + Desktop UI + CLI + agents. |
| Translate at boundaries | Scratchpad evolves → daily note captures → doc canonicalizes. |

#### The Refinement Flow

Content moves through boundaries, transforming at each:

```text
┌─────────────────────────────────────────────────────────────────┐
│  SCRATCHPAD (messy, fast, personal)                              │
│    "some random thought ctx::2026-01-26 @ 5pm"                   │
│         │                                                        │
│         ▼ [boundary: "worth anchoring temporally"]               │
│  DAILY NOTE (chronological, still personal)                      │
│    "- 5pm - floatty patterns - boundaries as design principle"   │
│         │                                                        │
│         ▼ [boundary: "reusable pattern"]                         │
│  CANONICAL DOC (architecture/, structured)                       │
│    "### 2.6 Permeable Boundaries"                                │
│         │                                                        │
│         ▼ [boundary: "external interface"]                       │
│  PUBLIC API / DOCS                                               │
└─────────────────────────────────────────────────────────────────┘
```

Each boundary is a **translation point**. The messy becomes structured. The personal becomes shareable. The implicit becomes explicit.

#### Why This Matters for AI-Native Tools

LLMs work best with clear context boundaries. floatty's architecture produces these naturally:

| Boundary Mechanism | AI Benefit |
|--------------------|------------|
| Block children | Natural context scope (subtree = unit) |
| `ctx::3` TTL | Explicit attention budget |
| `[[wikilink]]` expansion | Controlled context permeability |
| Workspace isolation | Prevents context pollution (test ≠ prod) |
| `pages::` container | Named boundaries (pages are namespaces) |

**The insight**: Boundaries aren't constraints—they're **translation infrastructure**. Good boundaries enable permeability. Bad architecture has no boundaries (everything bleeds) or impermeable walls (nothing connects).

floatty's `::` syntax IS a boundary marker. `sh::` says "this crosses to shell". `ctx::` says "this crosses to timeline". `[[link]]` says "this references across pages". The markers name the boundary crossings.

#### Applied Example: float.dispatch

```text
float.dispatch/
├── bridges/          # Boundary: incoming captures
│   └── auto-inbox/   # Raw arrivals (pre-translation)
├── boards/           # Boundary: processed + organized
│   └── sysops-log/   # Canonical records
└── README.md         # Boundary: external documentation
```

Each folder is a boundary with different permeability:
- `auto-inbox/`: Highly permeable (anything lands here)
- `boards/`: Semi-permeable (curated, but internal)
- Public docs: Low permeability (stable interface)

---

## Part 3: Decision Framework

### The Five Questions

When deciding what primitive to use, ask these questions in order:

```
Q1: Who initiates?
────────────────────────────────────────────────────────────
User types a prefix and wants a result?     → HANDLER
System detects a change and should react?   → HOOK or PROJECTION

Q2: Does it own the block?
────────────────────────────────────────────────────────────
Yes - transforms content, creates children  → HANDLER
No - reads, enriches, but doesn't modify    → HOOK
No - builds derived state from many blocks  → PROJECTION

Q3: When does it run?
────────────────────────────────────────────────────────────
Once, on explicit trigger (Enter key)       → HANDLER
Every time a handler executes (pipeline)    → HOOK (execute:before/after)
Every time blocks change (observer)         → HOOK (block:*) or PROJECTION

Q4: Is it in the critical path?
────────────────────────────────────────────────────────────
Yes - user is waiting for result            → HANDLER or sync HOOK
No - can happen in background               → PROJECTION (async, batched)

Q5: Does it need other hooks' output?
────────────────────────────────────────────────────────────
Yes - needs enriched context                → HOOK (with priority ordering)
No - standalone operation                   → HANDLER
```

### When to Use What

```
I want to...                              Use a...
─────────────────────────────────────────────────────────────────
Execute user command, produce output   →  HANDLER
Intercept execution, enrich context    →  HOOK (execute:before)
React to any block change              →  HOOK (block:update)
Build derived index in background      →  PROJECTION
Display block type specially           →  RENDERER
Query blocks, show results             →  HANDLER (read-only)

Mental model check:
─────────────────────────────────────────────────────────────────
"Is this a Redux action?"              →  Handler
"Is this Redux middleware?"            →  Hook
"Is this a Redux selector?"            →  Projection
"Is this a React component?"           →  Renderer

"Is this an mIRC alias?"               →  Handler
"Is this an mIRC on EVENT?"            →  Hook

"Is this a CQRS command?"              →  Handler (write)
"Is this a CQRS query?"                →  Handler (read) or Projection

"Is this an Excel formula?"            →  filter:: / query::
"Is this an Excel chart?"              →  :::Component
```

### The Four Primitives

```
┌─────────────────────────────────────────────────────────────────┐
│  HANDLER          "I do something when you ask"                  │
│  ───────────────────────────────────────────                     │
│  Trigger: User types prefix + executes                           │
│  Output:  Transforms block, creates children, calls APIs         │
│  Owns:    The block it runs on                                   │
│  Examples: sh::, ai::, search::, filter::                        │
├─────────────────────────────────────────────────────────────────┤
│  HOOK             "I enrich, validate, or react"                 │
│  ───────────────────────────────────────────                     │
│  Trigger: System event (block change, execution lifecycle)       │
│  Output:  Returns context, can abort, does NOT own block         │
│  Owns:    Nothing—observer/interceptor only                      │
│  Examples: sendContextHook, ttlDirectiveHook, backlinkHook       │
├─────────────────────────────────────────────────────────────────┤
│  PROJECTION       "I maintain derived state in background"       │
│  ───────────────────────────────────────────                     │
│  Trigger: Batched block events (debounced)                       │
│  Output:  Updates indexes, caches, external systems              │
│  Owns:    A derived data structure                               │
│  Examples: backlinkIndex, searchIndex, pageNameIndex             │
├─────────────────────────────────────────────────────────────────┤
│  RENDERER         "I display this block type specially"          │
│  ───────────────────────────────────────────                     │
│  Trigger: Block has specific type/content pattern                │
│  Output:  Visual representation (JSX)                            │
│  Owns:    The visual, not the data                               │
│  Examples: KanbanRenderer, ChartRenderer, MermaidRenderer        │
└─────────────────────────────────────────────────────────────────┘
```

### Renderer: The Detection → Rendering Pattern

Renderers are special—they're **not** handlers or hooks. A hook DETECTS the type, a renderer DISPLAYS it:

```
Block: ":::Kanban\ncolumns: todo, done\n:::"
        │
        ▼
componentDetectionHook (block:update)
  Sets block.metadata.componentType = 'kanban'
        │
        ▼
BlockDisplay.tsx checks metadata
        │
        ▼
<KanbanRenderer props={block.metadata.componentProps} />
```

```typescript
// Detection: A hook that sets metadata
export const componentDetectionHook: Hook = {
  id: 'component-detection',
  event: 'block:update',
  filter: (block) => block.content.startsWith(':::'),
  handler: (ctx) => {
    // Parse component type, store in metadata
    // The RENDERER then uses this metadata
    return { context: { componentType: 'kanban', componentProps: {...} } };
  }
};

// Rendering: A component that reads metadata
<Show when={block.metadata?.componentType}>
  <ComponentRenderer type={block.metadata.componentType} props={...} />
</Show>
```

### Applied Examples

#### filter:: — Handler or Hook?

**Analysis:**
- User types `filter:: include(project::floatty)`
- User expects to see results
- Results should appear as content/children
- User initiated, expects output

**Verdict: HANDLER** (it's like search:: — user asks, handler delivers)

```typescript
export const filterHandler: BlockHandler = {
  prefixes: ['filter::'],
  execute: (blockId, content, actions) => {
    const results = queryBlocks(parseFilter(content));
    // Render results as children
  }
};
```

#### ctx::3 [[Page]] — Handler or Hook?

**Analysis:**
- User types this in conversation
- It's a directive, not a command expecting output
- It affects HOW ai::/send works, not what the block becomes
- It enriches context for another handler

**Verdict: HOOK** (execute:before for ai::/send)

```typescript
export const ttlDirectiveHook: Hook = {
  id: 'ttl-directive',
  event: 'execute:before',
  priority: 2,
  filter: (block) => block.content.startsWith('ai::') || block.content.startsWith('/send'),
  handler: (ctx) => {
    // Parse ctx:: directives from conversation
    // Return enriched context, don't modify blocks
    return { context: { ttlState: parsedState } };
  }
};
```

#### :::Kanban — Handler or Hook?

**Analysis:**
- User types `:::Kanban ... :::`
- It's not "executed" — it's rendered differently
- No explicit trigger beyond typing
- It's a block TYPE, not a command

**Verdict: NEITHER** — It's a **Renderer**

The `:::` syntax reveals a fourth primitive. See "Renderer: The Detection → Rendering Pattern" above.

#### Backlink Index — Handler, Hook, or Projection?

**Analysis:**
- No user trigger
- Reacts to ALL block changes
- Builds derived state (reverse index)
- Should be batched (expensive to compute on every keystroke)

**Verdict: PROJECTION**

```typescript
blockProjectionScheduler.register('backlink-index', async (envelope) => {
  for (const event of envelope.events) {
    updateBacklinkIndex(event);
  }
}, { debounceMs: 1500 });
```

#### Door Block Markdown (FLO-633) — Handler, Hook, or Projection?

**Analysis:**
- No user trigger — fires on read
- Pure function over `block.output` (no side effects)
- Never mutates Y.Doc — lives only in the HTTP response payload
- Cacheable (content-addressed via `hash(output.data)`)

**Verdict: PROJECTION** (read-side, server-computed)

This is the first **server-side Projection** in floatty — the backlink index above is a frontend `ProjectionScheduler` example; this one runs in Rust at read-time inside the Axum handler. Same CQRS role (computed read model), different layer.

```rust
// floatty_core::projections (pure, sync, panic-free)
pub fn walk_spec_to_markdown(output_data: &Value) -> String { ... }

// api::blocks::inject_rendered_markdown — wired into the GET handler
pub(crate) fn inject_rendered_markdown(dto: &mut BlockDto, cache: &ProjectionCache) {
    // Only door blocks, only when metadata.renderedMarkdown is null/empty.
    // LRU cache keyed by (block_id, hash(output.data)) — content-addressed.
    // Walker wrapped in catch_unwind so malformed specs never 500.
}
```

**Why server-side, not frontend-hook**: agent-path render blocks (`generatedVia: "agent"`) never get observed by a browser, so the frontend hook never runs. The read-time projection closes the blind spot without touching the write path — agents hitting the REST API get the same markdown a human would see in the outliner.

**Symmetry with the frontend ProjectionScheduler**: both are read models that compute from block state and live outside the CRDT. The frontend version rebuilds the backlink index in response to events (write-triggered, read-fast); the server version computes on request (read-triggered, read-compute-cache). Same pattern, different temporal shape.

#### Wikilink Expansion for AI — Handler, Hook, or Projection?

**Analysis:**
- Runs when ai::/send executes
- Enriches the message context
- Doesn't own the block
- Part of a pipeline (needs TTL state from earlier hook)

**Verdict: HOOK** (execute:before, priority 5 — after TTL hook)

```typescript
export const wikilinkExpansionHook: Hook = {
  id: 'wikilink-expansion',
  event: 'execute:before',
  priority: 5,  // After TTL hook (2)
  filter: (block) => block.content.startsWith('ai::') || block.content.startsWith('/send'),
  handler: (ctx) => {
    const { ttlState } = ctx;  // From earlier hook
    const expanded = expandWikilinks(ctx.messages, ttlState);
    return { context: { messages: expanded } };
  }
};
```

---

## Part 4: Precedent & Scale

These patterns aren't theoretical—they're battle-tested:

### Redux Scale
- **Facebook**: Millions of actions/second
- **Instagram**: Real-time feed updates
- **Airbnb**: Complex booking state machines
- **Proven since**: 2015

### mIRC Scale
- **Peak**: 10+ million concurrent users (2003)
- **Uptime**: Networks running 20+ years
- **Real-time**: Sub-second message delivery
- **Proven since**: 1995

### CQRS/Event Sourcing Scale
- **Banking**: LMAX does 6 million transactions/second
- **Trading**: Stock exchanges worldwide
- **Audit**: Complete history, regulatory compliance
- **Proven since**: 2005

### Excel Scale
- **Users**: 1+ billion
- **Formulas**: Trillions evaluated daily
- **Reactive**: Instant recalculation
- **Proven since**: 1985

Floatty stands on the shoulders of giants. The architecture isn't experimental—it's proven at scales far beyond what Floatty will ever need.

---

## Part 5: The Vision

```
Floatty is not an app with AI features.

Floatty is an AI-native operating environment where:

  - Every block is a potential action (Redux action)
  - Every `::` is a dispatch waiting to happen
  - The outline IS the event store (CQRS)
  - Blocks are cells, queries are formulas (Excel)
  - AI compiles fuzzy intent into structured execution
  - Small dumb scripts compose into smart systems (UNIX)
  - Writing IS programming
  - Reading IS debugging
  - The document IS the application
```

---

## Appendix: Quick Reference

### Handler vs Hook vs Projection

```
┌────────────────────┬─────────────┬───────────────┬─────────────────┐
│ Characteristic     │   HANDLER   │     HOOK      │   PROJECTION    │
├────────────────────┼─────────────┼───────────────┼─────────────────┤
│ Trigger            │ User prefix │ System event  │ Batched events  │
│ Owns block?        │ YES         │ NO            │ NO              │
│ Modifies block?    │ YES         │ NO (context)  │ NO (index)      │
│ Sync/Async         │ Async OK    │ Sync preferred│ Async, batched  │
│ Output             │ Block/child │ Context obj   │ Derived state   │
│ User sees?         │ Yes         │ No            │ No              │
└────────────────────┴─────────────┴───────────────┴─────────────────┘
```

### Hook Priority Chain (execute:before)

```
Priority │ Hook                    │ Purpose
─────────┼─────────────────────────┼─────────────────────────
    0    │ sendContextHook         │ Build conversation
    2    │ ttlDirectiveHook        │ Parse ctx:: directives
    5    │ wikilinkExpansionHook   │ Expand [[links]]
    6    │ queryExpansionHook      │ Expand query:: blocks
    8    │ backlinkContextHook     │ Add backlinks
   10    │ tokenEstimationHook     │ Size check
   20    │ toolInjectionHook       │ Add available tools
  100    │ loggingHook             │ Audit trail
```

### Projection Timing

```
Projection      │ Debounce │ Purpose
────────────────┼──────────┼─────────────────────────
backlink-index  │ 1500ms   │ Reverse link map
tantivy-index   │ 3000ms   │ Full-text search
page-name-index │ 1000ms   │ Autocomplete
```

---

## See Also

- `FLOATTY_HOOK_SYSTEM.md` - Hook implementation details
- `ARCHITECTURE_LINEAGE.md` - Historical context
- `LOGGING_STRATEGY.md` - Structured logging patterns
- `../ydoc-patterns.md` - Y.Doc/CRDT patterns
