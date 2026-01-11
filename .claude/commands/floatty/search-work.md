---
description: Continue floatty search architecture work (Tantivy integration)
---

# Search Architecture Work Unit

## Phase 1: Context Gathering (BEFORE reading docs)

Launch explore agents to assess current state:

```
Use Task tool with subagent_type=Explore:
1. "What is the current state of Origin enum in floatty-core?"
   - Check src-tauri/floatty-core/src/ for origin.rs or origin usage

2. "What block mutation methods exist in YDocStore?"
   - Check src-tauri/floatty-core/src/store.rs

3. "What hooks or event systems exist in floatty-core?"
   - Check for hooks/, events.rs, or similar patterns
```

Also check git for recent work:
```bash
git log --oneline -20
git log --oneline --grep="Work Unit" | head -10
git log --oneline --grep="Origin" | head -5
```

## Phase 2: Read Architecture Docs

After exploration, read these files:

1. **`docs/SEARCH_WORK_UNITS.md`** - Work unit definitions with Entry/Exit protocols
2. **`docs/SEARCH_ARCHITECTURE_LAYERS.md`** - Architecture context and target state
3. **`docs/SEARCH_ARCHITECTURE_SNAPSHOT.md`** - Code validation reference
4. **`docs/handoffs/`** - Any existing handoff documents

Check for discovered gaps at end of SEARCH_WORK_UNITS.md.

## Phase 3: Determine Current Position

Cross-reference exploration findings with work unit index:

| Unit | Name | Status Check |
|------|------|--------------|
| 0.1 | Origin Enum | Does origin.rs exist? |
| 0.2 | Origin in Y.Doc | Are transact() calls tagged? |
| 1.1 | BlockChange Types | Does events.rs exist? |
| 1.5.x | Hook Registry | Does hooks/mod.rs exist? |
| 2.x | Metadata | Is block.metadata typed? |
| 3.x | Tantivy | Is tantivy in Cargo.toml? |

## Phase 4: Execute Next Unit

For the identified next unit:

1. **Entry Protocol**: Verify prerequisites are met
2. **Scope**: Only modify files listed in the unit
3. **Validation**: Run checks defined in Exit Protocol
4. **Commit**: Use format `feat: Work Unit X.Y.Z - {name}`

## Phase 5: Document Discoveries

If you find gaps or architectural insights during exploration:

1. Add to "Discovered Gaps" section of SEARCH_WORK_UNITS.md
2. Capture to evna:
```
mcp__evna-remote__active_context(
  capture="ctx::{date} @ {time} [project::floatty] [mode::gap-discovery] {summary}",
  project="floatty"
)
```

## Rules

Reference `.claude/rules/ydoc-patterns.md` for Y.Doc patterns.
Reference `.claude/rules/do-not.md` for anti-patterns.

The goldfish bowl pattern means each unit is self-contained.
Exploration first ensures you don't assume stale state from docs.
