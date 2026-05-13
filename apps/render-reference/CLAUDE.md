# render-reference

Authoritative reference renderer + contract harness for the render door. Eight specs run through the real `@json-render/solid` pipeline using the live `@floatty/render-door` catalog/registry/components — not hand-rolled CSS mimicry.

Full context: `apps/render-reference/README.md`.

## Stack

SolidJS + Vite + `@json-render/solid` (^0.19.0) + `@solid-primitives/keyed` for provider re-key on tab switch.

## Commands

```bash
pnpm dev          # vite dev server on :5199 (strictPort)
pnpm build        # vite production build → dist/
pnpm preview      # vite preview
pnpm typecheck    # tsc --noEmit, strict mode ON
```

Or via turbo from repo root:

```bash
turbo run typecheck --filter render-reference
turbo run build --filter render-reference
```

## Cross-package wiring (PR #262)

Render-reference is the contract harness for `packages/render-door/`. The render door's catalog and components live in that package; render-reference imports them via:

- **Workspace dep**: `"@floatty/render-door": "workspace:*"` in `package.json`
- **Vite alias**: `'@render-door': path.resolve(__dirname, '../../packages/render-door/src')` in `vite.config.ts` — kept for import-statement stability so spec files use `@render-door/catalog` instead of churning to `@floatty/render-door/catalog`. The workspace dep declares the relationship; the alias gives vite the on-disk path.
- **tsconfig paths**: `"@render-door/*": ["../../packages/render-door/src/*"]`

When the render door's catalog/component types drift, render-reference's `tsc --noEmit` catches it. This is the harness doing its job — three real bugs surfaced this way during PR #260/#262: json-render 0.18 `JSONUIProvider` shape change, Zod 4 `z.record()` arity, `generateSpecViaAgent` returning unnormalized spec.

## Strict mode is on

`tsconfig.json` has `"strict": true`. Don't relax it without thinking — the contract-harness role *requires* strict for the bug-catching value to land.

## Provider re-key on spec switch (FLO-587 / PR #260)

The provider tree is wrapped in `<Key each={[activeId()]} by={(id) => id}>` so `StateProvider` reads `initialState` anew on every layout switch. Without this, state mutations from one spec persist silently into the next because `StateProvider` captures `initialState` once via `createStateStore` then reuses via a stored ref (verified in `node_modules/@json-render/solid/dist/index.mjs:17-22`).

When adding a spec that carries non-empty `state`, this is what makes it work cleanly across tab switches.

## Adding a reference spec

1. Create `src/specs/{layout-name}.ts` exporting a typed `Spec` from `@json-render/core`
2. Add an entry to the `LAYOUTS` array in `src/App.tsx` (`{ id, label, description, spec }`)
3. Update the count in the `// Our N reference specs` comment above the imports (currently 8)
4. Run `pnpm typecheck` to confirm strict-mode is happy

## Don't

- Don't hide the `as any` cast on `active().spec.state` — it was masking a json-render 0.18 API change in PR #260, and removing it surfaced the real fix (move `registry` and `catalog` to `<JSONUIProvider>`). Future ergonomic shortcuts here will likely hide similar drift.
- Don't drop the `<Key>` wrapper for performance — its purpose is correctness, not optimization. The cost is one provider remount per tab click; the benefit is per-spec state isolation.
- Don't bypass `pnpm typecheck` in CI verification — bundle works ≠ types are coherent. The harness's value is in catching contract drift early.

## See also

- `packages/render-door/README.md` — the door this app exercises
- `.claude/rules/door-development.md` — when to extract a door to `packages/` (the rule that explains why render-door lives where it does)
- `.float/work/render-door-package/PLAN.md` — extraction story (local-only, gitignored)
