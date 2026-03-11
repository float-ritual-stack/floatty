---
description: Continue a work track (e.g., search-work, testing-infra)
argument-hint: <track-name>
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: |
            You are validating whether a floatty float-loop session should end.

            Context: $ARGUMENTS

            First, determine the SESSION TYPE by scanning the conversation:

            **PLANNING SESSION** (Phase 0/1 - no Edit/Write tools used):
            - Required: STATE.md updated with session notes
            - Optional: evna context capture

            **UNIT WORK SESSION** (Phase 4 - Edit/Write tools were used):
            - Required: Code committed (git commit in transcript)
            - Required: STATE.md updated with outcome
            - Required: /floatty:sweep was run before claiming complete
            - Required: Handoff written if stopping mid-unit
            - Check: If gaps discovered, was /floatty:gap used?
            - Check: Did implementation follow architecture or create one-offs?

            **EXPLORATION SESSION** (only Read/Grep/Glob tools):
            - Required: Findings captured (evna or STATE.md)

            **MID-WORK PAUSE** (user said "stopping for now", "picking up later"):
            - Always allow: {"ok": true}

            Decision logic:
            1. If user explicitly pausing → allow
            2. If PLANNING/EXPLORATION session → check minimal requirements
            3. If UNIT WORK session claiming "done"/"complete" → check full protocol

            If critical items missing:
            {"ok": false, "reason": "Session type: [type]. Missing: [items]"}

            Otherwise:
            {"ok": true}
          timeout: 30
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

#### Track Size Assessment

Before creating files, assess track size:

**Small** (1-3 units, single session likely):
- Create: STATE.md, WORK_UNITS.md, handoffs/
- Skip: ARCHITECTURE.md, AGENT_PROMPT.md, FAILURE_MODES.md, refs/

**Medium** (4-8 units, multi-session):
- Create: STATE.md, WORK_UNITS.md, ARCHITECTURE.md, handoffs/
- Generate: AGENT_PROMPT.md
- Prompt for: FAILURE_MODES.md

**Large** (9+ units, multi-week):
- Create: Everything — STATE.md, WORK_UNITS.md, ARCHITECTURE.md, AGENT_PROMPT.md, handoffs/, refs/
- Prompt for: FAILURE_MODES.md
- Suggest: Validation ladder in WORK_UNITS.md

Ask the user: "How many units do you expect? (rough guess — small/medium/large)"

#### Create Directory Structure

```bash
mkdir -p .float/work/$ARGUMENTS/handoffs
# For medium/large tracks:
mkdir -p .float/work/$ARGUMENTS/refs
```

#### Create Files

Create all files in a single pass — minimize bootstrap friction:

1. **STATE.md** - Current position tracker
2. **WORK_UNITS.md** - Unit definitions
3. **ARCHITECTURE.md** - Context and target state (medium/large)
4. **AGENT_PROMPT.md** - Cold-start session protocol (medium/large)

After skeleton, prompt:
> "Any known anti-patterns or failure modes for this track? Things that have gone wrong before, PR review patterns, recurring bugs? I'll create FAILURE_MODES.md if so."

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
| 0.1 | {first unit} | None | {deliverable} | Pending |

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
- [ ] Verify preconditions (grep before claiming — check existing code)
- [ ] Run /floatty:classify if this is a new feature
- [ ] Run /floatty:arch-review if architecture decision needed

## Implementation
1. {Step 1}
2. {Step 2}

## Exit Checklist
- [ ] Tests pass
- [ ] If runtime behavior: verified in running app (not just unit tests)
- [ ] No warnings
- [ ] Code reviewed for simplification
- [ ] Run /floatty:sweep for bug patterns
- [ ] Decisions documented
- [ ] Handoff written (use handoff template)
```

---

## Reference Material

Track-specific reference docs live in `refs/`. These are living drafts —
they evolve during implementation. Final docs go to `docs/` AFTER code ships.

| Doc | Purpose |
|-----|---------|
| (add as needed during implementation) | |

---

## Discovered Gaps

{Add gaps discovered during implementation here}
```

#### ARCHITECTURE.md Template (medium/large)
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

#### AGENT_PROMPT.md Template (medium/large)

Generate this with track-specific content — fill placeholders from what the user provides:

