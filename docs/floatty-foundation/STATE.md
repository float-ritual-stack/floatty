# Floatty Foundation - State

> Living document. Hooks read this. Update as you work.

## Current Phase

Phase 0: Event Infrastructure
**Linear**: [FLO-139](https://linear.app/float-hub/issue/FLO-139/phase-0-event-infrastructure)

## Current Work Unit

**ID**: 0.5
**Name**: Tests + Phase Gate
**Status**: pending
**Scope**: `src/lib/events`, `src/lib/hooks`

### Entry Criteria

- [ ] Review test patterns in src/hooks/*.test.ts
- [ ] Understand vitest setup

### Exit Criteria

- [ ] Unit tests for EventBus
- [ ] Unit tests for ProjectionScheduler
- [ ] Unit tests for HookRegistry
- [ ] All tests pass (`npm run test`)
- [ ] Phase 0 gate checklist complete

### Rollback

```bash
git checkout HEAD -- src/lib/events/*.test.ts src/lib/hooks/*.test.ts
```

### Modifications

(Auto-updated by state-tracker.py)

### Learnings

(Fill as you discover things)

---

## Completed Work Units

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
| 0.5 | Tests + Phase Gate | pending | 1h |

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
