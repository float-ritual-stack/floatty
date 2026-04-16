---
name: designing-json-render-catalogs
description: Design and maintain @json-render component catalogs for AI-driven UI in floatty projects. Use when adding a new component type, debugging "No renderer for component type" warnings, deciding between composed vs atomic components, reviewing token efficiency of AI-generated specs, or filling catalog gaps. Covers the three-layer pattern (semantic / structural / inline), the silent-drop diagnostic, MCP iframe rebuild discipline, and catalog-sprawl prevention.
---

# Designing json-render catalogs

Catalog design decides how many tokens the AI burns per spec and how reliable its output is. This skill codifies the rules from real debugging in the floatty-explorer codebase (PRs #2, #3).

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

`@json-render/react` returns `null` for unknown component types and logs a console warning:

```
[browser] No renderer for component type: Timeline
```

**The bug is invisible to the user** — the spec element is dropped along with its entire subtree, so any children of the missing container vanish silently.

**Triage:**

1. Console warning names the missing type → catalog gap confirmed.
2. Leaf or container? Usually container — the AI reaches for wrappers (`Row`, `Timeline`, `Grid`, `Stack`).
3. Add the catalog entry to `src/lib/catalog/explorer-catalog.ts` (with `slots: ["default"]` if it has children).
4. Add the renderer to the appropriate file in `src/lib/catalog/renderers/` (layout containers → `nav.tsx`).
5. **Rebuild the MCP iframe**: `pnpm mcp:build` — the iframe is a pre-built artifact and will diverge from the Next.js dev server otherwise.
6. Commit both files together — splitting them leaves a broken state and half-fixes downstream.

PR #2 (`Row`) and PR #3 (`Timeline`) are reference fixes — same shape, different name. When a third warning appears, fix the gap, don't argue with the AI.

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

| File | Role |
|------|------|
| `src/lib/catalog/explorer-catalog.ts` | Component definitions (zod props + descriptions) |
| `src/lib/catalog/renderers/analysis.tsx` | Semantic analysis cards (`PatternCard`, `GapItem`, `ObservationCard`) |
| `src/lib/catalog/renderers/nav.tsx` | Structural containers + chips (`Row`, `Timeline`, `Chip`, `SectionLabel`) |
| `src/lib/catalog/renderers/typography.tsx` | Inline text atoms (`Heading`, `Paragraph`, `Bold`) |
| `src/lib/catalog/renderers/block-primitives.tsx` | Outline block types (`ContextMarker`, `WikilinkChip`) |
| `src/lib/catalog/renderers/visualizations.tsx` | Rich data views (`LinkGraph`, `ActivityHeatmap`) |
| `src/lib/catalog/explorer-renderer.tsx` | Registry assembly via `createRenderer` |
| `dist/mcp/index.html` | Pre-built MCP iframe bundle — rebuild with `pnpm mcp:build` |

## Anti-patterns

- **Visual-only primitives** (`Box`, `Container`, `Spacer`): you're decomposing when you should be composing. Exception: a truly generic *grouping* container (`Row`, `Timeline`) — that belongs in the Structural layer.
- **Renderer without a catalog entry**: the framework uses the catalog's props schema for AI instruction generation. A renderer the AI doesn't know about will never be emitted.
- **Catalog entry without a renderer**: produces the silent-drop bug above.
- **Skipping `pnpm mcp:build`**: the MCP iframe and the Next.js dev server drift apart. PR #2 surfaced this — the artifact panel and inline chat rendered the same spec differently because the iframe was built from a different catalog state.
- **Describing what a component looks like** in the catalog `description`. Describe what it *means* and *when* to use it — the AI reads the description to decide whether to reach for the component, not to style it.

## Checklist for catalog edits

- [ ] Catalog entry added to `explorer-catalog.ts`
- [ ] Renderer added to the appropriate `renderers/*.tsx`
- [ ] `slots: ["default"]` set if the component has children
- [ ] `description` teaches the AI *when* to use the component (semantic, not visual)
- [ ] Variants expressed as props, not new component types
- [ ] `pnpm mcp:build` run to refresh the iframe bundle
- [ ] Both files committed in the same commit
