---
name: release-workflow
description: Workflow command scaffold for release-workflow in floatty.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /release-workflow

Use this workflow when working on **release-workflow** in `floatty`.

## Goal

Prepares and publishes a new release version, including updating version numbers, changelogs, and configuration files.

## Common Files

- `package.json`
- `CHANGELOG.md`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update package.json version and dependencies.
- Update src-tauri/Cargo.toml and tauri.conf.json with new version.
- Update (or add to) CHANGELOG.md with release notes.
- Commit all updated files with a release message.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.