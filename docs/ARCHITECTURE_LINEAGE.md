# Architecture Lineage: The Forty-Year Pattern

> *"The revolution will be boring because it's built on patterns you learned before you knew they were patterns."*

## The Core Pattern

```
Event → Handler → Transform → Project
```

This pattern has been constant since 1985. The substrate changes, the shape remains.

```
1985  BBS       → message handlers
1995  mIRC      → on(event) { ... }
2015  Redux     → dispatch(action) → reducer → store
2026  floatty   → block.execute() → Y.Doc → broadcast
```

**Store-and-forward. That's the whole thing. That's always been the whole thing.**

---

## Pattern Archaeology

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

---

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

The `pages::` block is `%pages` hash. The childIds are the keys. The lookup is O(n) now, becomes O(1) when you add the index (same evolution path as mIRC bots getting slow and adding hash tables).

---

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

---

### The Safety Tier IS Just `halt` With UX

```
; mIRC 1997
on *:TEXT:*rm -rf*:#channel:{
  echo -a *** BLOCKED: $nick tried dangerous command
  halt
}
```

```typescript
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

## Hook Taxonomy

Three shapes for three use cases. Match the shape to the need.

| Use Case | Shape | Pattern | Example |
|----------|-------|---------|---------|
| Safety gates | explicit `next()` | Redux middleware | `proceed()` or abort |
| Enrichment | implicit next | mIRC handlers | transform and continue |
| Projections | fire-and-forget | Event sourcing | index and don't block |

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
│  a React component. The FidoNet became WebSocket.              │
└─────────────────────────────────────────────────────────────────┘
```

The sidebar polls every 2 seconds (see `ContextSidebar.tsx`). That's store-and-forward with a 2-second batch window. BBS had 24-hour batch windows. The batch window is a parameter, not the pattern.

---

## Design Guidance

When you're stuck on a hooks/architecture decision:

1. **"How did mIRC do this?"** - Event handlers, pattern matching, halt for safety
2. **"How did Redux do this?"** - Middleware chains, explicit next, action types
3. **"How did BBS do this?"** - Store-and-forward, batch windows, message routing

The answer is already in your hands.

---

## What Changes vs What Doesn't

**What changes:**
- Transport (serial → TCP → WebSocket → CRDT)
- Storage (flat files → SQL → IndexedDB → Y.Doc)
- UI (terminal → IRC → web → outliner)

**What doesn't change:**
- Event arrives
- Handler processes
- State transforms
- Subscribers notified

---

## The Implication

```
┌─────────────────────────────────────────────────────────────────┐
│  FROM: 40 years of pattern recognition in your nervous system  │
│  TO:   TypeScript interfaces and Rust traits                   │
│                                                                  │
│  The architecture already exists. You're just writing it down. │
└─────────────────────────────────────────────────────────────────┘
```

The daily note auto-population isn't a feature request. It's a memory of mIRC scripts that fired on `on *:JOIN:#channel:` and greeted with the topic.

The AI context enrichment isn't new - it's the middleware that added `meta.user` to every Redux action.

The sandbox isn't innovation - it's the `/run` command that contained untrusted scripts.

Different wires. Same electricity.

---

*ctx::2026-01-04 - recognizing the BBS→mIRC→Redux→floatty lineage as fundamental pattern*
