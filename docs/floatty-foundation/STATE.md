# Floatty Foundation - State

> Living document. Hooks read this. Update as you work.

## Current Phase

Phase 0: Event Infrastructure
**Linear**: [FLO-139](https://linear.app/float-hub/issue/FLO-139/phase-0-event-infrastructure)

## Current Work Unit

**ID**: 0.2
**Name**: EventBus (sync pub/sub)
**Status**: pending
**Scope**: `src/lib/events`

### Entry Criteria

- [ ] Understand types from 0.1 (EventEnvelope, BlockEvent, Origin)
- [ ] Review current Y.Doc observer in useBlockStore.ts
- [ ] Understand priority conventions from FLOATTY_HOOK_SYSTEM.md

### Exit Criteria

- [ ] `src/lib/events/eventBus.ts` created with EventBus class
- [ ] subscribe/unsubscribe/emit API
- [ ] Priority-ordered handler execution
- [ ] `npx tsc --noEmit` passes

### Rollback

```bash
git checkout HEAD -- src/lib/events/eventBus.ts
```

### Modifications

(Auto-updated by state-tracker.py)

### Learnings

(Fill as you discover things)

---

## Completed Work Units

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
| 0.2 | EventBus (sync pub/sub) | pending | 1h |
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
