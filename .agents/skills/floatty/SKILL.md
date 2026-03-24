---
name: floatty-conventions
description: Development conventions and patterns for floatty. TypeScript Vite project with conventional commits.
---

# Floatty Conventions

> Generated from [float-ritual-stack/floatty](https://github.com/float-ritual-stack/floatty) on 2026-03-24

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
- `refactor`
- `release`

### Message Guidelines

- Average message length: ~60 characters
- Keep first line concise and descriptive
- Use imperative mood ("Add feature" not "Added feature")


*Commit message example*

```text
refactor: simplify review findings — normalizeSpec, markdown fence protection
```

*Commit message example*

```text
fix: event listener leak in GardenView + remove unused stateStore
```

*Commit message example*

```text
feat: json-render component catalog + session-garden door + DoorPaneView
```

*Commit message example*

```text
chore: release v0.9.8
```

*Commit message example*

```text
docs: changelog for v0.9.7
```

*Commit message example*

```text
fix(FLO-507): persist sidebar width to config.toml on resize
```

*Commit message example*

```text
fix(collapse-nav): C.3 review fixes — HMR dispose + dead code removal
```

*Commit message example*

```text
fix: Cmd+. toggles collapse on blocks with output (artifact/eval/door)
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
- `src/components/*`
- `src/hooks/*`
- `src/lib/*`
- `**/*.test.*`
- `**/api/**`

**Example commit sequence**:
```
feat: cmd bar ordering, ⌘⌘ block ID copy, Home/Today commands, scroll fix, nav consolidation (FLO-466) (#174)
chore: release v0.9.4
docs: compress CLAUDE.md from 948 to 191 lines (#177)
```

### Test Driven Development

Test-first development workflow (TDD)

**Frequency**: ~3 times per month

**Steps**:
1. Write failing test
2. Implement code to pass test
3. Refactor if needed

**Files typically involved**:
- `**/*.test.*`
- `**/*.spec.*`
- `src/**/*`

**Example commit sequence**:
```
test: add tests for user validation
feat: implement user validation
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
feat: cmd bar ordering, ⌘⌘ block ID copy, Home/Today commands, scroll fix, nav consolidation (FLO-466) (#174)
chore: release v0.9.4
docs: compress CLAUDE.md from 948 to 191 lines (#177)
```

### Feature Development With Implementation Tests And Docs

Implements a new feature or major enhancement, typically involving both code and documentation updates, sometimes with tests.

**Frequency**: ~3 times per month

**Steps**:
1. Implement new feature in main codebase (e.g., src/components/, src/hooks/, src/lib/)
2. Update or add related documentation (e.g., CLAUDE.md, docs/architecture/, .claude/rules/)
3. Add or update tests (e.g., *.test.ts, *.test.tsx)
4. Update package.json or package-lock.json if dependencies or scripts are affected

**Files typically involved**:
- `src/components/`
- `src/hooks/`
- `src/lib/`
- `docs/`
- `.claude/rules/`
- `CLAUDE.md`
- `package.json`
- `package-lock.json`

**Example commit sequence**:
```
Implement new feature in main codebase (e.g., src/components/, src/hooks/, src/lib/)
Update or add related documentation (e.g., CLAUDE.md, docs/architecture/, .claude/rules/)
Add or update tests (e.g., *.test.ts, *.test.tsx)
Update package.json or package-lock.json if dependencies or scripts are affected
```

### Config Or Schema Driven Feature Extension

Extends system capabilities by adding new config fields or schema changes, updating both backend (Rust, Tauri) and frontend TypeScript types, and wiring through to UI or logic.

**Frequency**: ~2 times per month

**Steps**:
1. Add new field to Rust config/schema (e.g., src-tauri/src/config.rs)
2. Update corresponding TypeScript types (e.g., src/lib/tauriTypes.ts)
3. Wire config field into UI/component logic (e.g., src/components/...)
4. Update documentation if necessary

**Files typically involved**:
- `src-tauri/src/config.rs`
- `src/lib/tauriTypes.ts`
- `src/components/`
- `docs/`
- `.claude/rules/`

**Example commit sequence**:
```
Add new field to Rust config/schema (e.g., src-tauri/src/config.rs)
Update corresponding TypeScript types (e.g., src/lib/tauriTypes.ts)
Wire config field into UI/component logic (e.g., src/components/...)
Update documentation if necessary
```

### Refactor To Extract Shared Utility Or Remove Duplication

Refactors code to extract shared helpers/utilities, remove duplication, or relocate logic for maintainability.

**Frequency**: ~2 times per month

**Steps**:
1. Identify duplicated logic across files
2. Extract shared helper to a common module (e.g., src/lib/..., src/hooks/...)
3. Update all call sites to use the new utility
4. Remove dead or redundant code
5. Update related documentation or rules if needed

**Files typically involved**:
- `src/components/`
- `src/hooks/`
- `src/lib/`

**Example commit sequence**:
```
Identify duplicated logic across files
Extract shared helper to a common module (e.g., src/lib/..., src/hooks/...)
Update all call sites to use the new utility
Remove dead or redundant code
Update related documentation or rules if needed
```

### Release Version Bump And Changelog Update

Prepares and publishes a new release by bumping version numbers and updating changelogs and config files.

**Frequency**: ~3 times per month

**Steps**:
1. Update version in package.json
2. Update version in Cargo.toml and tauri.conf.json (if Tauri app)
3. Update CHANGELOG.md with new version and changes
4. Update Cargo.lock if Rust dependencies changed

**Files typically involved**:
- `package.json`
- `CHANGELOG.md`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

**Example commit sequence**:
```
Update version in package.json
Update version in Cargo.toml and tauri.conf.json (if Tauri app)
Update CHANGELOG.md with new version and changes
Update Cargo.lock if Rust dependencies changed
```

### Bugfix Driven By Code Review Or User Report

Fixes bugs or addresses code review feedback, often referencing PR numbers and making targeted changes.

**Frequency**: ~5 times per month

**Steps**:
1. Identify bug or review issue (often via PR or issue reference)
2. Make targeted fix in relevant code file(s)
3. Update or add tests if needed
4. Sometimes update documentation or rules if behavior changes

**Files typically involved**:
- `src/components/`
- `src/hooks/`
- `src/lib/`
- `docs/`
- `.claude/rules/`

**Example commit sequence**:
```
Identify bug or review issue (often via PR or issue reference)
Make targeted fix in relevant code file(s)
Update or add tests if needed
Sometimes update documentation or rules if behavior changes
```

### Documentation Extraction And Reorganization

Extracts, compresses, or reorganizes documentation from large monolithic files into focused, smaller rules or reference files.

**Frequency**: ~1 times per month

**Steps**:
1. Move sections from main doc (e.g., CLAUDE.md) to new or existing focused files (e.g., .claude/rules/...)
2. Compress or rewrite narrative explanations into concise, definitive statements
3. Update references and pointers in main documentation

**Files typically involved**:
- `CLAUDE.md`
- `.claude/rules/`
- `docs/`

**Example commit sequence**:
```
Move sections from main doc (e.g., CLAUDE.md) to new or existing focused files (e.g., .claude/rules/...)
Compress or rewrite narrative explanations into concise, definitive statements
Update references and pointers in main documentation
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
