---
description: Begin or resume a floatty foundation work session
---

Read `docs/floatty-foundation/STATE.md` and show me:

1. **Current Phase** and Linear issue link
2. **Current Work Unit** - ID, name, status, scope
3. **Entry Criteria** checklist - what must be true to start
4. **Modifications** so far (if resuming)

Then:
- If status is `in_progress`: We're resuming. Show what was modified, ready to continue.
- If status is `pending`: Check entry criteria. If all met, set status to `in_progress`.
- If status is `complete`: Show next work unit from queue.

Also surface relevant **trial knowledge** from `~/.claude/skills/floatty-foundation/references/trial-knowledge.md` based on the work unit scope.

Remember: Stay focused on ONE work unit at a time. The scope-guard hook will block edits outside the defined scope.
