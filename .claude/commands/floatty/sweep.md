---
description: Systematic bug pattern sweep across codebase
argument-hint: [pattern number 1-8 or "all"]
---

# Floatty Bug Pattern Sweep: $ARGUMENTS

Systematic sweep for known bug patterns. Run periodically to catch issues before they bite.

## The Eight Patterns

| # | Pattern | Symptom | Fix |
|---|---------|---------|-----|
| 1 | Unguarded State Transitions | Flag stays set after error | try/finally |
| 2 | TypedArray/Buffer Boundary | Wrong bytes hashed/sent | Pass array not .buffer |
| 3 | Unbounded Collections | Memory leak, eventual crash | Size limit + overflow behavior |
| 4 | Fire-and-Forget Async | Silent failures, zombie tasks | .catch() or await |
| 5 | Silent Degradation | Works until it doesn't | Visible failure + recovery |
| 6 | HMR Singletons | State accumulates on reload | dispose() cleanup |
| 7 | Symmetry / Hotfix Drift | Fix in one place, siblings use old way | Grep siblings, fix all or document why safe |
| 8 | Logging Discipline Violations | Secrets in logs, drops pre-init, mode drift | Apply @.claude/rules/logging-discipline.md |

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

### Pattern 7: Symmetry / Hotfix Drift (FLO-317)

Search for patterns that may have drifted from their siblings.

Run all patterns from @.claude/commands/floatty/references/symmetry-check-patterns.md

For each finding, verify using the red flags checklist in the reference.
Report in the standard sweep findings table.

### Pattern 8: Logging Discipline Violations (PR #223)

Read @.claude/rules/logging-discipline.md first. Then apply these greps:

**8a — Secrets in tracing calls** (rule 1):
```bash
grep -rn 'tracing::\(info\|warn\|error\)!' src-tauri/floatty-server/src src-tauri/floatty-core/src src-tauri/src | grep -iE 'api_key|token|password|secret|bearer|authorization|endpoint'
```
For each hit, verify the field is NOT user-configurable (URLs from config/env, keys, tokens). `url = %url` where url is `http://127.0.0.1:N` is safe; where it's user-configured it's a leak.

**8b — Pre-init tracing calls** (rule 2):
```bash
# Find functions that run before setup_logging() and emit via tracing::
grep -n 'setup_logging\|ServerConfig::load\|BackupConfig::load' src-tauri/floatty-server/src/main.rs
grep -n 'tracing::\(warn\|error\|info\)!' src-tauri/floatty-server/src/config.rs
```
Any `tracing::*` call inside `ServerConfig::load()` (or functions it calls before `setup_logging()` runs in `main.rs`) is a silent drop. Must be `eprintln!`.

**8c — Mixed failure modes in one subsystem** (rule 3):
```bash
# Grep adjacent .expect("Failed to ...") and eprintln!("Failed to ...") in the same function
grep -rn '\.expect("Failed' src-tauri/floatty-server/src src-tauri/floatty-core/src
```
For each `.expect()`, check the surrounding function. If there's also an `eprintln! + continue` path for a similar failure in the same subsystem, one of them is wrong — align upward (panic) for source-of-truth failures, downward (eprintln) for optional features.

**8d — Comment/sink drift** (rule 4):
```bash
# Comments mentioning stdout/stderr near logging calls
grep -rn -B1 'eprintln\|println\|tracing::' src-tauri/floatty-server/src src-tauri/src | grep -iE 'stdout|stderr|subscriber|tracing::|eprintln|println'
```
If a comment says "stdout" above `eprintln!` (which is stderr), or says "via subscriber" above a raw `eprintln!`, fix the comment. Comments should name the exact mechanism.

**8e — `target:` overrides without filter entries** (rule 5):
```bash
# Find all target: overrides
grep -rn 'target: "' src-tauri/floatty-server/src src-tauri/floatty-core/src | grep 'tracing::'
# Find the filter defaults
grep -A2 'EnvFilter::try_new\|EnvFilter::new' src-tauri/floatty-server/src/main.rs src-tauri/src/lib.rs
```
Every target name in the grep-1 output must appear in the filter default in grep-2 output. Otherwise those lines are silently filtered to OFF.

**8f — Filter default parity across processes**:
Both `src-tauri/floatty-server/src/main.rs` `setup_logging()` and `src-tauri/src/lib.rs` `setup_logging()` must include the `hyper=warn,reqwest=warn,opentelemetry=off` silencers. Removing them causes telemetry-induced-telemetry loops when OTLP ships.

**Report format**: use the standard table, but cite the rule number from `logging-discipline.md`:

| Severity | File:Line | Rule | Issue | Fix |
|---|---|---|---|---|
| Critical | main.rs:182 | 1 | Endpoint URL logged raw | Mask to metadata-only |
| Warning | config.rs:208 | 2 | `tracing::warn!` in pre-init call graph | Switch to `eprintln!` |
| Note | main.rs:386 | 4 | Comment says stdout, code uses stderr | Fix comment |

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
