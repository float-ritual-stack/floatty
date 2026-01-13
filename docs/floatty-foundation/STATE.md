# Floatty Foundation - State

> Living document. Hooks read this. Update as you work.

## Current Phase

Phase 0: Event Infrastructure
**Linear**: [FLO-139](https://linear.app/float-hub/issue/FLO-139/phase-0-event-infrastructure)

## Current Work Unit

**ID**: Phase 0 Complete
**Name**: Phase Gate
**Status**: complete
**Scope**: N/A

Phase 0 Event Infrastructure is complete. See Completed Work Units below.

---

## Phase 0 Gate Checklist

- [x] All work units complete (0.1-0.5)
- [x] All tests pass (379 tests)
- [x] Type check passes (`npm run type-check`)
- [x] No regressions in existing functionality
- [x] Architecture aligned with FLOATTY_HOOK_SYSTEM.md

**Phase 0 Deliverables**:
- `src/lib/events/` - Event types, EventBus (sync), ProjectionScheduler (async batched)
- `src/lib/hooks/` - Hook types, HookRegistry aligned with architecture doc
- Full test coverage for all new modules

---

## Completed Work Units

### 0.5 Tests + Phase Gate ✓

**Scope**: `src/lib/events`, `src/lib/hooks`

**Modifications**:
- Created `src/lib/events/eventBus.test.ts` - 16 tests for EventBus
- Created `src/lib/events/projectionScheduler.test.ts` - 19 tests for ProjectionScheduler
- Created `src/lib/hooks/hookRegistry.test.ts` - 26 tests for HookRegistry

**Test coverage**:
- EventBus: subscribe/unsubscribe, emit, priority ordering, filtering, error isolation
- ProjectionScheduler: register/unregister, enqueue, batching, auto-flush, error isolation
- HookRegistry: register/unregister, run (async), runSync, filtering, priority, abort, result accumulation

**Learnings**:
- Test helper `createTestEnvelope` needs at least one event (empty array skips handlers)
- Fake timers need `advanceTimersByTimeAsync` for promises with setTimeout
- `console.warn` calls need exact argument matching

---

### 0.4 Hook Registry ✓

**Scope**: `src/lib/hooks`

**Modifications**:
- Created `src/lib/hooks/types.ts` - Hook, HookEvent, HookContext, HookResult, HookFilters
- Created `src/lib/hooks/hookRegistry.ts` - HookRegistry class with register/unregister/run
- Created `src/lib/hooks/index.ts` - re-exports

**Features**:
- Aligned with FLOATTY_HOOK_SYSTEM.md design
- Priority-ordered hook execution
- Async hook support with run() + sync-only runSync()
- HookResult with abort/content modification for execute:before
- Block-level filtering via HookFilter
- Global `hookRegistry` singleton

**Note**: Pivoted from "Wire to Y.Doc observer" to building proper Hook Registry
per architecture doc alignment discussion.

---

### 0.3 ProjectionScheduler (batched async) ✓

**Scope**: `src/lib/events`

**Modifications**:
- Created `src/lib/events/projectionScheduler.ts` - async batched event processing
- Updated `src/lib/events/index.ts` - exports ProjectionScheduler, blockProjectionScheduler

**Features**:
- Queue-based batching with configurable flush interval (default 2s)
- Max queue size protection (default 1000 events)
- Parallel async projection execution
- Error isolation per projection
- Global `blockProjectionScheduler` singleton instance

---

### 0.2 EventBus (sync pub/sub) ✓

**Scope**: `src/lib/events`

**Modifications**:
- Created `src/lib/events/eventBus.ts` - EventBus class with subscribe/unsubscribe/emit
- Updated `src/lib/events/index.ts` - exports EventBus, blockEventBus, SubscriptionOptions

**Features**:
- Priority-ordered handler execution (lower = earlier)
- Per-subscription filter support
- Error isolation (one handler failing doesn't break others)
- Global `blockEventBus` singleton instance

---

### 0.1 Event Types ✓

**Scope**: `src/lib/events`

**Modifications**:
- Created `src/lib/events/types.ts` - Origin, BlockEvent, EventEnvelope, filters
- Created `src/lib/events/index.ts` - re-exports

**Learnings**:
- No `type-check` script exists; use `npx tsc --noEmit` directly
- Y.Doc observer captures txOrigin from `events[0]?.transaction.origin`
- Block event types match Y.Map actions: add→create, update→update, delete→delete

---

## Work Units Queue

| ID | Name | Status | Est |
|----|------|--------|-----|
| 0.1 | Event Types | complete | 30m |
| 0.2 | EventBus (sync pub/sub) | complete | 1h |
| 0.3 | ProjectionScheduler (batched async) | complete | 1h |
| 0.4 | Hook Registry | complete | 1h |
| 0.5 | Tests + Phase Gate | complete | 1h |

---

## Phase 0 Goal

Decouple Y.Doc observer from consumers via two-lane event system:

```
Y.Doc Update
     │
     ├──► EventBus (sync) ──► immediate reactions
     │
     └──► ProjectionScheduler (async) ──► batched index writes
```

See `docs/architecture/FLOATTY_HOOK_SYSTEM.md` for full context.

---

## Quick Reference

**Run tests**: `npm run test`
**Type check**: `npm run type-check`
**Lint**: `npm run lint`
**Dev mode**: `npm run tauri dev`

**Trial knowledge**: `~/.claude/skills/floatty-foundation/references/trial-knowledge.md`
**Plan file**: `~/.claude/plans/tingly-growing-hellman.md`
