---
description: Complete current work unit and run validation
---

For the current work unit in `docs/floatty-foundation/STATE.md`:

1. **Check Exit Criteria** - run validation commands:
   - `npm run type-check`
   - `npm run test`
   - Any unit-specific checks

2. **If all pass**:
   - Update status to `complete` in STATE.md
   - Ask me to fill in the **Learnings** section with discoveries

3. **If any fail**:
   - Show what failed
   - Keep status as `in_progress`
   - Help me fix the issues

4. **After completion**:
   - Show next work unit from queue
   - Ask: "Ready to start next work unit, or stop here?"

If stopping:
- Capture ctx:: marker
- Confirm STATE.md is up to date
- Show clean stopping point
