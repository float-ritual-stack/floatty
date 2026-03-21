---
name: floatty-conventions
description: Development conventions and patterns for floatty. TypeScript Vite project with conventional commits.
---

# Floatty Conventions

> Generated from [float-ritual-stack/floatty](https://github.com/float-ritual-stack/floatty) on 2026-03-21

## Overview

This skill teaches Claude the development patterns and conventions used in floatty.

## Tech Stack

- **Primary Language**: TypeScript
- **Framework**: Vite
- **Architecture**: type-based module organization
- **Test Location**: colocated
- **Test Framework**: vitest

## When to Use This Skill

Activate this skill when:
- Making changes to this repository
- Adding new features following established patterns
- Writing tests that match project conventions
- Creating commits with proper message format

## Commit Conventions

Follow these commit message conventions based on 200 analyzed commits.

### Commit Style: Conventional Commits

### Prefixes Used

- `fix`
- `feat`
- `chore`
- `docs`
- `release`
- `refactor`

### Message Guidelines

- Average message length: ~60 characters
- Keep first line concise and descriptive
- Use imperative mood ("Add feature" not "Added feature")


*Commit message example*

```text
chore: release v0.9.7
```

*Commit message example*

```text
docs: changelog for v0.9.7
```

*Commit message example*

```text
fix(collapse-nav): C.3 review fixes — HMR dispose + dead code removal
```

*Commit message example*

```text
refactor(collapse-nav): Unit C.2 — remove dead expansion code
```

*Commit message example*

```text
feat(collapse-nav): Unit B.6 — config-driven child render limit (default no limit)
```

*Commit message example*

```text
docs(collapse-nav): Units D.1+D.2 — architecture doc + rules update
```

*Commit message example*

```text
refactor(collapse-nav): Unit C.1 — relocate findTabIdByPaneId to useLayoutStore
```

*Commit message example*

```text
feat(collapse-nav): Unit B.5 — size cap for expandToDepth (Cmd+E)
```

## Architecture

### Project Structure: Single Package

This project uses **type-based** module organization.

### Source Layout

```
src/
├── assets/
├── components/
├── context/
├── generated/
├── hooks/
├── lib/
```

### Entry Points

- `src/App.tsx`
- `src/main.tsx`

### Configuration Files

- `eslint.config.js`
- `package.json`
- `tsconfig.json`
- `vite.config.ts`
- `vitest.config.ts`

### Guidelines

- Group code by type (components, services, utils)
- Keep related functionality in the same type folder
- Avoid circular dependencies between type folders

## Code Style

### Language: TypeScript

### Naming Conventions

| Element | Convention |
|---------|------------|
| Files | camelCase |
| Functions | camelCase |
| Classes | PascalCase |
| Constants | SCREAMING_SNAKE_CASE |

### Import Style: Relative Imports

### Export Style: Named Exports


*Preferred import style*

```typescript
// Use relative imports
import { Button } from '../components/Button'
import { useAuth } from './hooks/useAuth'
```

*Preferred export style*

```typescript
// Use named exports
export function calculateTotal() { ... }
export const TAX_RATE = 0.1
export interface Order { ... }
```

## Testing

### Test Framework: vitest

### File Pattern: `*.test.ts`

### Test Types

- **Unit tests**: Test individual functions and components in isolation

### Mocking: vi.mock


*Test file structure*

```typescript
import { describe, it, expect } from 'vitest'

describe('MyFunction', () => {
  it('should return expected result', () => {
    const result = myFunction(input)
    expect(result).toBe(expected)
  })
})
```

## Error Handling

### Error Handling Style: Try-Catch Blocks


*Standard error handling pattern*

```typescript
try {
  const result = await riskyOperation()
  return result
} catch (error) {
  console.error('Operation failed:', error)
  throw new Error('User-friendly message')
}
```

## Common Workflows

These workflows were detected from analyzing commit patterns.

### Feature Development

Standard feature implementation workflow

**Frequency**: ~16 times per month

**Steps**:
1. Add feature implementation
2. Add tests for feature
3. Update documentation

**Files typically involved**:
- `src/*`
- `src/components/*`
- `src/components/views/*`
- `**/*.test.*`
- `**/api/**`

**Example commit sequence**:
```
feat: fuzzy page search, presence API, deep links & terminal wikilink navigation (#170)
chore: release v0.9.0
fix: disable pane-inactive-overlay pointer events during block drag (#171)
```

### Refactoring

Code refactoring and cleanup workflow

**Frequency**: ~5 times per month

**Steps**:
1. Ensure tests pass before refactor
2. Refactor code structure
3. Verify tests still pass

**Files typically involved**:
- `src/**/*`

**Example commit sequence**:
```
feat: search metadata round-trip fix + schema enrichment + API filters (#172)
fix: add X-Floatty-Confirm-Destructive header to binary-import script
chore: release v0.9.2
```

### Release Workflow

Prepares and publishes a new release version, including updating version numbers, changelogs, and configuration files.

**Frequency**: ~4 times per month

**Steps**:
1. Update package.json version and dependencies.
2. Update src-tauri/Cargo.toml and tauri.conf.json with new version.
3. Update (or add to) CHANGELOG.md with release notes.
4. Commit all updated files with a release message.

**Files typically involved**:
- `package.json`
- `CHANGELOG.md`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

**Example commit sequence**:
```
Update package.json version and dependencies.
Update src-tauri/Cargo.toml and tauri.conf.json with new version.
Update (or add to) CHANGELOG.md with release notes.
Commit all updated files with a release message.
```

### Feature Development With Multi File Integration

Implements a new feature or major refactor that requires coordinated changes across multiple files, often including implementation, tests, and documentation.

**Frequency**: ~6 times per month

**Steps**:
1. Implement new logic or refactor in main code files.
2. Update or add related tests.
3. Update or add documentation (docs/ or .claude/rules/).
4. Update types/interfaces if needed.
5. Commit all related files together.

**Files typically involved**:
- `src/components/*.tsx`
- `src/hooks/*.ts`
- `src/lib/*.ts`
- `src-tauri/floatty-core/src/**/*.rs`
- `src-tauri/floatty-server/src/**/*.rs`
- `docs/**/*.md`
- `.claude/rules/**/*.md`

**Example commit sequence**:
```
Implement new logic or refactor in main code files.
Update or add related tests.
Update or add documentation (docs/ or .claude/rules/).
Update types/interfaces if needed.
Commit all related files together.
```

### Api Schema And Filter Extension

Extends or enriches the backend API and search schema, often adding new filter parameters, updating Rust schema, and wiring new fields through to the API.

**Frequency**: ~2 times per month

**Steps**:
1. Update Rust schema files (e.g., schema.rs, index_manager.rs).
2. Update API handler (api.rs) to accept new parameters.
3. Update or add tests for new API/filter behavior.
4. Update documentation (CLAUDE.md, .claude/rules/api-reference.md).
5. Commit all related files together.

**Files typically involved**:
- `src-tauri/floatty-core/src/search/schema.rs`
- `src-tauri/floatty-core/src/search/index_manager.rs`
- `src-tauri/floatty-core/src/search/service.rs`
- `src-tauri/floatty-server/src/api.rs`
- `src-tauri/floatty-core/src/search/writer.rs`
- `src-tauri/floatty-core/src/hooks/parsing.rs`
- `src-tauri/floatty-core/src/metadata.rs`
- `src-tauri/floatty-core/Cargo.toml`
- `src-tauri/Cargo.lock`
- `docs/**/*.md`
- `.claude/rules/api-reference.md`

**Example commit sequence**:
```
Update Rust schema files (e.g., schema.rs, index_manager.rs).
Update API handler (api.rs) to accept new parameters.
Update or add tests for new API/filter behavior.
Update documentation (CLAUDE.md, .claude/rules/api-reference.md).
Commit all related files together.
```

### Documentation Restructuring And Extraction

Restructures and extracts documentation from large monolithic files into focused rules or reference files for clarity and maintainability.

**Frequency**: ~2 times per month

**Steps**:
1. Extract sections from main documentation (e.g., CLAUDE.md) into new or existing .claude/rules/*.md files.
2. Update references and pointers in the main documentation.
3. Add or update architecture, API, or config docs.
4. Commit all documentation changes together.

**Files typically involved**:
- `CLAUDE.md`
- `.claude/rules/*.md`
- `docs/**/*.md`

**Example commit sequence**:
```
Extract sections from main documentation (e.g., CLAUDE.md) into new or existing .claude/rules/*.md files.
Update references and pointers in the main documentation.
Add or update architecture, API, or config docs.
Commit all documentation changes together.
```

### Refactor Move Or Extract Shared Logic

Moves shared logic or utilities to new locations, updates all import sites, and removes duplication.

**Frequency**: ~2 times per month

**Steps**:
1. Move or extract shared function(s) to a more appropriate module.
2. Update all import sites to use the new location.
3. Remove old or dead code.
4. Commit all related changes together.

**Files typically involved**:
- `src/components/*.tsx`
- `src/hooks/*.ts`
- `src/lib/*.ts`

**Example commit sequence**:
```
Move or extract shared function(s) to a more appropriate module.
Update all import sites to use the new location.
Remove old or dead code.
Commit all related changes together.
```


## Best Practices

Based on analysis of the codebase, follow these practices:

### Do

- Use conventional commit format (feat:, fix:, etc.)
- Write tests using vitest
- Follow *.test.ts naming pattern
- Use camelCase for file names
- Prefer named exports

### Don't

- Don't write vague commit messages
- Don't skip tests for new features
- Don't deviate from established patterns without discussion

---

*This skill was auto-generated by [ECC Tools](https://ecc.tools). Review and customize as needed for your team.*
