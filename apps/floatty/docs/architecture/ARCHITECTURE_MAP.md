# Floatty Architecture Map

> "Event → Handler → Transform → Project" — the 40-year invariant from BBS to floatty

## The Four Layers

```
┌─────────────────────────────────────────────────────────────────┐
│  CONTROL SURFACE                                    [spec]      │
│  Intent primitives (float.view.navigate, float.data.query)      │
│  Multi-client protocol (claim/result over WS)                   │
├─────────────────────────────────────────────────────────────────┤
│  PROJECTION                                         [built]     │
│  EventBus (sync) → immediate UI/validation                      │
│  ProjectionScheduler (async) → backlinks, search, ctx timeline  │
├─────────────────────────────────────────────────────────────────┤
│  EXECUTION                                          [built]     │
│  HandlerRegistry (prefix → handler)                             │
│  HookRegistry (before/after + lifecycle)                        │
├─────────────────────────────────────────────────────────────────┤
│  SUBSTRATE                                          [built]     │
│  Y.Doc blocks (CRDT): structure + content + metadata            │
│  Origins: user | remote | hook | undo | api | system | executor │
└─────────────────────────────────────────────────────────────────┘
```

**Status key**: `[built]` = real code, tests, wired up. `[spec]` = documented, not yet implemented.

## Layer 1: Substrate (Truth)

Y.Doc blocks as the single source of truth. Everything else is projection or transport.

**State**: Block content, structure (parentId, childIds), syncable metadata.

**Implementation**: `src/hooks/useBlockStore.ts` (Y.Map-backed block CRUD), `src-tauri/src/server.rs` (floatty-server WebSocket sync).

**Origins** (`src/lib/events/types.ts`): Every mutation carries an origin tag:

| Origin | Source | Can Trigger Hooks? |
|--------|--------|-------------------|
| `user` | Keyboard/mouse input | Yes |
| `remote` | CRDT sync from other client | Yes |
| `hook` | Hook-generated metadata | No (prevents loops) |
| `executor` | Handler execution output | Yes |
| `undo` | Undo/redo stack | Yes |
| `api` | External API call | Yes |
| `system` | Internal housekeeping | No |
| `reconnect-authority` | Server state on WS reconnect | Yes |

**Decision rule**: If it must sync and be queryable offline → Y.Doc metadata. If derived and rebuildable → projection index.

## Layer 2: Execution (Do Things)

Handlers perform actions, hooks enrich/gate/transform.

### Handler Registry

```
src/lib/handlers/registry.ts    — Registry (prefix → handler mapping)
src/lib/handlers/executor.ts    — Executor (dispatch + lifecycle)
src/lib/handlers/*.ts           — Individual handlers (search, daily, help, backup, etc.)
```

Prefix → Handler mapping. Handlers read content, do work, write output to blocks.

```typescript
registry.register({
  prefixes: ['search::'],
  execute: async (blockId, content, actions) => { ... }
});
```

### Hook Registry

```
src/lib/hooks/hookRegistry.ts   — Registry (lifecycle → hook mapping)
src/lib/hooks/index.ts          — Hook wiring
```

Hooks enrich, gate, or transform. They don't perform primary actions.

| Hook Phase | Can Abort? | Can Mutate? | Use Case |
|------------|------------|-------------|----------|
| `execute:before` | Yes | Context only | Validation, context injection |
| `execute:after` | No | Block metadata | Extraction, indexing |
| `block:created` | No | New block | Default metadata |
| `block:updated` | No | Changed block | Re-extract markers |

## Layer 3: Projection (Derive Views)

Transform substrate into queryable/displayable forms. Never block user input.

### EventBus (Sync Lane)

```
src/lib/events/eventBus.ts      — Typed pub/sub (213 lines)
src/lib/events/types.ts         — BlockEvent, OriginType definitions
```

Immediate reactions that must complete before next render:
- UI state updates
- Validation feedback
- Focus routing

### ProjectionScheduler (Async Lane)

