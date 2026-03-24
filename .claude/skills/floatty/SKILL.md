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
feat: json-render component catalog + session-garden door + DoorPaneView
```

*Commit message example*

```text
fix(FLO-507): persist sidebar width to config.toml on resize
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
refactor(collapse-nav): Unit C.2 — remove dead expansion code
```

*Commit message example*

```text
fix(collapse-nav): C.3 review fixes — HMR dispose + dead code removal
```

*Commit message example*

```text
fix: Cmd+. toggles collapse on blocks with output (artifact/eval/door)
```

*Commit message example*

```text
fix: pages:: children default to collapsed
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
docs: add search API + vocabulary discovery to CLAUDE.md
test: add ctx_datetime tests for real text expander formats
feat: cmd bar ordering, ⌘⌘ block ID copy, Home/Today commands, scroll fix, nav consolidation (FLO-466) (#174)
```

### Refactoring

Code refactoring and cleanup workflow

**Frequency**: ~4 times per month

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

### Release Version Bump

Prepares and publishes a new release version, updating changelog and version numbers across package and config files.

**Frequency**: ~3 times per month

**Steps**:
1. Update CHANGELOG.md with release notes.
2. Update package.json version.
3. Update src-tauri/Cargo.toml and/or Cargo.lock with new version.
4. Update src-tauri/tauri.conf.json as needed.
5. Commit all changes with a 'chore: release vX.Y.Z' message.

**Files typically involved**:
- `CHANGELOG.md`
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

**Example commit sequence**:
```
Update CHANGELOG.md with release notes.
Update package.json version.
Update src-tauri/Cargo.toml and/or Cargo.lock with new version.
Update src-tauri/tauri.conf.json as needed.
Commit all changes with a 'chore: release vX.Y.Z' message.
```

### Config Schema Update

Adds or modifies configuration fields that require updates in both Rust backend and TypeScript frontend, ensuring type safety and persistence.

**Frequency**: ~2 times per month

**Steps**:
1. Add or update field in src-tauri/src/config.rs (Rust backend).
2. Update corresponding TypeScript types in src/lib/tauriTypes.ts.
3. Update any frontend components that use the config (e.g., src/components/BlockItem.tsx, src/components/Terminal.tsx).
4. Implement logic to load, persist, and use the new config field.
5. Test persistence and usage across app restarts.

**Files typically involved**:
- `src-tauri/src/config.rs`
- `src/lib/tauriTypes.ts`
- `src/components/BlockItem.tsx`
- `src/components/Terminal.tsx`

**Example commit sequence**:
```
Add or update field in src-tauri/src/config.rs (Rust backend).
Update corresponding TypeScript types in src/lib/tauriTypes.ts.
Update any frontend components that use the config (e.g., src/components/BlockItem.tsx, src/components/Terminal.tsx).
Implement logic to load, persist, and use the new config field.
Test persistence and usage across app restarts.
```

### Expand Collapse Navigation Policy Change

Implements or refactors navigation and expand/collapse logic for hierarchical block trees, often introducing new policies or limits and wiring them through multiple hooks/components.

**Frequency**: ~3 times per month

**Steps**:
1. Edit or add logic in src/lib/expansionPolicy.ts (core policy logic).
2. Update or add tests in src/lib/expansionPolicy.test.ts.
3. Wire new logic through hooks (src/hooks/useTreeCollapse.ts, src/hooks/usePaneStore.ts).
4. Update components that trigger or depend on expand/collapse (e.g., src/components/Outliner.tsx, src/components/BlockItem.tsx).
5. Update documentation (e.g., .claude/rules/architecture.md, docs/architecture/EXPAND_COLLAPSE_NAVIGATION.md).

**Files typically involved**:
- `src/lib/expansionPolicy.ts`
- `src/lib/expansionPolicy.test.ts`
- `src/hooks/useTreeCollapse.ts`
- `src/hooks/usePaneStore.ts`
- `src/components/Outliner.tsx`
- `src/components/BlockItem.tsx`
- `.claude/rules/architecture.md`
- `docs/architecture/EXPAND_COLLAPSE_NAVIGATION.md`

**Example commit sequence**:
```
Edit or add logic in src/lib/expansionPolicy.ts (core policy logic).
Update or add tests in src/lib/expansionPolicy.test.ts.
Wire new logic through hooks (src/hooks/useTreeCollapse.ts, src/hooks/usePaneStore.ts).
Update components that trigger or depend on expand/collapse (e.g., src/components/Outliner.tsx, src/components/BlockItem.tsx).
Update documentation (e.g., .claude/rules/architecture.md, docs/architecture/EXPAND_COLLAPSE_NAVIGATION.md).
```

### Navigation Pane Link Resolution

Refactors or extends navigation logic to resolve pane links for navigation actions across multiple UI entry points.

**Frequency**: ~2 times per month

**Steps**:
1. Add or update resolveLink/resolveSameTabLink utility in src/lib/navigation.ts.
2. Update all navigation call sites in components (e.g., src/components/BlockItem.tsx, src/components/LinkedReferences.tsx, src/components/Terminal.tsx, src/components/views/FilterBlockDisplay.tsx, src/components/views/SearchResultsView.tsx).
3. Update or remove redundant navigation logic from hooks (e.g., src/hooks/useBacklinkNavigation.ts, src/hooks/usePaneLinkStore.ts).
4. Add or update tests if necessary.
5. Document new navigation patterns in rules or architecture docs.

**Files typically involved**:
- `src/lib/navigation.ts`
- `src/components/BlockItem.tsx`
- `src/components/LinkedReferences.tsx`
- `src/components/Terminal.tsx`
- `src/components/views/FilterBlockDisplay.tsx`
- `src/components/views/SearchResultsView.tsx`
- `src/hooks/useBacklinkNavigation.ts`
- `src/hooks/usePaneLinkStore.ts`

**Example commit sequence**:
```
Add or update resolveLink/resolveSameTabLink utility in src/lib/navigation.ts.
Update all navigation call sites in components (e.g., src/components/BlockItem.tsx, src/components/LinkedReferences.tsx, src/components/Terminal.tsx, src/components/views/FilterBlockDisplay.tsx, src/components/views/SearchResultsView.tsx).
Update or remove redundant navigation logic from hooks (e.g., src/hooks/useBacklinkNavigation.ts, src/hooks/usePaneLinkStore.ts).
Add or update tests if necessary.
Document new navigation patterns in rules or architecture docs.
```

### Documentation Extraction And Update

Extracts, reorganizes, or updates documentation by moving details from a monolithic doc (e.g., CLAUDE.md) into focused rules or architecture files.

**Frequency**: ~2 times per month

**Steps**:
1. Extract sections from CLAUDE.md into new or existing .claude/rules/*.md or docs/architecture/*.md files.
2. Update CLAUDE.md to reference new locations and compress content.
3. Add or update architecture, API reference, or config documentation.
4. Commit with a docs: or chore: message.

**Files typically involved**:
- `CLAUDE.md`
- `.claude/rules/api-reference.md`
- `.claude/rules/architecture.md`
- `.claude/rules/config-and-logging.md`
- `docs/architecture/EXPAND_COLLAPSE_NAVIGATION.md`

**Example commit sequence**:
```
Extract sections from CLAUDE.md into new or existing .claude/rules/*.md or docs/architecture/*.md files.
Update CLAUDE.md to reference new locations and compress content.
Add or update architecture, API reference, or config documentation.
Commit with a docs: or chore: message.
```

### Artifact Content Type Detection Improvement

Improves or extends artifact rendering by detecting and handling new content types (e.g., HTML, JSON, text, JSX) and updating transformation logic and tests.

**Frequency**: ~2 times per month

**Steps**:
1. Update detection and transform logic in src/lib/handlers/artifactTransform.ts and/or artifactHandler.ts.
2. Add or update tests in src/lib/handlers/artifactTransform.test.ts.
3. Update artifact rendering logic in related components if needed.
4. Document changes if necessary.

**Files typically involved**:
- `src/lib/handlers/artifactTransform.ts`
- `src/lib/handlers/artifactTransform.test.ts`
- `src/lib/handlers/artifactHandler.ts`

**Example commit sequence**:
```
Update detection and transform logic in src/lib/handlers/artifactTransform.ts and/or artifactHandler.ts.
Add or update tests in src/lib/handlers/artifactTransform.test.ts.
Update artifact rendering logic in related components if needed.
Document changes if necessary.
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
