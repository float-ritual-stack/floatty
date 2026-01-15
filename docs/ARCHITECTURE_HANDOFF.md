# Architecture Handoff: Codebase Exploration Guide

> For AI agents: Explore the codebase, verify designs align with reality, identify gaps.

**Created**: 2026-01-15
**Purpose**: Enable fresh context to understand what exists vs. what's planned

---

## Executive Summary

Floatty has three architectural layers:

1. **Implemented** - EventBus, HookRegistry, Handler system, Y.Doc integration
2. **Planned** - Multi-client coordination protocol, Tantivy search index
3. **Exploration** - `filter::` blocks, `:::Component` syntax, TTL directives

Your job: **Verify what's real, identify what's ghost spec.**

---

## Quick Orientation

### What Floatty Is

Terminal emulator + block-based outliner + context aggregation sidebar.

```
┌─────────────────────────────────────────────────┐
│ Tab Bar                                         │
├─────────────────────────────────────────────────┤
│                    │ ctx:: Sidebar              │
│   Terminal/        │ - markers from Claude Code │
│   Outliner Panes   │ - parsed via Ollama        │
│                    │                            │
└─────────────────────────────────────────────────┘
```

### Stack

| Layer | Tech |
|-------|------|
| App shell | Tauri v2 |
| Frontend | SolidJS |
| Terminal | xterm.js + portable-pty |
| Outliner CRDT | yjs (TS) + yrs (Rust) |
| State | SolidJS stores |

---

## Infrastructure Audit Checklist

### 1. EventBus System

**Files to check**:
- [ ] `src/lib/events/eventBus.ts` - Subscription mechanics, event types
- [ ] `src/lib/events/projectionScheduler.ts` - Debounced async handlers
- [ ] `src/lib/events/types.ts` - Event type definitions

**Questions**:
- What events are defined?
- How does subscription work?
- What projections are registered?

### 2. Hook System

**Files to check**:
- [ ] `src/lib/hooks/hookRegistry.ts` - Registration, execution flow
- [ ] `src/lib/hooks/types.ts` - Hook interface
- [ ] `src/lib/handlers/hooks/` - Existing hooks (look for `sendContextHook`)
- [ ] `src/lib/handlers/executor.ts` - Hook lifecycle integration

**Questions**:
- What hooks exist?
- How does priority ordering work?
- How does abort propagate?

### 3. Handler Registry

**Files to check**:
- [ ] `src/lib/handlers/registry.ts` - Handler registration
- [ ] `src/lib/handlers/*.ts` - Individual handlers

**Questions**:
- What prefixes are registered? (`sh::`, `ai::`, `/send`, etc.)
- Is this TypeScript-only or does Rust have handlers?
- How does execution dispatch work?

### 4. Y.Doc Integration

**Files to check**:
- [ ] `src/hooks/useBlockStore.ts` - Look for `observeDeep()` (~line 250-374)
- [ ] Origin tags in transactions

**Questions**:
- How are events emitted to EventBus from Y.Doc changes?
- What origin tags exist?
- Is there loop prevention?

### 5. Block Store

**Files to check**:
- [ ] `src/lib/blockTypes.ts` - Block type definitions, prefix detection
- [ ] `src/hooks/useBlockStore.ts` - CRUD operations

**Questions**:
- What is `block.metadata` used for?
- How is prefix detection implemented?
- What fields exist on a Block?

### 6. Search/Tantivy

**Files to check**:
- [ ] `src-tauri/src/` - Any Tantivy-related Rust code
- [ ] Tauri commands (search for `#[tauri::command]`)

**Questions**:
- Is Tantivy integrated or just planned?
- What search commands exist in Rust?
- Is there a projection for indexing?

### 7. Context Sidebar

**Files to check**:
- [ ] `src/components/ContextSidebar.tsx` - Data fetching
- [ ] `src-tauri/src/ctx_watcher.rs` - JSONL file watching
- [ ] `src-tauri/src/ctx_parser.rs` - Ollama parsing

**Questions**:
- Is it polling Tauri commands or subscribing to EventBus?
- What's the data flow from JSONL → sidebar?

### 8. Wikilinks & Backlinks

