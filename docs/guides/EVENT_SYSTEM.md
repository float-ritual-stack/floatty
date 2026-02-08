# Event System Guide

> Two-lane event architecture: EventBus (sync) and ProjectionScheduler (async batched).

---

## Overview

Floatty uses a two-lane event system for block changes:

```
Y.Doc Change
     │
     ├──────────────────────────────────────┐
     │                                      │
     ▼                                      ▼
┌─────────────────────┐         ┌─────────────────────┐
│     EventBus        │         │ ProjectionScheduler │
│   (synchronous)     │         │   (async batched)   │
├─────────────────────┤         ├─────────────────────┤
│ • UI updates        │         │ • Search indexing   │
│ • Validation        │         │ • Metadata extract  │
│ • Immediate effects │         │ • Analytics         │
│ • < 16ms handlers   │         │ • Expensive ops     │
└─────────────────────┘         └─────────────────────┘
```

**When to use which:**

| Use Case | Lane | Why |
|----------|------|-----|
| Update UI signals | EventBus | Must be synchronous |
| Validate content | EventBus | Block before propagation |
| Update search index | ProjectionScheduler | Expensive, can batch |
| Extract metadata | ProjectionScheduler | Can debounce |
| Send webhooks | ProjectionScheduler | Network latency OK |

---

## EventBus (Sync Lane)

For handlers that must run immediately and synchronously.

### Basic Usage

```typescript
import { blockEventBus, EventFilters, Origin } from '../lib/events';

// Subscribe to events
const subscriptionId = blockEventBus.subscribe(
  (envelope) => {
    for (const event of envelope.events) {
      if (event.type === 'block:create') {
        console.log('Block created:', event.blockId);
      }
    }
  },
  {
    filter: EventFilters.creates(),
    priority: 50,
    name: 'my-handler',
  }
);

// Later: unsubscribe
blockEventBus.unsubscribe(subscriptionId);
```

### Emitting Events

```typescript
blockEventBus.emit({
  batchId: crypto.randomUUID(),
  timestamp: Date.now(),
  origin: Origin.User,
  events: [
    {
      type: 'block:update',
      blockId: 'abc123',
      block: { id: 'abc123', content: 'hello', ... },
      previousBlock: { id: 'abc123', content: 'hi', ... },
      changedFields: ['content'],
    },
  ],
});
```

### Priority Conventions

| Range | Use |
|-------|-----|
| -100 to -1 | Security, validation (run first) |
| 0 to 49 | Context assembly, transformation |
| 50 to 99 | Standard processing (default: 50) |
| 100+ | Logging, cleanup (run last) |

### Event Filters

Pre-built filters for common patterns:

```typescript
import { EventFilters } from '../lib/events';

// Filter by event type
EventFilters.creates()           // block:create only
EventFilters.updates()           // block:update only
EventFilters.deletes()           // block:delete only

// Filter by what changed
EventFilters.fieldChanged('content')   // content field changed
EventFilters.fieldChanged('collapsed') // collapsed state changed

// Filter by origin
EventFilters.fromOrigin(Origin.User)   // user-initiated only
EventFilters.fromOrigin(Origin.Remote) // remote sync only

// Filter by content
EventFilters.contentPrefix('sh::')     // sh:: blocks only
EventFilters.byBlockType('ai')         // ai blocks only
EventFilters.hasWikilinks()            // blocks with [[links]]

// Combine filters
EventFilters.all(
  EventFilters.updates(),
  EventFilters.fieldChanged('content'),
  EventFilters.fromOrigin(Origin.User)
)

EventFilters.any(
  EventFilters.contentPrefix('sh::'),
  EventFilters.contentPrefix('ai::')
)
```

---

## ProjectionScheduler (Async Lane)

For expensive operations that can be batched.

### Basic Usage

```typescript
import { blockProjectionScheduler, EventFilters } from '../lib/events';

// Register a projection
const projectionId = blockProjectionScheduler.register(
  'search-indexer',
  async (envelope) => {
    // This receives batched events
    for (const event of envelope.events) {
      if (event.type === 'block:update') {
        await updateSearchIndex(event.block);
      }
    }
  },
  {
    filter: EventFilters.updates(),
    name: 'tantivy-index',
  }
);

// Events are queued and flushed every 2 seconds
blockProjectionScheduler.enqueue(envelope);

// Manual flush (for tests)
await blockProjectionScheduler.flush();

// Cleanup
blockProjectionScheduler.unregister(projectionId);
blockProjectionScheduler.stop();
```

### Configuration

```typescript
const scheduler = new ProjectionScheduler({
  flushIntervalMs: 2000,  // Flush every 2 seconds (default)
  maxQueueSize: 1000,     // Force flush if queue exceeds this
  autoStart: true,        // Start timer automatically
});
```

### Timing Guidelines

From `ydoc-patterns.md`:

| Layer | Timing | Purpose |
|-------|--------|---------|
| Input (BlockItem) | 150ms | Batch keystrokes |
| Sync (Y.Doc) | 50ms | Batch server sync |
| Hooks (metadata) | 1-2s | Batch extraction |
| Index (Tantivy) | 2-5s | Batch expensive commits |

---

## Event Types

