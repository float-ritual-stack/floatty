---
name: verify-citations
description: Verify that every file path, rule number, method signature, line number, and API claim in a draft prompt, design memo, or architectural plan actually matches the codebase. Invoke before emitting any artifact that cites specific files or rule numbers. Runs in a fresh Explore subagent so the verification tool calls do not pollute the parent conversation.
context: fork
agent: Explore
allowed-tools: Read Grep Glob Bash(ls *) Bash(find *) Bash(cat *) Bash(grep *) Bash(test *) Bash(wc *)
---

# Verify Citations

You have been forked into an isolated Explore subagent. Your task is to verify every assertion in the draft below against the actual codebase. Do not propose improvements to the draft itself — only report what is verified, what is missing, and what is wrong.

## Draft to verify

$ARGUMENTS

## Verification protocol

For every claim in the draft, run the appropriate check.

### 1. File paths

For each file cited (e.g., `apps/floatty/src/components/Foo.tsx`):

- Run `ls` or `test -f` to confirm existence
- If the claim includes a line number (`Foo.tsx:123`), read that line range and confirm the content matches what the draft says is there
- If the filename looks plausible but does not exist, search for near-matches via `find` or Glob with a partial name — a fabrication often differs from the real file by one token

### 2. Rule numbers

For each `<rule-file>.md #N` citation:

- Read the rule file from `.claude/rules/`
- Confirm rule #N exists (some files skip numbers)
- Confirm the content the draft summarizes matches what the rule actually says — not just that the heading exists

### 3. Method signatures

For each cited function signature (e.g., `updateBlockMetadata(id, partial, origin)`):

- Grep the actual source for the function definition
- Compare argument names, types, and default values
- Flag if argument order, argument count, or defaults are wrong

### 4. Enum values and type unions

For each cited enum member (e.g., `Origin::System`) or type union value (e.g., `BlockType = 'poll'`):

- Read the actual Rust source or generated TS file
- Confirm the variant exists
- If the draft claims a variant does NOT exist, grep to confirm absence (negative verification matters as much as positive)

### 5. API behavioral claims

For each claim about how an API behaves (e.g., "updateBlockMetadata does a shallow merge at line 1898"):

- Read the cited implementation
- Confirm the behavior matches the description
- Shallow/deep, sync/async, field-level/object-level — these are the details that drift

### 6. Cross-references

For each skill-reference, command-reference, or inter-doc link:

- Confirm the referenced skill exists (`ls ~/.claude/skills/` or `ls .claude/skills/`)
- Confirm the referenced command exists (`ls .claude/commands/`)
- Confirm the referenced doc file exists

## Output format

```markdown
## Verification Report

### Verified ✅
- `apps/floatty/src/lib/blockTypes.ts:119` — `parseBlockType()` exists, returns BlockType union
- `ydoc-patterns.md #9` — content matches draft description
- `updateBlockMetadata(id, partial, origin)` — signature verified at `useBlockStore.ts:1887`

### Errors ❌
- `TableBlockDisplay.tsx` — file does NOT exist. Closest match: `TableView` function inside `BlockDisplay.tsx:277`. Draft should cite the real location.
- `Origin::System` — variant does NOT exist in `origin.rs`. Valid variants: `User, Hook, Remote, Agent, BulkImport`. Draft should remove this citation or substitute `Origin::Hook` if the intent was "skip hook processing."

### Warnings ⚠️
- `BlockItem.tsx:~888` — line drift. FilterBlockDisplay mount is actually at line 1072. Draft should update the line number.
- `/floatty:classify` — exists as a slash command but uses H/H/P/R taxonomy, not the Pattern A/B taxonomy used in BLOCK_TYPE_PATTERNS.md. Draft should clarify which taxonomy is meant.

### Unverifiable (deferred)
- Runtime behavior claims that require executing the code
- Claims about UI behavior that require browser state
- Claims about future-proofing or design intent that are not in the code
```

## Constraints

- Do NOT emit a corrected draft. Your output is a structured report, not a rewrite. The parent session owns the correction.
- Do NOT speculate about claims you cannot verify. Mark them "unverifiable (deferred)".
- Do NOT fall back to pattern-matching against what "should" be true. Read the actual file.
- If a claim cites a line number that is off by a few lines due to recent edits, report the drift and the correct location.
- If you cannot find a file or function the draft cites, do one follow-up search (with wildcards or partial name) before reporting "not found."
- Prefer the project tree under `apps/floatty/` for this codebase. If a claim uses a bare path (e.g., `src/lib/foo.ts`), check both `apps/floatty/src/lib/foo.ts` and `src/lib/foo.ts` before declaring it missing.

## Why this skill exists

The 2026-04-13 six-run AI tool evaluation on the `poll::` block design task showed that every model made at least one confident assertion about a file or function that did not exist or did not match the code. Prose instructions to "verify before emitting" were unreliable. This skill moves verification from prose guardrails in the parent skill to an isolated verification pass that structurally cannot skip the checks.

The fork into Explore context means the verification tool calls (Read, Grep, ls) do not pollute the parent conversation's context budget. The parent only sees the structured verification report.

ultrathink
