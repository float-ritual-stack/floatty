# @float/render-catalog

Shared FLOAT semantic vocabulary for [json-render](https://json-render.dev) consumers.

Holds Zod component definitions + action definitions. **Framework-agnostic**: depends only on `@json-render/core` + `zod`. Each consumer composes its own catalog with its platform-specific schema.

## Status

Phase 1 of [[FLO-657]] (parent [[FLO-656]]) — scaffolding established. Real component migrations land in subsequent steps per `.float/work/floatty-catalog-extraction/PLAN.md`.

## Consumers

| Consumer | Renderer | Status |
|---|---|---|
| `@floatty/render-door` | `@json-render/solid` | Phase 1 Step 4+ |
| `apps/outline-explorer` | `@json-render/react` | Phase 1 Step 4+ |
| `apps/ink-chat` (future) | `@json-render/ink` | Phase N — separate PR when use case emerges |

## Usage

```typescript
// Consumer composes its own catalog with its platform schema:
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/solid/schema';   // or '@json-render/react/schema'
import {
  sharedComponentDefinitions,
  doorComponentDefinitions,         // or explorerComponentDefinitions
} from '@float/render-catalog/components';

export const catalog = defineCatalog(schema, {
  components: {
    ...sharedComponentDefinitions,
    ...doorComponentDefinitions,
  },
  actions: { /* ... */ },
});
```

## Component sets

| Set | Source file | Purpose |
|---|---|---|
| Shared (Set A) | `src/components/shared.ts` | 12 components both door and explorer use (PatternCard, Section, GapItem, ...) |
| List shapes (Set D) | `src/components/list-shapes.ts` | 4 shape-distinguished primitives (Timeline, List, AnchoredList, Narrative) per [[FLO-657]] Apr 20 comment |
| Door-only (Set B) | `src/components/door.ts` | 32 components only the render door consumes |
| Explorer-only (Set C) | `src/components/explorer.ts` | 34 components only outline-explorer consumes |

See `.claude/skills/designing-json-render-catalogs/` (post-[[FLO-658]]) for the catalog design doctrine: three-layer pattern, silent-drop diagnostic, MCP rebuild discipline, composition over decomposition.

## What does NOT live here

- SolidJS renderers — stay in `packages/render-door/src/components.tsx`
- React renderers — stay in `apps/outline-explorer/src/lib/catalog/renderers/`
- Platform-specific `schema` import — each consumer imports its own from `@json-render/{solid,react}/schema`

## Constraint

`packages/render-catalog/src/` only imports from `@json-render/core` and `zod`. **Zero `solid-js`, zero `react`, zero JSX.** This is enforced by ESLint (TODO post-Step 3) and verifiable via:

```bash
grep -rE "from ['\"]solid-js|from ['\"]react|from ['\"]@json-render/(solid|react)" packages/render-catalog/src/
# Expected: empty (only test files in __tests__/ may import platform schemas)
```
