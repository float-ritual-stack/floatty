---
description: Release workflow - bump version, update changelog, tag, push, and publish GitHub Release
argument-hint: <patch|minor|major|x.y.z>
allowed-tools: Bash(git *), Bash(pnpm *), Bash(jq *), Bash(date *), Bash(grep *), Bash(gh *), Read, Edit, Write
---

# Floatty Release

Run the full release workflow for floatty.

## Arguments

- `$ARGUMENTS` - Version bump type (`patch`, `minor`, `major`) or explicit version (`0.13.7`)
- Default: `patch` if not specified

## Layout reminder (monorepo)

All version-bearing files live under `apps/floatty/` — NOT the repo root.

| File | Path |
|---|---|
| `package.json` | `apps/floatty/package.json` |
| `Cargo.toml` | `apps/floatty/src-tauri/Cargo.toml` (TWO `version =` lines: `[workspace.package]` + `[package]`) |
| `tauri.conf.json` | `apps/floatty/src-tauri/tauri.conf.json` |
| `CHANGELOG.md` | `apps/floatty/CHANGELOG.md` |

**Use the Edit tool for JSON edits**, NOT `jq … > tmp.json && mv tmp.json file.json`. Edit is atomic, doesn't litter `/tmp`, and produces a clean diff. (`mv -i` was historically aliased here and blocked confirmations; the alias is gone — see `~/.zsh/terminal-qol.zsh` — but the Edit-tool guidance still stands on its own merits.)

## Workflow Steps

### 1. Precondition Checks

Run these checks FIRST, abort if any fail:

```bash
# Must be on main branch (warn if not, ask to continue)
git branch --show-current

# Working tree must be clean
git status --porcelain

# Tests must pass — repo's canonical command (see CLAUDE.md)
pnpm --filter float-pty test
```

### 2. Symmetry / Drift Check (FLO-317)

Before releasing, verify no unguarded path fallbacks or pattern drift.

Run ALL grep patterns AND the release assertions checklist from @.claude/commands/floatty/references/symmetry-check-patterns.md

If any issues found, fix before continuing. This is the "FLO-317 never again" gate.

Scope the check to **this release's diff** (`git diff $(git describe --tags --abbrev=0)..HEAD --stat`) — pre-existing patterns inventoried by the grep are not release blockers; only NEW drifts introduced since the last tag are.

### 3. Determine New Version

```bash
CURRENT=$(jq -r '.version' apps/floatty/package.json)
echo "Current version: $CURRENT"
```

If `$ARGUMENTS` is `patch`/`minor`/`major`, calculate the bump:
- `patch`: 0.13.6 → 0.13.7
- `minor`: 0.13.6 → 0.14.0
- `major`: 0.13.6 → 1.0.0

If `$ARGUMENTS` is explicit (like `0.14.0`), use that.

### 4. Generate Changelog Entry

Get commits since last tag:

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline --no-merges
```

Read recent CHANGELOG entries to match format:

```bash
head -40 apps/floatty/CHANGELOG.md
```

Standard sections (omit unused): `### ✨ Features` / `### 🐛 Fixes` / `### 📝 Docs` / `### 🧪 Tests`. Each release opens with a 2–4 sentence narrative paragraph naming the user-visible symptom in plain language. Bullets carry `(commit-sha / [[PR #N]] / [[FLO-N]] — file paths)` refs.

**IMPORTANT**: Show the proposed changelog entry to the user and ask for approval before proceeding.

### 5. Update Version Numbers (use Edit tool, NOT jq+mv)

Update ALL version locations:

**`apps/floatty/package.json`** — single `"version": "..."` line. Use Edit tool with the exact old→new string.

**`apps/floatty/src-tauri/Cargo.toml`** — TWO `version = "..."` lines (`[workspace.package]` and `[package]`). Use Edit tool with `replace_all: true` since both are the same pre-bump string.

**`apps/floatty/src-tauri/tauri.conf.json`** — single `"version": "..."` line at top level. Use Edit tool.

**`apps/floatty/src-tauri/Cargo.lock`** — sync after the manifest change so the locked workspace versions match. Run from the workspace root:

```bash
(cd apps/floatty/src-tauri && cargo update --workspace)
```

`cargo update --workspace` targets the workspace packages' versions; per Cargo docs and known issues (rust-lang/cargo#5530, #16926, #12599) the resolver may also touch transitive entries during the dependency-graph re-resolution, so review the diff before staging. Without this step, `Cargo.lock` keeps the old workspace versions and any subsequent `cargo build` produces a dirty working tree on a fresh checkout of the tag — see drift history below.

