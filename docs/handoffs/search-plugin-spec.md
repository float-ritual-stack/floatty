---
description: Implement search infrastructure as handler/door with fzf integration
created: 2026-01-13
status: ready-for-investigation
---

# Spec: Search as Handler/Door with Plugin Surface Area

## Overview

Implement in-app search using the existing handler/door architecture (`search::`, `pick::`), expose navigation APIs for plugins, and optionally integrate with the existing `$tv()` fzf picker system.

This is both a **feature implementation** and an **architectural expansion** — we're defining the plugin surface area that future handlers will use.

---

## Goals

1. **`search::` handler** - Inline results view, click to navigate
2. **`pick::` handler** - fzf picker, keyboard-driven quick jump
3. **Navigation API** - Expose `navigateToBlock()` for all plugins/views
4. **`$tv(search:...)` channel** - Composable search in any command
5. **Plugin surface area** - Document what handlers can do

---

## Current State

### What Exists

| Component | Location | Status |
|-----------|----------|--------|
| Handler registry | `src/lib/handlers/` | Working (sh, ai, daily) |
| Tantivy search | `src-tauri/floatty-core/src/search/` | Working |
| Search REST API | `GET /api/v1/search?q=...` | Working |
| $tv() picker | `src/lib/tvResolver.ts` | Working |
| Terminal/fzf | `src/lib/terminalManager.ts` | Working |
| Block navigation | `src/hooks/usePaneStore.ts` | Scattered, not exposed |
| Page navigation | `src/hooks/useBacklinkNavigation.ts` | Working |

### What's Missing

| Component | Gap |
|-----------|-----|
| `search::` handler | Not implemented |
| `pick::` handler | Not implemented |
| Navigation API | Not exposed to handlers/views |
| Search channel for $tv() | Not implemented |
| Plugin surface area docs | Not documented |

---

## Architecture Context

### Handler Pattern (established)

```typescript
// src/lib/handlers/types.ts
interface BlockHandler {
  prefixes: string[];
  execute: (blockId: string, content: string, actions: ExecutorActions) => Promise<void>;
}

// ExecutorActions - what handlers can currently do
interface ExecutorActions {
  createBlockInside: (parentId: string) => string;
  createBlockInsideAtTop?: (parentId: string) => string;
  updateBlockContent: (id: string, content: string) => void;
  deleteBlock?: (id: string) => boolean;
  setBlockOutput?: (id: string, output: unknown, outputType: string) => void;
  setBlockStatus?: (id: string, status: 'idle' | 'running' | 'complete' | 'error') => void;
  getBlock?: (id: string) => unknown;
  paneId?: string;
  // No navigation APIs currently
}
```

### View Component Pattern (established via daily::)

```typescript
// Handlers can set structured output that renders via custom components
actions.setBlockOutput(blockId, data, 'daily-view');

// BlockItem.tsx renders based on outputType
{block()?.outputType === 'daily-view' && (
  <DailyView data={block()!.output as DailyNoteData} />
)}
```

### $tv() Picker Pattern (established)

```typescript
// Commands can include $tv(channel) for interactive picking
sh:: cat $tv(files)

// tvResolver.ts resolves by:
// 1. Spawning picker:: block with fzf
// 2. Waiting for user selection
// 3. Substituting selected value into command
```

---

## Design Decisions Needed

### Decision 1: Handler Types (Executor vs Lens)

**Context**: Current handlers (sh, ai) are "executors" - they run commands and create child blocks. Search is different - it queries but shouldn't pollute the outline with result blocks.

**Options**:

| Option | Behavior | Pros | Cons |
|--------|----------|------|------|
| A: Executor pattern | Create child blocks for results | Consistent with sh/ai | Clutters outline, results go stale |
| B: Lens pattern | Render via setBlockOutput, no children | Clean outline, refreshable | New pattern |
| C: Hybrid | User chooses via modifier | Flexible | Complex |

**Recommendation**: Option B (Lens pattern) using `setBlockOutput` like `daily::`.

### Decision 2: Navigation API Location

**Context**: View components (like SearchResultsView) need to navigate, but they don't receive ExecutorActions.

**Options**:

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A: Props drilling | Pass onNavigate callback through props | Explicit, testable | Verbose, threading burden |
| B: SolidJS Context | NavigationContext provider | Clean API | Hidden dependency |
| C: Global module | `import { navigateToBlock } from '../lib/navigation'` | Simple, works anywhere | Global state |

**Recommendation**: Option C (Global module). Navigation is inherently global (affects pane state). Export functions that view components can import directly.

### Decision 3: fzf Integration Approach

**Context**: We have $tv() picker infrastructure. How should `pick::` use it?

**Options**:

