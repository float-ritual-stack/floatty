---
paths:
  - "packages/render-door/src/render.tsx"
  - "packages/render-door/src/catalog.ts"
  - "packages/render-door/src/agent-*"
  - "packages/render-catalog/src/**/*"
  - "apps/floatty/doors/render-test/**/*"
---

# render:: Agent — Source-First Discipline

The `render::` door spawns an external `claude -p` agent to generate json-render specs (`packages/render-door/src/render.tsx::generateSpecViaAgent`). Every change to that path or to the catalog/schema/prompt around it has been re-derived from scratch multiple times because the canonical knowledge lives **outside the floatty repo**. This rule fixes that.

## Mandatory pre-edit reads

Before editing any file in `paths:` above, read these in this order:

| # | Path | Why |
|---|------|-----|
| 1 | `~/projects/_reference/json-render/packages/core/src/schema.ts` | `Catalog` interface, `JsonSchemaOptions`, `zodToJsonSchema` — the JSON Schema export contract |
| 2 | `~/projects/_reference/json-render/packages/solid/src/schema.ts` | The actual spec shape used by render-door (`elements: s.record(...)`) — DIFFERENT from `react/src/schema.ts`, do not substitute |
| 3 | `~/projects/_reference/json-render/packages/core/src/prompt.ts` | How `catalog.prompt()` builds the system prompt — duplication signal |
| 4 | `~/projects/_reference/json-render/packages/core/src/spec-validator.ts` | What `validateSpec` checks; what counts as a valid spec |
| 5 | `~/float-hub/float.dispatch/references/json-render-docs.md` | Snapshot of https://json-render.dev/docs (frontmatter dates the snapshot) |
| 6 | https://json-render.dev/docs | Live published docs — refresh the snapshot if the live version has diverged |
| 7 | `packages/render-door/src/catalog.ts` | The actual `bbsCatalog` — canonical list of available components and door-defined actions (count is derivable from the file; do not assert it in prose) |

The cloned source under `~/projects/_reference/json-render/` is **authoritative**. The bundled `node_modules/.../@json-render/core/dist/*.d.ts` is a build artifact — readable, but pre-flattened by the bundler. Read source, not dist.

## Ground-truth facts (do not re-derive)

These are pinned to specific lines so future edits don't have to rediscover them.

### `bbsCatalog.jsonSchema({ strict: true })` is the schema for `claude --json-schema`

`packages/render-door/src/catalog.ts:25` defines the canonical catalog. `Catalog.jsonSchema(options)` (`@json-render/core` — `~/projects/_reference/json-render/packages/core/src/schema.ts:443`) returns the JSON Schema export. With `strict: true` it produces the LLM-structured-output subset (OpenAI strict mode, Anthropic `--json-schema`, Gemini equivalent).

```ts
import { bbsCatalog } from './catalog';
const schema = bbsCatalog.jsonSchema({ strict: true });
// → pass as --json-schema arg to `claude -p` with --output-format json
```

**Do NOT hand-roll a JSON Schema** in `render.tsx` or anywhere else. `type` should be the literal-enum of catalog component names, `props` should narrow per-component to the declared Zod shape — both come for free from `jsonSchema()`. A hand-rolled schema desyncs from the catalog every time a component is added.

### Strict-mode `elements` collapse — known caveat

`packages/solid/src/schema.ts:17` declares `elements: s.record(<UIElement>)`. In strict mode, `core/src/schema.ts:1486-1500` collapses records to opaque `{ type: "object", properties: {}, required: [], additionalProperties: false }` because LLM strict-mode requires no dynamic keys (the comment block in `core/src/schema.ts:109-125` documents this explicitly).

Consequence: **strict-mode `--json-schema` protects the outer envelope (`root`, `elements`, `state`, no extra fields) but does not validate per-element shape**. Per-element correctness still rides on `catalog.prompt()` describing each component. This is intentional and not a bug.

If you need per-element validation, use **non-strict mode** (`bbsCatalog.jsonSchema()`) — this preserves `additionalProperties: <UIElement schema>` so `type` enums and `props` shapes are constrained. Tradeoff: Claude's `--json-schema` constrained-decoder may reject non-strict schemas because they don't conform to the LLM-structured-output subset. Test against the real CLI before committing.

