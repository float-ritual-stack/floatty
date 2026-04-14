---
name: pattern-fit-check
description: Apply the four-question invariant-match checklist to a reference implementation and a target problem. Use before copying any code pattern from one use case to another — the missing step between "find the reference" and "use the reference". Runs in an Explore subagent with extended thinking so invariant analysis does not pollute the parent conversation. Complements the passive .claude/rules/pattern-fit-check.md rule file.
context: fork
agent: Explore
allowed-tools: Read Grep Glob Bash(ls *) Bash(cat *) Bash(grep *)
---

# Pattern Fit Check (Active)

You have been forked into an isolated Explore subagent to run the four-question pattern-fit checklist from `.claude/rules/pattern-fit-check.md`.

## Inputs

- Reference pattern: $0
- Target problem: $1
- Optional context: $2

If any of these are missing or ambiguous, ask for clarification via a single short report — do not guess.

## Your task

### Step 1: Locate the reference implementation

Find and read the reference pattern (`$0`). This might be a file, a function, or a named pattern in docs. Use Glob/Grep to locate it if the name is not a direct file path. If multiple candidates match, report them and ask which one is meant.

### Step 2: State the reference's invariants

Write down what the reference pattern *guarantees to protect*, as declarative statements. Not "it is a good pattern for X" — actual invariants. Example shape:

- "Rows have no stable identity; position is identity."
- "Children have stable block UUIDs; content edits do not change which child is which."
- "The parent contentEditable is never remounted during the view's lifetime."
- "No external code holds a reference to internal items across edits."

One sentence per invariant. Aim for 3-6 invariants per reference. State them plainly — if you cannot articulate an invariant in one sentence, you do not yet understand the pattern well enough to compare it.

### Step 3: State the target problem's requirements as invariants

Same shape, for the target problem (`$1`). What must remain true regardless of implementation detail?

- "Votes must survive option renames."
- "Concurrent writes from two clients must not lose data."
- "The parent block must remain editable by the user."
- "Derived counts must recompute from stored data, never be persisted."

### Step 4: Compare

For each requirement, identify which reference invariant protects it (if any). Build a table:

| Requirement | Protected by reference? | Notes |
|---|---|---|
| Option identity across renames | ❌ Reference uses positional identity | Mismatch — compensate or pick different reference |
| Concurrent writes | ✅ CRDT field-level resolution | Match |
| Parent editability | ✅ Reference keeps parent unchanged | Match |
| ... | ... | ... |

### Step 5: Verdict

Emit exactly one:

- **Full match**: reference fits, copy it with confidence. All requirements are protected by reference invariants.
- **Partial fit, N compensations named**: reference fits with N explicit compensations. List each compensation and what it protects against.
- **Mismatch, pick different reference**: reference does not fit. Name what a better reference would need to protect, and (if possible) suggest where to look in the codebase for a better fit.

## Output format

```
## Pattern Fit Report

**Reference**: $0 (at <actual file path>)
**Target**: $1

### Reference invariants
1. ...
2. ...
3. ...

### Target requirements
1. ...
2. ...
3. ...

### Comparison
| Requirement | Protected? | By which invariant / what is missing |
|---|---|---|
| ... | ... | ... |

### Verdict
<Full match | Partial fit with N compensations | Mismatch — pick different reference>

### Compensations (if partial fit)
1. <compensation>: protects against <what>, implemented by <how>
2. ...

### If mismatch: what a better reference would need
- Invariant 1: ...
- Invariant 2: ...
- Suggested search: `grep -r "<likely-pattern>" apps/floatty/src/components/`
```

## Why extended thinking and fork context

Invariant analysis benefits from extended thinking — the 2026-04-13 evaluation showed a 6-minute deeply-investigated Claude Code session produced substantially better invariant analysis than faster runs. The fork into Explore ensures the reference-file reads happen in isolated context so the parent conversation is not polluted with the investigation tool calls.

## Relationship to the passive rule file

The pattern-fit check itself is encoded in `.claude/rules/pattern-fit-check.md`. That rule file is *passive* — auto-attached via `paths:` frontmatter when editing matching files. This skill is the *active* version — invoke it when you need to run the checklist explicitly on a specific reference/target pair.

Use the rule file as a reminder that pattern-fit matters. Use this skill when the decision is load-bearing and needs structured analysis.

ultrathink
