---
description: Capture discovered architecture gap and update work unit specs
argument-hint: <gap description>
---

# Gap: $ARGUMENTS

## Phase 0: Identify Active Track

Check for active work track:

```bash
# Find most recently modified track
ls -lt .float/work/*/STATE.md 2>/dev/null | head -1
```

If no track found, this gap applies to general floatty architecture.
If track found, the gap will be documented in that track's WORK_UNITS.md.

---

## Phase 1: Verify the Gap

Before documenting, explore to confirm the gap is real:

```
Use Task tool with subagent_type=Explore:
"Verify: [description of gap]. Check if this functionality exists anywhere in the codebase."
```

Check relevant areas:
- `src-tauri/floatty-core/src/` for Rust implementations
- `src/` for TypeScript implementations
- `.float/work/{track}/` for existing documentation

---

## Phase 2: Document the Gap

Read the active track's WORK_UNITS.md to understand current unit structure.

Gap details to capture:
- What was discovered
- Which unit surfaced it (or general exploration)
- Why it matters (what breaks without it)
- Suggested placement in unit sequence

---

## Phase 3: Determine Impact

| Impact | Action |
|--------|--------|
| Blocks current work | Add as prerequisite unit (0.x, 1.x, etc.) |
| Enables future capability | Add to later phase or create new phase |
| Nice-to-have | Add to `## Discovered Gaps` section at end of doc |

---

## Phase 4: Update Track WORK_UNITS.md

Add to Discovered Gaps section in `.float/work/{track}/WORK_UNITS.md`:

```markdown
### Gap: {Gap Name}

**Discovered**: {date} during Unit {X.Y} / exploration
**Surfaced by**: {what triggered discovery}

**Current State**:
{What exists now}

**Impact**:
{What breaks or is limited without this}

**Architecture Implications**:
{Diagram or explanation if helpful}

**Suggested Resolution**:
{Potential unit or approach}

**Status**: Documented, [blocking/not blocking] current work

**Notes**: {Additional context}
```

---

## Phase 5: Update Dependencies (if blocking)

If new unit must be inserted:
1. Add to Work Unit Index table
2. Update Entry Protocol of dependent units
3. Add full unit definition with Entry/Exit protocols

---

## Phase 6: Capture to evna

```
mcp__evna-remote__active_context(
  capture="ctx::{date} @ {time} [project::floatty] [mode::gap-capture] track::{track} - {summary}",
  project="floatty"
)
```

---

## Example

```
/floatty:gap Rust YDocStore has no block-level mutation methods
```

Would:
1. Identify active track (e.g., testing-infra)
2. Explore to verify store.rs only has apply_update()
3. Document the limitation and its impact in `.float/work/testing-infra/WORK_UNITS.md`
4. Capture to evna for sibling awareness
