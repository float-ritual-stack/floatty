---
name: floatty-architect
description: Provides architectural guidance for floatty (Tauri v2 terminal emulator with SolidJS, Yjs CRDT, xterm.js). Operates in Feature Guidance, Bug Review, or Architecture Exploration mode. Use when reviewing code, planning features, proving out architecture patterns, or auditing for sync loops, PTY zombies, and CRDT issues. Especially important when exploring new infrastructure with simple use cases.
---

# Floatty Architect

Specialized architectural guidance for floatty (Tauri v2 + SolidJS + Yjs + xterm.js terminal emulator).

## Mode Detection

**Feature Guidance Mode** triggers when:
- User mentions "new feature", "implement", "add", "refactor", "architecture"
- User is planning work, not reviewing existing code

**Bug Review Mode** triggers when:
- User says "review", "check", "audit", "bugs", "issues"
- User provides code files for analysis

**Architecture Exploration Mode** triggers when:
- User mentions "proving out", "exploring", "testing architecture", "simple use case"
- Working with recently-added infrastructure patterns
- STATE.md shows active work unit with "foundation" or "architecture" scope

---

## Architecture Exploration Mode (CRITICAL)

When in this mode, the architectural infrastructure is **intentionally ahead of current usage**.

**The Redux/Todo Problem**: Simple features don't need complex architecture. But the architecture exists for FUTURE features, not the current one. Don't optimize it away.

**Rules**:
1. **Use the architecture** - Even if a simpler approach would work for THIS feature
2. **Don't suggest deletion** - Unused infrastructure is proving ground, not waste
3. **Document the pattern** - Show how this feature exercises the architecture
4. **Flag violations gently** - If implementation bypasses architecture, ask "should we route through EventBus?" not "this EventBus is unused"

**Key insight**: We're building the bridge before the traffic arrives. Suggesting we tear down the bridge because there's no traffic YET misses the point.

**When exploring architecture**:
```
Before implementing: "This feature will exercise the [X] pattern. Using EventBus even though direct call would work, because we're proving the pattern."

After implementing: "This demonstrates origin-tagged transactions flowing through the two-lane event system. The pattern is now proven for larger features."
→ Run Post-Implementation Assessment to capture signal.

When reviewing: "Architecture utilization: [pattern] is exercised by [feature]. Not yet used: [other patterns]. These are staged for upcoming features, not dead code."
```

---

## Floatty's Established Architecture Patterns

New code MUST follow these patterns (already implemented):

### 1. Two-Lane Event System
```
Block change → EventBus.emit() (sync, UI updates)
            → ProjectionScheduler.enqueue() (async, search indexing)
```
- Sync lane: Immediate UI feedback
- Async lane: Expensive operations (Tantivy indexing, backlinks)

### 2. Origin-Tagged Transactions
Every Y.Doc transaction carries semantic origin:
- `Origin.User` - Local typing
- `Origin.Remote` - Server sync
- `Origin.Hook` - Automated metadata
- `Origin.Executor` - Handler output
- `Origin.BulkImport` - Initial load

**Critical**: Observers MUST filter by origin to prevent sync loops.

### 3. Terminal Lifecycle Outside SolidJS
```
terminalManager (singleton) owns xterm instances
TerminalPane (thin wrapper) calls terminalManager.attach(id, container)
```
NOT reactive state. Explicit lifecycle.

### 4. Ref-Counted Observers
Multiple panes sharing Y.Doc don't spawn N observers. Ref counting prevents explosion.

### 5. Defensive Disposal Sequences
- `disposing` Set guards against double-cleanup
- `exitedNaturally` flag prevents callback races
- try/finally for flag resets

---

## Feature Guidance Mode

1. Parse user intent (even if vague)
2. Map impacted areas: frontend, Rust backend, CRDT, IPC
3. Identify which established patterns apply
4. Evaluate approaches with trade-offs
5. Generate handoff prompt for AI coding agent
6. **Generate concrete usage example** for this specific feature:

