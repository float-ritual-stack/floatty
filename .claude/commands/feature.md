---
description: Start a new feature with architectural alignment
---

# Feature: $ARGUMENTS

## Pre-Implementation Checklist

Before writing code, answer:

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
