---
description: Pre-flight check before creating a PR
argument-hint: [branch name or "current"]
---

# Floatty PR Pre-Flight Check

Run this before pushing to catch common issues.

## Step 0: Basics

Run these first:
```bash
npm run test          # All tests pass?
npm run lint          # No lint errors?
cd src-tauri && cargo check  # Rust types clean?
```

Report results:
- [ ] Tests: __ passing, __ failing
- [ ] Lint: clean / issues found
- [ ] Cargo: clean / issues found

## Step 1: Diff Analysis

Examine the diff for this branch ($ARGUMENTS). For each changed file, check:

### Pattern 1: Unguarded State Transitions
Look for: `flag = true; await/operation; flag = false;`
- Any flags set without try/finally? List them.

### Pattern 2: TypedArray/Buffer
Look for: `.buffer` on Uint8Array passed to crypto/WS/IPC
- Any risky .buffer usage? List them.

### Pattern 3: Unbounded Collections
Look for: Arrays/Sets/Maps that grow from events
- Any new collections without size limits? List them.
- What happens at limit?

### Pattern 4: Fire-and-Forget Async
Look for: `async` functions called without `await` or `.catch()`
- Any unhandled async calls? List them.

### Pattern 5: Silent Degradation
Look for: `catch` blocks that only log, `if (error) return`
- Any silent failures that should be visible? List them.

### Pattern 6: HMR Singletons
Look for: Module-level `let`/`const` with mutable state
- Any new module state without HMR cleanup? List them.

### Pattern 7: Symmetry / Hotfix Drift (FLO-317)
For each changed file, ask: "Did I change a pattern that exists elsewhere?"

**Check**: For any function you modified, grep for sibling implementations using the patterns in @.claude/commands/floatty/references/symmetry-check-patterns.md

Red flags from the reference's checklist apply here — especially:
- [ ] Modified function has siblings doing the same thing a different way
- [ ] Added `#[cfg]` gate but similar code nearby is unguarded
- [ ] Fixed a path/URL in one place but it's hardcoded elsewhere
- [ ] Changed a serialization format but readers still expect the old one

## Step 2: Specific Floatty Checks

### Y.Doc Changes
- [ ] All `transact()` calls have origin parameter?
- [ ] New observers have cleanup tracked?
- [ ] Schema changes documented?

### Handler Changes
- [ ] Handler registered in index.ts?
- [ ] Handler has error handling in execute()?
- [ ] Output properly reflects success/error state?

### WebSocket/Sync Changes
- [ ] Reconnection logic tested?
- [ ] Message ordering considered?
- [ ] Overflow behavior defined?

### Terminal Changes
- [ ] Dispose cleans up all resources?
- [ ] Re-parenting tested?
- [ ] PTY process tracked for kill?

## Step 3: Manual Test Script

Based on the changes, what should be manually tested?

```bash
# Generate a test script:
1. Start app: npm run tauri dev
2. [specific steps for this PR]
3. Verify: [expected outcome]
4. Edge case: [what could go wrong]
```

## Step 4: PR Description Draft

Generate a PR description:

```markdown
## Summary
[What does this PR do?]

## Changes
- [File 1]: [What changed]
- [File 2]: [What changed]

## Testing
- [ ] Automated: [which tests cover this]
- [ ] Manual: [steps to verify]

## Risks
- [Any risks or things to watch]
```

## Step 5: Final Checklist

- [ ] No console.log left in (except intentional logging)
- [ ] No TODO/FIXME without ticket reference
- [ ] No commented-out code blocks
- [ ] No hardcoded secrets/keys
- [ ] CHANGELOG updated (if user-facing)
- [ ] Types exported if needed by other modules

---

## Output

Provide:
1. **Issues found** (blocking vs. non-blocking)
2. **Suggested fixes** for any blocking issues
3. **PR description** draft
4. **Confidence level** (Ready / Needs work / Needs discussion)
