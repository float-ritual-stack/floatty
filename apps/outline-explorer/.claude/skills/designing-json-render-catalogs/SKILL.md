---
name: designing-json-render-catalogs
description: Design and maintain @json-render component catalogs for AI-driven UI in floatty projects. Use when adding a new component type, debugging "No renderer for component type" warnings, deciding between composed vs atomic components, reviewing token efficiency of AI-generated specs, filling catalog gaps, or wiring catalog → AI agent contract (catalog.prompt / catalog.jsonSchema / validateSpec). Covers the three-layer pattern (semantic / structural / inline), the silent-drop diagnostic, the catalog↔agent contract, render-door vs outline-explorer specifics, shared-vs-local components, and catalog-sprawl prevention.
---

# Designing json-render catalogs

Catalog design decides how many tokens the AI burns per spec and how reliable its output is. This skill codifies the rules from real debugging in the floatty-explorer codebase (PRs #2, #3) and the floatty render-door (catalog primitives extraction, 2026-04-26).

## Core principle

**Compose. The AI should reach for `PatternCard`, not assemble `Box` + `Border` + `Text`.**

A composed component = one spec element with rich props. The renderer encodes the layout once. The catalog `description` teaches the AI *when* to use it.

An atomic component = one element per visual primitive. The AI re-derives layout every generation — ~4x the tokens, dramatically more error-prone.

## The three-layer pattern

| Layer | Role | Examples | `slots` |
|-------|------|----------|---------|
| **Semantic** | One element = one meaningful unit with rich props | `PatternCard`, `ContextMarker`, `TimelineEvent`, `ObservationCard`, `StatusLine`, `GapItem` | `[]` |
| **Structural** | Containers that group semantic elements | `Section`, `Row`, `Timeline`, `Divider` | `["default"]` |
| **Inline atoms** | Text decoration inside prose | `Chip`, `Bold`, `InlineCode`, `WikilinkChip` | `[]` |

Every Semantic leaf should have a natural Structural container. If the AI reaches for a container you haven't named, that's a catalog gap — see "Silent-drop diagnostic" below.

## Catalog ↔ agent contract

A catalog isn't just runtime data — three primitives bind catalog choices to the AI's actual output:

| Primitive | What it does | When it fires |
|---|---|---|
| `catalog.prompt({ mode, customRules })` | Auto-generates the AI system prompt from component descriptions + zod prop schemas + actions | At agent invocation — read by the LLM |
| `catalog.jsonSchema({ strict })` | Exports JSON Schema for `--json-schema` constrained decoding (or Anthropic API tools format) | At agent invocation — constrains the LLM decoder |
| `catalog.validate(spec)` / `validateSpec(spec)` | Runs the catalog's zod schemas against the parsed spec | At runtime — guards renderer from silent-drop bugs |

**A catalog change without coordinated agent-side regeneration drifts.** If you add a component, the prompt is auto-updated (good); if you also have a hand-rolled JSON Schema or hand-listed components in a system prompt, those don't update automatically. The render-door's pre-2026-04-26 `RENDER_TOOL_SCHEMA` was an example of this drift.

**Operational rule for the floatty render-door agent path:** see `floatty/.claude/rules/render-door-agent.md` — path-globbed rule with mandatory pre-edit reads, ground-truth facts (strict-mode `record` collapse, etc.), and anti-patterns specific to the agent path.

## Shared vs local components

In the floatty monorepo, json-render catalogs split into two layers:

| Layer | Location | Consumed by |
|---|---|---|
| **Shared** | `packages/render-catalog/src/components/` (exports `sharedComponentDefinitions`, `doorComponentDefinitions`) | Both render-door (Solid) AND outline-explorer (React) |
| **App-local** | `packages/render-door/src/catalog.ts` (`bbsCatalog`); outline-explorer's `src/lib/catalog/explorer-catalog.ts` (`explorerCatalog`) | One consumer; composes shared + adds local components/actions |

**Implication**: a change to `packages/render-catalog/src/components/` ripples to BOTH apps. A change to `bbsCatalog` or `explorerCatalog` is local.

If a new component is genuinely shared, define it in `@float/render-catalog` and let each app pick it up. If it's specific to one app's domain (kanban, daily, the AI panel), define it in that app's local catalog.

## When to add a new component

- **Semantic component** → AI needs to express a new kind of meaning (new card type, new marker type).
- **Structural component** → an existing leaf needs a natural container and the AI is reaching for a name that doesn't exist in the catalog.
- **Do NOT add** a new component for a visual variant. Use a prop:

```
✅ Section with variant: "default" | "highlight" | "warning"
✅ GapItem with severity: "info" | "warning" | "critical"
❌ SectionHighlight, SectionWarning, GapItemCritical
```

Variant sprawl makes the catalog fat and the AI's choice paralysis worse. Props keep the catalog small and push variant decisions into data.

## Silent-drop diagnostic

`@json-render/react` (and `/solid`, `/vue`, etc.) returns `null` for unknown component types and logs a console warning:

```
[browser] No renderer for component type: Timeline
```

**The bug is invisible to the user** — the spec element is dropped along with its entire subtree, so any children of the missing container vanish silently.

**Triage:**

1. Console warning names the missing type → catalog gap confirmed.
2. Leaf or container? Usually container — the AI reaches for wrappers (`Row`, `Timeline`, `Grid`, `Stack`).
3. Add the catalog entry (see "File locations" below for the right file per consumer).
4. Add the renderer to the appropriate file (per consumer).
5. **Rebuild the artifact** (per consumer — see below).
6. Commit catalog + renderer + rebuild artifact in one commit.

PR #2 (`Row`) and PR #3 (`Timeline`) on outline-explorer are reference fixes — same shape, different name. When a third warning appears, fix the gap, don't argue with the AI.

## Token math

One composed element in the flat spec:

```json
"commit-1": {
  "type": "PatternCard",
  "props": { "label": "...", "description": "...", "confidence": "high" },
  "children": []
}
```

~60 tokens. The renderer handles border color, confidence dot, layout.

Atomic equivalent (`Box` + `Border` + `ColoredDot` + `BoldText` + `MutedText`) would be 5+ elements with keys, props, and children arrays — 250+ tokens per card, and the AI re-derives the layout every generation.

Over a typical spec response (10-20 semantic elements), composition saves ~1500-3500 tokens per call.

## File locations

### Outline-explorer specifics

| File | Role |
|------|------|
| `src/lib/catalog/explorer-catalog.ts` | Component definitions (zod props + descriptions) |
| `src/lib/catalog/renderers/analysis.tsx` | Semantic analysis cards (`PatternCard`, `GapItem`, `ObservationCard`) |
| `src/lib/catalog/renderers/nav.tsx` | Structural containers + chips (`Row`, `Timeline`, `Chip`, `SectionLabel`) |
| `src/lib/catalog/renderers/typography.tsx` | Inline text atoms (`Heading`, `Paragraph`, `Bold`) |
| `src/lib/catalog/renderers/block-primitives.tsx` | Outline block types (`ContextMarker`, `WikilinkChip`) |
| `src/lib/catalog/renderers/visualizations.tsx` | Rich data views (`LinkGraph`, `ActivityHeatmap`) |
| `src/lib/catalog/explorer-renderer.tsx` | Registry assembly via `defineRegistry` |
| `dist/mcp/index.html` | Pre-built MCP iframe bundle — rebuild with `pnpm mcp:build` |

### Render-door / floatty specifics

| File | Role |
|------|------|
| `packages/render-catalog/src/components/` | Shared component definitions (consumed by render-door + outline-explorer) |
| `packages/render-door/src/catalog.ts` | `bbsCatalog` — composes shared + door-local components/actions |
| `packages/render-door/src/registry.ts` | Registry assembly via `defineRegistry` for the Solid renderer |
| `packages/render-door/src/agent-schema.ts` | Catalog-derived agent primitives — JSON Schema export, system prompt builder |
| `packages/render-door/src/render.tsx` | Door wiring (`render::` prefix, agent invocation, view component) |
| `packages/render-door/dist/index.js` | Compiled door bundle — rebuild with `node apps/floatty/scripts/compile-door-bundle.mjs` (fetched at runtime by the door loader) |

### Shared (both)

| File | Role |
|------|------|
| `packages/render-catalog/src/components/*.ts` | Source of truth for shared component definitions; changes ripple to both apps |
| `~/projects/_reference/json-render/packages/{core,solid,react}/src/` | Authoritative json-render source (cloned, not in monorepo) |
| `~/float-hub/float.dispatch/references/json-render-docs.md` | Local docs snapshot of https://json-render.dev/docs |

## Anti-patterns

- **Visual-only primitives** (`Box`, `Container`, `Spacer`): you're decomposing when you should be composing. Exception: a truly generic *grouping* container (`Row`, `Timeline`) — that belongs in the Structural layer.
- **Renderer without a catalog entry**: the framework uses the catalog's props schema for AI instruction generation. A renderer the AI doesn't know about will never be emitted.
- **Catalog entry without a renderer**: produces the silent-drop bug above.
- **Skipping the artifact rebuild**: outline-explorer's `pnpm mcp:build` and render-door's `compile-door-bundle.mjs` produce pre-built bundles that drift from source if not refreshed. PR #2 surfaced this on outline-explorer — the artifact panel and inline chat rendered the same spec differently because the iframe was built from a different catalog state.
- **Describing what a component looks like** in the catalog `description`. Describe what it *means* and *when* to use it — the AI reads the description to decide whether to reach for the component, not to style it.
- **Loose zod for component props** (`z.record(z.unknown())`, `z.any()`): produces a useless prompt entry. The AI gets no guidance and emits arbitrary shapes that fail at render time. Encourage tight zod (`.enum`, `.literal`, named object shapes). The prompt size argument from "Variants as props" connects directly: tight schemas teach the AI; loose schemas don't.
- **Record-keyed catalog props** when relying on strict-mode `--json-schema`: `core/src/schema.ts:1486-1500` collapses records to opaque `{ type: "object", properties: {}, additionalProperties: false }` because LLM-strict subset forbids dynamic-key maps. The contributor sees no error; the LLM stops being constrained on that field. Either use named-object schemas, or accept that strict-mode protection won't reach record-typed props (and lean on `validateSpec` post-parse).
- **Hand-rolling JSON Schema next to the catalog**: call `catalog.jsonSchema(...)` and serialize at use-site. Hand-rolled schemas drift every time a component is added.

## Checklist for catalog edits

- [ ] Decided shared vs local: shared components → `packages/render-catalog/src/components/`; app-specific → app's local catalog
- [ ] Catalog entry added (zod props + description + slots)
- [ ] Renderer added in the matching renderer file (per consumer)
- [ ] `slots: ["default"]` set if the component has children
- [ ] `description` teaches the AI *when* to use the component (semantic, not visual)
- [ ] Variants expressed as props, not new component types
- [ ] Tight zod (`.enum`, `.literal`, named objects) — not `z.record(z.unknown())` or `z.any()`
- [ ] If using `--json-schema` constrained decoding: no record-keyed fields introduced (or strict-mode collapse accepted)
- [ ] Artifact rebuilt: `pnpm mcp:build` (outline-explorer) or `node apps/floatty/scripts/compile-door-bundle.mjs` (render-door)
- [ ] If render-door agent path is wired with `--json-schema`, regenerate snapshot tests for `catalog.jsonSchema({ strict: true })`
- [ ] Catalog + renderer + rebuilt artifact committed in the same commit

## See also

- `floatty/.claude/rules/render-door-agent.md` — operational rule for the render:: agent path; mandatory pre-edit reads + ground-truth facts
- `apps/floatty/.claude/rules/door-development.md` — door module shape, registry/provider patterns
- `~/.claude/rules/check-before-create.md` — find existing → decide (edit / link / new) before adding new components
