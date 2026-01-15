# Floatty Codebase Exploration: Architecture Alignment

**Purpose**: Validate the vision document against actual codebase state
**Prerequisite**: Read `docs/handoffs/query-components-context-vision.md` first
**Output**: Gap analysis and grounded implementation plan

---

## Context

You have access to a detailed architecture vision for extending Floatty with query systems, component embedding, and context management. This vision was developed through design discussion but has NOT been validated against the current codebase state.

Your task is to:
1. Explore the codebase to understand what infrastructure already exists
2. Compare against the vision document
3. Identify gaps between vision and reality
4. Create a grounded implementation plan

---

## Phase 1: Infrastructure Audit

Scan these files and document their current state:

### 1.1 EventBus System

- [ ] `src/lib/events/eventBus.ts` - How does subscription work? What events exist?
- [ ] `src/lib/events/projectionScheduler.ts` - What projections are registered?
- [ ] `src/lib/events/types.ts` - What event types are defined?
- [ ] `src/lib/events/index.ts` - What's exported?

**Questions to answer**:
- Is EventBus a class or functional module?
- What's the subscription API?
- Are there sync vs async lanes?

### 1.2 Hook System

- [ ] `src/lib/hooks/hookRegistry.ts` - How are hooks registered and executed?
- [ ] `src/lib/hooks/types.ts` - What's the Hook interface?
- [ ] `src/lib/handlers/hooks/` directory - What hooks exist?
- [ ] `src/lib/handlers/executor.ts` - How does hook lifecycle work?

**Questions to answer**:
- What's the hook signature?
- How is priority handled?
- Is there a sendContextHook reference implementation?

### 1.3 Y.Doc Integration

- [ ] `src/hooks/useBlockStore.ts` - Find the observeDeep section
- [ ] How are events emitted to EventBus and ProjectionScheduler?
- [ ] What origin tags are used?

**Questions to answer**:
- Is there already a two-lane pattern (sync + async)?
- What event payload structure?

### 1.4 Block Store & Types

- [ ] Block type definition location
- [ ] Is `block.metadata` used? What fields?
- [ ] How are wikilinks parsed? (`src/lib/inlineParser.ts`?)

**Questions to answer**:
- What metadata fields exist?
- Is there marker extraction?
- How are outlinks tracked?

### 1.5 Handler Registry

- [ ] `src/lib/handlers/registry.ts` - What handlers are registered?
- [ ] What prefixes exist? (`/send`, `sh::`, `ai::`, etc.)
- [ ] How does prefix matching work?

**Questions to answer**:
- Is there a `/send` handler?
- How are handlers executed?

### 1.6 Tantivy/Search

- [ ] `src-tauri/floatty-core/` - Tantivy integration location
- [ ] `src-tauri/floatty-server/` - Search API endpoints
- [ ] What fields are indexed?

**Questions to answer**:
- Is search working?
- What query capabilities exist?
- Is there a TantivyIndexHook?

### 1.7 Context Sidebar

- [ ] `src/components/ContextSidebar.tsx` - How does it fetch data?
- [ ] Is it polling Tauri commands or using EventBus?
- [ ] What's the data structure for context markers?

**Questions to answer**:
- Is migration to EventBus needed?
- What's the current refresh pattern?

### 1.8 Backlinks

- [ ] `src/hooks/useBacklinkNavigation.ts` or similar
- [ ] How are backlinks currently computed?
- [ ] Is there an index or O(n) scan?

**Questions to answer**:
- Performance characteristics?
- Would benefit from ProjectionScheduler?

---

## Phase 2: Gap Analysis

