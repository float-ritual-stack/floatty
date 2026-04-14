---
name: floatty-improve-prompt
description: Rewrite rough engineering requests into floatty-specific implementation prompts. Use when the user drops a vague or messy task description and you need to sharpen it before executing — "improve this prompt", "make this clearer", "sharpen this request", or when a request touches multiple floatty subsystems and needs scoping. Also use proactively when a request is ambiguous enough that executing it directly would risk wasted work. Overlaps with util-er (which handles burp→contract routing) but this skill focuses specifically on prompt quality for engineering tasks, not workflow orchestration.
allowed-tools: Read Grep Glob Bash(ls *) Bash(find *) Bash(cat *) Bash(grep *) Bash(test *)
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

## Step -1: Check for Attached Context

Before classifying, check whether the request includes attached material (spec file, PR diff, code snippet, design doc). If so:
- **Read it first** before classifying — classify off the actual scope, not the terse prompt text
- The attached material often reveals the real scope ("implement this" + 500-line spec is architecture, not a one-liner)
- If the attached context contradicts the prompt text, the context wins

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

**Compound requests**: Some requests are genuinely multi-type (e.g., "make doors work with linked panes" = architecture question *and* feature ask). Don't force these into one bucket — name both types and apply both rule sets. The improved prompt should address both concerns explicitly rather than silently dropping one.

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
- **Embed a scope guard in the output prompt**: "Only change what's required for this feature. Don't add configurability, don't clean up surrounding code, don't add comments to unchanged functions. The right amount of complexity is the minimum that makes this work."

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
- **Embed an investigate-first constraint**: "Read the relevant files before proposing changes. Never speculate about code you haven't opened."
- **Embed a commit-to-approach constraint**: "Choose an approach and commit to it. Avoid revisiting decisions unless new information directly contradicts your reasoning."
- **Trigger extended thinking for invariant analysis**: include the keyword "ultrathink" somewhere in the improved prompt. Architecture decisions involving multiple reference patterns or tradeoffs across subsystems benefit measurably from extended thinking — observed in the 2026-04-13 evaluation where a 6-minute "baked" architectural response outperformed all faster responses on invariant analysis. The keyword only activates in Claude Code environments but is harmless elsewhere.
- **Invoke `pattern-fit-check` skill when copying a reference pattern**: if the architecture involves adopting or adapting an existing implementation, call the `pattern-fit-check` skill with the reference and target as arguments. It runs the four-question invariant-match checklist in a fresh Explore subagent.

### debugging
- Start with failure symptoms and repro path
- Identify likely subsystem from symptoms
- Prefer instrumentation/logging/inspection before code changes
- For DOM issues: check via Tauri MCP `webview_execute_js` first
- **Embed an investigate-first constraint in the output prompt**: "Never speculate about code you have not opened. Read the file before answering. Make claims grounded in the actual codebase, not assumptions about what should be there."

### tests
- Define the exact failure mode or invariant being tested
- Scope to narrowest useful coverage
- Store-first testability: test pure logic functions, not DOM

