---
name: floatty-improve-prompt
description: Rewrite rough engineering requests into floatty-specific implementation prompts. Use when the user drops a vague or messy task description and you need to sharpen it before executing — "improve this prompt", "make this clearer", "sharpen this request", or when a request touches multiple floatty subsystems and needs scoping. Also use proactively when a request is ambiguous enough that executing it directly would risk wasted work. Overlaps with util-er (which handles burp→contract routing) but this skill focuses specifically on prompt quality for engineering tasks, not workflow orchestration.
---

# Floatty Prompt Improver

Take a rough engineering request and rewrite it into a high-quality implementation prompt tailored to the floatty codebase. The goal is not to make prompts longer — it's to make them specific enough that execution doesn't waste cycles on wrong assumptions.

## When This Helps vs When It Doesn't

**Use this when:**
- Request is vague ("make pane linking more reliable")
- Request touches multiple subsystems and needs scoping
- Request could be interpreted multiple ways
- You want to hand off a task to a subagent with clear context

**Skip this when:**
- Request is already specific ("add `exclude_types` param to SearchFilters")
- Request is a one-liner you can just do
- User said "just do it"

## Step 0: Classify

Before rewriting, classify the request. The classification determines which rules apply.

| Type | Signals | Key Question |
|------|---------|-------------|
| bug_fix | "broken", "wrong", error descriptions | What's the root cause? |
| feature | "add", "new", "support", "enable" | What existing patterns does this extend? |
| refactor | "clean up", "simplify", "extract" | What's the concrete pain? |
| architecture | "redesign", system-level scope | What are the tradeoffs? |
| debugging | "why is", "investigate", symptoms | What's the repro path? |
| tests | "test", "coverage", "verify" | What invariant are we checking? |
| docs | "document", "explain" | What's the actual architecture? |

## Step 1: Apply Type Rules

### bug_fix
- Hypothesize root cause from symptoms (or ask for it)
- Scope to minimal patch — not a rewrite
- Name the regression surfaces this fix could break
- Require targeted validation (specific test or manual repro)

### feature
- Anchor to existing patterns: is this a Handler, Hook, Projection, or Renderer?
- Define scope boundaries — what changes, what explicitly doesn't
- Identify integration points with existing subsystems
- Require validation of adjacent behavior (not just the new thing)

### refactor
- Require concrete pain statement — "it's messy" isn't enough
- Preserve behavior unless explicitly changing it
- Specify what should NOT be refactored (scope creep guard)
- Require before/after reasoning

