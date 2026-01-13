# Floatty Foundation - State

> Living document. Hooks read this. Update as you work.

## Current Phase

Phase 0: Event Infrastructure
**Linear**: [FLO-139](https://linear.app/float-hub/issue/FLO-139/phase-0-event-infrastructure)

## Current Work Unit

**ID**: 0.3
**Name**: ProjectionScheduler (batched async)
**Status**: pending
**Scope**: `src/lib/events`

### Entry Criteria

- [ ] Understand EventBus pattern from 0.2
- [ ] Review async batching requirements for search/index writes
- [ ] Understand debounce timing from ydoc-patterns.md

### Exit Criteria

- [ ] `src/lib/events/projectionScheduler.ts` created
- [ ] Queue-based batching with configurable flush interval
- [ ] Async handler support with error isolation
- [ ] `npx tsc --noEmit` passes

### Rollback

```bash
git checkout HEAD -- src/lib/events/projectionScheduler.ts
```

### Modifications

(Auto-updated by state-tracker.py)

### Learnings

(Fill as you discover things)

---

## Completed Work Units

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
| 0.3 | ProjectionScheduler (batched async) | pending | 1h |
| 0.4 | Wire to Y.Doc observer | pending | 1h |
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