```markdown
# $ARGUMENTS — Agent Prompt

You are working on {goal summary from ARCHITECTURE.md}.

## First Session? Start Here

1. Read `.float/work/$ARGUMENTS/ARCHITECTURE.md` — what we're building, constraints, key files
2. Read `.float/work/$ARGUMENTS/STATE.md` — where are we?
3. Read `.float/work/$ARGUMENTS/WORK_UNITS.md` — find current unit
4. Check `.float/work/$ARGUMENTS/handoffs/` for anything dated after STATE.md's last session
5. If FAILURE_MODES.md exists, scan for risks relevant to current unit

## Session Protocol

### On Entry
1. Read STATE.md → current position
2. Read WORK_UNITS.md → find next unit
3. Read latest handoff (if any)
4. Check git log for work newer than STATE.md (track may have drifted)
5. Verify preconditions by READING CODE, not assuming

### During Implementation
- Follow the unit's implementation steps
- If you discover something missing: document in Discovered Gaps (WORK_UNITS.md)
- If architecture decision needed: document in ARCHITECTURE.md
- Grep before building — check existing code for what you need

### Before Declaring Done
- Tests pass (necessary but not sufficient)
- If unit has runtime behavior: verify in running app
- Run failure mode checklist if FAILURE_MODES.md exists

### On Exit
1. Update STATE.md: session date, unit, outcome, next actions
2. Write handoff to handoffs/unit-{X.Y}-{status}.md (use handoff template)
3. If you changed future unit scope, update WORK_UNITS.md too
4. Commit if code was written
5. Capture to evna

## Key Principles
- {2-4 track-specific principles extracted from ARCHITECTURE.md}
```

#### FAILURE_MODES.md Template (when user provides anti-patterns)
```markdown
# $ARGUMENTS: Known Failure Modes

## 1. {Pattern Name}
**Pattern**: {what goes wrong}
**Evidence**: {where this was observed}
**Guard**: {how to prevent it}
**Track-specific risk**: {how this manifests in THIS track's work}

---

## Using This File

### In Unit Entry
Before starting implementation, scan this list for risks relevant to the unit.

### In Gate/Sweep Checklists
Each failure mode maps to a checkpoint — include relevant ones in exit checklist.

### Updating This File
When a new failure mode is discovered, add it here with the unit reference.
```

#### Handoff Template

All handoffs should follow this structure:

```markdown
# Unit {X.Y} Handoff: {Name}

**Status**: Complete | Partial | Blocked
**Date**: {date}
**Commit**: {hash} on {branch} (or "no code changes")

## What Was Done
{Bullet list of concrete deliverables}

## Verification Evidence
{Console output, test results, curl responses, screenshot descriptions}
{If no runtime verification: explain why not}

## Decisions Made
{Architectural choices, with rationale}

## Gaps Discovered
{Anything that should be added to WORK_UNITS.md Discovered Gaps}

## What Next Session Needs
{Specific starting point for the next cold-start sibling}
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

1. **`.float/work/$ARGUMENTS/AGENT_PROMPT.md`** - Session protocol (if exists — follow it)
2. **`.float/work/$ARGUMENTS/STATE.md`** - Current position and session log
3. **`.float/work/$ARGUMENTS/WORK_UNITS.md`** - Unit definitions with Entry/Exit protocols
4. **`.float/work/$ARGUMENTS/ARCHITECTURE.md`** - Context and target state
5. **`.float/work/$ARGUMENTS/FAILURE_MODES.md`** - Known anti-patterns (if exists)
6. **`.float/work/$ARGUMENTS/handoffs/`** - Any existing handoff documents

Check for discovered gaps at end of WORK_UNITS.md.

---

## Phase 2.5: Drift Detection

Compare STATE.md's claimed position against actual codebase:

1. Last unit STATE.md claims complete → verify the deliverable exists in code
2. Check git log since STATE.md's last session date → any work not captured?
3. Check Linear issues mentioned in ARCHITECTURE.md → any resolved since last session?

```bash
# Work since last session (replace date with STATE.md's Last Session)
git log --oneline --since="{last_session_date}" --all | head -20
```

If drift detected:
- Update STATE.md before proceeding
- Note drift in session log: "Drift: Unit X.Y already shipped per git log"

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
- If FAILURE_MODES.md exists, scan for risks relevant to this unit

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
- If unit has runtime behavior: verify in running app (unit tests are necessary but NOT sufficient)
- Document decisions in handoff (use handoff template)
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
   # Create handoff for next session (use handoff template above)
   touch .float/work/$ARGUMENTS/handoffs/unit-{X.Y}-partial.md
   ```

3. If this session changed future unit scope (deferred, removed, restructured),
   update WORK_UNITS.md too — not just STATE.md. Cold-start siblings read both files.

4. Capture to evna:
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
- Grep before building — check existing code for what you need
- Unit tests passing ≠ feature works — verify runtime behavior in the app