### docs
- Use floatty terminology, not generic descriptions
- Sync with actual architecture (read the code, don't guess)
- Reference specific files and line numbers

## Step 2: Rewrite with Floatty Context

### Pre-rendered codebase state (injected fresh at each invocation)

These listings are rendered before you see this skill (Claude Code's `!command` shell injection, verified working 2026-04-14). They reflect the actual tree at invocation time. Use them as the source of truth for "what files exist." Do NOT cite files not present in these listings without explicit "likely in" hedging.

When emitting the improved prompt, you may reference these listings directly — you saw the real files, not a stale memory. Attribution note: prefer "verified via pre-rendered `ls` at skill invocation" over "from CLAUDE.md" in any downstream-facing hedge, because it is more accurate and the downstream model benefits from knowing the source is fresh.

**Block type union (ts-rs generated — closed set, cannot be extended from TypeScript side alone)**:
```!
cat apps/floatty/src/generated/BlockType.ts 2>/dev/null || echo "(file not found on this branch)"
```

**View-mode components in `src/components/views/`** (each has a different mounting mechanism — do NOT assume they are all `<Show when={block.type === 'X'}>` mounts. Verify in `BlockItem.tsx` before claiming a pattern):

```!
ls apps/floatty/src/components/views/ 2>/dev/null
```

Known mounting mechanisms (verify for any specific component before citing):
- `FilterBlockDisplay` — mounted via `<Show when={block()?.type === 'filter'}>` in `BlockItem.tsx` (the only true `block.type`-mounted sibling view)
- `SearchResultsView`, `ImgView` — mounted via `outputType` dispatch through `BlockOutputView.tsx` (`outputType?.startsWith('search-')`, `outputType === 'img-view'`)
- `DoorHost`, `DoorPaneView`, `IframePaneView` — door rendering + pane-level linked-pane views (different path entirely from block-type sibling views)

The "sibling view mounted via block.type" pattern is real for filter:: but is NOT the only pattern in this directory. Do not generalize.

**Core block components**:
```!
ls apps/floatty/src/components/BlockItem.tsx apps/floatty/src/components/BlockDisplay.tsx apps/floatty/src/components/BlockOutputView.tsx 2>/dev/null
```

**Existing doors** (source convention: `{name}/{name}.tsx` + `door.json`):
```!
ls -d apps/floatty/doors/*/ 2>/dev/null
```

**Rule files** (cite by filename only if present here):
```!
ls .claude/rules/ 2>/dev/null
```

**Architecture docs**:
```!
ls apps/floatty/docs/*.md 2>/dev/null | head -30
```

**Key infrastructure files**:
```!
ls apps/floatty/src/hooks/useBlockStore.ts apps/floatty/src/hooks/useSyncedYDoc.ts apps/floatty/src/lib/blockTypes.ts apps/floatty/src/lib/blockItemHelpers.ts 2>/dev/null
```

---

### Context to reference when writing

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
- **Explain the why behind constraints**: bare prohibitions ("don't touch X") are weaker than explained ones ("don't touch X because Y will break"). Claude generalizes from the reason, not just the rule.
- **Cite search terms, not filenames, for reference implementations you haven't verified.** Filenames in an improved prompt are load-bearing — the downstream model will either defer to them (and cite wrong files) or verify them and over-fit on whatever they find. If you're naming a reference pattern but haven't opened the file in this session, describe it by behavior: "the view-mode block that parses structured data from children — likely in `src/components/views/`, find it before starting" beats "read `TableBlockDisplay.tsx`" when you don't actually know `TableBlockDisplay.tsx` is the real name. Search terms force the downstream model to do discovery and report the real filename in its own verified response.
- **Risks as investigations, not conclusions**: The "Risks / Regression Surfaces" section should name *topics to investigate*, not conclusions the downstream model should restate. "`resolveLink()` may return stale pane references after drag/drop" is a conclusion — the model just files it with a citation. "Pane link resolution during drag/drop: investigate whether `resolveLink()` handles rearrangement correctly" is an investigation — the model has to find the answer. Pointers, not conclusions. If you already know the answer, the downstream model isn't being tested; it's being stenographed.
- **Don't hand out rule numbers as answers**: "Cmd+L linked panes — rule #7 applies" tells the model to file rule #7. "Cmd+L linked panes: determine which `ydoc-patterns.md` rule (if any) applies to the origin-tagging model" forces the model to open the file. Reserve rule-number citations for "Relevant Files" (here is the file to read) — not the prompt body (here is the analysis).
- **Don't pre-enumerate solution spaces.** "Three candidates to evaluate: A, B, C" means the downstream model picks from A, B, C and misses D. Prefer "List the storage approaches this codebase supports for mutable shared state, then pick one and justify." Let the model find options before evaluating them. Name the question, not the answer set.

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

## Step 3: Verify Assertions Before Emitting

Before returning the improved prompt, do a grep pass on your own draft. This step is non-negotiable — the prior version of this skill produced prompts that confidently cited files that didn't exist (e.g., `TableBlockDisplay.tsx` was cited as a real file when the actual pattern lives as a `TableView` function inside `BlockDisplay.tsx`). That cascade hurts downstream work in two directions: models that defer to the hallucinated filename cite wrong files; models that verify the filename discover the wrong reference pattern and over-fit on it.

**Required checks before emitting:**

1. **File paths**: Every file cited in "Relevant Files" or referenced in the prompt body — `ls` or `test -f` it. If you can't verify, downgrade to search-term phrasing ("find the view-mode block in `src/components/views/` that…") or "likely in".

2. **Rule numbers**: Every `#N` citation (e.g., "ydoc-patterns.md #9") — read the rule file and confirm that rule exists and the content matches what you're claiming. If you're naming a rule by number, the downstream model will assume you read it.

3. **Skill references**: `/floatty:classify`, `door-component-development`, etc. — verify via `ls ~/.claude/skills/` or the project's `.claude/` tree. Don't cite a skill you haven't confirmed exists.

4. **Method signatures**: If the prompt mentions `updateBlockMetadata(id, partial, origin)`, grep for the actual signature. Do not assert argument orders from memory.

5. **Self-sniff test**: Re-read the draft with one question — "does this prompt contain the answer?" If a section can be copy-pasted into the final memo with only a citation added, it's an answer. Rewrite as an investigation (see the "Risks as investigations" rule in Step 2).

If any check fails, either fix the assertion or downgrade to hedged phrasing. Don't emit an improved prompt that asserts things you haven't verified — unverified assertions propagate into confident-sounding wrong answers downstream.

### Chain to `verify-citations` for deep verification

For any architecture, feature, or compound prompt that cites multiple files, rule numbers, method signatures, or line numbers, invoke the `verify-citations` skill with the draft as its argument as a final verification pass:

> Invoke the `verify-citations` skill and pass the full draft text as its invocation input. That skill runs in an isolated Explore subagent with a fresh context budget, verifies every claim against the actual codebase, and returns a structured report distinguishing verified / errors / warnings / unverifiable.
>
> (Note for the skill author: do NOT refer to the arguments placeholder by its literal variable name in backticks here — Claude Code's template engine substitutes it literally even inside code spans, producing nonsense output. Describe the behavior, not the variable.)

**When to chain**:
- Architecture or compound-type prompts (always)
- Any prompt citing 3+ specific files
- Any prompt citing rule numbers by number
- Any prompt a downstream model will act on directly without human review

**When to skip the chain**:
- Simple refactor prompts with a single file
- Trivial edits already obvious from context
- Debugging prompts that are pure investigation paths (the downstream model will verify as it reads)

If `verify-citations` reports errors, correct the draft before emitting. If it reports warnings, consider downgrading the flagged claims to hedged phrasing ("likely in" / "investigate whether"). Do NOT emit a draft that failed verification without addressing the findings.

## Step 4: Output Format

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
