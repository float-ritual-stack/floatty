---
description: Run phase gate checklist before proceeding to next phase
---

Phase Gate Checklist for current phase in `docs/floatty-foundation/STATE.md`:

1. **Test Suite**: Run `npm run test` - all tests must pass
2. **Lint**: Run `npm run lint` - must be clean
3. **Type Check**: Run `npm run type-check` - must pass
4. **STATE.md Review**:
   - All work units in current phase marked `complete`?
   - Learnings sections populated?
5. **COMPLETE.md**: Does `docs/floatty-foundation/PHASE-N/COMPLETE.md` exist?
   - If not, create it with:
     - Key decisions made
     - Patterns established
     - Gotchas discovered
     - Links to relevant code
6. **User Approval**: Ask "Ready to proceed to Phase N+1?"

Report status as:
```
Phase N Gate Check:
✅/❌ npm run test (X tests)
✅/❌ npm run lint
✅/❌ npm run type-check
✅/❌ All work units complete
✅/❌ Learnings captured
✅/❌ COMPLETE.md exists

[Action required if any ❌]
```

Only proceed to next phase with explicit user approval.
