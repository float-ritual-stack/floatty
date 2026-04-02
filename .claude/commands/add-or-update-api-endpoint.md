---
name: add-or-update-api-endpoint
description: Workflow command scaffold for add-or-update-api-endpoint in floatty.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-or-update-api-endpoint

Use this workflow when working on **add-or-update-api-endpoint** in `floatty`.

## Goal

Implements or updates a backend API endpoint, updates API documentation, and may add supporting helpers or fix related tests.

## Common Files

- `src-tauri/floatty-server/src/api.rs`
- `.claude/rules/api-reference.md`
- `src-tauri/floatty-core/src/hooks/`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit or add endpoint handler in src-tauri/floatty-server/src/api.rs
- Update .claude/rules/api-reference.md with new endpoint documentation
- Optionally update or create supporting logic in src-tauri/floatty-core/src/hooks/
- Optionally fix or improve related tests

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.