**Files to check**:
- [ ] `src/lib/inlineParser.ts` - `[[wikilink]]` tokenization
- [ ] `src/hooks/useBacklinkNavigation.ts` - Navigation, page creation
- [ ] `src/components/LinkedReferences.tsx` - Backlink display

**Questions**:
- Is backlink computation O(n) scan or indexed?
- How are outlinks extracted?
- Is there a backlink index projection?

---

## Gap Analysis Template

Fill this in as you explore:

| Feature | Status | Evidence | Notes |
|---------|--------|----------|-------|
| EventBus | EXISTS / PARTIAL / MISSING | file:line | |
| ProjectionScheduler | EXISTS / PARTIAL / MISSING | file:line | |
| HookRegistry | EXISTS / PARTIAL / MISSING | file:line | |
| sendContextHook | EXISTS / PARTIAL / MISSING | file:line | |
| Handler executor | EXISTS / PARTIAL / MISSING | file:line | |
| Y.Doc → EventBus bridge | EXISTS / PARTIAL / MISSING | file:line | |
| Tantivy indexing | EXISTS / PARTIAL / MISSING | file:line | |
| Backlink index | EXISTS / PARTIAL / MISSING | file:line | |
| filter:: syntax | EXISTS / PARTIAL / MISSING | file:line | |
| query:: syntax | EXISTS / PARTIAL / MISSING | file:line | |
| :::Component registry | EXISTS / PARTIAL / MISSING | file:line | |
| TTL directives | EXISTS / PARTIAL / MISSING | file:line | |
| Multi-client coordination | EXISTS / PARTIAL / MISSING | file:line | |

---

## Vision Documents (For Comparison)

These describe **planned** features - verify if any are actually implemented:

| Document | Claims | Verify |
|----------|--------|--------|
| [PATTERN_INTEGRATION_SKETCH.md](architecture/PATTERN_INTEGRATION_SKETCH.md) | `filter::`, `:::Component`, routing | Likely NOT implemented |
| [BACKLINKS_AND_TTL_EXPLORATION.md](explorations/BACKLINKS_AND_TTL_EXPLORATION.md) | TTL directives, backlink injection hooks | Likely NOT implemented |
| [EVENTBUS_HOOK_MIGRATION_REVIEW.md](architecture/EVENTBUS_HOOK_MIGRATION_REVIEW.md) | Migration candidates | Check what's done vs pending |
| [FLOATTY_MULTI_CLIENT.md](architecture/FLOATTY_MULTI_CLIENT.md) | Coordination protocol | Check DONE vs NEXT sections |

---

## Implementation Priority (Suggested)

Based on dependency chains:

### Immediate (Infrastructure exists)
1. **Backlink index projection** - EventBus exists, just needs projection handler
2. **Context sidebar → EventBus** - Replace polling with subscription
3. **ttlDirectiveHook** - Hook system exists, pattern is clear

### Short-term (Minor additions)
4. **wikilinkExpansionHook** - Depends on backlink index
5. **filter:: parser** - New parser, uses existing EventBus
6. **tokenEstimationHook** - Simple hook, no dependencies

### Medium-term (New subsystems)
7. **Tantivy integration** - Requires Rust commands + projection
8. **query:: syntax** - Depends on Tantivy
9. **Component registry** - New renderer infrastructure

### Deferred (Design decisions needed)
10. **Multi-client coordination** - Needs protocol finalization
11. **Tool injection** - Needs component registry first
12. **Routing engine** - Complex, many edge cases

---

## Output Expected

After exploration, provide:

1. **Infrastructure Audit Results** - What you found in each area
2. **Gap Analysis Table** - Filled in with evidence
3. **Corrected Vision** - What's real vs ghost spec
4. **Revised Implementation Plan** - Based on actual state
5. **First PR Scope** - Concrete files/changes for immediate value

---

## Important Notes

- **Don't assume** - Verify by reading code
- **Quote evidence** - `file.ts:123` style references
- **Flag surprises** - Reality often differs from docs
- **Preserve working code** - Don't suggest rewrites for things that work
- **Follow existing patterns** - Consistency over novelty

---

## Related Documentation

- [docs/README.md](README.md) - Documentation index
- [CLAUDE.md](../CLAUDE.md) - Detailed architecture, commands, patterns
- [docs/guides/](guides/) - Developer reference guides
- [docs/tutorials/](tutorials/) - Walkthrough examples
