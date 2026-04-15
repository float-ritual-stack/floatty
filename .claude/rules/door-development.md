---
paths:
  - "apps/floatty/doors/**/*"
  - "apps/floatty/src/lib/handlers/doorLoader.ts"
  - "apps/floatty/src/lib/handlers/doorAdapter.ts"
  - "apps/floatty/src/lib/handlers/doorSandbox.ts"
  - "apps/floatty/src/lib/handlers/doorTypes.ts"
  - "apps/floatty/src/lib/doorStdlib.ts"
  - "apps/floatty/scripts/compile-door-bundle.mjs"
---

# Door Development Patterns

## Door Module Exports

A door module MUST export `door` and `meta`. The `default` export is NOT used by the loader.

```typescript
export const meta = { id: 'my-door', name: 'My Door', version: '0.0.1', selfRender: true };
export const door = {
  kind: 'view' as const,
  prefixes: ['my-door::'],
  async execute(blockId, content, ctx) { ... },
  view: MyDoorView,
};
```

`validateDoorModule` checks `mod.door` and `mod.meta` — missing either = load failure.

## defineRegistry Destructuring (FM #18)

```typescript
// ✅ CORRECT — destructure the return
const { registry } = defineRegistry(catalog, { components: { ... } });

// ❌ WRONG — gives wrapper object. Symptom: "No renderer for component type" warning, empty render
const registry = defineRegistry(catalog, { components: { ... } });
```

## Renderer Provider Stack (4 deep, this order)

```tsx
<StateProvider initialState={spec.state || {}}>
  <ActionProvider handlers={{}}>
    <VisibilityProvider>
      <ValidationProvider>
        <Renderer spec={spec} registry={registry} />
      </ValidationProvider>
    </VisibilityProvider>
  </ActionProvider>
</StateProvider>
```

Missing any = crash. Wrong order = crash.

## selfRender Execution Model

selfRender doors fire `execute` when user presses Enter (command handler pattern). Blocks created via API don't auto-execute. The `execute` function calls `ctx.actions.setBlockOutput()` to set Y.Doc output. The `view` component renders that output.

## Door Output Lives in Y.Doc

`outputType` and `output` are Y.Doc fields, NOT in SQLite. REST `/api/v1/blocks/:id` shows them as null even when they exist. To verify door output: use MCP `webview_screenshot` or `webview_execute_js` to inspect DOM.

## Deploy Path (CRITICAL — loader expects index.js)

The door loader reads `{doorDir}/index.js`. NOT `render.js`, NOT `{id}.js`.

### Monorepo paths (post-monorepo shift)

Source and script now live under `apps/floatty/`. The deploy target didn't change — it's still the user-level `~/.floatty{,-dev}/doors/` dir. Only the source/script paths shifted.

```bash
# ✅ CORRECT — run from apps/floatty/
cd apps/floatty && node scripts/compile-door-bundle.mjs doors/render/render.tsx ~/.floatty-dev/doors/render/index.js

# OR from repo root, with full paths
node apps/floatty/scripts/compile-door-bundle.mjs apps/floatty/doors/render/render.tsx ~/.floatty-dev/doors/render/index.js

# Deploy to BOTH dev and release (user runs release daily)
cp ~/.floatty-dev/doors/render/index.js ~/.floatty/doors/render/index.js

# ❌ WRONG — pre-monorepo path, script no longer at repo root
node scripts/compile-door-bundle.mjs doors/render/render.tsx ~/.floatty-dev/doors/render/index.js

# ❌ WRONG — loader ignores this file entirely (wrong filename)
node apps/floatty/scripts/compile-door-bundle.mjs apps/floatty/doors/render/render.tsx ~/.floatty/doors/render/render.js
```

### Deploy target paths

| Profile | Source of truth | Deploy target |
|---|---|---|
| Debug (`tauri dev`) | `apps/floatty/doors/{id}/*.tsx` | `~/.floatty-dev/doors/{id}/index.js` |
| Release (`tauri build`) | Same source | `~/.floatty/doors/{id}/index.js` |

Path resolution: `paths.rs → default_root()` uses `#[cfg(debug_assertions)]` to pick `.floatty-dev` vs `.floatty`. The doors dir is always `{root}/doors/`.

**Burned 2026-03-27**: Deployed all session to `render.js` instead of `index.js`. Release build ran stale 7:50 AM code while we thought fixes were live. Every "it's not working" was this bug.

**Burned 2026-04-15**: Ran `node scripts/compile-door-bundle.mjs ...` from repo root after the monorepo shift. Script lives at `apps/floatty/scripts/` now — old path errors out with `Cannot find module`. Update the rule when you move files.

## Hot-Reload

File watcher detects changes in `~/.floatty-dev/doors/`. Logs `[doors] Hot-reloaded: {id}` on success. No app restart needed for door code changes.

## isOutputBlock for Doors

```typescript
if (ot === 'door' && block()?.content === '') return true;  // adapter — hide contentEditable
return false;  // selfRender with content — keep contentEditable, render output below
```

Use `=== ''` not `!content` (falsy check catches "0").

## DOMPurify on All innerHTML

Every `innerHTML` in door components MUST use `DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })`.

## Testing ErrorBoundary Fallbacks

Build a door that throws during render, compile with `compile-door-bundle.mjs`, deploy to `~/.floatty-dev/doors/`, hot-reload picks it up. Create block with door prefix, press Enter to execute. Cannot trigger ErrorBoundary from MCP alone — Y.Doc isn't accessible from `webview_execute_js`.
