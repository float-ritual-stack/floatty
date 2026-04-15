---
paths:
  - ".claude/skills/**/SKILL.md"
  - "apps/floatty/src/components/views/**/*.tsx"
  - "apps/floatty/src/hooks/useBlockStore.ts"
  - "apps/floatty/src/components/BlockItem.tsx"
  - "apps/floatty/src/lib/handlers/**/*.ts"
---

# Pattern Fit Check

Meta-rule for adopting reference implementations. When you find a reference pattern to copy, verification ("this file exists, this function does what I think") is necessary but not sufficient. The missing step is **asking whether the pattern's invariants match your problem's invariants** before copying it.

**Active version**: for structured invariant analysis, invoke the `pattern-fit-check` skill (not this rule file). The skill runs in an isolated Explore subagent with extended thinking. This rule file is the passive version — auto-attached via the `paths:` frontmatter when editing matching files, so the "check invariants before copying" reflex is in your context when you need it.

## Why This Rule Exists

Derived from a six-run AI tool comparison on a `poll::` block design task (2026-04-13). Claude Code correctly discovered that `TableView` (inside `BlockDisplay.tsx`) parses rows inline from content rather than using child blocks. It then copied the parse-from-content pattern for polls. The copy failed because:

- **Tables protect the invariant**: "rows are positional, nothing references them externally"
- **Polls require the invariant**: "options have stable identifiers, votes reference them and must survive renames"

These invariants conflict. Tables don't need stable row IDs (nothing persists references to rows). Polls do (votes persist references to options). The reference pattern was correctly identified but incorrectly generalized. A single "check the invariants" step before copying would have caught the mismatch.

Gitinspect in the same comparison cited a hallucinated filename (`TableBlockDisplay.tsx` — doesn't exist) but reasoned about the filter:: pattern instead. It accidentally landed on the correct design because filter:: uses child blocks whose block IDs are stable by construction. The "worse verification" produced the right design because the pattern it imitated fit the problem.

**Lesson**: verification of "is this the real file" and verification of "does this pattern fit my problem" are different checks. Skip either and you ship wrong.

## The Checklist

Before adopting any reference implementation as a template, answer these four questions in writing (even informally). If any answer is unclear, read more code or pick a different reference.

### 1. What invariants does the reference pattern protect?

State them explicitly. Not "TableView is a good pattern for display blocks" — that's a description, not an invariant. An invariant is a constraint the pattern guarantees to uphold:

- TableView: "Rows have no stable identity; position is identity. Reordering rows changes which data is which. Nothing external can reference a specific row across edits."
- FilterBlockDisplay: "Children have stable block UUIDs. The filter re-evaluates reactively when children change. External references to children (if any) survive child renames because block IDs are immutable."
- SearchResultsView: "Display-only. Parent owns keyboard focus. Visual state flows through props. No internal mutation."
- TableView keyboard handling (the exception): "Internal editable cells require internal focus. `onNavigateOut` callback for boundary crossings."

If you can't articulate the invariants of your reference in one sentence each, you don't understand the reference well enough to copy it.

### 2. What invariants does your problem require?

State your problem's requirements as invariants. Not "the poll should show a bar chart" — that's a feature. Invariants are what must remain true regardless of implementation detail:

- Poll options: "Options have stable identifiers across renames. Votes persist references to options; votes must remain valid when an option's display text changes."
- Poll votes: "Votes survive across reload and sync to other clients. Concurrent votes from different users resolve deterministically. A user's second vote overwrites their first, not accumulates."
- Poll rendering: "Click-to-vote mutates state. Parent block keeps contentEditable for editing the poll question."

### 3. Do the reference's invariants cover your problem's requirements?

Compare the two lists. For each requirement, identify which reference invariant protects it, OR note that no reference invariant covers it.

Example for poll::-via-TableView:
- "Stable option identifiers across renames" → ❌ TableView explicitly does NOT protect this; rows are positional
- "Click-to-vote mutates state" → ✅ TableView handles click-to-edit similarly
- "Parent keeps contentEditable for editing question" → ❌ Wait, TableView replaces contentEditable when the table renders. Different shape.

Two mismatches → TableView is the wrong reference. Pick differently.

Example for poll::-via-FilterBlockDisplay:
- "Stable option identifiers across renames" → ✅ Child block UUIDs are stable, votes keyed by child ID survive renames
- "Click-to-vote mutates state" → ~ FilterBlockDisplay has click-to-navigate, not click-to-mutate. Partial fit. Compensation: wire click handler to `updateBlockMetadata` instead of `navigateToBlock`.
- "Parent keeps contentEditable for editing question" → ✅ Filter blocks keep contentEditable; view renders alongside

One partial + two full → FilterBlockDisplay is the correct reference, with one named compensation.

### 4. If the reference is a partial fit, what compensations are needed?

A partial fit is acceptable *if* you name the compensations explicitly. Unnamed compensations leak as bugs three weeks later when someone else assumes the full pattern applies.

For poll::-via-FilterBlockDisplay, the one compensation:

- "FilterBlockDisplay navigates on click; PollBlockDisplay must mutate metadata on click. Wire click handler through `castVote(blockId, optionId, voterId)` helper (new) that wraps `updateBlockMetadata` with `origin: 'user'` and preserves sibling metadata fields via deep-merge (see `ydoc-patterns.md` rule #9 for shallow-merge caveat)."

Now the compensation is discoverable to future readers.

## When To Apply This Rule

- **Before writing a new block type, door, hook, or any component that copies a reference implementation.**
- **During code review** when a diff says "following pattern X" — ask the reviewer to list the invariants of X and the requirements of the new code.
- **When an AI tool suggests "this should work like Y"** — apply the checklist to Y before accepting the suggestion.
- **When reading a design memo** that anchors on a specific reference — check whether the memo addresses invariant fit, or just asserts pattern match.

## Anti-Patterns This Rule Catches

- **Pattern match by name**: "It's a view-mode block → use view-mode block pattern." Names don't carry invariants. `TableView` and `FilterBlockDisplay` are both "view-mode blocks" and protect different invariants.
- **Verification without generalization check**: Reading the reference carefully, correctly noting "this is what it does," then copying it without asking if its constraints fit your problem.
- **First-reference anchoring**: Adopting the first reference you find because it's the first reference you find. If you have time to read one reference, you have time to read two and compare.
- **Invariants as vibes**: "It's a display-only component" is not an invariant. "The component never calls setBlockContent or updateBlockMetadata; all state is read-only from props" is an invariant.

## Reference To This Rule

Files that should link here:

- `.claude/skills/floatty-improve-prompt/SKILL.md` — when the improver recommends a reference pattern, it should pass through this check
- `door-component-development` skill (installed globally at `~/.claude/skills/door-component-development/`) — when copying an existing door, run this check
- `.claude/commands/floatty/classify.md` — after classifying as Handler/Hook/Projection/Renderer, apply this before picking a specific reference
- `apps/floatty/docs/BLOCK_TYPE_PATTERNS.md` — when adding a new block type, this check is between "find reference" and "write code"

## The Short Version

Before you copy a pattern, write down:
1. What invariants does the pattern protect?
2. What invariants does my problem need?
3. Do they match?
4. If partial match, what am I compensating for?

Four sentences. Saves you a week.