### architecture
- Map current subsystem boundaries before proposing new ones
- Name tradeoffs explicitly (not just benefits)
- Separate the design from the migration plan
- Avoid implementation theater (designing systems that won't be built)

### debugging
- Start with failure symptoms and repro path
- Identify likely subsystem from symptoms
- Prefer instrumentation/logging/inspection before code changes
- For DOM issues: check via Tauri MCP `webview_execute_js` first

### tests
- Define the exact failure mode or invariant being tested
- Scope to narrowest useful coverage
- Store-first testability: test pure logic functions, not DOM

### docs
- Use floatty terminology, not generic descriptions
- Sync with actual architecture (read the code, don't guess)
- Reference specific files and line numbers

## Step 2: Rewrite with Floatty Context

Use this context naturally in the rewrite — don't dump it all:

**Stack**: SolidJS frontend, Tauri v2 desktop shell, Rust backend (floatty-core + floatty-server), headless Axum server, Yjs/Yrs CRDT sync

**Major subsystems** (use the right names):
- PTY terminal: xterm.js, base64 batching, Tauri Channels, `terminalManager.ts`
- Multi-pane: `useLayoutStore`, `usePaneStore`, linked-pane resolution (Cmd+L), `PaneLayout.tsx`
- Block outliner: block tree, childIds, zoom, collapse, contentEditable, `useBlockStore`
- Command bar: Cmd+K, `useCommandBar`
- Doors/plugins: `doorLoader.ts`, `doorTypes.ts`, iframe sandbox, chirp:: bridge
- Metadata pipeline: MetadataExtractionHook (priority 10) → InheritanceIndex (15) → TantivyIndexHook (50)
- Search: Tantivy (ephemeral, nuke-and-rebuild), `SearchService`, fuzzy page matching
- Sync: Y.Doc authority on server, WebSocket broadcast, sequence numbers, gap fill

**Key terrain**: `src/`, `src-tauri/`, `src-tauri/floatty-core/`, `src-tauri/floatty-server/`, `doors/`

**Rules for the rewrite:**
- Preserve the real task — don't inflate a 10-line fix into a cathedral
- Prefer surgical edits over broad rewrites unless architecture work is explicit
- Use floatty terms: panes, blocks, zoom, childIds, Y.Doc, doors, command bar, metadata extraction, inheritance, search index, focus routing, linked panes
- Don't invent files that might not exist — say "likely in" not "in"
- If the request touches risky systems, name the invariants

**High-risk surfaces** (mention only when relevant to the specific request):

| Surface | What Breaks |
|---------|------------|
| CRDT/Y.Doc sync | Origin filtering gaps → sync loops. Transaction authority violations → stale reads |
| Block tree mutations | Pre-flight validation skipped → orphaned blocks. Delete without descendant check → data loss |
| Focus routing | Dual-focus (two tabIndex) → event bubbling chaos. Stale closures → wrong block targeted |
| Pane drag/drop | Drop zones computed once → stale after resize. Pointer-event interference between overlays |
| HMR cleanup | Module-level state without `import.meta.hot.dispose()` → leaked subscriptions on reload |
| Metadata pipeline | Hook priority ordering matters. `.ok()` swallows errors silently. Inheritance != own markers |
| PTY batching | Sync work in batcher thread → UI freeze. JSON instead of base64 → 40% slower |
| contentEditable | Bare `<br>` not `<div>` wrapping. `Range.toString()` lies about offsets. `isAtStart()` != offset 0 |
| Search index | Standard tokenizer destroys `::` and `[[]]` syntax. Field boost missing → marker matches outrank prose |

## Step 3: Output Format

```markdown
## Improved Prompt
<rewritten engineering prompt — specific, scoped, floatty-native>

## Classification
<type> — <one sentence why>

## Risks / Regression Surfaces
- <specific break risks tied to THIS request, not generic>

## Suggested Validation
- <targeted tests, manual checks, or invariants — proportional to risk>

## Relevant Files
- <only files that materially help execute this task — "likely in" if uncertain>
```

## Anti-Patterns

These make prompts worse, not better:

- **Generic padding**: "ensure proper error handling", "follow best practices" — be specific or omit
- **Scope inflation**: bug fix prompt that includes refactoring suggestions
- **Generic language**: "the application" → "floatty", "the state" → "Y.Doc" or "SolidJS store"
- **Hallucinated files**: if you're not sure it exists, grep first or say "likely in"
- **Ceremony for simple tasks**: don't add phases/milestones to a one-file change
- **Missing "don't"**: sometimes the most valuable part of a prompt is what NOT to touch

## Example

**Input**: "make pane linking more reliable"

**Output**:

### Improved Prompt
Task: Improve reliability of pane linking (Cmd+L) without redesigning the pane/navigation system.

Context: floatty uses multi-pane UI with linked-pane navigation. Cmd+L opens `PaneLinkOverlay` to pick a target outliner pane. Wikilink clicks in source navigate in linked target. Chain: A→B, B→C cascades. Implementation spans `usePaneLinkStore.ts` (link resolution), `PaneLinkOverlay.tsx` (picker UI), `navigation.ts` (unified navigation routing).

Requirements:
- Preserve current interaction model unless change is necessary for reliability
- Surgical fixes, not new abstractions
- Identify root cause(s) before proposing code changes
- Don't regress: command bar navigation, block navigation, terminal→outliner linking

Deliver: root cause analysis → minimal implementation plan → code changes → regression risks → validation

### Classification
debugging — "more reliable" implies current behavior has failure modes that need investigation before fixing

### Risks / Regression Surfaces
- `resolveLink()` in `usePaneLinkStore` may return stale pane references after drag/drop rearrangement
- Focus routing to wrong pane when linked target is inactive or replaced
- Highlight cleanup leaking across panes on failed navigation
- Terminal-originated navigation (via chirp) may bypass link resolution

### Suggested Validation
- Link A→B, navigate repeatedly via wikilink clicks
- Test when target pane is inactive, closed, or replaced by split
- Test terminal→outliner navigation through link chain
- Test after HMR reload (subscription cleanup)

### Relevant Files
- `src/hooks/usePaneLinkStore.ts` — link state, `resolveLink()`
- `src/components/PaneLinkOverlay.tsx` — Cmd+L picker UI
- `src/lib/navigation.ts` — unified navigation routing
- `src/components/BlockDisplay.tsx` — wikilink click handling
