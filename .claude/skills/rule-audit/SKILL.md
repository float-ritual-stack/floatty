---
name: rule-audit
description: Audit .claude/rules/ files for broken citations. Walks every rule file, extracts cited file paths and line number references from the body, verifies each against the actual codebase, and reports drift. Use periodically or before merging PRs that touch rule files — catches rule-file rot before it propagates into improved prompts and downstream work.
allowed-tools: Bash(python3 *) Read
---

# Rule File Audit

Walks `.claude/rules/` and verifies every citation against the actual codebase. Reports broken file paths and stale line numbers. Runs a bundled Python script with stdlib only — no dependencies.

## Usage

From the project root:

```bash
python3 .claude/skills/rule-audit/scripts/audit.py
```

Outputs a markdown report to stdout. Pipe to a file, paste into a PR comment, or post to the sysops-log board as needed.

## What it checks

- **File paths in rule bodies**: backtick-wrapped paths like `src/foo.ts` or `apps/floatty/src/hooks/useBlockStore.ts` are checked against the filesystem
- **Line number citations**: `file.ts:123` is flagged if the file is shorter than 123 lines (off-by-many drift catchable without reading)
- **Line range citations**: `file.ts:100-150` is flagged if the range exceeds the file length
- **Near-match suggestions**: when a cited path does not exist, the script searches for files with the same basename and suggests alternatives

## When to run

- Before merging a PR that adds or edits rule files
- Periodically (weekly or monthly) to catch drift in existing rules
- After large refactors that move files — likely to break citations
- When an improved prompt references a rule file and fails verification

## Why this exists

The 2026-04-13 evaluation revealed that rule files and improved prompts frequently cite files that do not exist, or file locations that have drifted. Prose guardrails ("verify before citing") did not prevent the hallucinations in practice. This script is the mechanical fallback: run it periodically to catch rot before the citations propagate through the improver into downstream work.

## Limitations

- Heuristic extraction — may miss exotic citation formats (e.g., markdown links, multi-line paths)
- Cannot verify that cited line content actually matches what the rule claims is there (that requires diffing against a snapshot)
- False positives on example/pseudocode paths that are not meant to be real — the script tries to filter these but some may slip through
- Does not check rule-number cross-references (`ydoc-patterns.md #9`) — that would require parsing rule file structure to count headings

## Example output

```markdown
# Rule File Audit Report

Audited 16 rule files.

**Total citations**: 143
**Missing files**: 2
**Line-number drift**: 1

## output-block-patterns.md

21 citations; 1 missing, 0 drift

### ❌ Missing
- `src/components/SearchResultsView.tsx` — not at `src/components/SearchResultsView.tsx`, but exists at: `apps/floatty/src/components/views/SearchResultsView.tsx`

## adding-block-types.md

15 citations; 1 missing, 1 drift

### ❌ Missing
- `src/components/TableBlockDisplay.tsx` — no file found with this name

### ⚠️ Line drift
- `BlockItem.tsx:888` — cites line 888 but file only has 1150 lines (likely stale after refactor; verify manually)
```