For each feature in the vision document, determine status:

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| EventBus | EXISTS / PARTIAL / MISSING | File path + line | Details |
| ProjectionScheduler | EXISTS / PARTIAL / MISSING | | |
| HookRegistry | EXISTS / PARTIAL / MISSING | | |
| sendContextHook | EXISTS / PARTIAL / MISSING | | |
| ttlDirectiveHook | EXISTS / PARTIAL / MISSING | | |
| Tantivy indexing | EXISTS / PARTIAL / MISSING | | |
| Backlink index | EXISTS / PARTIAL / MISSING | | |
| Component registry | EXISTS / PARTIAL / MISSING | | |
| filter:: syntax | EXISTS / PARTIAL / MISSING | | |
| query:: syntax | EXISTS / PARTIAL / MISSING | | |
| ctx:: directives | EXISTS / PARTIAL / MISSING | | |
| Unified context stream | EXISTS / PARTIAL / MISSING | | |
| Tool registry | EXISTS / PARTIAL / MISSING | | |

---

## Phase 3: Dependency Mapping

Create a dependency graph showing what can be built with existing infrastructure:

```
┌─────────────────────────────────────────────────────────────┐
│                     EXISTS (verified)                        │
├─────────────────────────────────────────────────────────────┤
│  EventBus?  ProjectionScheduler?  HookRegistry?  Tantivy?   │
└──────────────────────────┬──────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ IMMEDIATE BUILD │ │ NEEDS MINOR ADD │ │ NEEDS NEW SYSTEM│
├─────────────────┤ ├─────────────────┤ ├─────────────────┤
│ - ???           │ │ - ???           │ │ - ???           │
│ - ???           │ │ - ???           │ │ - ???           │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

Fill in based on your findings.

---

## Phase 4: Grounded Implementation Plan

Based on exploration, create a revised plan:

### Immediate (Uses existing infrastructure)

These can be implemented NOW with what exists:

- [ ] Task - File: `path/to/file.ts`, Changes: description
- [ ] Task - ...

### Short-term (Requires minor additions)

These need small additions to existing systems:

- [ ] Task - Depends on: X
- [ ] Task - Adds: new file to existing pattern

### Medium-term (Requires new subsystems)

These need new modules but fit existing architecture:

- [ ] Task - New files: list
- [ ] Task - Integration points: where it connects

### Deferred (Needs design decisions)

These have open questions that need resolution:

- [ ] Task - Question: ???
- [ ] Task - Alternative approaches: ???

---

## Output Format

Provide findings as a structured report:

### 1. Infrastructure Audit Results

For each area, provide:
- **Status**: What exists
- **Evidence**: File paths, line numbers, code quotes
- **Notes**: Surprises, deviations from vision

### 2. Gap Analysis Table

Complete the table above with evidence.

### 3. Dependency Graph

Visual representation of what blocks what.

### 4. Grounded Implementation Plan

Revised phases based on reality.

### 5. Recommendations

- **Prioritize**: What to build first (highest leverage)
- **Defer**: What can wait (low impact or high complexity)
- **Reconsider**: What from vision doesn't fit the codebase

---

## Important Guidelines

### DO

- **Verify by reading code** - Don't assume from file names
- **Quote evidence** - Show the actual code that proves your finding
- **Flag surprises** - If reality differs significantly from vision, highlight it
- **Follow existing patterns** - Consistency over novelty
- **Check CLAUDE.md** - It has critical patterns and anti-patterns

### DON'T

- **Don't rewrite working code** - Preserve what works
- **Don't add new patterns** - Use existing conventions
- **Don't guess** - If unsure, note it as "NEEDS VERIFICATION"
- **Don't skip the Rust side** - `src-tauri/` has critical infrastructure

---

## Suggested Exploration Order

1. Start with `src/lib/events/` - Foundation for everything
2. Then `src/lib/handlers/` - Execution patterns
3. Then `src/hooks/useBlockStore.ts` - Y.Doc integration
4. Then `src-tauri/floatty-core/` - Rust infrastructure
5. Finally `src/components/` - UI patterns

---

## Session Start Command

When starting this exploration, run:

```bash
# Verify test suite passes (baseline)
npm run test

# Check for EventBus
fd -t f "eventBus" src/

# Check for hooks
fd -t f -e ts . src/lib/hooks/ src/lib/handlers/hooks/

# Check Rust search
fd -t f "tantivy" src-tauri/
```

---

ctx::exploration [project::floatty] [mode::codebase-audit] Exploration prompt for architecture validation
