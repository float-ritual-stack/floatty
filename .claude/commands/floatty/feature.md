---
description: Start a new feature with architectural alignment
---

# Feature: $ARGUMENTS

## Step 1: Classify the Primitive

Before writing code, determine what KIND of thing this is. Use the Five Questions:

```
Q1: Who initiates?
    User types prefix → HANDLER
    System detects change → HOOK or PROJECTION

Q2: Does it own the block?
    Yes, transforms/creates → HANDLER
    No, enriches context → HOOK
    No, builds derived state → PROJECTION

Q3: When does it run?
    Once, on Enter → HANDLER
    On every execution → HOOK (execute:before/after)
    On block changes → HOOK (block:*) or PROJECTION

Q4: Critical path?
    User waiting → HANDLER or sync HOOK
    Background OK → PROJECTION

Q5: Needs other hooks' output?
    Yes → HOOK (with priority)
    No → HANDLER
```

**Classification**: [ ] Handler  [ ] Hook  [ ] Projection  [ ] Renderer

Reference `docs/architecture/PHILOSOPHY.md` § "Applied Examples" for worked decisions.

## Step 2: Event → Handler → Transform → Project

Now trace the data flow:

1. **Event**: What triggers this feature?
   - Block created? User input? Timer? External API?

2. **Handler**: Where does the logic live?
   - New handler in executor.ts?
   - New hook registration?
   - Existing component extension?

3. **Transform**: What changes?
   - Block content? New blocks created? State updated?

4. **Project**: What updates in the UI?
   - Reactive signal? Sidebar? New component?

## Pattern Alignment

Reference `docs/PATTERNS.md` for:
- [ ] Child-output pattern (if executable)
- [ ] Y.Doc transaction wrapping
- [ ] Origin filtering (if observing Y.Doc)
- [ ] Double-rAF for focus (if DOM manipulation after mutation)

## Bug Category Check

Will this touch any of the four danger zones?
- [ ] Terminal DOM (Re-Parenting Trap)
- [ ] Y.Doc observers (Sync Loop)
- [ ] PTY lifecycle (Zombies)
- [ ] Block lookups after sync (Split Brain)

## Implementation Plan

1. Scan relevant files first (see CLAUDE.md key files table)
2. Identify integration points
3. Implement incrementally with verification after each step
4. Add to `docs/PATTERNS.md` if this creates a new reusable pattern

## Files to Review

Based on the feature description, likely relevant:
- [ ] `executor.ts` if adding new prefix
- [ ] `useBlockStore.ts` if changing block behavior
- [ ] `usePaneStore.ts` if affecting view state
- [ ] `useLayoutStore.ts` if affecting pane structure
- [ ] `terminalManager.ts` if touching terminal lifecycle