```
src/lib/events/projectionScheduler.ts   — Debounced batch processor (334 lines)
```

Batched work that can lag behind typing:
- Search index updates (Tantivy)
- Backlink index maintenance
- ctx:: timeline aggregation

**Latency Budgets**:

| Projection | Budget | Strategy |
|------------|--------|----------|
| UI focus | <16ms | Sync EventBus, no debounce |
| Backlinks | <2s | Async, debounced |
| Search index | <5s | Async, batched commits |
| ctx:: sidebar | <2s | Polling (event-driven is a future target) |

**Rule**: Projections are rebuildable. If the index corrupts, rebuild from Y.Doc. (Tantivy already does this — nukes index on restart per FLO-186.)

### UI Projections

The four keyboard control patterns are themselves projections of block state:

| Pattern | Focus Owner | What It Projects |
|---------|-------------|-----------------|
| Regular | contentEditable | Block content → editable DOM |
| Output | outputFocusRef | Handler output → display-only view |
| Picker | Component ref | Block data → editable grid/board |
| Inline Tree | Parent wrapper | Ancestor chain → expandable breadcrumbs |

## Layer 4: Control Surface (Unification) [SPEC]

Stable API vocabulary for multi-client coordination. **Not yet implemented** — documented as architectural target.

### Intent Primitives

```typescript
// Data operations
float.data.get(blockId)
float.data.query({ type: 'search', query: '...' })
float.data.mutate({ type: 'update', blockId, content })

// View operations
float.view.navigate(blockId, { highlight: true })
float.view.layout.split('horizontal')

// System operations
float.sys.on('block:changed', handler)
float.sys.dispatch('execute', { blockId })
```

Intent primitives map 1:1 to UX affordances. `float.view.navigate` = "show block X" (scroll + focus + unzoom + uncollapse as needed).

### Multi-Client Protocol

Desktop claims execution; server routes; results broadcast.

```
Mobile (read-only) ──request──▶ Server ──claim──▶ Desktop (executor)
                   ◀──result───        ◀──result──
```

Principle: Define protocols, don't embed implementations. LSP-style capability negotiation.

---

## The Six Invariants

1. **Y.Doc is the truth**; everything else is a projection or a transport.

2. **Execution is pluggable** (handlers); **observation is universal** (events).

3. **Hooks enrich/gate/transform**; **projections batch/index/derive**.

4. **Origin tags prevent loops** and enable selective reactions.

5. **Multi-client = protocol + capabilities**, not shared code.

6. **Corrections are training deltas** — mistakes become rules (`.claude/rules/`).

---

## Document Index

### Normative (Law)

Rules that agents must follow when writing code.

| Document | Layer | Location |
|----------|-------|----------|
| [ydoc-patterns.md](../../.claude/rules/ydoc-patterns.md) | Substrate | `.claude/rules/` |
| [solidjs-patterns.md](../../.claude/rules/solidjs-patterns.md) | All | `.claude/rules/` |
| [contenteditable-patterns.md](../../.claude/rules/contenteditable-patterns.md) | Projection | `.claude/rules/` |
| [output-block-patterns.md](../../.claude/rules/output-block-patterns.md) | Projection | `.claude/rules/` |
| [do-not.md](../../.claude/rules/do-not.md) | All | `.claude/rules/` |

### Architectural (How It Works)

System design docs — read to understand, don't need to memorize.

| Document | Layer | Purpose |
|----------|-------|---------|
| [FLOATTY_HANDLER_REGISTRY.md](FLOATTY_HANDLER_REGISTRY.md) | Execution | Handler registry design |
| [HANDLER_REGISTRY_IMPLEMENTATION.md](HANDLER_REGISTRY_IMPLEMENTATION.md) | Execution | Implementation details |
| [FLOATTY_HOOK_SYSTEM.md](FLOATTY_HOOK_SYSTEM.md) | Execution | Hook lifecycle contracts |
| [EVENTBUS_HOOK_MIGRATION_REVIEW.md](EVENTBUS_HOOK_MIGRATION_REVIEW.md) | Projection | Two-lane event system |
| [KEYBOARD_CONTROL_PATTERNS.md](KEYBOARD_CONTROL_PATTERNS.md) | Projection | Four keyboard patterns |
| [LOGGING_STRATEGY.md](LOGGING_STRATEGY.md) | All | Structured logging guide |
| [RUST_MODULARIZATION_GUIDE.md](RUST_MODULARIZATION_GUIDE.md) | Substrate | Rust backend structure |

