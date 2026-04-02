```markdown
# floatty Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you the core development patterns, coding conventions, and coordinated workflows used in the `floatty` codebase—a TypeScript project built with Vite. The repository demonstrates a modular, testable approach to modern frontend and backend development, with a focus on structured logging, component modularity, and a robust "doors" UI system. You'll learn how to follow the team's conventions, refactor code, add features, and manage releases efficiently.

---

## Coding Conventions

**File Naming**
- Use `camelCase` for files and folders.
  - Example: `useContentSync.ts`, `blockItem.tsx`

**Import Style**
- Use **relative imports** for internal modules.
  - Example:
    ```ts
    import { createLogger } from '../lib/logger'
    import { useContentSync } from '../../hooks/useContentSync'
    ```

**Export Style**
- Prefer **named exports**.
  - Example:
    ```ts
    // src/lib/logger.ts
    export function createLogger() { ... }
    ```

**Commit Messages**
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  - Prefixes: `fix:`, `feat:`, `chore:`, `refactor:`, `docs:`
  - Example: `feat: add structured logging to block handlers`

---

## Workflows

### Multi-Layer Logging Refactor
**Trigger:** When upgrading or standardizing the logging system across the codebase  
**Command:** `/refactor-logging`

1. Implement or update the logging utility (e.g., `createLogger`) in `src/lib/logger.ts`.
2. Update ESLint or linting rules in `eslint.config.js` to enforce new logging standards.
3. Refactor related files (hooks, handlers, UI components) to replace `console.*` with structured logging.
   - Example:
     ```ts
     // Before
     console.log('Block updated:', blockId);

     // After
     import { logger } from '../lib/logger';
     logger.info({ blockId }, 'Block updated');
     ```
4. Update or fix related test files to mock or adapt to the new logging system.

**Files Involved:**  
`src/lib/logger.ts`, `eslint.config.js`, `src/lib/handlers/*.ts`, `src/components/*.tsx`, etc.

---

### Component Extraction and Hook Refactor
**Trigger:** When a component grows too large or logic needs to be reused/isolated  
**Command:** `/extract-hook`

1. Identify logic to extract from a large component (e.g., `BlockItem.tsx`).
2. Create a new hook or component file (e.g., `useContentSync.ts`, `BlockOutputView.tsx`).
3. Move relevant logic and refactor imports/exports.
   - Example:
     ```ts
     // src/hooks/useContentSync.ts
     export function useContentSync(...) { ... }
     ```
4. Update the original component to use the new hook/component.
5. Verify with or update tests.

**Files Involved:**  
`src/components/BlockItem.tsx`, `src/hooks/useContentSync.ts`, etc.

---

### Door Component Catalog Expansion
**Trigger:** When adding a new UI component to the doors/render system  
**Command:** `/add-door-component`

1. Implement new component(s) in `doors/render/components.tsx`.
2. Add component metadata/schema to `doors/render/catalog.ts`.
3. Register the component in `doors/render/registry.ts`.
4. Update related documentation or design tokens if needed.

**Example:**
```ts
// doors/render/components.tsx
export function DoorSlider(props) { ... }

// doors/render/catalog.ts
export const doorComponents = [
  ...,
  { name: 'DoorSlider', schema: { ... } }
];

// doors/render/registry.ts
import { DoorSlider } from './components';
registry.register('DoorSlider', DoorSlider);
```

---

### Door System Feature Development
**Trigger:** When adding a new door verb, route, or agent capability  
**Command:** `/add-door-verb`

1. Update or add new actions/verbs in `doors/render/catalog.ts`.
2. Implement or adapt logic in `doors/render/components.tsx` and `doors/render/render.tsx`.
3. Update `doors/render/registry.ts` for registration.
4. Update agent prompt logic or documentation if needed.
5. Add or update tests if applicable.

---

### Release Version Bump
**Trigger:** When a new version of the application is ready for release  
**Command:** `/release`

1. Update `CHANGELOG.md` with new version and changes.
2. Bump version in `package.json`.
3. Update version in `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
4. Update `src-tauri/Cargo.lock` if necessary.

---

### Config Persistence Refactor
**Trigger:** When persistence mechanism for a UI state needs to be changed or fixed  
**Command:** `/refactor-persistence`

1. Update frontend component logic (e.g., `Terminal.tsx`) to use new persistence method (e.g., from `localStorage` to config file).
   - Example:
     ```ts
     // Before
     localStorage.setItem('sidebarWidth', width);

     // After
     import { saveSidebarWidth } from '../lib/config';
     saveSidebarWidth(width);
     ```
2. Update backend config structs or Rust code if `config.toml` is involved.
3. Update type definitions (e.g., `src/lib/tauriTypes.ts`).
4. Remove or adapt old persistence logic.
5. Test persistence across reloads.

---

### Door System Bugfix and Review Sweep
**Trigger:** After a PR review or testing round uncovers multiple issues in the doors system  
**Command:** `/review-fixes`

1. Address review comments and bugfixes in `doors/render` and related components.
2. Update or move dependencies in `package.json`.
3. Update documentation/specs if needed.
4. Refactor duplicated or problematic logic.

---

## Testing Patterns

- **Framework:** [Vitest](https://vitest.dev/)
- **Test File Pattern:** `*.test.ts`
- **Placement:** Tests are located alongside source files or in related directories.
- **Example:**
  ```ts
  // src/lib/events/eventEmitter.test.ts
  import { createEventEmitter } from './eventEmitter';

  test('emits and listens to events', () => {
    const emitter = createEventEmitter();
    const handler = vi.fn();
    emitter.on('foo', handler);
    emitter.emit('foo', 42);
    expect(handler).toHaveBeenCalledWith(42);
  });
  ```

---

## Commands

| Command               | Purpose                                                      |
|-----------------------|--------------------------------------------------------------|
| /refactor-logging     | Standardize logging system across the codebase               |
| /extract-hook         | Extract logic from a component into a reusable hook/component|
| /add-door-component   | Add a new UI component to the doors/render system            |
| /add-door-verb        | Add a new verb/feature to the doors system                   |
| /release              | Prepare and publish a new release                            |
| /refactor-persistence | Change how UI/app state is persisted                         |
| /review-fixes         | Apply bugfixes and review findings across door-related files  |
```
