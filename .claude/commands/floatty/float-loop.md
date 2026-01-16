---
description: Continue a work track (e.g., search-work, testing-infra)
argument-hint: <track-name>
hooks:
  PostToolUse:
    - matcher: "Edit|Write"
      hooks:
        - type: command
          command: "npm run lint --silent 2>&1 | head -20 || true"
  Stop:
    - hooks:
        - type: prompt
          prompt: |
            You are validating whether a floatty work unit session should end.

            Context: $ARGUMENTS

            Analyze the conversation and check if the Exit Protocol was followed:

            1. **Handoff Written?** - Was a handoff created/updated in .float/work/{track}/handoffs/?
            2. **Code Committed?** - Were changes committed (look for git commit in transcript)?
            3. **Sweep Run?** - Was /floatty:sweep run before claiming unit complete?
            4. **Gaps Logged?** - If gaps discovered, was /floatty:gap used?
            5. **STATE.md Updated?** - Was session outcome logged?
            6. **Architecture Used?** - Did implementation follow existing patterns or create one-offs?

            IMPORTANT distinctions:
            - If session is clearly mid-work (not claiming completion), allow stop: {"ok": true}
            - If user explicitly said "stopping for now" or "picking up later", allow stop
            - Only block if Claude is claiming "done" without completing exit protocol

            If critical items missing when claiming done:
            {"ok": false, "reason": "Before marking complete: [missing items]"}

            Otherwise:
            {"ok": true}
          timeout: 45
---

# Float Loop: $ARGUMENTS

Work track session for **$ARGUMENTS**.

Track directory: `.float/work/$ARGUMENTS/`

---

## Integrated Commands

Float-loop orchestrates these specialized commands at the right moments:

| Phase | Command | When to Use |
|-------|---------|-------------|
| Entry | `/floatty:classify` | Unit involves a new feature → classify as Handler/Hook/Projection/Renderer |
| Entry | `/floatty:arch-review` | Validate approach against architecture before implementing |
| Impl | `/floatty:gap` | Discovered something missing → document and assess impact |
| Exit | `/floatty:sweep` | Before marking unit complete → check for bug patterns |
| Exit | `/floatty:gate` | Phase boundary → run full gate checklist |
| PR | `/floatty:pr-check` | Before creating PR → pre-flight validation |

---

## Phase 0: Track Bootstrap

Check if track exists, bootstrap if not:

```bash
# Check for track directory
ls -la .float/work/$ARGUMENTS/ 2>/dev/null || echo "NEW_TRACK"
```

### If NEW_TRACK:

Create the track structure:

```bash
mkdir -p .float/work/$ARGUMENTS/handoffs
```

Then create initial files:

1. **STATE.md** - Current position tracker
2. **WORK_UNITS.md** - Unit definitions (empty template)
3. **ARCHITECTURE.md** - Context and target state

Use these templates:

#### STATE.md Template
```markdown
# $ARGUMENTS Track State

**Created**: {date}
**Last Session**: {date}
**Current Unit**: None (planning phase)

## Session Log

| Date | Unit | Outcome | Notes |
|------|------|---------|-------|
| {date} | - | Track created | Initial planning |

## Active Context

- What we're trying to accomplish
- Key constraints
- Open questions

## Next Actions

1. Define work units in WORK_UNITS.md
2. Begin first unit
```

#### WORK_UNITS.md Template
```markdown
# $ARGUMENTS: Work Units

**Generated**: {date}
**Methodology**: Isolated work units with handoff documents

---

## Work Unit Structure

Every work unit follows this lifecycle:

```text
ENTRY → IMPLEMENTATION → EXIT
```

- **Entry**: Read handoff, verify preconditions, create todos
- **Implementation**: Smallest working increment, tests as you go
- **Exit**: Validate, document decisions, write handoff, commit

---

## Work Unit Index

| Unit | Name | Depends On | Delivers | Status |
|------|------|------------|----------|--------|
| 0.1 | {first unit} | None | {deliverable} | ⏳ Pending |

---

## Unit 0.1: {First Unit}

### Entry Prompt

```markdown
# Work Unit 0.1: {Name}

## Context
{What this unit accomplishes}

## Preconditions
- {List prerequisites}

## Deliverable
{Concrete outcome}

## Entry Checklist
- [ ] Read previous handoff (if any)
- [ ] Code review relevant files
- [ ] Verify preconditions
- [ ] Run /floatty:classify if this is a new feature
- [ ] Run /floatty:arch-review if architecture decision needed

## Implementation
1. {Step 1}
2. {Step 2}

## Exit Checklist
- [ ] Tests pass
- [ ] No warnings
- [ ] Code reviewed for simplification
- [ ] Run /floatty:sweep for bug patterns
- [ ] Decisions documented
- [ ] Handoff written
```

---

## Discovered Gaps

{Add gaps discovered during implementation here}
```

