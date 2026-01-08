# Phase 0 Work Units - Event Infrastructure

## 0.1 Event Types (30min)

**Status**: pending
**Scope**: `src/lib/events`

### Entry Criteria

- [ ] Located useBlockStore.ts
- [ ] Understand current Y.Doc observer pattern
- [ ] Read FLOATTY_HOOK_SYSTEM.md for context

### Exit Criteria

- [ ] `types.ts` created with:
  - `EventEnvelope` - wrapper with id, timestamp, origin
  - `BlockEvent` - create/update/delete block events
  - `Origin` - local vs remote vs projection
- [ ] `index.ts` exports all types
- [ ] `npm run type-check` passes

### Rollback

```bash
git checkout HEAD -- src/lib/events/
```

### Implementation Notes

Types should match the two-lane model:
- EventBus uses EventEnvelope for sync dispatch
- ProjectionScheduler uses same events for batching

---

## 0.2 EventBus - Sync Pub/Sub (1h)

**Status**: pending
**Scope**: `src/lib/events`

### Entry Criteria

- [ ] Work unit 0.1 complete
- [ ] Event types defined and exported

### Exit Criteria

- [ ] `eventBus.ts` created with:
  - `subscribe(event, handler)` - returns unsubscribe
  - `emit(event)` - sync dispatch to all handlers
  - Type-safe event matching
- [ ] Logging subscriber receives events (visible in console)
- [ ] `npm run test` passes

### Rollback

```bash
git checkout HEAD -- src/lib/events/eventBus.ts
```

### Implementation Notes

Use `Set<Handler>` for subscribers. Consider WeakSet but explicit unsubscribe is clearer.

---

## 0.3 ProjectionScheduler - Batched Async (1h)

**Status**: pending
**Scope**: `src/lib/events`

### Entry Criteria

- [ ] Work units 0.1 and 0.2 complete
- [ ] EventBus working

### Exit Criteria

- [ ] `projectionScheduler.ts` created with:
  - `enqueue(event)` - add to pending batch
  - `flush()` - process batch immediately
  - Auto-flush on 100ms idle OR 50 items
  - Coalesce by blockId (last write wins)
- [ ] Batching visible in console (log flush sizes)
- [ ] `npm run test` passes

### Rollback

```bash
git checkout HEAD -- src/lib/events/projectionScheduler.ts
```

### Implementation Notes

Use `spawn()` wrapper pattern for fire-and-forget with error logging.

---

## 0.4 Wire to Y.Doc Observer (1h)

**Status**: pending
**Scope**: `src/lib/events, src/hooks/useBlockStore.ts`

### Entry Criteria

- [ ] Work units 0.1-0.3 complete
- [ ] EventBus and ProjectionScheduler working

### Exit Criteria

- [ ] Y.Doc observer emits to EventBus (sync)
- [ ] Y.Doc observer enqueues to ProjectionScheduler (async)
- [ ] Origin filtering: skip `'projection'`, `'hook'` origins
- [ ] Existing functionality unchanged
- [ ] `npm run test` passes (268 tests)

### Rollback

```bash
git checkout HEAD -- src/hooks/useBlockStore.ts
```

### Implementation Notes

**CRITICAL**: Must filter by `transaction.origin` to avoid sync loops.

```typescript
yDoc.on('update', (update, origin) => {
  if (origin === 'projection' || origin === 'hook') return;
  eventBus.emit(createBlockEvent(update));
  projectionScheduler.enqueue(createBlockEvent(update));
});
```

---

## 0.5 Tests + Phase Gate (1h)

**Status**: pending
**Scope**: `src/lib/events, tests/`

### Entry Criteria

- [ ] Work units 0.1-0.4 complete
- [ ] All existing tests passing

### Exit Criteria

- [ ] New tests for EventBus subscribe/emit
- [ ] New tests for ProjectionScheduler batching
- [ ] `npm run test` all pass
- [ ] `npm run lint` clean
- [ ] PHASE-0/COMPLETE.md written with decisions and learnings

### Rollback

```bash
git checkout HEAD -- src/lib/events/ tests/
```

### Implementation Notes

Test batching behavior with fake timers. Verify coalescing works correctly.

---

## Phase Gate Checklist

After 0.5 complete:

- [ ] `npm run test` passes
- [ ] `npm run lint` clean
- [ ] STATE.md learnings captured
- [ ] PHASE-0/COMPLETE.md written
- [ ] User approval for Phase 1
