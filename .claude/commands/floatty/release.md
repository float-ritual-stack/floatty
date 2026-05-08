---
description: Release workflow - bump version, update changelog, tag, push, and publish GitHub Release
argument-hint: <patch|minor|major|x.y.z>
allowed-tools: Bash(git *), Bash(pnpm *), Bash(jq *), Bash(date *), Bash(grep *), Bash(gh *), Read, Edit, Write
---

# Floatty Release

Run the full release workflow for floatty.

**One gate**: changelog approval. After that, ship end-to-end (version bumps, commit, tag, push, GitHub Release) in a single motion. The push and GitHub-Release steps are predictable yes-es when the changelog is right; gating them is theater.

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

**Use the Edit tool for JSON edits**, NOT `jq … > tmp.json && mv tmp.json file.json`. Edit is atomic, doesn't litter `/tmp`, and produces a clean diff.

---

## Phase 1 — Silent prep (no user interaction)

Run all of these without prompting; abort only if something fails.

### 1a. Preconditions

```bash
git branch --show-current        # must be main (warn-and-continue if not)
git status --porcelain           # must be clean (untracked harness files like .claude/scheduled_tasks.lock are OK)
pnpm --filter float-pty test     # must pass
```

### 1b. Drift check (FLO-317) — scoped to release diff only

Pre-existing patterns aren't release blockers; only NEW drifts since the last tag are. Run each grep against the release diff:

```bash
LAST_TAG=$(git describe --tags --abbrev=0)
git diff $LAST_TAG..HEAD apps/floatty/src-tauri/ -- '*.rs' | grep -E '^\+.*\.join\(".floatty'           # hardcoded paths
git diff $LAST_TAG..HEAD apps/floatty/src-tauri/ -- '*.rs' | grep -E '^\+.*(data_dir|config_path|default_.*path)'
git diff $LAST_TAG..HEAD apps/floatty/src/ -- '*.ts' '*.tsx' | grep -E '^\+(let |const.*= new )'        # module-level state
git diff $LAST_TAG..HEAD apps/floatty/src/ | grep -E '^\+.*blockEventBus\.subscribe'                   # new subscribers
git diff $LAST_TAG..HEAD apps/floatty/src/hooks/useBlockStore.ts | grep -E '^\+.*(removeChildId|rootIds\.delete)'
```

Reference: `@.claude/commands/floatty/references/symmetry-check-patterns.md` for the full pattern catalog. If any release-diff hit surfaces a real issue, abort before phase 2.

### 1c. Determine new version

```bash
CURRENT=$(jq -r '.version' apps/floatty/package.json)
```

If `$ARGUMENTS` is `patch`/`minor`/`major`, calculate the bump. If explicit (`0.14.0`), use that.

### 1d. Gather changelog raw material

```bash
git log $LAST_TAG..HEAD --oneline --no-merges     # commits in scope
git diff $LAST_TAG..HEAD --stat                   # file scope
head -90 apps/floatty/CHANGELOG.md                # format reference (read recent entries)
```

### 1e. Draft the changelog entry

Standard sections (omit unused): `### ✨ Features` / `### ✨ Performance` / `### 🐛 Fixes` / `### ♻️ Refactors` / `### 📝 Docs` / `### 🧪 Tests`.

Each release opens with a **2-4 sentence narrative paragraph naming the user-visible symptom in plain language** — not "we did X" but "this fixes Y." Bullets carry `(commit-sha / [[PR #N]] / [[FLO-N]] — file paths)` refs. Group meaningfully — don't just list commits.

---

## Phase 2 — The single gate

Show the proposed changelog entry to the user with this framing:

> **Any changes to the changelog? Otherwise shipping end-to-end (version bumps → commit → tag → push → GitHub Release).**

Iteration is fine: if the user wants edits, apply them and re-ask. Once the user approves (or says "looks good" / "ship it" / similar), proceed to phase 3 without further gates.

If the user explicitly opts out of push or GitHub Release ("hold off on the push" / "skip the release page"), respect that — but don't ask preemptively. The default is end-to-end.

---

## Phase 3 — Ship end-to-end (one motion, no further gates)

After phase-2 approval, execute steps 3a–3g in a single batch.

### 3a. Update version files

| File | Approach |
|---|---|
| `apps/floatty/package.json` | `Edit` tool — single `"version": "..."` line |
| `apps/floatty/src-tauri/Cargo.toml` | `Edit` tool with `replace_all: true` — TWO `version = "..."` lines (workspace.package + package) |
| `apps/floatty/src-tauri/tauri.conf.json` | `Edit` tool — single `"version": "..."` line |

