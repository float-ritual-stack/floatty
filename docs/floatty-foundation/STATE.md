# Floatty Foundation - State

> Living document. Hooks read this. Update as you work.

## Current Phase

Phase 0: Event Infrastructure
**Linear**: [FLO-139](https://linear.app/float-hub/issue/FLO-139/phase-0-event-infrastructure)

## Current Work Unit

**ID**: 0.1
**Name**: Event Types
**Status**: pending
**Scope**: `src/lib/events`

### Entry Criteria

- [ ] Located useBlockStore.ts
- [ ] Understand current Y.Doc observer pattern
- [ ] Read FLOATTY_HOOK_SYSTEM.md for context

### Exit Criteria

- [ ] `src/lib/events/types.ts` created with EventEnvelope, BlockEvent, Origin
- [ ] `src/lib/events/index.ts` exports all types
- [ ] `npm run type-check` passes

### Rollback

```bash
git checkout HEAD -- src/lib/events/
```

### Modifications

(Auto-updated by state-tracker.py)

### Learnings

(Fill as you discover things)

---

## Work Units Queue

| ID | Name | Status | Est |
|----|------|--------|-----|
| 0.1 | Event Types | pending | 30m |
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
