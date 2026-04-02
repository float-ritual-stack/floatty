---
name: multi-layer-logging-refactor
description: Workflow command scaffold for multi-layer-logging-refactor in floatty.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /multi-layer-logging-refactor

Use this workflow when working on **multi-layer-logging-refactor** in `floatty`.

## Goal

Migrates multiple layers of the codebase from console.* logging to structured logging using createLogger, often as part of a coordinated refactor across many files and directories.

## Common Files

- `src/lib/logger.ts`
- `eslint.config.js`
- `src/lib/handlers/*.ts`
- `src/lib/handlers/hooks/*.ts`
- `src/hooks/*.ts`
- `src/components/*.tsx`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Implement or update logging utility (e.g., createLogger) in src/lib/logger.ts
- Update ESLint or linting rules to enforce new logging standards (eslint.config.js)
- Refactor batches of related files (e.g., hooks, handlers, UI components) to replace console.* with structured logging
- Update or fix related test files to mock or adapt to the new logging system

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.