### Guides (How To Build)

Step-by-step implementation guides for common tasks.

| Document | Layer | Purpose |
|----------|-------|---------|
| [RICH_OUTPUT_HANDLER_GUIDE.md](RICH_OUTPUT_HANDLER_GUIDE.md) | Execution | Adding new `prefix::` handlers |
| [INLINE_EXPANSION_PATTERNS.md](INLINE_EXPANSION_PATTERNS.md) | Projection | Per-item expandable state |

### Vision (Where We're Going)

Future direction. Ghost spec — documented but not yet built.

| Document | Layer | Purpose |
|----------|-------|---------|
| [MDX_LITE_VISION.md](MDX_LITE_VISION.md) | Execution | Children-as-config component blocks |
| [FLOATTY_MULTI_CLIENT.md](FLOATTY_MULTI_CLIENT.md) | Control | Multi-client protocol design |
| [INTENT_PRIMITIVES.md](INTENT_PRIMITIVES.md) | Control | Stable API vocabulary |

### Lineage (Why It's This Shape)

Conceptual history and pattern archaeology.

| Document | Layer | Purpose |
|----------|-------|---------|
| [FORTY_YEAR_PATTERN.md](FORTY_YEAR_PATTERN.md) | All | BBS → mIRC → Redux → floatty |
| [BBS_OUTLINE_CONVERGENCE.md](BBS_OUTLINE_CONVERGENCE.md) | Substrate | Conceptual convergence |
| [SHIMMER_TO_PATTERNS.md](SHIMMER_TO_PATTERNS.md) | All | Ritual vocabulary → standard patterns |
| [PHILOSOPHY.md](PHILOSOPHY.md) | All | Design philosophy |
| [PATTERN_INTEGRATION_SKETCH.md](PATTERN_INTEGRATION_SKETCH.md) | All | Pattern integration roadmap |
| [EDITOR_ARCHAEOLOGY.md](EDITOR_ARCHAEOLOGY.md) | Projection | Editor iteration history |

---

## High-Leverage Next Steps

### 1. Backlinks: O(n) → O(1)

**Current**: `LinkedReferences` scans all blocks on render.
**Target**: Hook extracts `outlinks` to block metadata; ProjectionScheduler maintains reverse index.

### 2. ctx:: Sidebar: Polling → Event-Driven

**Current**: 2s polling interval via Tauri commands.
**Target**: Rust watcher emits event, frontend subscribes via EventBus.

### 3. `block:move` Events

**Current**: Indent/outdent operations don't emit structural change events.
**Target**: Move operations produce `block:move` events with `changedFields: ['parentId', 'order']`.

### 4. `changedFields` on All Events

**Current**: Hooks see "block changed" but not which fields.
**Target**: Events include `changedFields` array for precise filtering (skip content-only changes when you only care about structure).

---

## Contract Table Template

For new components, define:

| Aspect | Value |
|--------|-------|
| **Inputs** | What triggers this |
| **Outputs** | What it produces |
| **State Location** | Y.Doc / Signal / SQLite / Memory |
| **Latency Budget** | Sync (<16ms) / Async (<Ns) |
| **Origin Rules** | Which origins trigger, which don't |

Example — Backlink Projection:

| Aspect | Value |
|--------|-------|
| **Inputs** | `block:update` events where content contains `[[` |
| **Outputs** | Reverse index: `targetId → Set<sourceId>` |
| **State Location** | Memory (rebuildable from Y.Doc) |
| **Latency Budget** | Async, <2s, debounced |
| **Origin Rules** | All origins except `hook` |
