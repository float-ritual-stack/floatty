---
description: Run phase gate checklist before proceeding to next phase
argument-hint: [track-name]
---

# Phase Gate Check

## Phase 0: Identify Active Track

```bash
# If track specified, use it; otherwise find most recent
ls -lt .float/work/$ARGUMENTS/STATE.md 2>/dev/null || ls -lt .float/work/*/STATE.md 2>/dev/null | head -1
```

---

## Gate Checklist

1. **Test Suite**: Run `npm run test` - all tests must pass
2. **Lint**: Run `npm run lint` - must be clean
3. **Rust Check**: Run `cargo check --manifest-path src-tauri/Cargo.toml`
4. **STATE.md Review**:
   - All work units in current phase marked `complete`?
   - Session log updated?
5. **WORK_UNITS.md Review**:
   - Discovered gaps documented?
   - Dependencies accurate?
6. **Handoffs Written**: Each completed unit has a handoff in `handoffs/`

---

## Report Format

Report status as:

```
Phase Gate Check for {track}:
✅/❌ npm run test ({X} tests)
✅/❌ npm run lint
✅/❌ cargo check
✅/❌ All work units in phase complete
✅/❌ Session log updated
✅/❌ Handoffs written

[Action required if any ❌]
```

---

## If All Pass

Update STATE.md:
- Increment current phase
- Log gate passage in session log
- Update "Next Actions" for new phase

---

## If Any Fail

List blockers and suggest fixes before re-running gate.
