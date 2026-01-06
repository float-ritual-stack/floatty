# The Forty-Year Pattern

> "Event → Handler → Transform → Project"
>
> Different wires, same electricity.

## The Shape

```
╭─────────────────────────────────────────────────────────────────╮
│  1985  BBS message handlers                                     │
│        → store-and-forward                                      │
│        → async event processing                                 │
│        → "new message in echo, trigger response"                │
│                                                                  │
│  1995  mIRC bots                                                │
│        → on TEXT *pattern* #channel                             │
│        → transform input → emit output                          │
│        → maintain state across events                           │
│                                                                  │
│  2015  Redux middleware                                         │
│        → action dispatched                                      │
│        → middleware intercepts                                  │
│        → transform, log, gate, enrich                           │
│        → store updates → selectors project                      │
│                                                                  │
│  2026  floatty hooks                                            │
│        → block created/executed                                 │
│        → hook intercepts                                        │
│        → transform, validate, inject context                    │
│        → output syncs → UI projects                             │
╰─────────────────────────────────────────────────────────────────╯
```

Same pattern. Event-driven. Interceptable. Transformable. Projectable.

---

## Concrete Mappings

### The Y.Doc Observer IS the mIRC Event Loop

```typescript
// useBlockStore.ts - this is literally `on *:TEXT:*:`
blocksMap.observeDeep((events) => {
  for (const event of events) {
    if (change.action === 'add') {
      // Pattern match on content
      if (content && isAutoExecutable(content)) {
        // Trigger handler
        setTimeout(() => _autoExecuteHandler!(key, content), 0);
      }
    }
  }
});
```

```
on *:TEXT:*:#float:{
  if ($regex($1-,/^daily::/)) {
    .timer 1 0 daily_handler $nick $1-
  }
}
```

Same shape. Event fires, pattern matches, handler scheduled.

### The `pages::` Container IS a Hash Table

```typescript
// useBacklinkNavigation.ts
function findPage(pageName: string): Block | null {
  const pagesContainer = findPagesContainer();
  for (const childId of pagesContainer.childIds) {
    if (childName === normalizedName) return child;
  }
  return null;
}
```

```
; mIRC hash table lookup
alias findpage {
  return $hget(pages, $1)
}
```

The `pages::` block is the `%pages` hash. The childIds are the keys. The lookup is O(n) now, becomes O(1) when you add the index (same evolution path as mIRC bots getting slow and adding hash tables).

### The Executor Pattern IS Redux Middleware

```typescript
// executor.ts
const handlers: ExecutableBlockHandler[] = [
  { prefixes: ['sh::', 'term::'], execute: ... },
  { prefixes: ['ai::', 'chat::'], execute: ... },
];

export function findHandler(content: string) {
  return handlers.find(h => h.prefixes.some(p => ...));
}
```

```javascript
// Redux middleware chain
const middleware = [
  shellMiddleware,
  aiMiddleware,
  loggerMiddleware,
];

// Each checks if it handles the action, passes to next if not
```

The `findHandler` loop is `applyMiddleware`. The prefixes are action types. The `execute` is the reducer.

### The Safety Tier IS Just `halt` With UX

```
; mIRC 1997
on *:TEXT:*rm -rf*:#channel:{
  echo -a *** BLOCKED: $nick tried dangerous command
  halt
}

// floatty 2026
{
  prefixes: ['agent::sh::'],
  execute: async (cmd) => {
    if (await showApprovalDialog(cmd)) {
      return executeWithSandbox(cmd);
    }
    return { blocked: true, reason: 'user_cancelled' };
  }
}
```

The approval dialog is `halt` with a GUI. The sandbox is running the command in a `/run` window instead of raw shell. Same pattern, better substrate.

---

## The ctx:: Sidebar Is Store-and-Forward

