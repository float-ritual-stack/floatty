# Render Spec Builder — assemble templates by hand, hand them to agents

**Status**: design settled 2026-08-18 (brainstorm during the overnight render
legibility session — [[PR #388]]/[[PR #389]]/[[PR #390]] context). Not yet
planned or built; this doc is the spec that a `writing-plans` pass turns into
units.

## The itch (Evan, verbatim shape)

> "getting an itch for like, a little drag and drop form/page builder so i can
> play around with things … make a template easily and point an agent at it for
> a reference instead of me getting into prompt-fight loops of 'no thats wrong'
> … let me assemble it myself"

Plus two follow-ups that shaped the design:

1. "can we ensure the json render dev tools are hooked up to that part as
   well? they are handy" — and, on inspection: "dev tools dont let us
   edit/change values … if we can make it so we can change values, that would
   be handy."
2. "how will we list previously saved ones so i can go back and edit them?"

The failure mode this kills: agent generates a spec → Evan says "no, that's
wrong" → agent regenerates → repeat. The template IS the instruction. Assembly
by hand, reference by path (or block), zero prompt-fighting about layout.

## Where it lives

**A second mode inside `apps/render-reference`** — not a new app. That app
already has everything expensive: the real `bbsCatalog` + `bbsRegistry` via the
`@render-door` vite alias, `markDevtoolsActive()` at module scope (so
`data-jr-key` is on every rendered element from first paint), the `<Key>`
provider re-key for per-spec state isolation, and 14 typed reference specs to
fork from. A standalone app would duplicate all of it and then drift.

Sidebar grows a mode switch: **Gallery** (existing, untouched) / **Builder**.

## Ground truth the design leans on (verified 2026-08-18)

- **Drop targets are a lookup, not a heuristic.** All 90 catalog components
  (81 `shared.ts` + 9 `door.ts`) declare `slots`: 70 declare `[]` (can never
  accept children), 19 declare `["default"]`, exactly one — `DocLayout` —
  declares `["sidebar", "main"]`. Validity of any drop is
  `catalog[type].slots`, exhaustively. 70/90 of the screen dims statically
  during a drag.
- **DOM→spec mapping is already emitted.** `@json-render/solid`'s renderer
  wraps every element with `data-jr-key={elementKey}` when devtools is active
  (`packages/solid/src/renderer.tsx:404`); render-reference already activates
  it at module load.
- **The devtools package is a composable kit, not a monolith.**
  `@json-render/devtools` exports `createSelectionBus`, `DEVTOOLS_KEY_ATTR`,
  `findElementByKey`, `highlightElement`, `setHoverHighlight`, `startPicker`,
  and per-tab constructors. The hit-testing/highlight layer for canvas DnD is
  already written there.
- **Devtools is read-only by design** (verified: no mutation surface in
  `packages/devtools/src`). That is what makes composition clean — devtools
  owns observation, the builder owns mutation, and they share one selection.
- **Prop shapes are mostly trivial.** Across the catalog: 258 `z.string()`,
  80 `z.number()`, 26 `z.enum()`, 13 `z.boolean()` — native controls. The tail
  (39 `z.array`, ~37 non-wrapper `z.object`, 17 `directiveOr`, 4 `z.record`)
  gets a JSON-textarea escape hatch, not bespoke UI.
- **Upstream prior art** (`~/projects/_reference/json-render`, v0.20.0):
  `examples/next-website-builder` is a JSON-tree editor + live preview with
  module-variable persistence — a reference for the debounced-preview loop,
  nothing to copy for assembly or persistence.

## Decisions (all Evan-endorsed in the brainstorm)

- **D1 — Artifact**: primary target is a **committed spec file in the repo**;
  posting a `render::` block to the outline is a second export, clipboard the
  third. Same serialization, three destinations.
- **D2 — Assembly UX**: **true canvas drag-and-drop, plus a tree pane**.
  Canvas for directness; tree as the escape hatch for elements canvas can't
  hit (zero-height, collapsed, overlapping). Evan explicitly asked to keep the
  tree ("that tends to be useful sometimes").
- **D3 — Devtools stay wired and read-only**: the panel renders as today; a
  shared `createSelectionBus` links canvas / builder tree / devtools Spec tab.
  Editing lives in the builder's props pane, not inside the shadow-DOM panel.
- **D4 — Editable values**: props pane generates controls from the Zod
  schema; live-applies to the spec (debounced for text inputs).
- **D5 — Persistence & listing**: saves land as
  `src/specs/saved/<name>.json`, auto-discovered by
  `import.meta.glob('./specs/saved/*.json', { eager: true })` (vite ^6.0.0 —
  available, no prior usage). Sidebar gains a SAVED section under the curated
  REFERENCE list; clicking a saved entry opens it in the builder for editing.
  The curated 14 stay hand-listed TS — they are the contract harness and must
  not be diluted by scratch templates.
- **D6 — Fork-don't-blank**: the builder opens on a copy of any gallery or
  saved spec (or empty `Stack` root). Realistic path to a template is "fork
  `sprintWrapSpec`, rearrange" — useful on day one.

## Architecture

One `Spec` in a Solid store. Every interaction is a pure transform. Canvas,
tree, props form, and devtools are four views over the same object.

```text
palette drag ──┐
canvas drop  ──┤
tree drag    ──┼──▶ specStore.apply(op) ──▶ Spec ──┬──▶ Renderer (canvas, data-jr-key)
props edit   ──┘        │                          ├──▶ TreePane
                   undo stack (spec snapshots)     ├──▶ PropsForm (selection)
                                                   └──▶ devtools panel (read-only)
                        selection: createSelectionBus() shared by all four
```

### Units

| unit | job | depends on |
|---|---|---|
| `builder/specStore.ts` | the `Spec` + pure ops (`insertElement`, `moveElement`, `removeElement`, `setProp`, `renameKey`) + undo/redo as snapshot array | nothing — pure, unit-testable |
| `builder/dropTargets.ts` | `(catalog, spec, pointerXY, rects) → {parentKey, slot, index} \| null` — slot lookup + sibling-gap math | catalog `slots`; pure given rects |
| `builder/Palette.tsx` | 90 components, grouped by the catalog's section comments, searchable; drag source | catalog |
| `builder/Canvas.tsx` | existing `Renderer` + drag overlay: dim invalid targets, insertion indicator at the computed gap | `dropTargets`, `DEVTOOLS_KEY_ATTR` utilities |
| `builder/TreePane.tsx` | select / reorder / reparent; keyboard-friendly | `specStore`, selection bus |
| `builder/PropsForm.tsx` | Zod → controls (string/number/enum/boolean native; array/object/directive as validated JSON textarea) | catalog schema, `specStore` |
| `builder/specIntegrity.ts` | `checkSpecIntegrity(spec)` — `root`/child refs resolve in `elements`, no duplicate refs, no orphans; the save gate after `bbsCatalog.validate` | nothing — pure, unit-testable |
| `builder/exporters.ts` | Save → dev-server endpoint writes `saved/<name>.json` · Post → floatty `POST /api/v1/blocks` with `render:: [title:: <name>] {spec}` · Copy → clipboard (reuses [[PR #390]]'s `toRenderBlock`) | — |
| `builder/savedSpecs.ts` | `import.meta.glob` discovery + name/slug handling | vite |

### Key mechanics

- **New-element keys**: slugified type + counter (`text-3`), collision-checked
  against the spec. Rename allowed in the tree (updates all `children` refs —
  a `specStore` op, so it's atomic and undoable).
- **Drop resolution order**: pointer → deepest `[data-jr-key]` under cursor →
  walk up until a component whose `slots` is non-empty → compute gap index
  against that element's children rects. `DocLayout`'s two named slots resolve
  by which slot container the pointer is inside; if ambiguous, default `main`.
- **Save endpoint**: a tiny vite dev-server middleware (`configureServer`) —
  `POST /__builder/save {name, spec}` → validates via `bbsCatalog.validate`
  → then a **graph-integrity check** (see below) → writes
  `src/specs/saved/<slug>.json`. Dev-only; no production surface exists
  because the app is a dev tool.
- **Graph integrity (`builder/specIntegrity.ts`)**: `bbsCatalog.validate` only
  checks per-element props against the component schemas — it accepts a spec
  whose `root` is missing from `elements`, or whose `children` name keys that
  do not exist. Such a spec saves fine and then fails to render on reopen. So
  a pure `checkSpecIntegrity(spec) → {ok} | {ok: false, errors}` runs after
  catalog validation and rejects: unresolved `root`, any unresolved child key,
  duplicate child references, and elements unreachable from `root` (orphans).
  The save endpoint writes nothing unless both gates pass. `specStore` ops
  maintain these invariants by construction, so a failure here means a bug in
  an op or a hand-edited `saved/*.json`, not user error.
- **Post-to-outline**: uses `FLOATTY_URL`/`FLOATTY_API_KEY`-style config
  (dev server env or a small settings field); emits the `[title:: …]` marker
  per [[PR #389]] so the block lands atomically.

## Error handling

- Invalid drop (no slotted ancestor under pointer) → no indicator, drop is a
  no-op. Never guess a parent.
- `bbsCatalog.validate` failure on save → inline error, file not written.
- `checkSpecIntegrity` failure on save (dangling `root`/child ref, duplicate
  ref, orphaned element) → inline error listing the offending keys, file not
  written. Reject before write, never repair silently: a written spec that
  cannot be reopened is the worse failure.
- Save-endpoint write failure → surfaced in the UI; spec stays in memory.
- Props JSON textarea → parse-on-blur with inline error; store untouched until
  valid.
- Undo depth capped (e.g. 100 snapshots) — specs are small; snapshots are fine.

## Testing

- `specStore` ops: pure unit tests (insert/move/remove/rename ref-integrity,
  undo/redo round-trips). The rename-updates-all-children-refs case is the one
  that will regress silently — pin it.
- `dropTargets`: table-driven tests with synthetic rects — leaf rejection,
  nested slot resolution, gap indices at boundaries, `DocLayout` named slots.
- `specIntegrity`: fixture specs that `bbsCatalog.validate` accepts but the
  integrity check must reject — missing `root` element, child key absent from
  `elements`, same key referenced twice, element unreachable from `root` — plus
  a valid nested spec that passes. This is the gate the catalog does not cover.
- Exporters: serialization snapshot — `saved/*.json` round-trips through
  `JSON.parse` into a spec `bbsCatalog.validate` accepts, and `toRenderBlock`
  output matches the [[PR #390]] shape.
- Contract harness unchanged: curated specs still typecheck under strict TS;
  builder code lives under `src/builder/` and does not touch `src/specs/*.ts`.

## Non-goals (this iteration)

- No editing inside the devtools shadow-DOM panel (composition, not fork).
- No streaming/agent generation inside the builder (assembly is the point).
- No SQLite / server persistence — `saved/*.json` in git IS the persistence,
  matching D1. Revisit only if templates need to exist off this machine
  without the repo.
- No floatty-app embedding of the builder (it stays a dev-server tool; the
  *output* is what enters floatty).
- No mobile/touch DnD.

## Open questions (fine to resolve during planning)

- Palette grouping: derive from `shared.ts` section comments vs a small
  hand-curated grouping map. (Lean: hand-curated map — comments aren't data.)
- Whether Post-to-outline needs a parent picker or always lands under a fixed
  `templates` page. (Lean: fixed page first.)
