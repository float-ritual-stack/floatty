# Exploration & Grounding Handoff

> For: AI coding agent starting implementation work
> Vision Doc: `docs/architecture/QUERY_COMPONENTS_CONTEXT_VISION.md`
> Status: EXPLORATION REQUIRED

## Context

A comprehensive architecture vision was developed for extending Floatty with query systems, component embedding, and context management. However, this vision was developed through design discussion without fully validating against the current codebase state.

**Your mission**: Explore the codebase, understand what currently exists, and create a grounded implementation plan.

---

## Phase 1: Infrastructure Audit

Scan these files and document their current state:

### 1.1 EventBus System

| File | Questions |
|------|-----------|
| `src/lib/events/eventBus.ts` | How does subscription work? What events exist? |
| `src/lib/events/projectionScheduler.ts` | What projections are registered? How is debouncing configured? |
| `src/lib/events/types.ts` | What event types are defined? |

### 1.2 Hook System

| File | Questions |
|------|-----------|
| `src/lib/hooks/hookRegistry.ts` | How are hooks registered and executed? |
| `src/lib/hooks/types.ts` | What's the Hook interface? |
| `src/lib/handlers/hooks/` | What hooks currently exist? List all files. |
| `src/lib/handlers/executor.ts` | How does hook lifecycle work? |

### 1.3 Y.Doc Integration

| File | Questions |
|------|-----------|
| `src/hooks/useBlockStore.ts` | Find the observeDeep section (around line 250-374). How are events emitted to EventBus and ProjectionScheduler? |
| | What origin tags are used? |

### 1.4 Block Store

| Question | Answer |
|----------|--------|
| What is the Block type definition? | |
| Is `block.metadata` used? What fields? | |
| How are wikilinks currently parsed? | Check `src/lib/inlineParser.ts` |

### 1.5 Handler Registry

| File | Questions |
|------|-----------|
| `src/lib/handlers/registry.ts` | What handlers are registered? |
| | What prefixes exist? (`/send`, `sh::`, `ai::`, etc.) |

### 1.6 Tantivy/Search

| File | Questions |
|------|-----------|
| `src-tauri/src/` | Is there Tantivy integration? |
| `src-tauri/floatty-core/` | What Rust crates exist? |
| | What Tauri commands exist for search/indexing? |

### 1.7 Context Sidebar

| File | Questions |
|------|-----------|
| `src/components/ContextSidebar.tsx` | How does it fetch data? |
| | Is it polling? Subscribing to events? |
| | What's the data structure for context markers? |

### 1.8 Backlinks

| File | Questions |
|------|-----------|
| `src/hooks/useBacklinkNavigation.ts` | How are backlinks currently computed? |
| | Is there an index or O(n) scan? |

---

## Phase 2: Gap Analysis

For each feature in the vision document, determine status:

| Feature | Status | Location/Notes |
|---------|--------|----------------|
| EventBus | EXISTS / PARTIAL / MISSING | |
| ProjectionScheduler | EXISTS / PARTIAL / MISSING | |
| HookRegistry | EXISTS / PARTIAL / MISSING | |
| sendContextHook | EXISTS / PARTIAL / MISSING | |
| ttlDirectiveHook | EXISTS / PARTIAL / MISSING | |
| Tantivy indexing | EXISTS / PARTIAL / MISSING | |
| Backlink index (O(1)) | EXISTS / PARTIAL / MISSING | |
| Component registry | EXISTS / PARTIAL / MISSING | |
| filter:: syntax | EXISTS / PARTIAL / MISSING | |
| query:: syntax | EXISTS / PARTIAL / MISSING | |
| Unified context stream | EXISTS / PARTIAL / MISSING | |
| Routing engine | EXISTS / PARTIAL / MISSING | |
| Tool registry | EXISTS / PARTIAL / MISSING | |
| ctx:: TTL parsing | EXISTS / PARTIAL / MISSING | |

---

## Phase 3: Dependency Mapping

Create a dependency graph showing:

```
What exists → What can be built immediately → What needs prerequisites
```

Example analysis:
- If EventBus exists → Can implement filter:: hook immediately
- If Tantivy commands missing → Must add Rust commands before query::
- If ProjectionScheduler exists but no handlers → Can add tantivy handler immediately

---

## Phase 4: Reality-Grounded Implementation Plan

Based on exploration, create a revised plan that:

1. **Acknowledges what exists** - Don't rebuild working code
2. **Identifies actual gaps** - What's truly missing vs. assumed missing
3. **Respects existing patterns** - Follow conventions in the codebase
4. **Provides concrete first steps** - What can be done in the first PR?

### Template for Plan

```markdown
## Implementation Plan (Grounded)

### Immediate (Uses existing infrastructure)
- [ ] Task 1 - File: path, Changes: description
- [ ] Task 2 - ...

### Short-term (Requires minor additions)
- [ ] Task 3 - Depends on: X, Changes: description
- [ ] Task 4 - ...

### Medium-term (Requires new subsystems)
- [ ] Task 5 - New files needed: list
- [ ] Task 6 - ...

### Deferred (Needs design decisions)
- [ ] Task 7 - Open question: X
- [ ] Task 8 - ...
```

---

## Output Format

Provide your findings as a structured report:

1. **Infrastructure Audit Results** - What you found in each area
2. **Gap Analysis Table** - Feature status matrix (filled in)
3. **Dependency Graph** - What blocks what
4. **Grounded Implementation Plan** - Revised phases with real file paths
5. **Recommendations** - What to prioritize, defer, or reconsider

---

## Important Notes

- **Don't assume** - Verify by reading code
- **Quote code** - Show evidence for findings (file:line format)
- **Flag surprises** - If reality differs significantly from vision, highlight it
- **Preserve working code** - Don't suggest rewriting things that work
- **Follow existing patterns** - Consistency over novelty
- **Check tests** - Look at test files to understand expected behavior

---

## Suggested Starting Commands

```bash
# Find all event-related files
rg -l "EventBus|eventBus" --type ts

# Find all hook implementations
ls -la src/lib/handlers/hooks/

# Check Tantivy integration
rg -l "tantivy|Tantivy" src-tauri/

# Find block type definitions
rg "interface Block|type Block" --type ts

# Check for existing filter/query syntax
rg "filter::|query::" src/
```

---

## First Message Example

```
I have a comprehensive architecture vision for extending Floatty with query systems,
component embedding, and context management. Before implementing anything, I need to:

1. Explore the codebase to understand what infrastructure already exists
2. Compare against the vision document (docs/architecture/QUERY_COMPONENTS_CONTEXT_VISION.md)
3. Identify gaps between vision and reality
4. Create a grounded implementation plan

Start with the Infrastructure Audit - examine the EventBus, Hook system, Y.Doc
integration, and handler registry. Quote relevant code so I can verify your findings.
```

---

## Multi-Agent Approach (Optional)

If running multiple agents:

| Agent | Role | Output |
|-------|------|--------|
| Scout | Runs exploration, produces audit report | Infrastructure findings |
| Architect | Reviews audit, reconciles with vision | Revised architecture |
| Implementer | Takes grounded plan, starts coding | PRs |

---

## Incremental Approach (Alternative)

1. Start with Phase 1 (Infrastructure Audit) only
2. Review findings with human
3. Proceed to Phase 2-4 based on discoveries
4. Iterate until confident

This is often safer as it allows course correction before deep implementation.

---

ctx::2026-01-15 [project::floatty] [mode::handoff] Exploration grounding prompt created for architecture validation
