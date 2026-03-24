---
name: release-version-bump
description: Workflow command scaffold for release-version-bump in floatty.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /release-version-bump

Use this workflow when working on **release-version-bump** in `floatty`.

## Goal

Prepares and publishes a new release version, updating changelog and version numbers across package and config files.

## Common Files

- `CHANGELOG.md`
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Update CHANGELOG.md with release notes.
- Update package.json version.
- Update src-tauri/Cargo.toml and/or Cargo.lock with new version.
- Update src-tauri/tauri.conf.json as needed.
- Commit all changes with a 'chore: release vX.Y.Z' message.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.