### 3b. Sync Cargo.lock

```bash
(cd apps/floatty/src-tauri && cargo update --workspace)
```

Without this, `Cargo.lock` keeps the old workspace versions and a fresh checkout of the tag produces a dirty working tree on first `cargo build` (drift caught in v0.13.7).

### 3c. Update CHANGELOG.md

Prepend the approved phase-2 entry between `## [Unreleased]` and the previous release section. Header: `## [x.y.z] - YYYY-MM-DD` (use `date "+%Y-%m-%d"`).

### 3d. Verify all 5 locations synced

```bash
echo "package.json:        $(jq -r '.version' apps/floatty/package.json)"
echo "tauri.conf.json:     $(jq -r '.version' apps/floatty/src-tauri/tauri.conf.json)"
echo "Cargo.toml count:    $(grep -c '^version = \"$NEW_VERSION\"' apps/floatty/src-tauri/Cargo.toml) (expected 2)"
echo "Cargo.lock float-pty:    $(grep -A1 '^name = \"float-pty\"$' apps/floatty/src-tauri/Cargo.lock | grep '^version')"
echo "Cargo.lock floatty-server: $(grep -A1 '^name = \"floatty-server\"$' apps/floatty/src-tauri/Cargo.lock | grep '^version')"
grep "^## \[$NEW_VERSION\]" apps/floatty/CHANGELOG.md
```

### 3e. Commit

```bash
git add apps/floatty/package.json \
        apps/floatty/src-tauri/Cargo.toml \
        apps/floatty/src-tauri/Cargo.lock \
        apps/floatty/src-tauri/tauri.conf.json \
        apps/floatty/CHANGELOG.md
git commit -m "chore: release v$NEW_VERSION — <one-line headline matching CHANGELOG narrative>"
```

### 3f. Annotated tag (substantive body)

The body matters — `gh release create --notes-from-tag` reads it back to populate the GitHub Release page. Bare `-m "Release vX.Y.Z"` produces empty Release pages.

```bash
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION

<2-4 sentence narrative summary of the release>

<bullet list of major changes — same shape as CHANGELOG bullets but compressed>

<refs to PRs / Linear issues>"
```

### 3g. Push + GitHub Release (no gate — phase 2 already approved)

```bash
git push origin main --tags
gh release create v$NEW_VERSION \
  --notes-from-tag \
  --title "v$NEW_VERSION — <one-line headline>"
gh release view v$NEW_VERSION --json url,publishedAt,name | jq
```

---

## Final report

After phase 3 completes, emit:

- Version: old → new
- Files changed
- Commit hash
- Tag SHA + push status
- GitHub Release URL

That's it. The release is live.

---

## Important notes

- **One gate** (phase 2 — changelog approval). After that, end-to-end. Don't gate push or GitHub Release separately — those are predictable yes-es.
- The changelog entry should be substantive — narrative paragraph + categorized bullets with file:commit refs. Don't just list commits.
- Annotated tag body and CHANGELOG entry should be the same content, lightly compressed for the tag.
- If anything fails mid-phase-3, show what was done and what remains. Partial state is fine; resume by running the failing step manually. Don't auto-rollback.
- User can opt out of push or GitHub Release if they explicitly say so — but ask once at the changelog gate, not separately at each step.

## Drift history (so we don't relearn)

These have been wrong in past versions of this skill — fix-on-sight if any future drift returns:

- Paths that omit `apps/floatty/` prefix (pre-monorepo layout)
- `sed -i ''` for Cargo.toml versions (only catches first `version =` line; misses `[workspace.package]`)
- `npm run test -- --run` (wrong tool + wrong flag; canonical is `pnpm --filter float-pty test`)
- `jq … > tmp.json && mv tmp.json …` for JSON edits — use the Edit tool instead (atomic, clean diff)
- Bare `-m "Release vX.Y.Z"` tag bodies (breaks `--notes-from-tag` for GitHub Release)
- Missing GitHub Release step entirely
- Missing `Cargo.lock` sync (released v0.13.7 with manifest at 0.13.7, lockfile still at 0.13.6 — fresh checkout produces dirty working tree on first `cargo build`)
- **Multi-gate theater**: separate approval prompts for push and GitHub Release after the changelog was already approved. v0.14.1 release surfaced this — the answer is always yes after the changelog is right. One gate, end-to-end.
