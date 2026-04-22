# render-reference

Authoritative reference renders for common floatty content types — rendered **through the real pipeline**, not hand-rolled CSS approximations.

```
cd apps/render-reference
pnpm install --filter render-reference...
pnpm dev                          # :5199 interactive
pnpm build                        # dist/index.html static
```

## Dual role

**1. Reference gallery.** Six common content shapes (daily note, weekly tracker, meeting notes, sprint wrap, standup headline, BBS post) with specs designed to show the render door's catalog at its best. Use as the canonical pattern library for render:: agent prompts, design conversations, docs.

**2. Component contract harness.** Each spec is a committed, versioned, deterministic test fixture that exercises catalog components. When a component ships a change in `apps/floatty/doors/render/components.tsx`, this app catches regressions on next reload. When the render:: agent later produces a broken spec, the reference gives you known-good fixtures to compare against — *"is the spec wrong, or is the component wrong?"* becomes decomposable.

Unlike Storybook, the specs here are **real content** — the bbs-post spec is a real doctrine post, the daily-note spec is a real day. The harness doubles as documentation.

## Wiring

`vite.config.ts` aliases `@render-door/*` → `../floatty/doors/render/`. Imports `bbsCatalog` + `bbsRegistry` + component source directly — no copy, no fork, no drift. A component change in production flows through on next reload.

```ts
// App.tsx
import { bbsCatalog } from '@render-door/catalog';
import { registry as bbsRegistry } from '@render-door/registry';
```

## Specs

One spec per file under `src/specs/`. Each exports a typed `Spec` from `@json-render/core`. To add a new reference layout:

1. Create `src/specs/{layout-name}.ts` with a `Spec` export
2. Add entry to `LAYOUTS` array in `App.tsx` with `id` / `label` / `description` / `spec`

Specs are *literal* — no state interpolation, no dynamic data. If you want to show dynamic behavior, wire state into the spec's `state` field and use `$state` / `$item` references; the real Renderer + StateProvider will evaluate them live.

## Component choices — a partial "when to reach for" guide

| Content shape | Reach for |
|---|---|
| Daily-note timelog + arcs | `ArcTimeline` — the whole thing in one component |
| Title/subtitle/date at top of a doc | `MetadataHeader` |
| Stats row (N count · N count · N count) | `StatsBar` |
| Doctrine / insight / shape-of-day | `QuoteBlock` with `type=insight` |
| Pull-quote that's the load-bearing beat | `QuoteBlock` with `type=quote`, inside a `Section` with `variant=highlight` |
| Trailing bridge:: lines / related notes | `QuoteBlock` with `type=note` |
| ASCII tree / fenced monospace block | `DataBlock` (never prose-with-tree-chars — that fails when rewrapped) |
| Corrections / action items / gaps | `GapItem` with `severity` |
| Inbound / outbound links at page foot | `BacklinksFooter` |
| Issue dependency chain (#A → #B → #C) | `DependencyChain` |
| Before/after process from a meeting | `MeetingDiff` |
| Cross-meeting decisions with filters | `DecisionLog` |
| BBS post title block | `EntryHeader` with `type=bbs-source` |
| Frontmatter tags as chips | `TagBar` + `TagChip` |
| Related-concepts list at article foot | `RefSection` + `RefCard` |

**Anti-patterns:**

- Stuffing arc narrative into `PatternCard.content` with a timestamp range in `confidence` — off-label use (confidence is for confidence levels on named patterns, not metadata overflow). Use `ArcTimeline` or `Section` + child blocks.
- Using `Text` with manual `\n\n` for multi-paragraph prose — the block model fights you. Use multiple `Text` blocks or an `EntryBody` markdown block.
- Hand-rolled ASCII two-column layouts as a single block — breaks on any terminal resize. Use sibling parent blocks instead.

## History

Built 2026-04-20 after the render agent's self-audit block ([[484659f6]]) flagged that `patterns.html` (~14 common patterns) only covers a slice of `catalog.ts` (57 components). Daddy named the specific failure mode as "approximation theater" in `[[2026-04-20-phantom-pantry-architecture-approximation-theater]]` — the earlier `~/.floatty/doors/render/agent/layouts.html` rendered convincingly in the browser but the JSON that should have produced the render wasn't in the file. CSS was the content, spec was fiction. This app passes its own `view source` test: every rendered block is the literal output of the spec file alongside it.

## Future-tense (backlog, not now)

- `src/specs/_fixtures/` — edge-case specs (empty children arrays, deeply nested Stacks, missing optional props, long strings, unicode in DataBlock). Layer where "children didn't display right" bugs get caught before reaching a real content spec.
- Playwright screenshot-diff CI — catch component visual regressions on PRs to `apps/floatty/doors/render/components.tsx`.
- SSR via Solid's `renderToString` — static HTML per layout without the 290 KB bundle, for link-sharable reference pages.
- `pnpm --filter render-reference test` that smoke-tests ActionProvider handlers.

## Related

- [[2026-04-20-phantom-pantry-architecture-approximation-theater]] — the doctrine post this app is the literal counter-example to
- `~/.claude/rules/capture-format.md` — Layer 0/1/2/3 write-shape doctrine
- `~/.floatty/doors/render/agent/patterns.html` — component-level storybook (the ~14 common patterns)
- `~/.floatty/doors/render/agent/layouts.html` — composition-level doctrine + spec (now banner-flagged as mural; this app supersedes its previews)
- `apps/floatty/doors/render/` — the source of truth this app imports from
