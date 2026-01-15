# Established Patterns Reference

Deep-dive documentation for floatty's five core architecture patterns.

## Contents

- [Two-Lane Event System](#two-lane-event-system)
- [Origin-Tagged Transactions](#origin-tagged-transactions)
- [Terminal Lifecycle Outside SolidJS](#terminal-lifecycle-outside-solidjs)
- [Ref-Counted Observers](#ref-counted-observers)
- [Defensive Disposal Sequences](#defensive-disposal-sequences)

---

## Two-Lane Event System

**Location**: `src/lib/events/`

### Why It Exists

Block changes need two different response speeds:
1. **Immediate** - UI must update NOW (user sees their typing)
2. **Eventually** - Expensive work can wait (search indexing, backlink extraction)

Mixing these in one path means either UI lag or dropped updates.

### Architecture

```
Block change (Y.Doc transaction)
     │
     ├──▶ EventBus.emit()           ← Sync lane
     │    └─ UI signals update
     │    └─ Immediate feedback
     │
     └──▶ ProjectionScheduler.enqueue()  ← Async lane
          └─ Tantivy indexing
          └─ Backlink extraction
          └─ Batched, debounced
```

### Key Files

| File | Purpose |
|------|---------|
| `src/lib/events/EventBus.ts` | Synchronous event emission |
| `src/lib/events/ProjectionScheduler.ts` | Async queue with debouncing |
| `src/lib/events/types.ts` | Event envelope types |

### Common Violations

```typescript
// ❌ WRONG - expensive work in sync path
blocksMap.observeDeep(events => {
  updateUI(events);
  await tantivy.index(events);  // Blocks UI!
});

// ✅ CORRECT - route expensive work to async lane
blocksMap.observeDeep(events => {
  eventBus.emit(toBlockChanges(events));  // Sync: UI
  projectionScheduler.enqueue(events);     // Async: indexing
});
```

---

## Origin-Tagged Transactions

**Location**: `src/lib/origin.ts`, used throughout

### Why It Exists

Without origin tags, observers can't distinguish:
- User typing (should trigger hooks)
- Hook writing metadata (should NOT trigger hooks again → infinite loop)
- Remote sync (should update UI but not re-process locally)

### Origin Values

| Origin | Meaning | Typical Response |
|--------|---------|------------------|
| `Origin.User` | Local keyboard input | Run hooks, sync to server |
| `Origin.Remote` | Server sync arrival | Update UI only |
| `Origin.Hook` | Automated metadata | Skip other hooks |
| `Origin.Executor` | Handler output | Skip hooks, sync to server |
| `Origin.BulkImport` | Initial load | Skip hooks, batch UI updates |

### Pattern

```typescript
// Writing with origin
yDoc.transact(() => {
  blockMap.set('content', newContent);
}, Origin.User);

// Reading origin in observer
blocksMap.observeDeep(events => {
  const origin = events[0]?.transaction.origin;

  if (origin === Origin.Hook) {
    return;  // Don't process hook-generated changes
  }

  if (origin === Origin.Remote) {
    updateUIOnly(events);
    return;  // Don't re-trigger local hooks
  }

  // Origin.User - run full processing
  processUserEdit(events);
});
```

### Common Violations

```typescript
// ❌ WRONG - no origin, triggers sync loop
yDoc.transact(() => {
  blockMap.set('metadata', extracted);
});

// ✅ CORRECT - origin prevents re-triggering
yDoc.transact(() => {
  blockMap.set('metadata', extracted);
}, Origin.Hook);
```

---

## Terminal Lifecycle Outside SolidJS

**Location**: `src/lib/terminalManager.ts`

### Why It Exists

SolidJS reactivity causes problems with heavy stateful objects:
- `<For>` identity changes unmount/remount terminals
- Store updates can trigger unexpected re-renders
- Terminal state (scrollback, WebGL context) is expensive to recreate

### Architecture

```
SolidJS Component Layer          Singleton (non-reactive)
┌─────────────────────┐         ┌────────────────────────────┐
│  TerminalPane.tsx   │   ref   │    terminalManager         │
│  (thin wrapper)     │ ──────▶ │  - instances: Map<id,term> │
│  - container div    │         │  - attach(id, container)   │
│  - calls attach()   │         │  - dispose(id)             │
└─────────────────────┘         │  - WebGL lifecycle         │
                                └────────────────────────────┘
```

### Key Rules

1. **TerminalPane is a thin wrapper** - no terminal state, just a container
2. **terminalManager owns instances** - survives component re-renders
3. **attach() is idempotent** - safe to call on every render
4. **dispose() handles WebGL** - must dispose addon BEFORE DOM removal

### Pattern

```typescript
// TerminalPane.tsx - thin wrapper
function TerminalPane(props: { id: string }) {
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    if (containerRef) {
      terminalManager.attach(props.id, containerRef);
    }
  });

  onCleanup(() => {
    // Don't dispose here! Manager handles lifecycle.
  });

  return <div ref={containerRef} class="terminal-container" />;
}

// terminalManager.ts - owns lifecycle
attach(id: string, container: HTMLElement) {
  let instance = this.instances.get(id);
  if (!instance) {
    instance = this.createTerminal(id);
    this.instances.set(id, instance);
  }
  instance.term.open(container);
}
```

---

## Ref-Counted Observers

**Location**: `src/hooks/useSyncedYDoc.ts`

### Why It Exists

Multiple panes can show the same block. Without ref-counting:
- Pane A opens block → registers observer
- Pane B opens same block → registers ANOTHER observer
- Now you have N observers for N panes → N× processing

### Architecture

```typescript
const observerRefs = new Map<string, {
  count: number;
  unsubscribe: () => void;
}>();

function registerObserver(blockId: string) {
  const existing = observerRefs.get(blockId);
  if (existing) {
    existing.count++;
    return () => unregisterObserver(blockId);
  }

  // First registration - actually subscribe
  const unsubscribe = blocksMap.observeDeep(handler);
  observerRefs.set(blockId, { count: 1, unsubscribe });

  return () => unregisterObserver(blockId);
}

function unregisterObserver(blockId: string) {
  const existing = observerRefs.get(blockId);
  if (!existing) return;

  existing.count--;
  if (existing.count === 0) {
    existing.unsubscribe();
    observerRefs.delete(blockId);
  }
}
```

### Common Violations

```typescript
// ❌ WRONG - new observer per component instance
function BlockView(props: { id: string }) {
  onMount(() => {
    blocksMap.observeDeep(handleChange);  // Explosion!
  });
}

// ✅ CORRECT - ref-counted via hook
function BlockView(props: { id: string }) {
  const cleanup = registerObserver(props.id);
  onCleanup(cleanup);
}
```

---

## Defensive Disposal Sequences

**Location**: Throughout, especially `src/lib/terminalManager.ts`, `src-tauri/src/pty/`

### Why It Exists

Disposal races cause:
- Double-free crashes (disposing already-disposed resource)
- Zombie processes (PTY still running after window close)
- Stale callbacks (handler fires after component unmounted)

### Patterns

#### 1. Disposing Guard Set

```typescript
const disposing = new Set<string>();

function dispose(id: string) {
  if (disposing.has(id)) return;  // Already disposing
  disposing.add(id);

  try {
    // Actual disposal work
    instance.destroy();
  } finally {
    disposing.delete(id);
  }
}
```

#### 2. exitedNaturally Flag

```typescript
let exitedNaturally = false;

ptyProcess.on('exit', () => {
  exitedNaturally = true;
  cleanup();
});

// In forced shutdown
function forceKill() {
  if (exitedNaturally) return;  // Already gone
  ptyProcess.kill();
}
```

#### 3. Valid PID Checks

```rust
// src-tauri/src/pty/manager.rs
fn kill_process(pid: u32) {
    if pid == 0 { return; }  // Invalid PID

    // Check if process exists before killing
    if let Ok(exists) = process_exists(pid) {
        if exists {
            signal::kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
        }
    }
}
```

#### 4. try/finally for Flag Resets

```typescript
let isProcessing = false;

async function process(data: unknown) {
  if (isProcessing) return;
  isProcessing = true;

  try {
    await doWork(data);
  } finally {
    isProcessing = false;  // Always reset, even on error
  }
}
```

### Common Violations

```typescript
// ❌ WRONG - no guard, double-dispose possible
function cleanup() {
  instance.destroy();
}

// ❌ WRONG - flag not reset on error
isProcessing = true;
await doWork();  // If this throws...
isProcessing = false;  // ...this never runs

// ✅ CORRECT - guarded with try/finally
if (disposing.has(id)) return;
disposing.add(id);
try {
  instance.destroy();
} finally {
  disposing.delete(id);
}
```

---

## Pattern Interaction Example

A block edit flowing through all five patterns:

```
1. User types in BlockItem
   └─ Y.Doc.transact(..., Origin.User)     [Origin-Tagged]

2. Observer fires (ref-counted, single instance)
   └─ Checks: origin !== Origin.Hook       [Origin filtering]
   └─ EventBus.emit(blockChange)           [Two-Lane: sync]
   └─ ProjectionScheduler.enqueue()        [Two-Lane: async]

3. UI updates immediately via EventBus

4. ProjectionScheduler (debounced) runs Tantivy index
   └─ transact(..., Origin.Hook)           [Origin-Tagged]

5. Observer fires again, sees Origin.Hook, skips re-processing

6. If pane closes during this:
   └─ disposing.has(paneId) check          [Defensive Disposal]
   └─ Ref count decremented                [Ref-Counted]
   └─ If last ref, unsubscribe observer
```

This is the rhythm: origins prevent loops, lanes separate concerns, refs prevent explosion, guards prevent races.