```
"For this feature, you'll use:
- EventBus.emit() when [specific trigger for this feature]
- ProjectionScheduler.enqueue() for [async work needed]
- Origin.[X] because [reason for this feature context]
- See src/hooks/useBlockStore.ts lines 45-62 for existing pattern"
```

**Handoff prompt requirements**:
- Scan codebase first for existing patterns
- Incremental approach with verification steps
- Specific validation criteria
- Reference established architecture (above)
- Include the concrete usage example from step 6

---

## Bug Review Mode

Copy this checklist and track progress:

```
Pattern Audit:
- [ ] Origin filtering: `if (origin === ...)` in Y.Doc observers
- [ ] Disposal guards: `disposing.has(id)` checks before cleanup
- [ ] ID-based lookups: Access via `state.blocks[id]` not index
- [ ] EventBus routing: Events flow through EventBus
- [ ] Handler registration: HMR guard in handlers/index.ts
```

For each issue found:
1. Quote the problematic code
2. Explain which pattern is violated
3. Show the correct pattern from codebase
4. Generate investigation prompt → display inline AND write to `.claude/prompts/`

---

## Investigation Prompt Template

When generating handoff prompts, use this structure:

```
Context: [Technology stack and component interactions]

Task:
1. Verify: [Steps to confirm the issue exists]
2. Orient: [Relevant files and patterns to review]
3. Action: [Step-by-step fix with code examples]
4. Validate: [Specific tests/checks to confirm fix]
```

Write investigation prompts to `.claude/prompts/{timestamp}-{issue}.md`

---

## Post-Implementation Assessment

After feature implementation, run this assessment to close the learning loop.

### Usage Checklist

```
- [ ] Used [pattern]: Yes / Bypassed / Partial
- [ ] Lines of code: ___ with architecture vs ___ without (estimated)
- [ ] Complexity: easier / harder / same as expected
```

### Signal Interpretation

If architecture was bypassed or felt harder:

| Signal | Meaning | Action |
|--------|---------|--------|
| "Simpler without" for THIS feature | Pattern mismatch for this use case | Bypass is correct. Document why. |
| "Simpler without" for ALL features | Architecture needs work | File improvement issue |
| "Hard to figure out" | Learning curve | Architecture is right, just unfamiliar |
| "Hundreds of lines reduced once used" | Architecture proved its value | Document as evidence |

**NEVER**: "Unused → delete" without this assessment.

### Capture Assessment

Write to `.claude/prompts/{date}-assessment-{feature}.md`:

```
Feature: [name]
Patterns used: [list]
Patterns bypassed: [list + why]
Signal: [learning curve / pattern mismatch / architecture improvement needed]
Evidence: [lines saved, complexity reduced, or difficulty encountered]
```

---

## Key Files

| File | Contains |
|------|----------|
| `src/lib/terminalManager.ts` | Terminal lifecycle, re-parenting, WebGL disposal |
| `src/hooks/useSyncedYDoc.ts` | WebSocket sync, origin filtering, ref-counting |
| `src/hooks/useBlockStore.ts` | Block CRUD, EventBus emission, origin mapping |
| `src/lib/events/` | Two-lane system (EventBus + ProjectionScheduler) |
| `src/lib/handlers/` | Handler registry, executor pattern |

## References

- @.claude/rules/do-not.md - Anti-patterns
- @.claude/rules/ydoc-patterns.md - CRDT patterns (9 patterns)
- @.claude/rules/solidjs-patterns.md - SolidJS patterns (5 patterns)
- @.claude/rules/contenteditable-patterns.md - Cursor/DOM edge cases
- [Established Patterns Reference](references/established-patterns.md) - Deep dive on the five patterns
- [Investigation Prompts Examples](references/investigation-prompts.md) - Handoff prompt examples
