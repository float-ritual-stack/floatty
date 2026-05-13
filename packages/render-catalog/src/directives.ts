// FLOAT-specific @json-render directives for token-efficient agent emissions.
//
// The render-door agent currently inlines every hex color and wikilink href
// in its structured-output JSON. With these directives, the agent emits e.g.
// `{ "$projectColor": "floatty" }` and the renderer resolves at runtime via
// the catalog color maps — same pixels on screen, fewer tokens out.
//
// Resolution is runtime — directives are evaluated during `resolvePropValue`
// (see @json-render/core::props.ts). Composable: any sub-value of a directive
// can itself be a `$state` / `$concat` / etc. expression.
//
// Floatty bundles these with `standardDirectives` from @json-render/directives
// (`$format`, `$math`, `$concat`, `$count`, `$truncate`, `$pluralize`, `$join`)
// — see the `floattyDirectives` export below.

import { z } from "zod";
import { defineDirective } from "@json-render/core";
import { standardDirectives } from "@json-render/directives";
import {
  STREAM_PROJECT_COLORS,
  STREAM_MODE_COLORS,
  UNKNOWN_COLOR,
} from "./colors";

/**
 * `$projectColor(name)` → hex string for the named project namespace.
 * Unknown projects resolve to UNKNOWN_COLOR.
 *
 * @example
 *   { "color": { "$projectColor": "floatty" } }  // → "#00e5ff"
 */
export const projectColorDirective = defineDirective({
  name: "$projectColor",
  description:
    "Resolves a FLOAT project namespace (e.g. 'floatty', 'rangle/pharmacy') to its canonical hex color. Unknown projects render with a muted gray fallback.",
  schema: z.object({
    $projectColor: z.string(),
  }),
  resolve(raw) {
    return STREAM_PROJECT_COLORS[raw.$projectColor] ?? UNKNOWN_COLOR;
  },
});

/**
 * `$ctxColor(modeName)` → hex string for a ctx:: work mode.
 * Unknown modes resolve to UNKNOWN_COLOR.
 *
 * @example
 *   { "color": { "$ctxColor": "debugging" } }  // → "#ff4444"
 */
export const ctxColorDirective = defineDirective({
  name: "$ctxColor",
  description:
    "Resolves a FLOAT ctx:: mode name (e.g. 'debugging', 'session-archaeology', 'digest') to its canonical hex color. Unknown modes render with a muted gray fallback.",
  schema: z.object({
    $ctxColor: z.string(),
  }),
  resolve(raw) {
    return STREAM_MODE_COLORS[raw.$ctxColor] ?? UNKNOWN_COLOR;
  },
});

/**
 * `$wikilink(target)` → the wikilink target as a string.
 *
 * Currently an identity transform — declares semantic intent without changing
 * the wire value. Future enrichment can return `{ target, label, backlinkCount }`
 * etc. without the agent or component needing to know.
 *
 * @example
 *   { "target": { "$wikilink": "FLO-679" } }  // → "FLO-679"
 */
export const wikilinkDirective = defineDirective({
  name: "$wikilink",
  description:
    "Marks a value as a wikilink target (page name, block hash, or issue ID like 'FLO-679'). The renderer resolves to the navigable target string; bbs-wikilink click handlers route through chirp navigation.",
  schema: z.object({
    $wikilink: z.string(),
  }),
  resolve(raw) {
    return raw.$wikilink;
  },
});

/**
 * `floattyDirectives` — the full bundle to wire into the renderer + agent.
 *
 * Pass to:
 *   - `<JSONUIProvider directives={floattyDirectives}>` (runtime resolution)
 *   - `bbsCatalog.prompt({ directives: floattyDirectives })` (agent system prompt)
 *
 * Includes the standard set from @json-render/directives plus the three
 * floatty-specific entries above.
 */
export const floattyDirectives = [
  ...standardDirectives,
  projectColorDirective,
  ctxColorDirective,
  wikilinkDirective,
];

/**
 * Zod schema wrapper — widens a prop schema to also accept directive-shaped
 * objects (any record with a `$`-prefixed key). Use in `shared.ts` for prop
 * slots that should accept agent-emitted directives (color, href, target).
 *
 * **Two-layer contract:**
 * - Runtime validation accepts the inner schema OR any record (directive shape).
 * - JSON Schema export encodes the union, so `claude --json-schema` allows
 *   the agent to emit `{ "$projectColor": "..." }` in a string slot.
 * - **TypeScript-inferred type is the inner schema** — because renderers
 *   receive values POST directive-resolution (the framework's `resolvePropValue`
 *   resolves directives before props hit the component). At render time
 *   `props.color` is always the inner type (e.g. `string | undefined`),
 *   never a directive object.
 *
 * The type assertion below is intentional: it lies to TypeScript at the
 * catalog-declaration site to keep renderer signatures honest about the
 * value they actually receive. The runtime Zod schema is the full union.
 *
 * @example
 *   color: directiveOr(z.string()).optional()
 *   // Wire-time validates: "#00e5ff" OR { "$projectColor": "floatty" }
 *   // Render-time props.color: string | undefined
 */
export function directiveOr<T extends z.ZodType>(schema: T): T {
  return z.union([schema, z.record(z.string(), z.unknown())]) as unknown as T;
}
