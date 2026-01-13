---
description: Systematic bug pattern sweep across codebase
argument-hint: [pattern number 1-6 or "all"]
---

# Floatty Bug Pattern Sweep: $ARGUMENTS

Systematic sweep for known bug patterns. Run periodically to catch issues before they bite.

## The Six Patterns

| # | Pattern | Symptom | Fix |
|---|---------|---------|-----|
| 1 | Unguarded State Transitions | Flag stays set after error | try/finally |
| 2 | TypedArray/Buffer Boundary | Wrong bytes hashed/sent | Pass array not .buffer |
| 3 | Unbounded Collections | Memory leak, eventual crash | Size limit + overflow behavior |
| 4 | Fire-and-Forget Async | Silent failures, zombie tasks | .catch() or await |
| 5 | Silent Degradation | Works until it doesn't | Visible failure + recovery |
| 6 | HMR Singletons | State accumulates on reload | dispose() cleanup |

## Sweep Instructions

For pattern $ARGUMENTS (or all), search the codebase and report findings.

### Pattern 1: Unguarded State Transitions

Search for boolean flags that guard async operations:
```
grep -rn "= true" src/ --include="*.ts" --include="*.tsx" | grep -E "(flushing|syncing|loading|disposing|applying)"
```

For each, verify:
- Is the flag reset in a finally block?
- What happens if the operation throws?

### Pattern 2: TypedArray/Buffer Boundary

Search for .buffer usage:
```
grep -rn "\.buffer" src/ --include="*.ts" --include="*.tsx"
```

For each, verify:
- Is this a Uint8Array view into a larger ArrayBuffer?
- Would passing the Uint8Array directly work?

### Pattern 3: Unbounded Collections

Search for growing collections:
```
grep -rn "\.push\|\.add\|\.set" src/ --include="*.ts" --include="*.tsx"
```

For each, verify:
- Is there a size limit?
- What happens when limit is reached?
- Is there cleanup/eviction logic?

### Pattern 4: Fire-and-Forget Async

Search for async calls without await:
```
grep -rn "async.*=>" src/ --include="*.ts" --include="*.tsx"
```

Also check:
- Promise-returning functions called without await
- setTimeout/setInterval with async callbacks
- Event handlers that are async

### Pattern 5: Silent Degradation

Search for catch blocks:
```
grep -rn "catch" src/ --include="*.ts" --include="*.tsx" -A 3
```

For each, verify:
- Does it just log and continue?
- Should it throw, retry, or trigger recovery?
- Is the failure visible to the user?

### Pattern 6: HMR Singletons

Search for module-level mutable state:
```
grep -rn "^let " src/ --include="*.ts" --include="*.tsx"
grep -rn "^const.*= new " src/ --include="*.ts" --include="*.tsx"
```

For each, verify:
- Is there `import.meta.hot.dispose()` cleanup?
- What state persists across HMR?

## Report Format

For each finding, report:

| Severity | File:Line | Pattern | Issue | Suggested Fix |
|----------|-----------|---------|-------|---------------|
| Critical/Warning/Note | path:123 | P1-P6 | Description | Fix |

## Severity Levels

- **Critical**: Will cause bug in normal usage
- **Warning**: Will cause bug in edge case
- **Note**: Code smell, not immediately dangerous

## Key Files to Always Check

- `src/hooks/useSyncedYDoc.ts` - CRDT sync, WebSocket, most complex
- `src/lib/terminalManager.ts` - PTY lifecycle, xterm instances
- `src/lib/handlers/*.ts` - Block execution, async operations
- `src/lib/httpClient.ts` - Server communication
- `src/hooks/useSyncHealth.ts` - Periodic health checks

## Output

Provide:
1. **Summary table** of all findings
2. **Critical issues** with specific fixes
3. **Warnings** grouped by pattern
4. **Notes** for future consideration
5. **Clean bill** if nothing found