#### ARCHITECTURE.md Template
```markdown
# $ARGUMENTS: Architecture Context

**Created**: {date}

## Goal

{What this track delivers when complete}

## Current State

{Exploration findings about where we are now}

## Target State

{Where we want to be}

## Key Files

| File | Purpose |
|------|---------|
| {path} | {role} |

## Constraints

- {Architectural constraints}
- {Dependencies}
- {Anti-patterns to avoid}

## Open Questions

1. {Question needing resolution}
```

After creating files, ask the user what this track is for and help fill in the templates.

---

## Phase 1: Context Gathering

Launch explore agents to assess current state relevant to this track:

```
Use Task tool with subagent_type=Explore:
1. "What is the current state of {relevant area} in floatty?"
2. "What existing infrastructure relates to {track goal}?"
```

Check git for recent related work:
```bash
git log --oneline -20
git log --oneline --grep="{track keywords}" | head -10
```

---

## Phase 2: Read Track Docs

Read the track-specific documentation:

1. **`.float/work/$ARGUMENTS/STATE.md`** - Current position and session log
2. **`.float/work/$ARGUMENTS/WORK_UNITS.md`** - Unit definitions with Entry/Exit protocols
3. **`.float/work/$ARGUMENTS/ARCHITECTURE.md`** - Context and target state
4. **`.float/work/$ARGUMENTS/handoffs/`** - Any existing handoff documents

Check for discovered gaps at end of WORK_UNITS.md.

---

## Phase 3: Determine Current Position

Cross-reference exploration findings with work unit index:

1. Read STATE.md for last session's position
2. Check unit statuses in WORK_UNITS.md
3. Verify actual codebase state matches documented state
4. Identify next incomplete unit

---

## Phase 4: Execute Next Unit

For the identified next unit:

### 4.1 Entry Protocol

- Read handoff from previous unit (if any)
- Verify prerequisites are met
- Create todo list

**If unit involves a new feature:**
```
Run /floatty:classify {feature description}
→ Determines if this should be Handler, Hook, Projection, or Renderer
```

**If architecture decision needed:**
```
Run /floatty:arch-review {approach description}
→ Fresh-context agent validates against PHILOSOPHY.md patterns
```

### 4.2 Implementation

- Only modify files in scope
- Write tests as you go
- Keep changes minimal

**If you discover something missing:**
```
Run /floatty:gap {gap description}
→ Documents gap, assesses impact, updates WORK_UNITS.md
```

### 4.3 Exit Protocol

**Before marking unit complete:**
```
Run /floatty:sweep all
→ Checks for the 6 bug patterns in changed files
```

- Run validation checks (tests, lint, typecheck)
- Document decisions in handoff
- Update STATE.md with session outcome
- Commit: `feat($ARGUMENTS): Unit X.Y - {name}`

**If completing a phase (multiple units):**
```
Run /floatty:gate
→ Full phase gate checklist (tests, completeness, COMPLETE.md)
```

---

## Phase 5: Session Exit

Before ending:

1. Update STATE.md with:
   - Session date
   - Units completed
   - Current position
   - Next actions

2. Write handoff if mid-unit:
   ```bash
   # Create handoff for next session
   touch .float/work/$ARGUMENTS/handoffs/unit-{X.Y}-partial.md
   ```

3. Capture to evna:
```
mcp__evna-remote__active_context(
  capture="ctx::{date} @ {time} [project::floatty] [mode::float-loop] track::$ARGUMENTS - {summary}",
  project="floatty"
)
```

---

## Phase 6: PR Preparation (when ready)

When track is complete or at a shippable milestone:

```
Run /floatty:pr-check
→ Pre-flight validation before creating PR
```

Then create PR with summary of delivered units.

---

## Quick Reference: When to Use Each Command

```
┌─────────────────────────────────────────────────────────────────┐
│  ENTRY PHASE                                                    │
├─────────────────────────────────────────────────────────────────┤
│  "What kind of thing is this?"     →  /floatty:classify        │
│  "Is this approach aligned?"       →  /floatty:arch-review     │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  IMPLEMENTATION PHASE                                           │
├─────────────────────────────────────────────────────────────────┤
│  "Found something missing!"        →  /floatty:gap             │
│  "Need to fix a bug"               →  /floatty:bug             │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  EXIT PHASE                                                     │
├─────────────────────────────────────────────────────────────────┤
│  "Unit complete, check patterns"   →  /floatty:sweep           │
│  "Phase complete, gate check"      →  /floatty:gate            │
│  "Ready for PR"                    →  /floatty:pr-check        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Rules

- Reference `.claude/rules/ydoc-patterns.md` for Y.Doc patterns
- Reference `.claude/rules/do-not.md` for anti-patterns
- Each unit is self-contained (goldfish bowl pattern)
- Exploration first prevents stale assumptions
- Track artifacts survive branch changes (`.float/` is gitignored)
- Use integrated commands at the right moments (see table above)
