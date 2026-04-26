/**
 * Agent-side primitives for the render:: door — JSON Schema export and the
 * system prompt builder used by the `claude -p` agent path.
 *
 * Landed as Phase 1 of the render-agent refactor — pure additions /
 * verbatim moves. Behavior is unchanged from the prior inline definitions
 * in render.tsx. See the originating PR for phase breakdown and rationale.
 *
 * See `.claude/rules/render-door-agent.md` for the operational rule
 * (which sources to read before editing this file).
 */

import { bbsCatalog } from './catalog';
import { LAYOUT_PATTERNS } from './patterns';

// =============================================================================
// JSON Schema export — for `claude -p --json-schema <schema>` and the
// Anthropic API tools-format schema.
//
// `bbsCatalog.jsonSchema(...)` is pure (sourced from the static catalog
// definition), so we compute once at module load.
//
// Strict caveat: `elements` is a record-typed field in the @json-render/solid
// schema (see ~/projects/_reference/json-render/packages/solid/src/schema.ts:17).
// In strict mode the record collapses to opaque
// `{ type: "object", properties: {}, additionalProperties: false }` per
// `core/src/schema.ts:1486-1500`. Strict mode therefore protects the OUTER
// envelope (root, elements, state, no extras) but per-element shape protection
// rides on `bbsCatalog.prompt()` describing each component plus a post-parse
// `bbsCatalog.validate(spec)` check. This is intentional and documented.
// =============================================================================

export const BBS_SPEC_JSON_SCHEMA_STRICT: object = bbsCatalog.jsonSchema({ strict: true });
export const BBS_SPEC_JSON_SCHEMA_LOOSE: object = bbsCatalog.jsonSchema();

// Schema actually passed to `claude -p --json-schema` for the agent path.
//
// Empirical findings (2026-04-26):
// 1. `claude --json-schema` accepts the loose schema (per-element `type` enum
//    and per-component zod props are preserved → real protection).
// 2. The strict schema collapses `elements: record(...)` to opaque per
//    `core/src/schema.ts:1486-1500`, so the LLM gets no shape to fill in and
//    returns empty `elements`. Strict is unusable for this use case.
// 3. The loose schema has `additionalProperties: false` at the top level and
//    only declares `root` + `elements` (the @json-render/solid `spec` shape
//    in `solid/src/schema.ts:13-29` doesn't include `title` or `state`).
//    The system prompt asks the agent to emit a top-level `title` and
//    `state`, which would be silently rejected without this extension.
//
// This wrapper extends the catalog's loose schema with the render-door's
// door-side conventions (top-level `title` and `state`) at use-site rather
// than mutating the catalog spec definition (which would ripple to other
// json-render consumers like outline-explorer).
export const BBS_AGENT_REQUEST_SCHEMA: object = (() => {
  const base = BBS_SPEC_JSON_SCHEMA_LOOSE as Record<string, unknown>;
  const properties = (base.properties as Record<string, unknown>) ?? {};
  return {
    ...base,
    properties: {
      ...properties,
      title: { type: 'string' },
      state: { type: 'object' },
    },
  };
})();

// =============================================================================
// System prompt — verbatim move from render.tsx::buildAgentSystemPrompt.
//
// Behavior preserved exactly: the "INITIAL STATE" split-and-rewrap is kept
// because changing prompt structure is a behavior change, out of scope for
// Phase 1. Phase 3 of the plan replaces this with
// `bbsCatalog.prompt({ mode: "standalone", customRules: [...] })`.
// =============================================================================

let _cachedCatalogPrompt: string | null = null;

export function buildAgentSystemPrompt(): string {
  const catalogPrompt = _cachedCatalogPrompt ??= bbsCatalog.prompt();
  const stateIdx = catalogPrompt.indexOf('INITIAL STATE');
  const componentSection = stateIdx !== -1 ? catalogPrompt.substring(stateIdx) : catalogPrompt;

  return [
    'You generate JSON render specs for floatty, a dark-themed terminal outliner.',
    '',
    'OUTPUT: A single JSON object on stdout. No markdown fences, no explanation, ONLY the JSON.',
    'Include a top-level "title" field (3-6 word human-readable summary) alongside root/state/elements.',
    '',
    'FORMAT:',
    '{"root":"<key>","title":"<3-6 word title>","state":{...},"elements":{"<key>":{"type":"<Component>","props":{...},"children":["<child-key>"]},...}}',
    '',
    componentSection,
    '',
    'OUTLINE WRITE vs LOCAL STATE:',
    '- createChild/upsertChild write REAL BLOCKS to the outline (persistent, searchable, visible as children)',
    '- pushState/removeState/setState only update LOCAL UI STATE (temporary, gone on re-render)',
    '- When the user says "add to outline", "save", "append", "create block" → use createChild or upsertChild',
    '- When the user wants a local list/counter/toggle within the UI only → use pushState/setState',
    '- Default to outline writes unless the user explicitly wants local-only state',
    '',
    'FLOATTY-SPECIFIC:',
    '- Every children key MUST exist in elements',
    '- gap is a NUMBER not a string',
    '- Use REAL data from the context provided, not placeholder text',
    '- Colors: #00e5ff (cyan), #e040a0 (magenta), #ff4444 (coral), #98c379 (green), #ffb300 (amber)',
    '- Output a SINGLE JSON object, NOT JSONL patches',
    '',
    LAYOUT_PATTERNS,
  ].join('\n');
}