| Option | Approach | Pros | Cons |
|--------|----------|------|------|
| A: New picker spawn | `pick::` spawns fzf directly | Full control | Duplicates $tv() logic |
| B: Reuse $tv() | `pick::` internally uses $tv(search:...) | Code reuse | Needs search channel |
| C: Extract shared | Factor out picker utils from tvResolver | Clean separation | Refactoring work |

**Recommendation**: Option B initially (add search channel to $tv()), then Option C if needed.

---

## Proposed Implementation

### Phase 1: Navigation API

**Goal**: Expose navigation functions for handlers and view components.

**Files to create/modify**:
- `src/lib/navigation.ts` (NEW) - Navigation functions
- `src/lib/handlers/types.ts` - Add navigation to ExecutorActions
- `src/components/BlockItem.tsx` - Wire up navigation when calling handlers

**API**:
```typescript
// src/lib/navigation.ts
export interface NavigateOptions {
  paneId?: string;
  splitDirection?: 'horizontal' | 'vertical';
  highlight?: boolean;
}

export function navigateToBlock(blockId: string, options?: NavigateOptions): void;
export function navigateToPage(pageName: string, options?: NavigateOptions): void;
export function scrollToBlock(blockId: string): void;
```

### Phase 2: search:: Handler (Inline Results)

**Goal**: `search:: query` shows results inline, click to navigate.

**Files to create/modify**:
- `src/lib/handlers/search.ts` (NEW) - Handler implementation
- `src/lib/handlers/index.ts` - Register handler
- `src/components/views/SearchResultsView.tsx` (NEW) - Results component
- `src/components/BlockItem.tsx` - Render SearchResultsView for outputType
- `src/index.css` - Styles for search results

**Behavior**:
```
User types: search:: project floatty
User presses Enter
-> Handler queries /api/v1/search
-> Handler calls setBlockOutput(blockId, results, 'search-results')
-> BlockItem renders SearchResultsView
-> User clicks result
-> navigateToBlock(resultBlockId)
```

### Phase 3: $tv(search:...) Channel

**Goal**: Add search as a $tv() channel for composability.

**Files to modify**:
- `src/lib/tvResolver.ts` - Add 'search' channel case

**Behavior**:
```
User types: sh:: echo $tv(search:floatty)
User presses Enter
-> $tv() resolves 'search' channel
-> Queries /api/v1/search?q=floatty
-> Formats results for fzf: "blockId\tpreview"
-> Spawns fzf picker
-> User selects
-> Substitutes blockId into command
-> Executes: sh:: echo abc123
```

### Phase 4: pick:: Handler (fzf Quick Jump)

**Goal**: `pick:: query` opens fzf, navigates on select.

**Files to create/modify**:
- `src/lib/handlers/pick.ts` (NEW) - Handler using $tv(search:...)
- `src/lib/handlers/index.ts` - Register handler

**Behavior**:
```
User types: pick:: project floatty
User presses Enter
-> Handler builds $tv(search:project floatty)
-> Resolves via tvResolver (spawns fzf)
-> User selects result
-> navigateToBlock(selectedBlockId)
```

---

## Investigation Tasks

Before implementing, investigate and document findings:

### Task 1: Audit Current Navigation

```
Files to examine:
- src/hooks/usePaneStore.ts - How does zoomToBlock work?
- src/hooks/useBacklinkNavigation.ts - How does navigateToPage work?
- src/hooks/useLayoutStore.ts - How does splitPane work?

Questions to answer:
1. What's the current API for zooming to a block?
2. What's the current API for splitting a pane?
3. Are there any navigation functions already exported?
4. What state needs to change when navigating?
```

### Task 2: Audit $tv() Picker System

```
Files to examine:
- src/lib/tvResolver.ts - How are channels resolved?
- src/lib/terminalManager.ts - How are picker terminals spawned?

Questions to answer:
1. How does $tv(files) work end-to-end?
2. What's the format for fzf input?
3. How is the picker result captured and returned?
4. How would adding a 'search' channel work?
```

### Task 3: Audit Search API

```
Files to examine:
- src-tauri/floatty-server/src/api.rs - Search endpoint
- src/lib/httpClient.ts - How is search called from frontend?

Questions to answer:
1. What's the search response format?
2. Are there search options (limit, filters)?
3. What fields are returned per hit (blockId, content, score)?
4. Is there highlighting/snippet support?
```

### Task 4: Audit View Component Pattern

```
Files to examine:
- src/components/views/DailyView.tsx - Existing view component
- src/components/BlockItem.tsx - How is outputType rendered?

Questions to answer:
1. How does DailyView receive its data?
2. How does BlockItem decide which view to render?
3. What props does the view component receive?
4. How would SearchResultsView handle click events?
```

---

## Implementation Checklist

