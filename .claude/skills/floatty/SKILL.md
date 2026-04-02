```markdown
# floatty Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches the core development patterns, coding conventions, and workflows used in the `floatty` TypeScript codebase, which is built on Vite. It covers best practices for component extraction, artifact handler updates, release management, code review fixes, UI state persistence, and more. The guide includes concrete coding examples, step-by-step workflow instructions, and suggested automation commands to streamline common tasks.

---

## Coding Conventions

**File Naming**
- Use `camelCase` for file names.
  - Example: `blockItem.tsx`, `useContentSync.ts`

**Import Style**
- Use relative imports.
  - Example:
    ```ts
    import { useContentSync } from '../hooks/useContentSync';
    ```

**Export Style**
- Prefer named exports.
  - Example:
    ```ts
    export function BlockItem() { ... }
    ```

**Commit Messages**
- Follow [Conventional Commits](https://www.conventionalcommits.org/) with these prefixes: `fix`, `feat`, `chore`, `refactor`, `docs`.
  - Example: `feat: add persistent sidebar width to config`
- Average commit message length: ~59 characters.

---

## Workflows

### Component Extraction Refactor
**Trigger:** When a component grows too large or contains reusable logic/UI that should be separated.  
**Command:** `/extract-component`

1. Identify reusable logic or UI in an existing component file (e.g., `BlockItem.tsx`).
2. Create a new file (e.g., `useContentSync.ts`, `BlockOutputView.tsx`) in `src/hooks/` or `src/components/`.
3. Move the relevant code from the original component to the new file.
4. Update the original component to import and use the new hook/component.
5. Test to ensure all functionality remains intact.

**Example:**
```tsx
// src/hooks/useContentSync.ts
export function useContentSync() { ... }

// src/components/BlockItem.tsx
import { useContentSync } from '../hooks/useContentSync';
```

---

### Add or Update Door Component
**Trigger:** When a new UI component is needed in the render:: door system, or when updating the catalog with new features.  
**Command:** `/add-door-component`

1. Add or update component implementation in `doors/render/components.tsx`.
2. Update `doors/render/catalog.ts` to define schema and catalog entry.
3. Update `doors/render/registry.ts` for registry wiring.
4. Optionally update `doors/render/render.tsx` for routing or rendering logic.
5. Test new or updated component.

**Example:**
```ts
// doors/render/components.tsx
export function NewDoorComponent() { ... }

// doors/render/catalog.ts
export const doorCatalog = { ... };

// doors/render/registry.ts
import { NewDoorComponent } from './components';
```

---

### Release Version Bump
**Trigger:** When preparing a new release for deployment or distribution.  
**Command:** `/release`

1. Update version number in `package.json`.
2. Update version in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
3. Update `CHANGELOG.md` with release notes.
4. Optionally update `src-tauri/Cargo.lock`.
5. Commit with a `chore: release` message.

**Example:**
```json
// package.json
"version": "1.2.3"
```

---

### Code Review Feedback Fix
**Trigger:** When code review or PR feedback is received that requires changes.  
**Command:** `/review-fix`

1. Review feedback from PR or code review.
2. Make necessary changes in the relevant files (often multiple, across `src/`, `doors/`, `package.json`, etc.).
3. Commit with a `fix: address review feedback` message.
4. Ensure all tests pass.

---

### Add or Update Artifact Handler
**Trigger:** When improving artifact rendering or adding support for new artifact types/dependencies.  
**Command:** `/update-artifact-handler`

1. Update `src/lib/handlers/artifactTransform.ts` and/or `artifactHandler.ts` with new logic.
2. Add or update tests in `artifactTransform.test.ts`.
3. Commit with a `feat(artifact):` or `fix(artifact):` message.
4. Test artifact rendering in the app.

**Example:**
```ts
// src/lib/handlers/artifactTransform.ts
export function transformArtifact(input) { ... }

// src/lib/handlers/artifactTransform.test.ts
import { transformArtifact } from './artifactTransform';
test('should transform artifact', () => { ... });
```

---

### Persist UI State to Config or LocalStorage
**Trigger:** When a UI state should be remembered between app restarts or browser reloads.  
**Command:** `/persist-ui-state`

1. Update UI component (e.g., `Terminal.tsx`) to read/write state from config or localStorage.
2. Update `src-tauri/src/config.rs` or `src/lib/tauriTypes.ts` if persisting to config.
3. Test persistence across reloads.
4. Commit with a `fix:` or `feat:` message.

**Example:**
```tsx
// src/components/Terminal.tsx
useEffect(() => {
  localStorage.setItem('sidebarWidth', sidebarWidth);
}, [sidebarWidth]);
```

---

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test File Pattern:** `*.test.ts`
- **Example:**
  ```ts
  // src/lib/handlers/artifactTransform.test.ts
  import { transformArtifact } from './artifactTransform';

  test('transforms artifact correctly', () => {
    expect(transformArtifact('input')).toBe('expectedOutput');
  });
  ```

---

## Commands

| Command                | Purpose                                                      |
|------------------------|--------------------------------------------------------------|
| /extract-component     | Extract shared logic or UI into a new hook/component         |
| /add-door-component    | Add or update a door component and update catalog/registry   |
| /release               | Bump version, update changelog, and prepare for release      |
| /review-fix            | Address code review or PR feedback                           |
| /update-artifact-handler | Update artifact handling logic and tests                   |
| /persist-ui-state      | Persist UI state to config or localStorage                   |
```
