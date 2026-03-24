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
refactor: render:: door uses selfRender — output on same block, no child
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
refactor: simplify review findings — normalizeSpec, markdown fence protection
```

*Commit message example*

```text
fix(FLO-507): persist sidebar width to config.toml on resize
```

*Commit message example*

```text
fix(collapse-nav): C.3 review fixes — HMR dispose + dead code removal
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

**Frequency**: ~15 times per month

**Steps**:
1. Add feature implementation
2. Add tests for feature
3. Update documentation

**Files typically involved**:
- `src/components/*`
- `src/context/*`
- `src/hooks/blockinput/*`
- `**/*.test.*`
- `**/api/**`

**Example commit sequence**:
```
docs: compress CLAUDE.md from 948 to 191 lines (#177)
FLO-498: Position-dependent outdent, merge atomicity, flush coverage + terrain map (#175)
chore: release v0.9.5
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
FLO-498: Position-dependent outdent, merge atomicity, flush coverage + terrain map (#175)
chore: release v0.9.5
Harden sync & tree integrity with parent validation and diagnostics (#180)
```

### Release Version Bump

Prepare and publish a new release version of the application.

**Frequency**: ~2 times per month

**Steps**:
1. Update version numbers in package.json and tauri config files.
2. Update CHANGELOG.md with release notes.
3. Update Cargo.toml and Cargo.lock for Rust backend.
4. Commit all changes with a 'chore: release vX.Y.Z' message.