```typescript
type BlockEventType =
  | 'block:create'
  | 'block:update'
  | 'block:delete'
  | 'block:move';

interface BlockEvent {
  type: BlockEventType;
  blockId: string;
  block?: Block;                  // undefined for delete
  previousBlock?: Block;          // set for update/delete
  changedFields?: BlockChangeField[]; // set for update
}

type BlockChangeField =
  | 'content'
  | 'type'
  | 'collapsed'
  | 'childIds'
  | 'parentId'
  | 'metadata'
  | 'output'
  | 'outputType'
  | 'outputStatus';
```

---

## Origin Tracking

Events carry an `Origin` to prevent infinite loops:

```typescript
enum Origin {
  User = 'user',       // User interaction (keyboard, click)
  Remote = 'remote',   // Y.Doc sync from another client
  Hook = 'hook',       // Generated by a hook
  Undo = 'undo',       // Undo/redo operation
  BulkImport = 'bulk_import', // Bulk import operation
  Api = 'api',         // REST API call
  System = 'system',   // System-generated
  Executor = 'executor', // Block executor
  ReconnectAuthority = 'reconnect-authority', // Server-authoritative reconnect apply
}
```

**Filter by origin to avoid echo loops:**

```typescript
blockEventBus.subscribe(
  (envelope) => {
    // Only process user-initiated changes
    if (envelope.origin === Origin.User) {
      processChanges(envelope.events);
    }
  }
);

// Or use EventFilters
blockEventBus.subscribe(handler, {
  filter: EventFilters.fromOrigin(Origin.User),
});
```

---

## Integration with Y.Doc

Events are typically emitted from Y.Doc observers:

```typescript
// In useBlockStore or similar
blocksMap.observeDeep((events) => {
  const blockEvents = transformYDocEvents(events);

  if (blockEvents.length > 0) {
    const envelope: EventEnvelope = {
      batchId: crypto.randomUUID(),
      timestamp: Date.now(),
      origin: determineOrigin(events),
      events: blockEvents,
    };

    // Sync lane - immediate
    blockEventBus.emit(envelope);

    // Async lane - batched
    blockProjectionScheduler.enqueue(envelope);
  }
});
```

---

## Common Patterns

### Pattern 1: UI Update on Block Change

```typescript
// Update a SolidJS signal when blocks change
blockEventBus.subscribe(
  (envelope) => {
    for (const event of envelope.events) {
      if (event.type === 'block:update') {
        setBlockSignal(event.blockId, event.block);
      }
    }
  },
  { priority: 50 }
);
```

### Pattern 2: Validate Before Write

```typescript
// Run at high priority to validate early
blockEventBus.subscribe(
  (envelope) => {
    for (const event of envelope.events) {
      if (event.type === 'block:update') {
        const content = event.block.content;
        if (content.includes('rm -rf /')) {
          console.warn('Dangerous command detected');
          // Could emit a warning event or block somehow
        }
      }
    }
  },
  { priority: -50, filter: EventFilters.updates() }
);
```

### Pattern 3: Debounced Index Update

```typescript
// Batch updates to search index
blockProjectionScheduler.register(
  'search-index',
  async (envelope) => {
    const updates = envelope.events
      .filter(e => e.type === 'block:update')
      .map(e => e.block);

    if (updates.length > 0) {
      await tantivy.indexBatch(updates);
    }
  },
  { filter: EventFilters.updates() }
);
```

### Pattern 4: Cross-Client Sync Handling

```typescript
// Only process changes from other clients
blockEventBus.subscribe(
  (envelope) => {
    if (envelope.origin === Origin.Remote) {
      // Update local UI to reflect remote changes
      for (const event of envelope.events) {
        refreshBlockUI(event.blockId);
      }
    }
  },
  { filter: EventFilters.fromOrigin(Origin.Remote) }
);
```

---

## HMR Cleanup

Both EventBus and ProjectionScheduler support cleanup for hot module replacement:

```typescript
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    blockEventBus.clear();
    blockProjectionScheduler.stop();
  });
}
```

---

## Testing

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, ProjectionScheduler, Origin } from '../lib/events';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('calls handlers in priority order', () => {
    const calls: number[] = [];

    bus.subscribe(() => calls.push(2), { priority: 50 });
    bus.subscribe(() => calls.push(1), { priority: 10 });
    bus.subscribe(() => calls.push(3), { priority: 100 });

    bus.emit({
      batchId: '1',
      timestamp: Date.now(),
      origin: Origin.User,
      events: [],
    });

    expect(calls).toEqual([1, 2, 3]);
  });
});

describe('ProjectionScheduler', () => {
  it('batches events until flush', async () => {
    const scheduler = new ProjectionScheduler({ autoStart: false });
    const handler = vi.fn();

    scheduler.register('test', handler);

    // Enqueue multiple events
    scheduler.enqueue({ batchId: '1', timestamp: 1, origin: Origin.User, events: [] });
    scheduler.enqueue({ batchId: '2', timestamp: 2, origin: Origin.User, events: [] });

    // Not called yet
    expect(handler).not.toHaveBeenCalled();

    // Flush
    await scheduler.flush();

    // Called once with merged envelope
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
```

---

## References

- EventBus: `src/lib/events/eventBus.ts`
- ProjectionScheduler: `src/lib/events/projectionScheduler.ts`
- Types: `src/lib/events/types.ts`
- Convenience filters: exported from `src/lib/events/index.ts` (`EventFilters`, implemented in `types.ts`)
- Y.Doc patterns: `.claude/rules/ydoc-patterns.md`
