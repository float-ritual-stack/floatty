---
description: Release workflow - bump version, update changelog, tag, and optionally push
argument-hint: <patch|minor|major|x.y.z>
allowed-tools: Bash(git *), Bash(npm *), Bash(cargo *), Bash(jq *), Bash(sed *), Bash(date *), Read, Edit, Write
---

# Floatty Release

Run the full release workflow for floatty.

## Arguments

- `$ARGUMENTS` - Version bump type (`patch`, `minor`, `major`) or explicit version (`0.4.0`)
- Default: `patch` if not specified

## Workflow Steps

### 1. Precondition Checks

Run these checks FIRST, abort if any fail:

```bash
# Must be on main branch (warn if not, ask to continue)
git branch --show-current

# Working tree must be clean
git status --porcelain

# Tests must pass
npm run test -- --run
```

### 2. Determine New Version

Get current version and calculate new:

```bash
# Current version from package.json
CURRENT=$(jq -r '.version' package.json)
echo "Current version: $CURRENT"
```

If `$ARGUMENTS` is `patch`/`minor`/`major`, calculate the bump:
- `patch`: 0.3.0 → 0.3.1
- `minor`: 0.3.0 → 0.4.0
- `major`: 0.3.0 → 1.0.0

If `$ARGUMENTS` is explicit (like `0.4.0`), use that.

### 3. Generate Changelog Entry

Get commits since last tag:

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline --no-merges
```

Create a changelog entry following the existing format in CHANGELOG.md:
- Group by category (Features, Bug Fixes, Documentation, etc.)
- Reference PR numbers and issue numbers where available
- Use past tense ("Added", "Fixed", "Updated")

**IMPORTANT**: Show the proposed changelog entry to the user and ask for approval before proceeding.

### 4. Update Version Numbers

Update ALL version locations (there are THREE):

```bash
# package.json
jq --arg v "$NEW_VERSION" '.version = $v' package.json > tmp.json && mv tmp.json package.json

# src-tauri/Cargo.toml (first version = line)
sed -i '' "s/^version = \".*\"/version = \"$NEW_VERSION\"/" src-tauri/Cargo.toml

# src-tauri/tauri.conf.json (CRITICAL: macOS app version comes from here)
jq --arg v "$NEW_VERSION" '.version = $v' src-tauri/tauri.conf.json > tmp.json && mv tmp.json src-tauri/tauri.conf.json

# Verify ALL THREE are updated
echo "Updated versions:"
echo "package.json:        $(jq -r '.version' package.json)"
echo "Cargo.toml:          $(grep '^version' src-tauri/Cargo.toml | head -1 | cut -d'"' -f2)"
echo "tauri.conf.json:     $(jq -r '.version' src-tauri/tauri.conf.json)"
```

### 5. Update CHANGELOG.md

Prepend the new entry after the header, using today's date:

```bash
date "+%Y-%m-%d"
```

Format: `## [x.y.z] - YYYY-MM-DD`

### 6. Create Release Commit

```bash
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json CHANGELOG.md
git commit -m "chore: release v$NEW_VERSION"
```

### 7. Create Git Tag

```bash
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
```

### 8. Summary & Next Steps

Show:
- Version: old → new
- Files changed
- Commit hash
- Tag created

Ask if user wants to push:
```bash
git push origin main --tags
```

## Important Notes

- Never push without explicit user confirmation
- If anything fails mid-workflow, show what was done and what remains
- The changelog entry should be substantive - don't just list commits, group and describe meaningfully