### Phase 1: Navigation API
- [ ] Create `src/lib/navigation.ts`
- [ ] Implement `navigateToBlock(blockId, options)`
- [ ] Implement `navigateToPage(pageName, options)`
- [ ] Implement `scrollToBlock(blockId)`
- [ ] Add highlight animation CSS
- [ ] Add navigation functions to ExecutorActions type
- [ ] Wire up navigation in BlockItem.tsx handler execution
- [ ] Test: Import and call navigateToBlock from console

### Phase 2: search:: Handler
- [ ] Create `src/lib/handlers/search.ts`
- [ ] Define SearchResults and SearchHit types
- [ ] Implement search query execution
- [ ] Implement setBlockOutput with 'search-results' type
- [ ] Register handler in index.ts
- [ ] Create `src/components/views/SearchResultsView.tsx`
- [ ] Implement result list rendering
- [ ] Implement click-to-navigate using navigation API
- [ ] Add outputType='search-results' case in BlockItem.tsx
- [ ] Add CSS styles for search results
- [ ] Test: `search:: floatty` shows results, click navigates

### Phase 3: $tv(search:...) Channel
- [ ] Add 'search' case to tvResolver.ts getChannelContent()
- [ ] Format search results for fzf (blockId\tpreview)
- [ ] Test: `sh:: echo $tv(search:floatty)` opens picker, substitutes

### Phase 4: pick:: Handler
- [ ] Create `src/lib/handlers/pick.ts`
- [ ] Implement using $tv(search:...) internally
- [ ] Navigate to selected block on completion
- [ ] Register handler in index.ts
- [ ] Test: `pick:: floatty` opens fzf, selection navigates

---

## Validation Criteria

### Navigation API
- [ ] `navigateToBlock(id)` zooms pane to block
- [ ] `navigateToBlock(id, { splitDirection: 'horizontal' })` opens in split
- [ ] `navigateToBlock(id, { highlight: true })` shows visual feedback
- [ ] `navigateToPage('PageName')` finds/creates page and navigates

### search:: Handler
- [ ] `search:: query` shows inline results
- [ ] Results show block content preview
- [ ] Results show relevance score
- [ ] Click result navigates to block
- [ ] Cmd+Click opens in horizontal split
- [ ] Cmd+Shift+Click opens in vertical split
- [ ] Empty query shows error message
- [ ] No results shows "No results found"
- [ ] Re-run (Enter again) refreshes results

### $tv(search:...) Channel
- [ ] `$tv(search:query)` spawns fzf with search results
- [ ] Results show preview text in fzf
- [ ] Selection returns blockId
- [ ] Escape cancels without substitution

### pick:: Handler
- [ ] `pick:: query` opens fzf picker
- [ ] Selection navigates to block
- [ ] Escape cancels gracefully
- [ ] Works with pane context (opens in correct pane)

---

## Future Considerations (Out of Scope)

- Live search (results update as you type)
- Search query syntax highlighting
- Search history / recent searches
- Saved searches as blocks
- Search within subtree
- Search filters UI
- Result grouping by page/date

---

## Reference: Existing Patterns

### Handler Registration
```typescript
// src/lib/handlers/index.ts
export function registerHandlers(): void {
  registry.register(shHandler);
  registry.register(aiHandler);
  registry.register(dailyHandler);
  // Add: registry.register(searchHandler);
  // Add: registry.register(pickHandler);
}
```

### Structured Output Pattern
```typescript
// Handler sets output
actions.setBlockOutput?.(blockId, data, 'search-results');
actions.setBlockStatus?.(blockId, 'complete');

// BlockItem renders
{block()?.outputType === 'search-results' && (
  <SearchResultsView data={block()!.output} paneId={props.paneId} />
)}
```

### $tv() Channel Pattern
```typescript
// src/lib/tvResolver.ts
async function getChannelContent(channel: string, arg: string): Promise<string> {
  switch (channel) {
    case 'files':
      return await invoke('list_files', { pattern: arg });
    case 'search':
      // NEW: Add this case
      const results = await fetch(`/api/v1/search?q=${arg}`);
      return formatForFzf(results);
  }
}
```

---

## Handoff Notes

1. **Start with investigation tasks** - Understand existing patterns before building
2. **Phase 1 (Navigation) unblocks Phase 2-4** - Do this first
3. **Phase 2 (search::) is the core feature** - Most user value
4. **Phase 3-4 are enhancements** - Can be separate PRs
5. **Test incrementally** - Each phase should work independently
6. **Document plugin surface area** - This sets precedent for future handlers

---

## Questions for Implementer

1. Should `search::` results persist across sessions (saved in Y.Doc output) or be ephemeral?
2. Should `pick::` navigate immediately or show "navigated to X" confirmation?
3. Should there be a keyboard shortcut to trigger search (Cmd+P style)?
4. Should search results show parent path / breadcrumb?
5. Maximum number of results to show (inline vs fzf)?
