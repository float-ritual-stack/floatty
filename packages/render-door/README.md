# @floatty/render-door

The `render::` door for floatty — the `@json-render/solid` catalog, component library, and registry that the floatty Tauri app loads at runtime and that `apps/render-reference` uses as its contract harness.

## What's in the box

- **`src/catalog.ts`** — ~44 component schemas (Zod → json-render). The single source of truth for what specs may target.
- **`src/components.tsx`** — SolidJS implementations for every catalog component. All `innerHTML` paths sanitized via DOMPurify.
- **`src/registry.ts`** — wires catalog to components via `defineRegistry`; exports `registry` and re-exports `bbsCatalog`.
- **`src/patterns.ts`** — common spec patterns referenced by prompt generation.
- **`src/render.tsx`** — door entrypoint consumed by the floatty runtime door loader (exports `door` + `meta`, implements `execute` + `view`).
- **`src/kanban.test.ts`** — smoke tests for a representative component.
- **`door.json`** — loader metadata (id, version, prefixes, `selfRender: true`).

## Who consumes it

### At runtime — `apps/floatty` (Tauri)

The floatty Tauri app's door loader reads `~/.floatty-dev/doors/render/index.js` (debug) or `~/.floatty/doors/render/index.js` (release). The compiled bundle is produced by `apps/floatty/scripts/compile-door-bundle.mjs` and deployed via `pnpm deploy` in this package.

### At compile time — `apps/render-reference`

The render-reference contract harness imports this package's source directly (via workspace dep + vite alias) to exercise every catalog + component pairing through the real `@json-render/solid` pipeline. When a catalog schema drifts or a component signature changes, the harness's strict-mode tsc surfaces it immediately. This is why the door lives in `packages/` now — its contracts are exercised by a peer app, not just by the app that owns it.

## Build + deploy

```bash
# Build the bundle (→ dist/index.js + dist/door.json)
pnpm --filter @floatty/render-door run build

# Deploy to debug profile only (~/.floatty-dev/doors/render/)
pnpm --filter @floatty/render-door run deploy:dev

# Deploy to both debug and release profiles (the usual development cycle)
pnpm --filter @floatty/render-door run deploy:all
```

The `pnpm run` prefix is required because pnpm has built-in commands named `deploy` and `install`; `pnpm run X` always invokes the package script regardless of name collisions.

`deploy:*` rebuilds before copying, so you don't need to run `build` separately. Hot-reload in a running floatty picks up the new bundle on its next file-watch tick.

## Typecheck

```bash
pnpm --filter @floatty/render-door typecheck
```

Runs `tsc --noEmit` in strict mode. Also runs from the root via `turbo run typecheck`, which uses the transit-node pattern to parallelize across packages while invalidating cache correctly when dependency source changes.

## History

Extracted from `apps/floatty/doors/render/` in [[PR #262]] after `apps/render-reference` (the contract harness) grew into a regular consumer of the door's types. Phase 1 of the monorepo colocated apps under `apps/*`; this is phase 2 — the first real cross-project package.
