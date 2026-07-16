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

## Door Views Have No Effects/Refs — Use Memos + Event Handlers (FLO-815)

A door view runs under the **door bundle's own Solid runtime** (solid-js is bundled per-door, not shared with the host). The host mounts the view via `<Dynamic>` in `DoorHost.tsx`, so the door runtime never receives an owner context. Consequence:

- ✅ **Fire in door views**: `createMemo`, `createSignal` (pull-based — read during render), event handlers (`onClick`, etc.), and rendering primitives (`<For>`, `<Show>`, `innerHTML=`).
- ❌ **Do NOT fire**: `createEffect`, `onMount`, `onCleanup`, and **refs** (both `ref={var}` and `ref={(el)=>…}`). They execute without an owner, so the scheduler never runs/disposes them.

This is silent — `createEffect` code that passes in a jsdom test (one shared runtime) does nothing in the app. FLO-815's first cut used a ref + `createEffect` to transform the rendered DOM post-mount; it rendered correctly in jsdom and did nothing live.

**The pattern**: compute derived structure at *render time* inside a `createMemo`, not in a post-mount effect. For DOM you'd normally build after mount, build it into the HTML string instead (DOMParser → transform → DOMPurify → `innerHTML`), and read anything you need at interaction time from the event's DOM ancestry (`e.currentTarget.closest(...)`) rather than a ref. See `doors/read/readDoc.ts::renderReaderDoc` for the reference.

> Sidebar doors (mounted via `SidebarDoorContainer`, not `DoorHost`/`<Dynamic>`) may sit under a different owner — do not assume the same constraint there without checking. This rule is specifically about **block-output** door views.

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

### Monorepo paths

Doors split into two source layouts depending on whether they have peer-app consumers:

- **Single-consumer doors** (most): source under `apps/floatty/doors/{id}/`. Compiled via `apps/floatty/scripts/compile-door-bundle.mjs` and deployed to `~/.floatty{,-dev}/doors/{id}/index.js`.
- **Multi-consumer doors** (currently just `render`): source extracted to `packages/{id}-door/src/`, with a `package.json` build script that wraps the same compile script. Consumed by the floatty Tauri app at runtime AND by `apps/render-reference` (or other peer apps) at compile time via workspace dependency.

The deploy target — `~/.floatty{,-dev}/doors/{id}/index.js` — is the same in both layouts. Only where the source lives differs.

```bash
# ✅ render door (now a package — phase-2 monorepo)
pnpm --filter @floatty/render-door run deploy:dev    # debug only
pnpm --filter @floatty/render-door run deploy:all    # debug + release

# ✅ Single-consumer doors (still under apps/floatty/doors/)
cd apps/floatty && node scripts/compile-door-bundle.mjs doors/{id}/{id}.tsx ~/.floatty-dev/doors/{id}/index.js

# OR from repo root, with full paths
node apps/floatty/scripts/compile-door-bundle.mjs apps/floatty/doors/{id}/{id}.tsx ~/.floatty-dev/doors/{id}/index.js

# Deploy to BOTH dev and release (user runs release daily)
cp ~/.floatty-dev/doors/{id}/index.js ~/.floatty/doors/{id}/index.js

# ❌ WRONG — pre-monorepo path, script no longer at repo root
node scripts/compile-door-bundle.mjs doors/{id}/{id}.tsx ~/.floatty-dev/doors/{id}/index.js

# ❌ WRONG — loader ignores this file entirely (wrong filename)
node apps/floatty/scripts/compile-door-bundle.mjs apps/floatty/doors/{id}/{id}.tsx ~/.floatty/doors/{id}/{id}.js

# ❌ WRONG — old render-door path, source moved to packages/render-door/src/
node apps/floatty/scripts/compile-door-bundle.mjs apps/floatty/doors/render/render.tsx ~/.floatty-dev/doors/render/index.js
```

### Deploy target paths

| Profile | Source of truth | Deploy target |
|---|---|---|
| Debug (`tauri dev`) | `packages/{id}-door/src/` (extracted) OR `apps/floatty/doors/{id}/` (single-consumer) | `~/.floatty-dev/doors/{id}/index.js` |
| Release (`tauri build`) | Same source | `~/.floatty/doors/{id}/index.js` |

Path resolution: `paths.rs → default_root()` uses `#[cfg(debug_assertions)]` to pick `.floatty-dev` vs `.floatty`. The doors dir is always `{root}/doors/`.

**Burned 2026-03-27**: Deployed all session to `render.js` instead of `index.js`. Release build ran stale 7:50 AM code while we thought fixes were live. Every "it's not working" was this bug.

**Burned 2026-04-15**: Ran `node scripts/compile-door-bundle.mjs ...` from repo root after the monorepo shift. Script lives at `apps/floatty/scripts/` now — old path errors out with `Cannot find module`. Update the rule when you move files.

**Phase 2 (2026-04-22)**: render-door extracted from `apps/floatty/doors/render/` to `packages/render-door/` after `apps/render-reference` (the contract harness) became a regular consumer. Pattern: when a door grows a peer-app consumer, promote it to `packages/`. The compile script (`apps/floatty/scripts/compile-door-bundle.mjs`) stays put — it's shared infrastructure, not door-specific. The package's `pnpm build` calls it via relative path.

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