### `--json-schema` requires `--output-format json`

The agent path uses `--output-format json` with `--json-schema` — the parsed result IS the spec, and `wrapper.structured_output` carries it directly (already-parsed object alongside the string-encoded `wrapper.result`). The prior text-mode + fenced-block extraction path was removed in the 2026-04-26 refactor. **Don't add fence-extraction heuristics as a fallback** — structured output replaces them entirely. The two are alternatives, not a fallback chain.

### `catalog.prompt()` is the canonical system prompt

`packages/render-door/src/render.tsx::buildAgentSystemPrompt` (or wherever the system prompt is constructed) should call `bbsCatalog.prompt({ customRules: [...] })`. Component lists, action signatures, and built-in actions (`setState`, `pushState`, `removeState`, `validateForm` from `solid/src/schema.ts:54-75`) are auto-generated. Manually enumerating them in the prompt is duplication and drift-prone.

### SpecStream / `pipeJsonRender` exists but is NOT used by render-door today

The docs describe a JSONL streaming format (RFC 6902 patches) for progressive rendering (`@json-render/core::createSpecStreamCompiler`, `@json-render/react::useUIStream`, `pipeJsonRender`). The render door currently uses one-shot `claude -p` and parses a complete spec — streaming is a future enhancement, not the current state. Don't conflate the two when reading docs.

### `shared.ts` is the symmetry contract

`packages/render-catalog/src/components/shared.ts` is the parity contract between render-door (SolidJS) and outline-explorer (React). Every component declared in `shared.ts` MUST have BOTH a Solid impl (in `packages/render-door/src/components.tsx`, registered via `registry.ts`) AND a React impl (in `apps/outline-explorer/src/lib/catalog/renderers/`). Surface-bound exceptions live in `door.ts` (music — Tauri+Tone+Strudel runtime) and `explorer.ts` (workflow UI: `RenderPrompt`/`SearchQuery`/`ShellCommand`). Do **not** add to `shared.ts` without both impls landing in the same PR — the silent-drop bug fires immediately on whichever surface is missing the renderer.

## Anti-patterns (additions to do-not.md scope)

- **Don't write a JSON Schema next to `catalog.ts`.** Call `bbsCatalog.jsonSchema(...)` and serialize at use-site.
- **Don't grep `node_modules/.../dist/*.d.ts` first.** Go to `~/projects/_reference/json-render/packages/*/src/`. Bundled `.d.ts` flattens module structure; source preserves it.
- **Don't copy the doc URLs into a CLAUDE.md.** Refresh `~/float-hub/float.dispatch/references/json-render-docs.md` (it has dated frontmatter). Update its `snapshot_date` when you do.
- **Don't reintroduce the fenced-block extractor.** The prior `render.tsx` heuristic was deleted with the 2026-04-26 refactor; `--json-schema` + `wrapper.structured_output` replaces it entirely.
- **Don't hand-write a system prompt that re-lists components.** Use `bbsCatalog.prompt()`. Pass project-specific guidance via `customRules` only.
- **Don't assume `react/src/schema.ts` shape applies.** The render door uses `@json-render/solid/schema`. Verify against `solid/src/schema.ts:10-95`.

## Why this rule exists

Three iterations of "let's add `--json-schema`" / "fix the agent prompt" / "the spec validation is wrong" have happened where the work was redone instead of grounded. Each time, the answer was already in `~/projects/_reference/json-render/packages/{core,solid}/src/`. This rule front-loads the reads so the discipline is mechanical, not memory-dependent.

The same pattern is named in the global memory entries `feedback_read_source_not_docs.md` and `feedback_read_json_render_tests.md` — this rule is the project-scoped, path-globbed form of the same lesson, applied to the render-door agent path specifically.

## See also

- `door-development.md` — door module shape, registry/provider patterns (broader scope)
- `do-not.md` — global anti-pattern catalog
- `~/.claude/rules/check-before-create.md` — when refreshing the docs snapshot, find existing first