```
┌─────────────────────────────────────────────────────────────────┐
│  1985 BBS:                                                      │
│    Message arrives → store to .MSG file → forward to readers    │
│                                                                  │
│  2026 floatty:                                                  │
│    ctx:: block created → store to Y.Doc → forward to sidebar    │
│                                                                  │
│  Same topology. The .MSG file became CRDT. The reader became   │
│  a SolidJS component. The FidoNet became WebSocket.            │
└─────────────────────────────────────────────────────────────────┘
```

The sidebar polls every 2 seconds (ContextSidebar.tsx). That's store-and-forward with a 2-second batch window. The BBS would have had a 24-hour batch window. The pattern scales.

---

## What This Means for the Hooks System

You don't need to design it from scratch. The shape is known:

```typescript
// The mIRC-shaped hook registry
interface Hook {
  id: string;
  event: EventPattern;      // on *:TEXT:*pattern*:#channel
  filter?: (ctx) => bool;   // if ($nick == evan)
  handler: (ctx) => Result; // { /msg $chan response }
  priority?: number;        // where in the chain
}

// The Redux-shaped middleware
type Middleware = (ctx) => (next) => (event) => Result;

// They're the same thing
// mIRC: implicit next (halt stops chain)
// Redux: explicit next (call or don't)
// floatty: either works, depends on use case
```

The question isn't "what pattern should we use?" - it's "which substrate of the pattern fits this context?"

| Use Case | Pattern | Why |
|----------|---------|-----|
| Safety gates | Explicit next (Redux) | `proceed()` or abort |
| Enrichment | Implicit next (mIRC) | Transform and continue |
| Projections | Fire-and-forget (event sourcing) | Index and don't block |

---

## The Store → Projection Pattern

```
Redux:
  store.dispatch(action)
  → reducers update state
  → selectors derive views
  → UI renders projections

floatty:
  block.execute()
  → handler produces output
  → Y.Doc updates (the store)
  → hooks index/project
  → UI renders + sidebar updates + timeline indexes

CQRS/Event Sourcing:
  command → event stored → projections rebuild views

floatty with hooks:
  execution → output block (event) → hooks project to:
    - wikilink index
    - ctx:: timeline
    - daily note structure
    - search index
```

The ctx:: blocks in the sidebar are a **projection**. An event (block created with ctx:: prefix) triggers a hook that updates a derived view.

---

## The Implication

When you build the hooks system, you're not inventing. You're **transcribing**:

```
┌─────────────────────────────────────────────────────────────────┐
│  FROM: 40 years of pattern recognition in your nervous system  │
│  TO:   TypeScript interfaces and Rust traits                   │
│                                                                  │
│  The architecture already exists. You're just writing it down. │
└─────────────────────────────────────────────────────────────────┘
```

- The daily note auto-population = mIRC `on *:JOIN:` greeting with topic
- The AI context enrichment = Redux middleware adding `meta.user`
- The sandbox = mIRC `/run` containing untrusted scripts
- The approval dialog = `halt` with better UX

---

## The Checksum

```
╭─────────────────────────────────────────────────────────────────╮
│  Event-driven architecture                                       │
│  + Interceptable middleware                                      │
│  + Transformable payloads                                        │
│  + Projectable derived state                                     │
│  = The pattern                                                   │
│                                                                  │
│  BBS → IRC → Redux → floatty                                    │
│  Different wires, same electricity.                             │
╰─────────────────────────────────────────────────────────────────╯
```

The revolution will be boring because it's built on patterns you learned before you knew they were patterns.

**Store-and-forward. That's the whole thing. That's always been the whole thing.**

---

## References

- [SHIMMER_TO_PATTERNS.md](./SHIMMER_TO_PATTERNS.md) - Ritual → Standard patterns
- [FLOATTY_HOOK_SYSTEM.md](./FLOATTY_HOOK_SYSTEM.md) - Hook interface design
- [FLOATTY_HANDLER_REGISTRY.md](./FLOATTY_HANDLER_REGISTRY.md) - Handler trait
- [../EXTERNAL_BLOCK_EXECUTION.md](../EXTERNAL_BLOCK_EXECUTION.md) - Auto-execute spike