**Files typically involved**:
- `CHANGELOG.md`
- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`
- `src-tauri/tauri.conf.json`

**Example commit sequence**:
```
Update version numbers in package.json and tauri config files.
Update CHANGELOG.md with release notes.
Update Cargo.toml and Cargo.lock for Rust backend.
Commit all changes with a 'chore: release vX.Y.Z' message.
```

### Expand Collapse Navigation Refactor

Iteratively improve, refactor, and extend the expand/collapse navigation system for block trees.

**Frequency**: ~4 times per month

**Steps**:
1. Edit navigation and expansion policy logic in src/lib/expansionPolicy.ts and related test files.
2. Update or refactor hooks in src/hooks/useTreeCollapse.ts, src/hooks/usePaneStore.ts, and src/hooks/useBlockInput.ts.
3. Update UI components like src/components/BlockItem.tsx and src/components/Outliner.tsx to use new logic.
4. Update or add documentation in .claude/rules/architecture.md or docs/architecture.
5. Commit with 'feat(collapse-nav): ...', 'fix(collapse-nav): ...', or 'refactor(collapse-nav): ...' messages.

**Files typically involved**:
- `src/lib/expansionPolicy.ts`
- `src/lib/expansionPolicy.test.ts`
- `src/hooks/useTreeCollapse.ts`
- `src/hooks/usePaneStore.ts`
- `src/hooks/useBlockInput.ts`
- `src/components/BlockItem.tsx`
- `src/components/Outliner.tsx`
- `.claude/rules/architecture.md`
- `docs/architecture/EXPAND_COLLAPSE_NAVIGATION.md`

**Example commit sequence**:
```
Edit navigation and expansion policy logic in src/lib/expansionPolicy.ts and related test files.
Update or refactor hooks in src/hooks/useTreeCollapse.ts, src/hooks/usePaneStore.ts, and src/hooks/useBlockInput.ts.
Update UI components like src/components/BlockItem.tsx and src/components/Outliner.tsx to use new logic.
Update or add documentation in .claude/rules/architecture.md or docs/architecture.
Commit with 'feat(collapse-nav): ...', 'fix(collapse-nav): ...', or 'refactor(collapse-nav): ...' messages.
```

### Add Or Update Sidebar Feature

Add, refactor, or fix sidebar-related features such as resizing, toggling, or linking.

**Frequency**: ~2 times per month

**Steps**:
1. Edit src/components/Terminal.tsx and src/components/SidebarDoorContainer.tsx for sidebar logic.
2. Update hooks in src/hooks/usePaneStore.ts and src/hooks/usePaneLinkStore.ts.
3. Update or add CSS in src/components/sidebar-doors.css.
4. Update keybinds or commands in src/lib/keybinds.ts and src/hooks/useCommandBar.ts.
5. Commit with 'feat: resizable sidebar', 'fix: sidebar', or similar messages.

**Files typically involved**:
- `src/components/Terminal.tsx`
- `src/components/SidebarDoorContainer.tsx`
- `src/hooks/usePaneStore.ts`
- `src/hooks/usePaneLinkStore.ts`
- `src/components/sidebar-doors.css`
- `src/lib/keybinds.ts`
- `src/hooks/useCommandBar.ts`

**Example commit sequence**:
```
Edit src/components/Terminal.tsx and src/components/SidebarDoorContainer.tsx for sidebar logic.
Update hooks in src/hooks/usePaneStore.ts and src/hooks/usePaneLinkStore.ts.
Update or add CSS in src/components/sidebar-doors.css.
Update keybinds or commands in src/lib/keybinds.ts and src/hooks/useCommandBar.ts.
Commit with 'feat: resizable sidebar', 'fix: sidebar', or similar messages.
```

### Sync Integrity Hardening

Harden Y.Doc sync and tree integrity with validation, diagnostics, and bug fixes.

**Frequency**: ~2 times per month

**Steps**:
1. Edit src/hooks/useBlockStore.ts for validation and transaction logic.
2. Add or update diagnostics in src/lib/syncDiagnostics.ts and src/lib/syncDiagnostics.test.ts.
3. Update UI components (e.g., src/components/BlockItem.tsx) to reflect new sync logic.
4. Update or add rules in .claude/rules/ydoc-patterns.md.
5. Commit with messages referencing sync integrity, parent validation, or diagnostics.

**Files typically involved**:
- `src/hooks/useBlockStore.ts`
- `src/lib/syncDiagnostics.ts`
- `src/lib/syncDiagnostics.test.ts`
- `src/components/BlockItem.tsx`
- `.claude/rules/ydoc-patterns.md`

**Example commit sequence**:
```
Edit src/hooks/useBlockStore.ts for validation and transaction logic.
Add or update diagnostics in src/lib/syncDiagnostics.ts and src/lib/syncDiagnostics.test.ts.
Update UI components (e.g., src/components/BlockItem.tsx) to reflect new sync logic.
Update or add rules in .claude/rules/ydoc-patterns.md.
Commit with messages referencing sync integrity, parent validation, or diagnostics.
```

### Search Schema And Ranking Update

Update search schema, preprocessing, ranking, and add or fix search-related features.

**Frequency**: ~2 times per month

**Steps**:
1. Edit Rust backend files: schema.rs, index_manager.rs, service.rs, writer.rs, tantivy_index.rs.
2. Update API layer in src-tauri/floatty-server/src/api.rs.
3. Update or add documentation in .claude/rules/api-reference.md.
4. Commit with 'feat(search): ...' or 'fix(search): ...' messages.

**Files typically involved**:
- `src-tauri/floatty-core/src/search/schema.rs`
- `src-tauri/floatty-core/src/search/index_manager.rs`
- `src-tauri/floatty-core/src/search/service.rs`
- `src-tauri/floatty-core/src/search/writer.rs`
- `src-tauri/floatty-core/src/hooks/tantivy_index.rs`
- `src-tauri/floatty-server/src/api.rs`
- `.claude/rules/api-reference.md`

**Example commit sequence**:
```
Edit Rust backend files: schema.rs, index_manager.rs, service.rs, writer.rs, tantivy_index.rs.
Update API layer in src-tauri/floatty-server/src/api.rs.
Update or add documentation in .claude/rules/api-reference.md.
Commit with 'feat(search): ...' or 'fix(search): ...' messages.
```

### Door Feature Development

Add or refactor a door (plugin/module) feature, including catalog, routes, and UI integration.

**Frequency**: ~2 times per month

**Steps**:
1. Edit or create door.json and related .tsx/.ts files in doors/ directories.
2. Update or add catalog, registry, and route files for the door.
3. Update src/components/Outliner.tsx or views for integration.
4. Update package.json and scripts if new dependencies or build steps are needed.
5. Commit with 'feat: ... door', 'refactor: ... door', or similar messages.

**Files typically involved**:
- `doors/render/door.json`
- `doors/render/render.tsx`
- `doors/session-garden/catalog.ts`
- `doors/session-garden/components.tsx`
- `doors/session-garden/door.json`
- `doors/session-garden/index.ts`
- `doors/session-garden/registry.ts`
- `doors/session-garden/session-garden.tsx`
- `src/components/Outliner.tsx`
- `src/components/views/DoorPaneView.tsx`
- `package.json`
- `scripts/compile-door-bundle.mjs`

**Example commit sequence**:
```
Edit or create door.json and related .tsx/.ts files in doors/ directories.
Update or add catalog, registry, and route files for the door.
Update src/components/Outliner.tsx or views for integration.
Update package.json and scripts if new dependencies or build steps are needed.
Commit with 'feat: ... door', 'refactor: ... door', or similar messages.
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
