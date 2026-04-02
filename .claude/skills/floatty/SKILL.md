```markdown
# floatty Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you the core development patterns, coding conventions, and workflows used in the `floatty` TypeScript codebase, which is built with the Vite framework and features a hybrid Rust backend via Tauri. You'll learn how to contribute features, refactor components, manage configuration, and maintain code quality using the project's established conventions and workflows.

---

## Coding Conventions

### File Naming

- Use **camelCase** for file names.
  - Example: `blockItem.tsx`, `artifactTransform.ts`

### Imports

- Use **relative imports** for local modules.
  ```ts
  import { useBlockLogic } from '../hooks/useBlockLogic'
  ```

### Exports

- Prefer **named exports**.
  ```ts
  // Good
  export function useBlockLogic() { ... }

  // Good
  export const BlockItem = () => { ... }
  ```

### Commit Messages

- Use **Conventional Commits** with these prefixes: `fix`, `feat`, `chore`, `refactor`, `docs`
- Average commit message length: ~59 characters
  - Example: `feat: add deep link support to doors catalog`

---

## Workflows

### Release Version Bump

**Trigger:** When releasing a new version to users  
**Command:** `/release`

1. Update `CHANGELOG.md` with new version details.
2. Update the `version` field in `package.json`.
3. Update `src-tauri/Cargo.toml` and/or `src-tauri/Cargo.lock` for the Rust backend version.
4. Update `src-tauri/tauri.conf.json` if configuration changes are needed.
5. Commit with a message containing `release` or `changelog`.

**Example:**
```sh
# Update files as needed, then:
git commit -am "chore(release): v1.2.3"
```

---

### Add or Refactor Component

**Trigger:** When implementing new UI features or refactoring for clarity  
**Command:** `/add-component`

1. Create or modify component files in `src/components/` or `doors/render/components.tsx`.
2. If refactoring, extract logic into new hooks or component files.
3. Update related files (e.g., registry, catalog, views) to use the new/extracted component.
4. Update or add tests if needed.

**Example:**
```tsx
// src/components/MyNewComponent.tsx
export const MyNewComponent = () => <div>New!</div>
```
```ts
// src/hooks/useMyLogic.ts
export function useMyLogic() { ... }
```

---

### Door System Feature or Refactor

**Trigger:** When extending or improving the doors system (e.g., new door, deep link, catalog update)  
**Command:** `/add-door-feature`

1. Modify or add files in `doors/render/` (e.g., `catalog.ts`, `components.tsx`, `registry.ts`, `render.tsx`).
2. Update or add door manifest files (`door.json`).
3. Update related documentation/specs if needed (e.g., `docs/specs/DOORS-V2-DEEP-LINKS.md`).
4. Wire up new actions or handlers in `src/components/` or `src/lib/handlers`.

**Example:**
```ts
// doors/render/catalog.ts
export const newDoor = { ... }
```

---

### Config-Driven Feature

**Trigger:** When making a feature configurable (e.g., sidebar width, child render limit)  
**Command:** `/add-config-field`

1. Add or update a field in `src-tauri/src/config.rs` (Rust config struct).
2. Update `src/lib/tauriTypes.ts` to reflect config changes.
3. Update frontend components to read/use the config (e.g., `src/components/Terminal.tsx`).
4. Persist/read config in Rust and JS as needed.

**Example:**
```rust
// src-tauri/src/config.rs
pub struct Config {
    pub sidebar_width: u32,
    // ...
}
```
```ts
// src/lib/tauriTypes.ts
export interface Config {
  sidebarWidth: number
}
```

---

### Extract Shared Hook or Logic

**Trigger:** When logic in a component becomes complex or is duplicated across files  
**Command:** `/extract-hook`

1. Identify shared logic in a component (e.g., `BlockItem.tsx`).
2. Extract logic into a new hook or module in `src/hooks/`.
3. Update original component(s) to use the new hook.
4. Update related components to use the hook as needed.

**Example:**
```ts
// src/hooks/useBlockLogic.ts
export function useBlockLogic() { ... }
```
```tsx
// src/components/BlockItem.tsx
import { useBlockLogic } from '../hooks/useBlockLogic'
```

---

### Fix or Improve Artifact Handler

**Trigger:** When artifact rendering or detection needs improvement (e.g., new file types, error handling)  
**Command:** `/fix-artifact`

1. Modify `src/lib/handlers/artifactTransform.ts` and related test files.
2. Update `src/lib/handlers/artifactHandler.ts` if needed.
3. Add or update tests in `artifactTransform.test.ts`.
4. Commit with `fix(artifact)` or `feat(artifact)` in the message.

**Example:**
```ts
// src/lib/handlers/artifactTransform.ts
export function detectArtifactType(file: File) { ... }
```
```ts
// src/lib/handlers/artifactTransform.test.ts
import { detectArtifactType } from './artifactTransform'
test('detects image type', () => { ... })
```

---

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test file pattern:** `*.test.ts`
- Place test files alongside or near the modules they test.
- Use named imports/exports in test files.

**Example:**
```ts
// src/lib/handlers/artifactTransform.test.ts
import { detectArtifactType } from './artifactTransform'

test('detects PDF files', () => {
  expect(detectArtifactType('file.pdf')).toBe('pdf')
})
```

---

## Commands

| Command           | Purpose                                                        |
|-------------------|----------------------------------------------------------------|
| /release          | Prepare and release a new version                              |
| /add-component    | Add or refactor a UI component                                |
| /add-door-feature | Add or refactor a feature in the doors system                 |
| /add-config-field | Add or update a configuration-driven feature                   |
| /extract-hook     | Extract shared logic into a reusable hook or module            |
| /fix-artifact     | Fix or improve artifact handler logic                          |
```