**`apps/floatty/CHANGELOG.md`** — prepend the new release section (see step 6).

After all edits, verify they synced:

```bash
echo "package.json:        $(jq -r '.version' apps/floatty/package.json)"
echo "tauri.conf.json:     $(jq -r '.version' apps/floatty/src-tauri/tauri.conf.json)"
echo "Cargo.toml count:    $(grep -c "^version = \"$NEW_VERSION\"" apps/floatty/src-tauri/Cargo.toml) (expected 2)"
echo "Cargo.lock count:    $(grep -A1 'name = "float-pty"\|name = "floatty-server"' apps/floatty/src-tauri/Cargo.lock | grep -c "version = \"$NEW_VERSION\"") (expected 2)"
grep "^## \[$NEW_VERSION\]" apps/floatty/CHANGELOG.md
```

### 6. Update CHANGELOG.md

Insert the new entry between `## [Unreleased]` and the previous release section. Use today's date:

```bash
date "+%Y-%m-%d"
```

Format header: `## [x.y.z] - YYYY-MM-DD`. Use the canonical narrative+sections shape per step 4.

### 7. Create Release Commit

```bash
git add apps/floatty/package.json \
        apps/floatty/src-tauri/Cargo.toml \
        apps/floatty/src-tauri/Cargo.lock \
        apps/floatty/src-tauri/tauri.conf.json \
        apps/floatty/CHANGELOG.md
git commit -m "chore: release v$NEW_VERSION — <one-line headline matching CHANGELOG narrative>"
```

### 8. Create Annotated Tag (with substantive body)

```bash
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION

<2-4 sentence narrative summary of the release>

<bullet list of major changes — same shape as CHANGELOG bullets but compressed>

<refs to PRs / Linear issues>"
```

The body matters: step 10 reads it back via `gh release create --notes-from-tag` to populate the GitHub Release page. Don't ship a bare `-m "Release vX.Y.Z"` — that produces an empty Release page.

### 9. Push (requires explicit user approval)

```bash
git push origin main --tags
```

Ask the user before pushing. Show: version old→new, commit hash, tag, files changed.

### 10. Publish GitHub Release (optional — ask user)

After the push lands, offer to publish a GitHub Release page from the annotated tag:

```bash
gh release create v$NEW_VERSION \
  --notes-from-tag \
  --title "v$NEW_VERSION — <one-line headline>"
```

Verify:

```bash
gh release view v$NEW_VERSION --json url,publishedAt,name | jq
```

Notes:

- `--notes-from-tag` reads the annotated tag's body (step 8). Bare-tag annotations produce empty Release pages — that's why step 8 mandates a substantive body.
- This step is OPTIONAL. Floatty's published-Release history is sparse (latest published Release was `v0.2.3` in Jan 2026 before today's `v0.13.7`); pushing the tag alone is the established convention. Publish the Release page when the user wants the surface for sharing/distribution; skip it otherwise.

### 11. Summary & Next Steps

Show in final response:
- Version: old → new
- Files changed (list)
- Commit hash
- Tag created
- Pushed: yes/no
- GitHub Release published: yes/no (with URL if yes)

## Important Notes

- **Never push without explicit user confirmation** (step 9 is a gate).
- **Never publish a GitHub Release without explicit user confirmation** (step 10 is also a gate).
- If anything fails mid-workflow, show what was done and what remains. Partial state is fine; resume by running the failing step manually.
- The changelog entry should be substantive — don't just list commits, group and describe meaningfully. Prose-readable narrative paragraph + categorized bullets with file:commit refs.
- Annotated tag body and CHANGELOG entry should be the same content, lightly compressed for the tag.
- The release is local-only until step 9. Step 10 doesn't fire without step 9.

## Drift history (so we don't relearn)

These have been wrong in past versions of this skill — fix-on-sight if any future drift returns:

- Paths that omit `apps/floatty/` prefix (pre-monorepo layout)
- `sed -i ''` for Cargo.toml versions (only catches first `version =` line; misses `[workspace.package]`)
- `npm run test -- --run` (wrong tool + wrong flag; canonical is `pnpm --filter float-pty test`)
- `jq … > tmp.json && mv tmp.json …` for JSON edits — use the Edit tool instead (atomic, clean diff)
- Bare `-m "Release vX.Y.Z"` tag bodies (breaks `--notes-from-tag` for GitHub Release)
- Missing GitHub Release step entirely
- Missing `Cargo.lock` sync (released v0.13.7 with manifest at 0.13.7, lockfile still at 0.13.6 — fresh checkout produces dirty working tree on first `cargo build`)
