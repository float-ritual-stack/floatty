```markdown
# floatty Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you the core development patterns, coding conventions, and workflow automation for the `floatty` TypeScript codebase, built with Vite. You'll learn how to contribute features, refactor code, handle releases, and maintain code quality using established conventions and repeatable workflows. The repository emphasizes modular UI development, clean commit practices, and robust testing.

---

## Coding Conventions

### File Naming

- Use **camelCase** for file names.
  - Example: `blockItem.tsx`, `artifactTransform.ts`

### Import Style

- Use **relative imports** for modules within the project.
  - Example:
    ```ts
    import { BlockOutputView } from './BlockOutputView'
    ```

### Export Style

- Use **named exports** for all modules.
  - Example:
    ```ts
    export function useContentSync() { ... }
    export const BlockOutputView = () => { ... }
    ```

### Commit Messages

- Follow **conventional commit** style.
- Prefixes: `fix`, `feat`, `chore`, `refactor`, `docs`
- Average commit message length: ~59 characters.
  - Example:
    ```
    feat(render): add support for new door component
    fix(artifact): improve content sniffing for JSON files
    ```

---

## Workflows

### Feature Development: Door Component

**Trigger:** When adding a new "door" (pluggable UI module) or extending an existing one  
**Command:** `/new-door-component`

1. Edit or create `doors/render/catalog.ts` to define schemas and catalog entries.
2. Implement or update components in `doors/render/components.tsx`.
3. Update `doors/render/registry.ts` for registry and style injection.
4. Modify `doors/render/render.tsx` to add new routes or logic.
5. Optionally, update or add `doors/render/door.json` manifest.
6. Update `package.json` if new dependencies are needed.

**Example:**
```ts
// doors/render/catalog.ts
export const doorCatalog = [
  { id: 'myDoor', name: 'My Door', schema: { ... } }
]

// doors/render/components.tsx
export const MyDoorComponent = () => <div>My Door UI</div>
```

---

### Feature Development: BlockItem Extraction

**Trigger:** When refactoring `BlockItem.tsx` by extracting reusable logic/UI  
**Command:** `/extract-blockitem-logic`

1. Identify logic/UI in `src/components/BlockItem.tsx` to extract.
2. Create a new file in `src/components/` or `src/hooks/` (e.g., `BlockOutputView.tsx`, `useContentSync.ts`).
3. Move relevant code into the new file.
4. Update `BlockItem.tsx` to import and use the new component/hook.
5. Update or add related test files if necessary.

**Example:**
```ts
// src/hooks/useContentSync.ts
export function useContentSync() { ... }

// src/components/BlockItem.tsx
import { useContentSync } from '../hooks/useContentSync'
```

---

### Code Review Fixes (Multi-file)

**Trigger:** When addressing code review or PR feedback across multiple files  
**Command:** `/review-fixes`

1. Review PR feedback or code review comments.
2. Edit the relevant files to address the feedback (naming, logic, dependencies, etc.).
3. Commit changes with a message referencing the PR or review round.
4. May include moving dependencies, renaming variables, extracting helpers, or fixing logic.

---

### Release Version Bump

**Trigger:** When preparing and publishing a new release  
**Command:** `/release`

1. Update `CHANGELOG.md` with release notes.
2. Update version in `package.json`.
3. Update `src-tauri/Cargo.toml` and/or `src-tauri/Cargo.lock` for Rust backend versioning.
4. Update `src-tauri/tauri.conf.json` if needed.
5. Commit with a message indicating the release version.

---

### Sidebar Width Persistence Update

**Trigger:** When changing how sidebar width is persisted (e.g., config.toml ↔ localStorage)  
**Command:** `/sidebar-width-persistence`

1. Edit `src/components/Terminal.tsx` to change sidebar width persistence logic.
2. If using `config.toml`: update `src-tauri/src/config.rs` and `src/lib/tauriTypes.ts`.
3. If switching to localStorage: remove or bypass `config.toml` logic.
4. Test persistence on resize and app restart.
5. Commit with a message referencing sidebar width or FLO-507.

---

### Artifact Handler Content Sniffing Update

**Trigger:** When improving or fixing artifact content detection and rendering  
**Command:** `/artifact-sniffing-update`

1. Edit `src/lib/handlers/artifactTransform.ts` to update detection logic.
2. Update or add tests in `src/lib/handlers/artifactTransform.test.ts`.
3. Optionally update `src/lib/handlers/artifactHandler.ts` for handler logic.
4. Commit with a message referencing artifact detection or content sniffing.

**Example:**
```ts
// src/lib/handlers/artifactTransform.ts
export function sniffContentType(content: string): 'json' | 'html' | 'text' { ... }
```

---

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test file pattern:** `*.test.ts`
- Place tests alongside implementation or in a parallel `__tests__` directory.
- Example:
  ```ts
  // src/lib/handlers/artifactTransform.test.ts
  import { sniffContentType } from './artifactTransform'

  test('detects JSON content', () => {
    expect(sniffContentType('{ "a": 1 }')).toBe('json')
  })
  ```

---

## Commands

| Command                     | Purpose                                                        |
|-----------------------------|----------------------------------------------------------------|
| /new-door-component         | Start workflow for adding or extending a door component         |
| /extract-blockitem-logic    | Extract reusable logic/UI from BlockItem.tsx                   |
| /review-fixes               | Address code review or PR feedback across multiple files        |
| /release                    | Prepare and publish a new release                              |
| /sidebar-width-persistence  | Update sidebar width persistence logic                         |
| /artifact-sniffing-update   | Improve artifact handler content detection and rendering        |
```
