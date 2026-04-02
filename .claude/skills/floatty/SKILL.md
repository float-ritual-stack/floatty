```markdown
# floatty Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute effectively to the `floatty` codebase, a TypeScript project built with Vite. You'll learn the repository's coding conventions, commit patterns, testing strategies, and step-by-step workflows for common development tasks such as adding API endpoints, releasing versions, developing UI components, refactoring, and more. This guide also introduces the `/commands` that streamline frequent actions in the project.

---

## Coding Conventions

### File Naming

- Use **camelCase** for file names.
  - Example: `artifactTransform.ts`, `useContentSync.ts`

### Imports

- Use **relative imports** for modules within the project.
  - Example:
    ```ts
    import { useContentSync } from '../hooks/useContentSync';
    ```

### Exports

- Use **named exports** for functions, components, and hooks.
  - Example:
    ```ts
    export function useContentSync() { ... }
    export const BlockOutputView = () => { ... }
    ```

### Commit Messages

- Follow **conventional commit** style.
- Prefixes: `fix`, `feat`, `chore`, `refactor`, `docs`
- Example:
  ```
  feat: add support for artifact content type detection
  fix: correct door registry schema validation
  ```

---

## Workflows

### Add or Update API Endpoint

**Trigger:** When you want to add a new backend API endpoint or update an existing one.  
**Command:** `/new-api-endpoint`

1. Edit or add the endpoint handler in `src-tauri/floatty-server/src/api.rs`.
2. Update `.claude/rules/api-reference.md` with documentation for the new or changed endpoint.
3. Optionally, update or create supporting logic in `src-tauri/floatty-core/src/hooks/`.
4. Optionally, fix or improve related tests.

**Example:**
```rust
// src-tauri/floatty-server/src/api.rs
#[post("/api/new-endpoint")]
fn new_endpoint(data: Json<NewData>) -> Json<Response> {
    // implementation
}
```
```md
// .claude/rules/api-reference.md
### POST /api/new-endpoint
Description: ...
```

---

### Release Version Bump

**Trigger:** When you want to prepare and release a new version.  
**Command:** `/release`

1. Update `CHANGELOG.md` with notes for the new version.
2. Update the `version` field in `package.json`.
3. Update `src-tauri/Cargo.toml` and/or `src-tauri/Cargo.lock` for Rust dependencies.
4. Update `src-tauri/tauri.conf.json` as needed.

**Example:**
```json
// package.json
"version": "1.2.3"
```
```toml
# src-tauri/Cargo.toml
version = "1.2.3"
```

---

### Door Component Development

**Trigger:** When you want to add, update, or refactor a door (UI) component.  
**Command:** `/new-door-component`

1. Edit or add the component in `doors/render/components.tsx`.
2. Register the component and its schema in `doors/render/catalog.ts`.
3. Wire up the component in `doors/render/registry.ts`.
4. Optionally, update `doors/render/render.tsx` for routing or agent prompt logic.
5. Optionally, update or create supporting documentation.

**Example:**
```tsx
// doors/render/components.tsx
export const DoorWidget = (props) => { ... }

// doors/render/catalog.ts
catalog.register('DoorWidget', DoorWidgetSchema);

// doors/render/registry.ts
registry.add('DoorWidget', DoorWidget);
```

---

### Door Code Review Fix

**Trigger:** When you want to address code review feedback for door-related code.  
**Command:** `/review-fix`

1. Edit affected files in `doors/render/`, `doors/manifest/`, or `doors/reader/`.
2. Edit related shared components (e.g., `src/components/BlockItem.tsx`).
3. Edit `package.json` if dependencies or devDependencies are involved.
4. Optionally, update or add documentation/specs.

---

### Component Extraction Refactor

**Trigger:** When you want to refactor a large component by extracting logic/UI into smaller hooks or components.  
**Command:** `/extract-component`

1. Move logic/UI from a large file (e.g., `src/components/BlockItem.tsx`) into a new file (e.g., `src/hooks/useContentSync.ts` or `src/components/BlockOutputView.tsx`).
2. Update imports in the original file to use the new module.
3. Repeat for additional extractions as needed.

**Example:**
```tsx
// src/hooks/useContentSync.ts
export function useContentSync() { ... }

// src/components/BlockItem.tsx
import { useContentSync } from '../hooks/useContentSync';
```

---

### Artifact Handler Enhancement

**Trigger:** When you want to improve artifact handling logic, especially content type detection and error handling.  
**Command:** `/improve-artifact-handler`

1. Edit `src/lib/handlers/artifactTransform.ts` and/or `artifactHandler.ts`.
2. Update or add tests in `src/lib/handlers/artifactTransform.test.ts`.
3. Optionally, update related UI or error display logic.

**Example:**
```ts
// src/lib/handlers/artifactTransform.ts
export function detectContentType(artifact: Artifact): string { ... }
```

---

### Expand/Collapse Navigation Refactor

**Trigger:** When you want to improve or document expand/collapse navigation logic.  
**Command:** `/refactor-expand-collapse`

1. Move or refactor navigation utilities (e.g., `findTabIdByPaneId`).
2. Remove dead or unused code related to expansion/collapse.
3. Update or add architecture documentation in `docs/architecture/` or `.claude/rules/`.
4. Update imports in affected files.

**Example:**
```ts
// src/lib/expansionPolicy.ts
export function findTabIdByPaneId(paneId: string): string | undefined { ... }
```

---

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test files:** Use the pattern `*.test.ts`
- **Example:**
  ```ts
  // src/lib/handlers/artifactTransform.test.ts
  import { detectContentType } from './artifactTransform';

  test('detects image content type', () => {
    expect(detectContentType({ mime: 'image/png' })).toBe('image');
  });
  ```

---

## Commands

| Command                   | Purpose                                                        |
|---------------------------|----------------------------------------------------------------|
| /new-api-endpoint         | Add or update a backend API endpoint                           |
| /release                  | Prepare and release a new version                             |
| /new-door-component       | Add, update, or refactor a door (UI) component                |
| /review-fix               | Address code review feedback for door-related code             |
| /extract-component        | Refactor by extracting logic/UI into smaller modules           |
| /improve-artifact-handler | Enhance artifact handling logic and related tests              |
| /refactor-expand-collapse | Refactor or document expand/collapse navigation logic          |
```
