# Changelog

All notable changes to floatty are documented here.

## [Unreleased]

---

## [0.14.5] - 2026-05-11

Catalog parity ship. The render-door (SolidJS) and outline-explorer (React) catalogs had grown asymmetric vocabularies — 21 components only the explorer agent could emit, ~48 components only the door agent could emit, plus a stale "44 components + 3 actions" doctrine line that under-claimed both. This release locks `packages/render-catalog/src/components/shared.ts` as the symmetry contract: every component declared there has both a Solid impl (render-door's `components.tsx`) and a React impl (outline-explorer's `renderers/`). Surface-bound exceptions are explicit and small — 9 music components stay in `door.ts` (Tauri+Tone+Strudel runtime, no React reimplementation in scope), 3 workflow-UI components stay in `explorer.ts` (RenderPrompt / SearchQuery / ShellCommand are explorer-specific shapes). End state: `shared.ts` 12 → 81, `door.ts` 59 → 9, `explorer.ts` 24 → 3. Bot-review hardening on the way: `colorTokenEnum` pins the documented color vocabulary into a Zod enum so the silent-fallback bug can't recur, a11y wins (real `<button>` semantics for Callout / TreeView / CollapsibleSection toggles, form labels use `useId()` for `htmlFor`/`id` pairing), corrected `BarChart` auto-scale contract, and form inputs resolve `$bindState` properly via `useBoundProp`. Plus 77-fixture contract-harness migration in `apps/render-reference/`. No `apps/floatty/` changes — Tauri binary doesn't need a rebuild; the door bundle regenerates at build time and is fetched at runtime by the door loader.

### ✨ Features

- **`ArcTimeline` DONE + duration affordance** ([[PR #307]] / `c931a2d` — `apps/outline-explorer/src/lib/catalog/renderers/visualizations.tsx`) — schema described arcs as completed sessions with DONE milestones + duration but the renderer only showed start/end. Now displays a green DONE pill on each arc + parsed duration ("Xh Ym" / "Ym") next to the time range. Implemented per user direction over the alternative of trimming the schema description (CodeRabbit Major).
- **`ContextStream` click-to-expand** ([[PR #307]] / `c931a2d` — `apps/outline-explorer/src/lib/catalog/renderers/visualizations.tsx`) — schema documented click-to-expand on capture rows; impl rendered all captures truncated. Per-row `useState` toggle now switches between truncated and `whitespace-pre-wrap` views with a chevron affordance.

### ♻️ Refactors

- **21 atoms promoted explorer → shared** ([[PR #306]] / `5977e1d` — `packages/render-catalog/src/components/shared.ts`, `explorer.ts`, `packages/render-door/src/components.tsx`, `registry.ts`) — moved 21 briefing/narrative atoms (Heading, Paragraph, Bold, InlineCode, BulletList, BlockRef, WalkChip, Prose, StepIndicator, Chip, SectionLabel, ConfidenceDot, ObservationCard, PatternCluster, EnrichedStepCard, StatusLine, Row, Timeline, HeadingBlock, ContextMarker, OutlinerBlock). 21 new Solid impls landed in render-door. `Text` deprecated entirely (superseded by Heading + Paragraph + Bold + InlineCode); `BulletList` consolidated (explorer's simpler `items: string[]` wins). +764/-359.
- **48 components promoted door → shared** ([[PR #307]] / `c931a2d` — `packages/render-catalog/src/components/shared.ts`, `door.ts`, `enums.ts`, `apps/outline-explorer/src/lib/catalog/renderers/*.tsx`, `explorer-renderer.tsx`) — moved 48 schemas (Layout/Container 6, Navigation 10, Entry 3, Form 6, Content 8, TUI 4, Viz 8, Workflow 4). 48 new React impls landed across 6 renderer files (existing `nav.tsx` / `block-primitives.tsx` / `analysis.tsx` / `visualizations.tsx` + 2 new files `form.tsx` and `terminal.tsx`) written by 6 parallel general-purpose subagents. `accentEnum` + `entryTypeEnum` moved to `enums.ts` alongside their promoted consumers. +2579/-569.
- **`colorTokenEnum` locks color vocabulary** ([[PR #306]] / `1425643` — `packages/render-catalog/src/components/enums.ts`, `shared.ts`) — `Chip.color` / `SectionLabel.color` / `PatternCluster.color` / `StatusLine.color` switched from free-form `z.string()` to `colorTokenEnum.optional()` (cyan/magenta/coral/amber/green/purple/dim). `catalog.validate()` now rejects unrecognized tokens and `--json-schema` constrains the agent at emission time — the silent-fallback bug can't recur.
- **Stale count-comment removal** ([[PR #306]] / `1680de7` — `packages/render-door/src/catalog.ts:1-8`, `.claude/rules/render-door-agent.md` item 7) — "44 components + 3 actions" claim stripped (real was 71+4); in-band doctrine line "count is derivable from the file; do not assert in prose".

### 🐛 Fixes

- **`accentColor()` token coverage gap** ([[PR #306]] / `1680de7` — `packages/render-door/src/components.tsx`) — door's `accentColor()` scoped to the original 4-color palette; promoted explorer atoms reference a 7-color set. Tokens outside the original four silently collapsed to muted. Extended the switch + added `V.purple` (#a366ff); `dim` → `V.tf`. Closes CodeRabbit Minor + Greptile P1 in one fix.
- **`ObservationCard` expandable contract honored** ([[PR #306]] / `1680de7` — `packages/render-door/src/components.tsx`) — schema described "expandable" but the Solid impl always rendered full body + links. Now starts collapsed (header-only with ▸/▾ chevron); click toggles. Audited the other 20 promoted components for the same drift; only this one had it.
- **`Heading.level` integer constraint** ([[PR #306]] / `1680de7` — `packages/render-catalog/src/components/shared.ts`) — `z.number()` allowed floats like 1.5 that silently fell through the switch to default styling. Added `.int()`.
- **`block-primitives.tsx` imports + stale `void` references** ([[PR #307]] / `cd4a0b9` — `apps/outline-explorer/src/lib/catalog/renderers/block-primitives.tsx`) — `void Info; void AlertTriangle; void AlertCircle;` referenced symbols never imported; meanwhile `resolveIcon` (used by Hero + CardCover) was missing from the import. Added `resolveIcon`, deleted the void block. Closes 4 bot threads (Greptile P1×2 + P2, CodeRabbit Critical) with one fix.
- **`Callout` + `TreeView` toggle a11y** ([[PR #307]] / `cd4a0b9` — `apps/outline-explorer/src/lib/catalog/renderers/block-primitives.tsx`, `visualizations.tsx`) — interactive `<div>`s became `<button type="button" aria-expanded={...}>`. Keyboard toggle + screen-reader expand state. Leaf TreeView rows stay non-interactive. (CodeRabbit Major ×2).
- **`BarChart` shared max — auto-scale contract honored** ([[PR #307]] / `cd4a0b9` — `apps/outline-explorer/src/lib/catalog/renderers/visualizations.tsx`) — schema described "Auto-scales from children values" but impl never computed chart-level max or passed it to children. Every BarItem rendered at 100%. Now computes `Math.max(...children.values)` and threads it via child-mapping with cloned props. Item-level max still wins.
- **`form.tsx` `$bindState` resolution** ([[PR #307]] / `cd4a0b9` — `apps/outline-explorer/src/lib/catalog/renderers/form.tsx`) — custom `readStringProp` helper returned `""` for `{$bindState: "..."}` descriptors, bypassing json-render's binding mechanism. Rewrote form renderers as hoisted React components using `useBoundProp` from `@json-render/react`. TextInput/TextArea read AND write back; FilterButtons/TabNav highlight active AND update state on click; Button got `emit('press')`.
- **Label/input `htmlFor`/`id` pairing** ([[PR #307]] / `44cb9a1` — `apps/outline-explorer/src/lib/catalog/renderers/form.tsx`) — TextInput + TextArea labels weren't programmatically linked. React 19 `useId()` now generates stable unique IDs; `<label htmlFor>` pairs with `<input id>` / `<textarea id>`. (CodeRabbit Minor).
- **`Heading.props.content` markdown prefix cleanup** ([[PR #307]] / `44cb9a1` — `apps/render-reference/src/specs/standup-headline.ts`, `hub-rich.ts`, `weekly-tracker.ts`, `meeting-notes.ts`, `sprint-wrap.ts`) — contract-harness migration agent preserved embedded `## ` / `>>> ` markdown prefixes verbatim during the mechanical `Text→Heading` swap. Heading is plain-text-only — prefixes rendered literally. Stripped 16 prefixes across 5 spec files. (CodeRabbit Minor).
- **Contract-harness `Text→Heading`/`Paragraph` migration** ([[PR #307]] / `cd4a0b9` — `apps/render-reference/src/specs/*.ts`) — `Text` was deleted in PR #306 but render-reference still had 77 executable references + 7 embedded JSON snippets across 11 spec files. The `Spec` type from `@json-render/core` is loose so `tsc --noEmit` didn't catch it; the renderer would have silent-dropped at runtime. Background agent applied the migration: `size: 'xl' weight: 'bold'` → `Heading` level 1, `size: 'lg' weight: 'bold'` → level 2, plain / `size: 'sm'` / `markdown: true` / mono / color-only → `Paragraph`. `size` / `weight` / `color` / `mono` / `markdown` props dropped (none survive into the typed atoms — intended deprecation tradeoff).

### 🧪 Tests

- **`agent-schema.test.ts` updated for Text deprecation** ([[PR #306]] / `5977e1d` — `packages/render-door/src/agent-schema.test.ts`) — two tests pinned `Text` in catalog spot-check / "Card-with-Text" minimal spec. Now check `Heading`; minimal spec renamed to "Card-with-Paragraph". 93/93 render-door + 1309/1309 float-pty passing.

### 📝 Docs

- **`shared.ts` is the symmetry contract** ([[PR #306]] / `5977e1d` — `.claude/rules/render-door-agent.md`) — new "Ground-truth facts" subsection codifying that every component in `shared.ts` must have both Solid + React impls. Surface-bound exceptions explicitly enumerated.
- **`LAYOUT_PATTERNS` refresh** ([[PR #306]] / `5977e1d` — `packages/render-door/src/patterns.ts`) — narrative references to deprecated `Text` swapped to `Paragraph` / `Heading`; JSON spec example block (Sprint Board) updated to use `Heading`.

---

## [0.14.4] - 2026-05-08

Closes the deferred-item from v0.14.3's render-door projection-contract proposal AND opens the Tier 2 navigation surface to MCP consumers. Two user-visible improvements bundled because they surfaced from probing the same v0.14.3 release. Headline: agent-written `render:: {full JSON}` blocks no longer **visually overlap with their rendered door view** during normal use — selfRender doors now hide contentEditable by default and surface a clean derived title instead, with a per-block toggle to switch into source-edit mode. A 229-block one-shot migration ran against the live outline to compress legacy `render:: {json}` content into semantic titles in-place. Separately, the MCP wrappers in `outline-explorer` (`search_blocks`, `get_inbound`, `get_block`, `expand_page`) now opt into `nav_classification` / `children_preview` / `siblings` so agents see Tier 1+2 nav-layer signals (`kind`, prev/next, first-N children) the v0.14.3 server already emits — closing the wire-vs-wrapper gap a probe-test caught.

### ✨ Features

- **Generalized door-block title-mode** ([[PR #305]] / `5f08613` — `apps/floatty/src/lib/blockItemHelpers.ts`, `apps/floatty/src/components/BlockItem.tsx`) — extracted `deriveDoorTitle()` as a pure function in `blockItemHelpers.ts` (canonical resolution: content-as-title for new projection-contract blocks → `output.data.title` for legacy → `output.data.spec.title` synchronous fallback). `BlockItem.tsx`'s `renderTitle()` memo now delegates to it, generalizing the FLO-569 `isRenderTitleMode` mechanism so it fires for **every** door block with output (not just `render::`-prefixed content). ContentEditable hides by default; toggle button label updated to "Edit source" / "Show title" so it reads correctly for both new-path and legacy blocks. 12 pinned tests cover the contract.
- **MCP wrappers opt into Tier 1+2 nav-layer surfaces** ([[PR #305]] / `5f08613` — `apps/outline-explorer/src/mcp/tools.ts`) — `search_blocks`, `get_inbound`, `get_block`, and `expand_page` now pass `include=effective_markers,nav_classification,children_preview,siblings`. Tool descriptions surface the new fields so agents discover them via natural-language tool-search. Live-verified the "## arcs" disambiguation case — three identical-content backlinks tag as `nav_node` with distinct `subtreeSize` (16/6/9) and one as `leaf_marker`. Closes the gap between the v0.14.3 server's wire data and what MCP consumers could see.

### 🐛 Fixes

- **Door-block visual cohabitation overlap eliminated** ([[PR #305]] / `5f08613` — `apps/floatty/src/components/BlockItem.tsx`, `apps/floatty/src/lib/blockItemHelpers.ts`) — selfRender doors used to stack contentEditable above + door view below, and when content was multiline (every legacy `render:: {full JSON}` block), the layers physically overlapped producing doubled/garbled text. The generalized title-mode hides contentEditable by default for door blocks with output. `trimStart()` in the legacy-shape detection ensures `'  render:: {...}'` (leading whitespace) routes through fallback arms instead of surfacing raw source as the "title" (CR-flagged Minor).
- **`expand_page` MCP description matches actual response** ([[PR #305]] / `5f08613` — `apps/outline-explorer/src/mcp/tools.ts`) — description listed `blockCount` but payload returns `childCount` + `treeBlockCount` (CR-flagged Minor).
- **Migration script defends against malformed API content** ([[PR #305]] / `5f08613` — `scripts/migrate-render-projection-contract.mjs`) — extracted `safeContent = full.content ?? ''` so a missing/null content field doesn't TypeError mid-loop after the backup is already written (Greptile P2).

### 🧪 Tests

- **12 new `deriveDoorTitle` tests** ([[PR #305]] / `5f08613` — `apps/floatty/src/lib/blockItemHelpers.test.ts`) — pin the contract across new-path, legacy, garbage-fallback, leading-whitespace, and null-block scenarios. 1309/1309 vitest passing.

### 🛠 Migration

- **One-shot legacy-render-block migration** ([[PR #305]] / `5f08613` — `scripts/migrate-render-projection-contract.mjs`) — walks the outline, finds blocks with `outputType === 'door'` and `content` starting with `render::`, and PATCHes content to a derived semantic title. Output (`output.data.spec`) untouched. Run against live release outline (port 8765 / v0.14.3): **229 blocks migrated, 12 skipped (no derivable title), 0 failed**. Backup at `/tmp/floatty-render-migration-2026-05-08-182602.json`. Closes the deferred follow-up from v0.14.3's PR #304 proposal doc.

---

## [0.14.3] - 2026-05-08

Render-door durability pass + ancestor-context Tier 2 opt-ins + backlinks structural-depth classification. Headline: agent-written `render:: {json}` blocks no longer **randomly fall back to displaying raw JSON during normal use** — five root causes ([[PR #304]]) collapsed under one "projection contract" doctrine where `content` carries semantic source and `output.data` carries the materialized projection. Frontend gets a fat-path auto-execute guard + idempotency check on `setBlockOutput`; API gains `output` / `outputType` / `outputStatus` on POST/PATCH so agents can write title-as-content + spec-as-output in one round-trip; MCP `add_block` / `patch_block` forwards those fields with cross-check validation; render-door's claude-p agent prompt is updated to default to one composed spec (Stack/Group/Tabs containers) and only reach for separate-block writes when the user explicitly asks. Tier 2 of [[FLO-679]] ships three navigation-layer opt-ins (`nav_classification`, `children_preview`, `siblings`) on every block-returning endpoint via the symmetry harness ([[PR #303]]). Backlinks gain Tier 1 structural-depth classification — heading-only-with-children vs leaf — so the `LinkedReferences` view can preview vs muted-render correctly ([[PR #302]]). Plus a docs grant for routine push + tauri:dev standing authorization ([[PR #301]]).

### ✨ Features

- **Backlinks Tier 1: structural-depth classification** ([[PR #302]] / `74bd07e` — `apps/floatty/src-tauri/floatty-server/src/api/blocks.rs`, `apps/floatty/src/components/LinkedReferences.tsx`, `apps/floatty/src/lib/backlinkClassify.ts`) — three-state classification (`nav_node` / `content_block` / `leaf_marker`) derived at read time from content shape + child presence. Server emits `BlockKind` on backlink hits via a shared `classify_block_kind` helper that reuses `parse_block_type` (no parallel heading-prefix detection); frontend mirrors via `backlinkClassify.ts` for the LinkedReferences UI. MCP tool descriptions swept across `expand-page`, `get-block`, `get-inbound`, `qmd-*`, `search-blocks` to surface the new classification.
- **Ancestor-context Tier 2 opt-ins** ([[PR #303]] / `e8a5070` / [[FLO-679]] — `apps/floatty/src-tauri/floatty-server/src/block_service.rs`, `apps/floatty/src-tauri/floatty-server/src/api/mod.rs`) — three new `?include=` opt-ins on every block-returning endpoint: `nav_classification` adds the block's `kind` (~100ns cost — one yrs read + child-list-empty check), `children_preview` adds first-N children as `BlockRef`s with content truncated UTF-8-safely to 200 chars (default 5, cap 20, `&children_preview_count=N`), `siblings` adds prev/next previews via the existing `get_siblings` primitive (returns `null` for root blocks). Symmetry harness in `tests/symmetry_ancestor_context.rs` enforces the wire contract — 464-line expansion covers all three fields × all surfaces.
- **API: `output` / `outputType` / `outputStatus` on `CreateBlockRequest` + `UpdateBlockRequest`** ([[PR #304]] / `e8c24aa` — `apps/floatty/src-tauri/floatty-server/src/api/blocks.rs`, `block_service.rs`, `api/mod.rs`) — agents can now write the projection envelope directly on POST/PATCH instead of stuffing raw JSON into `content` and relying on auto-execute. New `json_value_to_yrs_any` helper at `api/mod.rs:91-118` writes the envelope as `yrs::Any::Map` (round-trip-compatible with the existing `yrs_out_to_json` read path). Pre-flight validates `outputType` required when `output` is set (PATCH allows existing block's outputType to satisfy). `output_status` round-trips through `BlockDto`. Four new projection-contract tests in `api/mod.rs::tests` cover POST / POST-rejection / PATCH / PATCH-rejection paths.
- **MCP `add_block` / `patch_block` forward output fields** ([[PR #304]] / `e8c24aa` — `apps/outline-explorer/src/mcp/tools.ts`) — both tools accept `output` / `outputType` / `outputStatus` with cross-check validation at the MCP boundary (outputType required when output set). Tool descriptions document the projection-contract shape and warn against the `content: "render:: {json}"` anti-pattern.

### 🐛 Fixes

- **Agent-written render blocks no longer fall back to raw JSON during normal use** ([[PR #304]] / `e8c24aa` — `apps/floatty/src/hooks/useBlockStore.ts`) — five root causes:
  1. Fat-path auto-execute output-presence guard at `useBlockStore.ts:660-694`. Slim path got the guard 2026-04-29; the fat-path observer didn't. Reconnect / state-vector sync / gap-fill `'add'` events for already-projected blocks were re-firing `door.execute()` → DoorHost remount → contentEditable bleed-through. Mirror of the slim-path guard added.
  2. `setBlockOutput` idempotency gate at `useBlockStore.ts:846-895`. Same-data writes still produced new envelope object refs → Solid `<Dynamic>` remount. Deep-equality skip via `deepEqualJsonLike` (already in-module — addresses CodeRabbit feedback that `JSON.stringify` is key-order sensitive).
  3. `debug_assert!(false, "unrepresentable serde_json::Number: {n}")` in the unreachable else branch of `json_value_to_yrs_any` — surfaces contract violations loudly in debug builds (Greptile P2).
  4. + 5. Render-door agent system prompt at `packages/render-door/src/agent-schema.ts::buildAgentSystemPrompt` now defaults to one composed spec (Stack/Group/Tabs containers) when the user asks for "multiple sections"; only uses `add_block` with the projection-contract shape when the user explicitly asks for separate sibling blocks; never writes `render:: {json}` as content.

### 📝 Docs

- **`AGENT_CREATED_DOOR_BLOCKS.md` "Follow-up — 2026-05-08" section** ([[PR #304]] / `e8c24aa` — `apps/floatty/docs/architecture/AGENT_CREATED_DOOR_BLOCKS.md`) — 214 lines added documenting the projection contract (semantic source vs materialized projection), wire format, verification recipe, files-involved table, and four deliberately-deferred follow-ups (source-hash gate, scoped subscribe, decoupled title-gen, selfRender visual layering).
- **Standing authorization for routine push + tauri:dev** ([[PR #301]] / `2ba9eca` — `.claude/rules/personal-tool-pr-scope.md`) — codifies what's pre-authorized for solo+bot-review workflow vs what still gates (force-push to main, `gh pr merge`, killing release floatty on 8765, dependency adds).

---

## [0.14.2] - 2026-05-08

Targeted follow-up to the v0.14.1 reactivity-narrowing pass. Cmd+Right and other native cursor-movement keystrokes were paying a per-keystroke `getAbsoluteCursorOffset` DOM walk inside `useBlockInput.handleKeyDown` — `cursor.snapshot()` was eager, but `useCursor`'s WeakMap cache invalidates on every `selectionchange`, so each keydown after a cursor move was a guaranteed cache miss + full traversal. `determineKeyAction` only consumes `cursorAtStart`/`cursorAtEnd`/`cursorOffset` on Enter/Tab/Backspace/plain-arrows; every other keydown — Cmd+Right (visual line end), modifier-only events, action keybinds (`deleteBlock`, `moveBlockUp/Down`, `zoomIn/Out`, `collapseBlock`), and printable characters — flowed through paths that never read the snapshot. This release gates the snapshot on a positive allowlist of cursor-consuming keys, with 10 new tests pinning the perf invariant including a Delete regression-pin (closest adjacency to Backspace, most likely candidate to grow a forward-merge consumer). ([[PR #300]])

### ✨ Performance

- **Lazy cursor snapshot in `handleKeyDown`** ([[PR #300]] / `3429c7a` — `apps/floatty/src/hooks/useBlockInput.ts`) — replaced eager `const snap = deps.cursor.snapshot()` with `cursorConsumingKey ? deps.cursor.snapshot() : null`. Allowlist matches the exact set of `determineKeyAction` branches that read cursor fields: Enter (any modifier), Tab (any modifier), Backspace, plain ArrowUp/ArrowDown (no shift). Every other key — Cmd+Right, Shift+Arrow block-selection paths, modifier-only, action keybinds, printable characters — skips the walk. The existing `snap?.atStart ?? false` / `snap?.offset ?? 0` defaults at the call site cover the null case for skipped branches (which all return early or hit `'none'` without consulting the defaulted fields).

### 🧪 Tests

- **10 new perf-invariant tests in `useBlockInput.test.ts`** ([[PR #300]] / `3429c7a` / `0f800ae` — `apps/floatty/src/hooks/useBlockInput.test.ts`) — pin both directions of the allowlist. Skipped: Cmd+Right, plain ArrowLeft/Right, Shift+ArrowUp/Down, printable chars (`a`/`1`/space), modifier-only events (Shift/Meta/Control), Delete + Shift+Delete (regression-pin against silent forward-merge addition). Take: Enter, Tab, Backspace, plain ArrowUp, plain ArrowDown. 1278/1278 vitest passing.

### 📝 Docs

- **`/floatty:release` collapsed to single approval gate** (`959f863` — `.claude/commands/floatty/release.md`) — multi-gate theater (separate prompts for push and GitHub Release after the changelog was already approved) replaced with end-to-end execution after the changelog gate. The push and GitHub-Release steps are predictable yes-es when the changelog is right; gating them was friction without information. v0.14.1 release surfaced this.

---

## [0.14.1] - 2026-05-08

Per-keystroke reactivity narrowing pass on the BlockItem path, plus a render-door null-safety fix that was masking the audit signal. Frontend perf audit on the 4795-block dev outline identified two compounding cost drivers — autocomplete state machines created 1:1 per BlockItem (4252 mounts in 10 minutes of navigation = 4252 instances) and a render-door PatternCard error-retry loop on collapse/zoom — and bundled five surgical narrowings: singleton autocomplete lift mirroring [[FLO-322]] pageNames, focused-block prop-drill removal (BlockItem reads `paneStore.getFocusedBlockId(paneId)` directly), pages:: container ID caching, `structuredClone` for paneStore persistence, and `resolveAlias` 8-char-prefix fast path. CodeRabbit caught a downstream regression — singleton state with per-block popup render → N stacked overlays — fixed by gating the popup mount to `state.activeBlockId === props.id`. Async GPT review surfaced four refinements and one cleanup. Net: navigation-churn + popup-stacking + persistence-clone overhead all narrowed. ([[PR #299]] / [[FLO-316]] / [[FLO-529]])

### ✨ Performance

- **Singleton `useWikilinkAutocomplete` lift to `WorkspaceContext`** ([[PR #299]] / `ba04406` — `apps/floatty/src/context/WorkspaceContext.tsx`, `apps/floatty/src/components/BlockItem.tsx`, `apps/floatty/src/hooks/useWikilinkAutocomplete.ts`) — was per-BlockItem (1:1 with mounts → 4252 instances across 10 min of nav). Lifted to a singleton instance in `WorkspaceProvider`, mirrors the [[FLO-322]] `pageNames` lift exactly. The scroll-dismiss `createEffect` also moved to the Provider — keeping it per-BlockItem post-lift would have registered N scroll listeners on popup open. Measured 4252:4252 → 169:1 across navigation.
- **Kill `focusedBlockId` prop fan-out** ([[PR #299]] / `63aaa25` / [[FLO-529]] — `apps/floatty/src/components/BlockItem.tsx`, `apps/floatty/src/components/Outliner.tsx`) — `focusedBlockId` was passed as a plain prop to every root BlockItem, then recursively to every child. On any focus change, the prop-surface invalidated across the whole visible tree. BlockItem now reads its own focus from `paneStore.getFocusedBlockId(props.paneId)` directly. Narrows the invalidation surface — memo bodies still execute for all readers but only the two BlockItems whose `isFocused` flips propagate downstream.
- **Cache `pages::` container id (downstream narrowing)** ([[PR #299]] / `6fb9493` — `apps/floatty/src/context/WorkspaceContext.tsx`) — `findPagesContainer` iterates rootIds + reads each root's content, registering a broad reactive dep. Extracted as a `pagesContainerId` memo so `pageNames` and `stubPageNameSet` only depend on the container's childIds + their content, not on every root block's content. Most edits don't touch root contents → these memos refire far less often. (Residual: the `pagesContainerId` memo itself still has the broad dep — future improvement is structural-marker identification of the container.)
- **`structuredClone` for paneStore persistence** ([[PR #299]] / `c08ab39` — `apps/floatty/src/hooks/usePaneStore.ts`) — `getPaneStateForPersistence` deep-cloned `state.collapsed` and `cappedHistory` via `JSON.parse(JSON.stringify(...))` on every persistence-version bump (collapse toggle, focus change, navigation push). `structuredClone` strips SolidJS proxies the same way without the JSON serialize/parse roundtrip.
- **`resolveAlias` 8-char-prefix fast path** ([[PR #299]] / `b3c3183` — `apps/floatty/src/context/WorkspaceContext.tsx`) — was eagerly building `Object.keys(store.blocks)` (4795 IDs) on every autocomplete keystroke once user typed a `|` after a hex prefix. 8-char prefixes (the recommended form) now hit the `shortHashIndex` O(1) and skip the array build entirely. Falls back to full scan for shorter (6-7 char) prefixes only.

### 🐛 Fixes

- **render-door PatternCard null-safety** ([[PR #299]] / `ba04406` — `packages/render-door/src/components.tsx`) — `inlineFormat` and `renderMarkdown` threw `s.replace of undefined` when spec props were null. SolidJS's error retry caused unrelated re-renders to amplify, masking the real perf signal during collapse/zoom. Both helpers now accept `undefined | null → ''` at the source, protecting all 10 markdown call sites in render-door.
- **Singleton autocomplete popup mounted N times on open** ([[PR #299]] / `407708a` — `apps/floatty/src/components/BlockItem.tsx`, `apps/floatty/src/hooks/useWikilinkAutocomplete.ts`) — CodeRabbit-flagged regression from the singleton lift: state was shared but `<WikilinkAutocomplete>` was rendered per-BlockItem under `<Show when={autocomplete.state()}>`, so every visible BlockItem mounted the popup component when state went non-null (N stacked overlays on the same anchor). Threaded `activeBlockId` through `AutocompleteState`; popup mounts only on the BlockItem where `state.activeBlockId === props.id`. Extracted `autocompleteStateForThisBlock` memo for single accessor read per BlockItem (GPT review iter / `929d7c2`).

### 📝 Docs

- **GPT review feedback on PR #299** (`b3c3183`) — softened `focusedBlockId` comment to reflect that memo bodies still execute (only downstream cascades narrow); documented the residual broad dep on `pagesContainerId` + named the future structural-marker fix; replaced unmeasured "2-3× faster" `structuredClone` comment with factual "avoids JSON serialize/parse roundtrip."
- **Ticket-ref correction** (`dda060c`) — earlier commits referenced `FLO-721` (which is about render-door BulletList, unrelated). Replaced with `FLO-316` (perf umbrella) for hooks/context refs, `FLO-529` (BlockItem decomposition) for the BlockItem focus-prop comment.

---

## [0.14.0] - 2026-05-05

Multi-outline retirement + render-door audio + rich-doc primitives. Headline shift: **DB-per-outline as mainline architecture is gone** ([[ADR-006]] / [[FLO-718]] / [[PR #298]]) — Phase 1's named-outline storage topology lands as ~2000 lines deleted, with workspace-via-data-dir + future scope-shaped outline reintroduction as the replacement. Feature was ~2 days of post-merge use; in the one real separation scenario, scripted backup/restore of `default` was the actual workaround. Worlds vs Outlines: world/workspace = data-dir/process/routing boundary; outline = command/view/scope inside a world. Retirement ships alongside two render-door expansions: a four-tier gain stack (master/component/track/pad) on the audio rig ([[FLO-703]] / [[PR #296]]) and four rich-doc primitives (Callout/Hero/GalleryGrid/CardCover) plus targeted reactivity + visual fixes across TabNav/DecisionLog/TuiStat/TreeView/Hero ([[PR #297]]).

### ✨ Features

- **Rich-doc primitives + 4 hub-page reference layouts** ([[PR #297]] / `ada3de8` — `packages/render-catalog/src/components/door.ts`, `packages/render-door/src/components.tsx`, `apps/render-reference/src/specs/`) — four new catalog components with full schema + impl + registry: `Callout` (13 types — note/info/tip/success/warning/danger/failure/bug/example/question/quote/abstract/todo, optional title, collapsible, type-tinted bg + 3px accent left-border, nestable via slots); `Hero` (title/subtitle/eyebrow + cover with gradient/color/icon + density full|compact + text-link actions instead of pill buttons — drops contrast + dead-affordance issues together); `GalleryGrid` (CSS auto-fit columns with `minCardWidth`); `CardCover` (header/body/properties/footer card with optional whole-card href). bbs-post layout refactored to use the new primitives. Agent guidance tells the `render::` agent when to reach for which primitive.
- **Render-door rig gain stack — master / component / track / pad** ([[PR #296]] / `7355166` / [[FLO-703]] — `packages/render-door/src/components.tsx`, `packages/render-catalog/src/components/door.ts`) — full four-tier gain control on the audio rig, ceiling bumped 1.5× → 2.5× per laptop-speaker headroom testing on 80Hz kicks. Per-rig `MasterOut` `GainNode` (window-attached registry, HMR-survival + AudioContext-divergence checks) inserted between voice/FX paths and `ctx.destination`. `MasterFX.gain` schema prop drives the master knob (UI: amber-bordered MASTER OUT panel). Per-component `gain` props on `StepSequencer` / `AcidBass` / `EuclideanDrums` / `DrumPad` / `Tone`. Per-track `tracks[].gain` on `StepSequencer` / `EuclideanDrums` and per-pad `pads[].gain` on `DrumPad`. Math: `0.25 ADSR baseline × component × track × master`, max ~1.56 amp at ceiling — capable of clipping `ctx.destination` on its own, which the fireStep comment now warns about.

### ♻️ Refactors

- **DB-per-outline retirement (ADR-006)** ([[PR #298]] / [[FLO-718]] / `d2edeeb` — 30 files, +840/-2087 = net **-1247 lines**) — Phase 1 multi-outline storage topology removed: deletes `outline_manager.rs` (611), `api/outlines.rs` (563), `floatty-core/src/outline.rs` (162, `OutlineName` type), frontend `outline::` handler (64), `appEvents.ts` (24, `pendingOutlineSwitch` carrier). `WsState` collapsed to single `broadcaster` field (renamed from `default_broadcaster`); `ws_handler` drops the `outline` query branch + `WsQuery` deserializer. `create_router` signature loses `OutlineManager` arg. `backup_dir_for(outline_name)` collapses to `backup_dir()` (sole caller passed `"default"` after route removal). `App.tsx` drops outline-restore-on-connect + native menu listener + `pendingOutlineSwitch` effect; adds defensive one-shot `localStorage.removeItem('floatty-outline')` migration. `httpClient.currentOutline` signal + `setOutline`/`getOutline` + per-outline `api()` prefix all gone. `useSyncedYDoc` WS URL no longer threads `?outline=`; IDB namespace simplified to `floatty-backup-{build}|{ws}`. Tauri-side Outlines submenu (102 lines: `fetch_outline_names`, `rebuild_outlines_menu`, capture vars, `tauri::menu::*` import) deleted. Decision-capture: `apps/floatty/docs/adrs/ADR-006-retire-db-per-outline.md`, `.claude/rules/integration-branch-discipline.md` (process lesson, multi-outline retirement is the canonical worked example), `.claude/handoffs/multi-outline-rollback-recon-2026-05-05.md` (recon body). `api/mod.rs` test boilerplate consolidates 11 inline `tempdir + YDocStore + WsBroadcaster + HookSystem + create_router` setups to existing `test_app()` helper (-66 lines test boilerplate). Symmetry-harness per-outline arms in `tests/symmetry_ancestor_context.rs` dropped; default-route arms keep FLO-679 contract. Migration: stale `floatty-backup-{build}|{ws}|default` IDBs cleaned up via fire-and-forget `deleteDatabase` on namespace set.

### 🐛 Fixes

- **TabNav active-binding reactive desync** ([[PR #297]] / `ada3de8`) — `useBoundProp` returned a primitive the closure captured forever; clicks moved body content but not the button highlight. Mirror to a local signal + `createEffect` sync.
- **DecisionLog topic hierarchy** ([[PR #297]] / `ada3de8`) — optional `topic` field for "what was being decided" grouping above per-decision rows.
- **TuiStat reshape** ([[PR #297]] / `ada3de8`) — equal-width cards became less-generic typographic block.
- **TreeView CSS-drawn connectors** ([[PR #297]] / `ada3de8`) — replaces brittle ASCII chars (`├── │ └──`) with CSS pseudo-elements; clean rendering at any zoom.
- **Hero action affordance** ([[PR #297]] / `ada3de8`) — text-link "see also" actions with kicker labels instead of pill buttons (drops contrast + dead-route issues together).

### 📝 Docs

- **ADR-006: Retire DB-per-outline as Mainline Architecture** ([[PR #298]]) — canonical decision record. World/workspace ≠ outline/view/scope distinction; bar to revisit (10+/10 with seven specific reintroduction triggers); preserves the lesson, retires the storage topology.
- **`.claude/rules/integration-branch-discipline.md`** ([[PR #298]]) — process rule: architecture experiments land on integration branches with explicit "this is now a building block" confirmation before mainline merge. Multi-outline retirement is the canonical worked example.
- **Recon handoff** at `.claude/handoffs/multi-outline-rollback-recon-2026-05-05.md` ([[PR #298]]) — audit re-verification, drift archaeology since 2026-04-07, A–G surface classification, parity matrix, cleanup phases.
- **Phase 1 review marked superseded** ([[PR #298]]) — `apps/floatty/docs/reviews/multi-outline-phase1-review.md` retains a "superseded by ADR-006" status header for archaeology.
- **Render-door rig architecture** ([[PR #296]]) — `gain` ceilings updated (1.5× → 2.5×) in the RIG_ARCHITECTURE notes; component schema descriptions teach mix-balance vs boost semantics.

### 🧪 Tests

- **`api/mod.rs` `test_app()` consolidation** ([[PR #298]]) — 11 inline test setups collapsed to existing helper (-66 lines test boilerplate). Sites that read `store` directly keep `store`; rest use `_store`. 103/103 lib tests still pass.
- **`idbBackup` test assertions end-anchored** ([[PR #298]]) — `stringMatching(/...$/)` instead of `stringContaining` so a regression to the legacy 3-part `…|default` namespace fails the test (CR follow-up review). Plus `deleteDatabase` mock stub for the new ADR-006 migration code path. 1268/1268 vitest.

---

## [0.13.8] - 2026-04-29

Five-merge release: techno-fidget audio rig + auto-execute architecture cleanup + FLO-698 read-path instrumentation + outline-explorer MCP expansion + personal-log changelog scaffolding. The headline shifts: agent-emitted `render::` blocks (chirp `create-child`, `POST /api/v1/blocks`) now auto-execute the same way user-typed ones do — three call sites converge on one canonical primitive (`_autoExecuteHandler` in `useBlockStore`, slim-path emit threshold, output-presence guard). The render-door grew an audio-rig pattern (MasterClock + slave sequencers + FX bus + Strudel iframe) and a "blocks-as-config" facility where child `prefix:: value` blocks override the parent door's `spec.state` reactively. Daddy's diagnostic stack on the freeze-on-load issue ([[FLO-698]]) gained microsecond timing fields on the three read endpoints, and outline-explorer's MCP shipped dual-shape reads, token previews, and write CRUD so other agents can drive the outline programmatically.

### ✨ Features

- **Techno-fidget audio rig + auto-execute foundation** ([[PR #290]] / `33ea520` — `packages/render-door/src/components.tsx`, `packages/render-catalog/src/components/door.ts`, `apps/render-reference/src/specs/`) — full audio-rig primitive lands in the render door: `MasterClock` (BPM + transport + step counter), `MasterFX` (delay + reverb send bus per `rigId`), and slave sequencers (`StepSequencer`, `AcidBass`, `EuclideanDrums`, `XYPad`, `DrumPad`, `Tone`) that subscribe to the rig via `RigBus` (window-singleton listener registries). Tracks per-slave swing on off-beat 16ths via `applySwing`. `EuclideanDrums` uses E. Bjorklund 2003 recursive form with rotate-to-first-hit (`bjorklund` + `rotateArray` exported with 30 unit tests). `Strudel` component embeds strudel.cc REPL via base64-encoded URL hash. Composable preset library at `apps/render-reference/src/specs/synth-presets.ts` (drum kits, patterns, acid lines, euclidean classics) lets agents grab from the library instead of synthesising every beat from scratch.
- **Auto-execute canonical primitive + slim-path emit** ([[PR #295]] / `1000922` — `apps/floatty/src/hooks/useBlockStore.ts`, `apps/floatty/src/lib/chirpWriteHandler.ts`, `apps/floatty/docs/architecture/AGENT_CREATED_DOOR_BLOCKS.md`) — chirp `create-child` / `upsert-child` now route through the canonical `_autoExecuteHandler` primitive in `useBlockStore` instead of a parallel `executeBlockIfHandler` callback (deleted with `useBlockExecution.ts`). Atomic `createBlockInsideWithContent(parentId, content)` so the resulting `block:add` event carries real content — `isAutoExecutable(content)` fires on first observation. `render::` added to the allowlist; slim-path now emits `blockEventBus` for steady-state Remote / ReconnectAuthority adds (gated by `SLIM_PATH_EMIT_THRESHOLD = 50` so initial-sync bulk reconnects keep skipping). Three subtle YMapEvent shapes tracked: path-1 `event.changes.keys` and path-2+ `path[1]`. New file `AGENT_CREATED_DOOR_BLOCKS.md` preserves the parallel-path → canonical-primitive lesson verbatim. Net: chirp create-child, `POST /api/v1/blocks`, and user-typed `render::` blocks all converge on one primitive. 17 files, +1328/-729.
- **Render-door blocks-as-config — child blocks override `spec.state`** ([[PR #295]] / `1000922` — `packages/render-door/src/render.tsx`, `packages/render-door/src/child-config.test.ts`) — raw-json render route now reads child blocks as `prefix:: value` overrides for `spec.state` (`parseChildConfigValue` / `readChildConfig` / `applyChildConfig`) and re-projects when child content / parentage changes via `subscribeBlockChanges`. Users can edit `bpm:: 130` under a render block to retune the parent door reactively. Reserved prefixes (`render::`, `ctx::`, `sh::`, `ai::`, `chat::`, `dispatch::`, `daily::`, `echocopy::`, `sync::`, `pages::`) are skipped so they retain their own outline meaning. 20 unit tests.
- **`useSlaveRig` audio-rig hook + `onDetach` callback** ([[PR #295]] / `1000922` — `packages/render-door/src/components.tsx`) — extracts the slave-mode subscription bookkeeping from 3 inline copies (StepSequencer / AcidBass / EuclideanDrums) into one hook with a generation counter for swing-delayed-fire race protection (consumer's `onStep` receives an `isStillCurrent: () => boolean` accessor — guards against rig swap during pending swing window). `onDetach` callback fires before tearing down the old rig's subscriptions so AcidBass kills its sustained 303 osc and the step-based sequencers reset `playing` / `currentStep` instead of leaving the previous rig's last beat frozen on the UI. `BeatTicksFooter` + `ClockBadge` JSX helpers consolidated from 3 duplicate inline copies.
- **outline-explorer MCP: dual-shape reads + token previews + write CRUD** ([[PR #291]] / `1405356` — `apps/outline-explorer/src/mcp/tools.ts`, `apps/outline-explorer/src/lib/types.ts`) — MCP tools now emit dual-shape responses (compact + detailed) so agents can pick the layer they need; token-budget previews on heavy reads; and full write CRUD (create / update / delete / move blocks) for programmatic outline manipulation. Substantial expansion of the MCP surface area for agent-driven workflows.

### 🐛 Fixes

- **FLO-698 P1: read-path tracing instrumentation for freeze diagnostics** ([[PR #293]] / `c1d9a6e` / [[FLO-698]] — `apps/floatty/src-tauri/floatty-server/src/api/sync.rs`) — `#[tracing::instrument]` on `get_state` / `get_state_vector` / `get_state_hash` with per-phase timing in microseconds (`*_us` field naming, `as_micros() as u64` — millisecond truncation was silencing every phase < 1 ms on small documents). `get_state_hash` consolidated to one snapshot: `lock_encode_us` + `count_us` measured under the same `doc_guard`/`txn`, then guard dropped before `hash_us`. Two consequences fixed: (1) caller's drift detection no longer sees spurious mismatches when a concurrent write lands between the two former transactions, and (2) `count_us` now measures pure traversal time without conflating a second-lock-acquire wait under writer-starvation contention. Daddy's Loki diagnostics now have the resolution + snapshot consistency to pinpoint freeze causes.
- **Render-door: rig swaps + Strudel UTF-8** ([[PR #295]] / `1000922` — `packages/render-door/src/components.tsx`) — `useSlaveRig` `onDetach` (above) prevents AcidBass droning + sequencers stuck on previous rig's beat after live `clockRig()` swap. FX bus HMR staleness fix evicts buses whose `AudioContext` is no longer the active one (prevents `cannot connect to AudioNode belonging to a different audio context` after hot reload). Strudel iframe `btoa()` UTF-8 path: `TextEncoder` + binary-string base64 so emoji / accented / CJK patterns no longer throw `InvalidCharacterError`.
- **Atomic chirp create-child** ([[PR #295]] / `1000922` — `apps/floatty/src/hooks/useBlockStore.ts`, `apps/floatty/src/lib/chirpWriteHandler.ts`) — chirp `create-child` previously split block creation across two Y.Doc transactions: `createBlockInside` (empty content) then `updateBlockContent`. The `block:add` event fired with empty content, `isAutoExecutable("")` returned false, the auto-execute guard skipped, and the subsequent content update arrived as a YMap field change the guard didn't check — so agent-emitted handler-prefixed blocks via chirp sat as raw text. New `createBlockInsideWithContent` makes creation atomic so the `add` event carries real content on its first observation.

### 📝 Docs

- **`AGENT_CREATED_DOOR_BLOCKS.md`** ([[PR #295]] / `1000922`) — full lifecycle + the architecture lesson preserved: `_autoExecuteHandler` is the canonical primitive; slim-path was the actual blocker (not chirp); when adding a new mechanism, grep for the existing primitive first.
- **`packages/render-door/docs/RIG_ARCHITECTURE.md`** ([[PR #290]] / [[PR #295]]) — Phase 1/2/3 plan + decision records for the audio-rig pattern (RigBus, FX bus per `rigId`, slave-mode generation counter).
- **Personal-log changelogs for `outline-explorer` + `ink-chat`** ([[PR #294]] / `58a7c1b`) — first-class CHANGELOG.md scaffolding for the two new apps brought into the monorepo via [[PR #237]]. Grounds future release work for them in the same shape as floatty's own.

### 🧪 Tests

- **`packages/render-door/src/audio-rig.test.ts` (new)** — bjorklund canonical patterns (1, 2, 3, 4, 5, 6 hits in 8/16 steps with rotation), `rotateArray`, `RigBus` pub/sub, `applySwing` off-beat delay timing. 30 cases.
- **`packages/render-door/src/child-config.test.ts` (new)** — `parseChildConfigValue` (numeric, boolean, string, JSON, array), `readChildConfig` (ignores reserved prefixes, handles unparented children gracefully), `applyChildConfig` (merges over defaults). 20 cases.
- **`apps/floatty/src/hooks/isAutoExecutable.test.ts` (new)** — allowlist contract: `daily::` ✓, `render::` ✓, `sh::` ✗, `ai::` ✗, `term::` ✗, `chat::` ✗, `dispatch::` ✗. 16 cases — locks the policy that auto-executable handlers must be idempotent and view-only (no shell, no API tokens, no side effects).
- **`apps/floatty/src/lib/chirpWriteHandler.test.ts`** — atomic `create-child` shape verified (single-call `createBlockInsideWithContent` instead of two-call create-then-update). Suite total: 1251 → 1268.

---

## [0.13.7] - 2026-04-28

Sidebar-pin chirp wikilinks now route to the user's Cmd+L target pane ([[FLO-696]]). Single-fix patch surfaced during RCA on a `render::agent` door pinned in the sidebar shelf — clicks navigated *inside* the pin instead of routing to the linked tab pane. Root cause was a sibling-drift between `paneLinkStore.resolveLink` (the chirp / deep-link / Cmd+Shift+L primitive) and `lib/navigation.ts::resolveSameTabLink` (the native-wikilink path). The [[FLO-671]] sidebar fallback shipped only on the latter; chirp callers silently fell back to the source pane. This release lifts the fallback into the primitive and updates the parent function to delegate, restoring symmetry.

### 🐛 Fixes

- **Sidebar-pin chirp wikilinks route to linked tab pane** (`d2bc331` / [[PR #288]] / [[FLO-696]] — `apps/floatty/src/hooks/usePaneLinkStore.ts`, `apps/floatty/src/lib/navigation.ts`) — `paneLinkStore.resolveLink` (the primitive used by `handleChirpNavigate`, `resolveTargetPane`, `App.tsx` deep-link, Cmd+Shift+L) was missing the [[FLO-671]] sidebar fallback that PR [[#269]] added only to `resolveSameTabLink`. From a sidebar pin's render door, chirp navigation got `null` and the caller `??`'d back to `sourcePaneId` (the pin), so the click landed inside the pin. Lifted the fallback into `resolveLink` as the single primitive (chain: block link → pane link → sidebar fallback → null) and restructured `resolveSameTabLink` to short-circuit the same-tab guard for sidebar sources (since `resolveLink` now enforces correctness). Both chirp and native wikilink paths now behave identically from inside a pin. **Behavior change worth noting**: `Cmd+Shift+L` from a focused block inside a sidebar pin previously was a no-op; now follows `sidebarLinks[activeTab]`. 12 new tests covering sidebar fallback + tab-hosted regression + parity.

### 🧪 Tests

- **`apps/floatty/src/hooks/usePaneLinkStore.test.ts` (new)** — first dedicated test file for `paneLinkStore`. 12 cases: 6 sidebar-fallback, 3 tab-hosted regression, 3 `resolveSameTabLink` parity. Resilient to singleton-state pollution from sibling test files (`paneStore` + `tabStore` + `layoutStore` + `paneLinkStore` all reset in `beforeEach`/`afterEach`). Suite total: 1248 → 1251.

---

## [0.13.6] - 2026-04-27

echoCopy:: door projection levels up to BlockDown — generic walker + 22 new explicit cases for component types that previously fell silently to `<!-- ComponentName -->`. TreeView now round-trips through `parseMarkdownTree` as nested child blocks (3-way invariant: tree spec ↔ indented bullets ↔ outline). render::agent shipped a defensive parse fix after a shell-init regression started leaking ANSI escapes into stdout.

### ✨ Features

- **echoCopy projection emits BlockDown idioms** (`7fa3e0e`, `0bb6afe`, `e39ee4f` — `apps/floatty/src/lib/handlers/hooks/outputSummaryHook.ts`) — `flattenSpecToMarkdown` previously had explicit cases for 16/55 catalog component types and silently dropped the rest via `default: break;`. Now: generic prop walker emits text-bearing props with `<!-- ${type} -->` grep markers (no silent drops), 22 new explicit cases borrow width-agnostic ASCII idioms from the [[3d40632d]] W15 dispatch — `▓▓▒▒ TITLE ▒▒▓▓` shaded headers (CollapsibleSection, TuiPanel), `████████ value` filled-block bars (BarChart owns its children walk to scale BarItems via closure), `* ✦` shipped items, `· · ·` ellipsis, `_← label_` breadcrumbs, `→` LinkGraph edges, `✓ ▸ ○ ⊘` TreeView status symbols. TreeView projects to indented bullets that `parseMarkdownTree` reconstructs as nested child blocks at original tree depth — the projection is structurally lossless for hierarchical components. 32 new tests.

### 🐛 Fixes

- **render-door agent: strip non-JSON prefix from claude --output-format json wrapper** (`aca2ac2` — `packages/render-door/src/render.tsx`) — under non-TTY parents (Tauri spawns via pipes), oh-my-zsh's iTerm2 integration in `chpwd_functions` emits `OSC 1337;CurrentDir=...` escape sequences when the shell does `cd "..." &&` to enter the agent cwd. Those escapes survived subprocess capture and prepended the JSON wrapper, causing `JSON.parse` to fail at byte 0 with `Unrecognized token ''` (ASCII ESC, 0x1B) — a copy-paste-evading character that displayed in the floatty error UI as a placeholder glyph. Defensive fix: `stripJsonPrefix()` locates the first `{`, slices from there, logs stripped bytes as space-separated hex for diagnosis. Helper exported with 14 unit tests covering ANSI CSI, OSC, BOM, ZWSP, garbage prose, and end-to-end `JSON.parse` roundtrip after a real ANSI prefix. [[FLO-687]] tracks the deeper `execute_shell_clean` Rust-side root cause fix.

### 📝 Docs

- **outline-explorer MCP: `get_block` advertises short-hash prefix support** (`13092f5` — `apps/outline-explorer/src/mcp/tools.ts`) — server-side resolution of 6+ hex char prefixes via `/api/v1/blocks/:id` was already shipped (handles `[[37371679]]` paste-and-resolve from cmd-cmd block-ID copy), but the tool description and `blockId` param doc both said "UUID" — agents reading the schema had no signal that short-hashes work. Description now documents prefix support, the `[[ ]]` strip step, and the 409-on-ambiguous fallback.

---

## [0.13.5] - 2026-04-26

Recency-sortable search hits + a hidden Tantivy staleness fix surfaced while reviving [[FLO-373]] (backlinks panel v2). The artifact iteration in claude-live wanted to sort inbound refs by `updatedAt` and discovered the data wasn't on the wire — and the Tantivy STORED column it would've fallen back to was being clobbered with `Utc::now()` on every reindex.

### ✨ Features

- **`BlockSearchHit` carries `createdAt` / `updatedAt` / `outputType`** ([[PR #287]] [[FLO-684]]) — search hits and `outlink=`-filtered backlink results now surface block timestamps and output type alongside content + breadcrumb. ms-resolution from Y.Map at response time, mirrors `BlockDto` for the same block. Eliminates the N+1 `floatty_block_get` follow-up agents previously needed for recency sorting and door-vs-text classification.
- **MCP `get_inbound` parameterized** ([[PR #287]] [[FLO-684]]) — `limit` (was hardcoded 15, now max 200) + `metaFilter` (`all` / `with-meta` / `without-meta`) wired to `?has_markers=`. `search_blocks` now shares the same `.max(200)` cap so agents can't slip a runaway query through one tool while the other guards.

### 🐛 Fixes

- **Tantivy indexer no longer clobbers `updated_at` with wall-clock NOW** ([[PR #287]] [[FLO-684]] — `apps/floatty/src-tauri/floatty-core/src/hooks/tantivy_index.rs:244`): the indexer now reads the block's actual `updatedAt` from the store instead of stamping with `chrono::Utc::now().timestamp()` at index time. Since the search index is ephemeral (rebuilt from Y.Doc on every app start), the bug meant every restart reset all `updated_at` values to startup time — recency sort across restarts was silently broken. Fix is one expression; consequences for any future `updated_after`/`updated_before` filter are larger.
- **`shape_search_hit` does one Y.Map lookup per hit, not three** ([[PR #287]] [[FLO-684]]): coalesced repeated `bmap.get(block_id)` calls into a single hoisted `block_map` reference. Pre-fix, content + metadata + (this PR's) timestamps each issued their own lookup; yrs `MapRef::get` is O(log n) and uncached within a transaction, so the constant factor mattered at search-result list size.

### Internal

- **Symmetry harness gets two new contracts** in `floatty-server/tests/symmetry_ancestor_context.rs`:
  - **CONTRACT 7** — `BlockSearchHit.{createdAt, updatedAt, outputType}` mirror the block's Y.Map fields. Catches future write-path drift between the singleton `read_block_dto` (`/blocks/:id`) and the search-path `shape_search_hit` (`/search`, `outline=` filter, `get_inbound`).
  - **CONTRACT 7b** — the no-blocks-map early-return path produces zero/None defaults; `skip_serializing_if` guards keep them off the wire.
- **`.claude/rules/api-reference.md` + `floatty-backend` skill** updated to document the new fields. Skill notes the deleted-but-still-indexed race may omit these fields via `skip_serializing_if`, so consumers should null-check before reading.

### Doctrine surfaced this cycle

- **CodeRabbit hallucination check protects working code** ([[PR #287]] round-1 review): CodeRabbit flagged a Major finding claiming `/blocks/:id?include=tree` returns a `{ block, tree }` wrapper. Verified against the running dev server (port 33333) — the response is flat (`createdAt`, `updatedAt`, `tree` all top-level on `BlockDto`); the suggested change would have broken pre-existing working code. Dismissed with curl evidence; CodeRabbit retracted with an apology and banked the API shape as a learning. The "verify audit findings before acting" memory is what kept the wrong fix from landing.
- **Symmetry sweeps catch param-cap drift** ([[PR #287]] round-1 Greptile P2): `get_inbound` got `.int().positive().max(200)` in the same PR but `search_blocks` was left unbounded. Greptile caught the asymmetry; aligned both tools to the same shape. The lesson is the same one `.claude/rules/symmetry-check.md` codifies: when you change HOW something works in one place, grep every sibling.

### Relates

- [[FLO-373]] — backlinks panel v2 (revived 2026-04-26 after artifact iteration in claude-live)
- [[FLO-338]] — prior search API enrichment, shipped without timestamps
- [[FLO-401]] — unlinked references panel, adjacent UX work to be absorbed at port time
- [[FLO-680]] — presence DTO ancestor-context, parallel architecture for the navigation surface

---

## [0.13.3] - 2026-04-26

Symmetry-check sweep against `packages/render-door/src/components.tsx`. Three bugs that were fixed in `apps/outline-explorer`'s parallel renderers (one in v0.13.0, two in v0.13.2) had drifted in the SolidJS port — render-door has its own "EXPLORER PORTS" section (`components.tsx:2446`) that was never re-synced. Same issues, same fixes, ported with adapted SolidJS reactivity / inline-style equivalents.

### 🐛 Fixes

- **render-door `ProvenanceChain` no longer renders `NaN%` for non-finite confidence** ([[PR #284]] symmetry-check follow-up): the gate `step.confidence != null` caught `null`/`undefined` but not `NaN` (`NaN != null` is `true` in JS). Replaced with `Number.isFinite(step.confidence)` for proper numeric narrowing. v0.13.0 fixed the same bug in `apps/outline-explorer/src/lib/catalog/renderers/visualizations.tsx`; the SolidJS port at `packages/render-door/src/components.tsx:2607` had the same code unchanged. **Symmetry-check miss**: changelog only mentioned the outline-explorer fix.
- **render-door `ProvenanceChain` auto-detects 0–100 confidence ints** ([[PR #284]] bug #4 propagated): renderer now treats `confidence > 1 && <= 100` as already-percent and `<= 1` as a fraction. Daddy's bug #4 hit outline-explorer in v0.13.2 (`100 → 10000%`); the SolidJS port had the same `Math.round(step.confidence! * 100)` math, so any door rendered through `bbsCatalog` in the floatty outliner would've shown `10000%` until this fix. Both renderers now share the `raw > 1 && raw <= 100 ? raw : raw * 100` shape.
- **render-door `ActivityHeatmap` legend labels no longer collide on long content** ([[PR #284]] bug propagated): outline-explorer's v0.13.0 fix added `gap-2` + `truncate min-w-0` (Tailwind); the SolidJS port uses inline styles, so the equivalents are `gap: '8px'` on the flex container, `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on the first/last spans, and `flex-shrink: 0` on the middle `peak: N` span so it doesn't get squished when the side labels are long.

### Internal

- **`pnpm --filter @floatty/render-door deploy:all`** — door bundle rebuilt and copied to both `~/.floatty-dev/doors/render/index.js` and `~/.floatty/doors/render/index.js` so the running release picks up the fixes immediately on next door reload (no Tauri rebuild required for door-only changes). Bundle size 940.0 KB → 941.0 KB (+1 KB for the auto-detect IIFE + extra inline-style attrs). The first-run zip at `apps/floatty/doors/render.zip` is regenerated by `./scripts/rebuild.sh`, not by this command.

### Doctrine surfaced this cycle

- **The `// EXPLORER PORTS —` comment block at `components.tsx:2446` is a symmetry-check liability** — render-door imported the explorer-side renderers (LinkGraph, ActivityHeatmap, ProvenanceChain, etc.) as ports but kept them inline rather than sharing source. Means every fix on the React side has to be re-applied to the SolidJS side manually, and the changelog only catches the side that was fixed first. The longer-term fix is to share renderers via a renderer-extraction (per the door-extraction pattern banked in memory: `feedback_door_extraction_pattern.md`) — but that's substantial scope. Short-term: when fixing a renderer in either consumer, grep the OTHER consumer's components for the same component name BEFORE landing the fix. Added to the audit checklist.

---

## [0.13.2] - 2026-04-26

Catch-all patch from Desktop Daddy's full ancestor-context test pass against the live outline ([[PR #284]], merged as 26ca959). Five mechanical fixes + one pre-existing PR #283 gap caught during the lint sweep, bundled because they were all mentally-loaded right then and the cognitive-overhead cost of triaging into separate tickets exceeded the cost of doing them in one motion. Two bot-review findings on the PR itself were also resolved in the same merge (greptile P1, coderabbit Minor).

### 🐛 Fixes

- **ProvenanceChain confidence value scale auto-detected** ([[PR #284]] bug #4): renderer now treats `confidence > 1 && <= 100` as already-percent (use as-is) and `<= 1` as fraction (multiply by 100). Daddy's spec passed `100` intending "100%" → rendered as `10000%` before this guard. Schema description in `packages/render-catalog/src/components/shared.ts` tightened to call out the schema-vs-runtime distinction explicitly: schema enforces 0–1, but `Spec` is permissive at runtime so agents bypassing validation still hit the renderer. The auto-detect is a defensive safety net; the contract is "emit fractions."
- **Breadcrumb ordering consistency between endpoints** ([[PR #284]] bug #1): `search_blocks` returns breadcrumb rootmost-first (server composer does `take(5).rev()` in `shape_search_hit`); `get_block` returned innermost-first because the MCP wrapper mapped `ancestors[].content` directly without reversing. Fixed in two MCP call sites: `apps/outline-explorer/src/mcp/tools.ts:170` and `apps/outline-explorer/src/lib/tools/get-block.ts:29`. Agent code that does `breadcrumb[0]` now gets a consistent "rootmost ancestor" answer regardless of which endpoint produced the response.
- **Marker parser unwraps embedded `[[wikilink]]` typos** ([[PR #284]] bug #2): `[project::[[floatty]]]` was capturing `[[floatty` because the `TAG_PATTERN` regex (`[^\]]+`) is greedy and stops at the first `]`. New `sanitize_marker_value()` helper in `floatty-core::hooks::parsing` strips a leading `[[` and trailing `]]` from captured values; clean values pass through unchanged. Two new unit tests lock the behavior in (`test_tag_marker_unwraps_embedded_wikilink`, `test_tag_marker_clean_value_passes_through`). Surfaced on a single historic block; low severity but unblocks downstream consumers expecting clean strings.
- **Ancestor depth cap bumped 10 → 20** ([[PR #284]] watch-this): hoisted to a single `pub(crate) const ANCESTOR_CONTEXT_MAX_DEPTH: usize = 20` in `block_service.rs` covering both `compute_ancestor_context` (populates `ancestorBlockIds`) and `get_ancestors` (used by the breadcrumb composer). Live-outline depth probe (31,120 blocks) found real-world max=16 with ~700 blocks (2.2%) above the old cap silently truncating their rootmost ancestors. 20 leaves headroom (only 1 block above it today). Symmetry harness chain bumped 16 → 25 (`ancestor_block_ids_caps_at_walker_max`); companion lib test renamed `get_ancestors_caps_at_ten` → `get_ancestors_caps_at_walker_max`. `api-reference.md` wire docs updated to reflect the new cap.
- **MCP `get_inbound` opt-in parity with `search_blocks`** ([[PR #284]] gap): `search_blocks` was passing `?include=effective_markers`; `get_inbound` wasn't. Added the param to both call sites (`mcp/tools.ts` server-side + `lib/tools/get-inbound.ts` AI-SDK), and wired the existing `include` opt in `SearchOptions` through `floatty-client.ts::searchBlocks` (the type was declared but the param builder skipped it — declaration-without-backfill, same shape as the v0.13.0 doctrine).
- **`get_inbound` AI-SDK refs surface `ancestorContext`** ([[PR #284]] greptile P1 self-review): I added `include=effective_markers` but only the MCP-server path forwarded `h.ancestorContext` on hits; the AI-SDK tool's `refs` projection only forwarded `{content, breadcrumb}`. Pure backend overhead — fetched the data, dropped it before the caller. Now mirrors the MCP server shape. Caught by greptile bot-review on PR #284 itself; resolved in the same merge.

### Internal

- **`packages/render-catalog/eslint.config.js` created** ([[PR #284]], pre-existing PR #283 gap): the package shipped with `"lint": "eslint ."` in scripts but no config file. ESLint v9 fails fast without `eslint.config.js`, so `pnpm lint --force` was returning non-zero on `@float/render-catalog` even on clean main. Mirrors `packages/render-door/eslint.config.js` (no JSX, no console diagnostics, `_`-prefix unused-var convention). Same root-cause class as the v0.13.0 doctrine: forward-declared scripts without backfill are the load-bearing failure mode.

### Doctrine surfaced this cycle

- **"Audit blast radius" lesson, fourth instance** — same root cause as the three banked in v0.13.0 + v0.13.1 doctrine, except this time it bit me on the same PR I added the surface in. I added `include=effective_markers` to both `get_inbound` call sites in PR #284's initial commit but only updated ONE return projection to actually consume the result. Greptile caught it on bot review. Reinforces: when a feature has multiple call sites or multiple projection layers, the audit must visit ALL of them — not just the closest neighbor. Added to the audit checklist in the memory file (`feedback_audit_blast_radius_before_changing_shared_contracts.md`).

---

## [0.13.1] - 2026-04-26

### 🐛 Fixes

- **`outputSummaryHook.ts` PatternCard markdown projection migrated to canonical signature** ([[FLO-657]] follow-up): the frontend `flattenSpecToMarkdown()` walker (which writes `block.metadata.renderedMarkdown`) was still reading the OLD PatternCard shape (`p.title`, `p.type`, `p.content`, `p.connectsTo`) after v0.13.0 canonicalized to `{label, description, confidence}`. Per the four-layer `renderedMarkdown` fallback chain (`output.data.normalizedMarkdown` → `metadata.renderedMarkdown` → `walk_spec_to_markdown` Rust → `walk_generic_json_to_markdown`), the frontend hook output is preferred over the migrated Rust walker — so PatternCard sections in `renderedMarkdown` came out as `### Pattern (high)` with the description body dropped (the Rust walker was correct, but never reached). Both the summary scanner (line 123–125) and the markdown projection switch (line 176–180) now read `p.label` / `p.description` / `p.confidence`. Surfaced by Desktop Daddy's full ancestor-context test pass against the live outline (kitchen-sink door spec on `render test` page) — same finding documented as bug #3 in that report.

### Doctrine surfaced this cycle

- **Blast-radius miss, third instance** — same root cause as the two PR #283 cases banked in v0.13.0 doctrine. The `feedback_audit_blast_radius_before_changing_shared_contracts.md` memory specifically called out "all four PatternCard surfaces" — the four are: (1) Zod schema in `@float/render-catalog` ✅, (2) SolidJS renderer in `@floatty/render-door` ✅, (3) Rust walker in `floatty-core::projections` ✅, (4) **frontend markdown hook in `apps/floatty/src/lib/handlers/hooks/outputSummaryHook.ts` ❌ (this fix)**. The fourth surface was not on the audit list because the four-layer fallback chain wasn't fully traced — the Rust walker was assumed authoritative when in practice the frontend hook intercepts it. **Update to the audit checklist**: when changing a shared component schema, grep BOTH for the component name AND for `renderedMarkdown` / `flattenSpecToMarkdown` writers — the projection layer has multiple writers and only the highest-priority one's output is used.

### Out-of-scope findings from same test pass (filed separately)

Desktop Daddy's full ancestor-context verification against the live outline (running floatty server, `render test` page, real conversation content) surfaced two more unrelated bugs and one watch-this. Not bundled into v0.13.1 because they're backend (`floatty-server`/`floatty-core`) concerns, not the frontend hook this patch fixes:

- **Breadcrumb ordering inconsistency between endpoints** (medium severity): `search_blocks` returns `breadcrumb` rootmost-first (`["pages::", "# render test"]`); `get_block` returns it innermost-first (`["# render test", "pages::"]`). `ancestorContext.ancestorBlockIds` is consistent across both (rootmost-first per the symmetry harness in [[PR #282]]) — only `breadcrumb` drifts. Agent code that does `breadcrumb[0]` gets a different answer depending on which endpoint produced the response. To file: `apps/floatty/src-tauri/floatty-server/src/api.rs` (BlockResponse breadcrumb composer vs SearchHit breadcrumb composer).
- **Marker parser captures broken `[[wikilink]]` syntax inside `[type::value]`** (low severity): on a historic block with content `ctx::2026-04-19 @ 04:01:51 PM = [project::[[floatty]] = [[2026-04-19]]` (a typo where the author wrote `[project::[[floatty]]]` instead of `[project::floatty]`), the marker parser captures `value: "[[floatty"` — literal opening bracket included. Should either reject as malformed or resolve `[[floatty]]` to its target. Affects `effectiveMarkers.value` shape for downstream consumers expecting clean strings.
- **Watch: real-world `ancestorBlockIds` depth at 9 (cap is 10)**: a hit on the FLO-680 thread (deep daily-note nesting) returned 9 ancestor IDs. One more level of nesting starts truncating root ancestors. User confirmed deep-nest is normal usage pattern; worth probing actual outline ancestor depth distribution to size the cap appropriately. Probe planned post-release.

---

## [0.13.0] - 2026-04-26

### ✨ Features

- **`@float/render-catalog` — shared FLOAT semantic vocabulary extracted from render-door + outline-explorer** ([[FLO-656]] parent, [[FLO-657]] this work, [[PR #283]]): new private workspace package consolidates the 68 component definitions that were previously declared inline (and divergently) in two consumer catalogs. Package shape modeled on `@json-render/ink/catalog` precedent — exports plain `*ComponentDefinitions` objects (`sharedComponentDefinitions`, `doorComponentDefinitions`, `explorerComponentDefinitions`) that consumers spread into their own `defineCatalog(schema, {...})` calls with their platform-specific schema (`@json-render/solid/schema` for render-door, `@json-render/react/schema` for outline-explorer). React and Solid schemas are byte-identical at the schema layer (verified by reading both `defineSchema(...)` calls), so a shared Zod component definition is portable across renderers without translation. Constraint enforced: `packages/render-catalog/src/` only imports `@json-render/core` + `zod` — zero solid, zero react, zero JSX. Both consumer catalog files shrunk from 545+318 lines down to 52+42 lines (thin composers: imports, single `defineCatalog` call, action definitions, export). Phase 1 of [[FLO-656]]; siblings [[FLO-658]] (skill relocation) and [[FLO-659]] (`@float/render-floatty` outline-target renderer) are queued separately.
- **PatternCard signature canonicalized** — Set A's only blocker resolved: render-door had `{title, content, type?, confidence?: string, connectsTo?: string[]}`, outline-explorer had `{label, description, confidence?: enum}`. Total signature divergence on a same-named component. Locked in **Option A**: explorer's signature wins (`{label, description, confidence: 'high' | 'medium' | 'low'}`) — semantic, doctrine-aligned ("describe what it MEANS"), Zod enum tighter than free-form string. Migrated all 14 PatternCard call sites across `apps/render-reference/src/specs/{sprint-wrap, conceptual-patterns, meeting-notes, catalog-atoms}.ts` + Rust projection in `apps/floatty/src-tauri/floatty-core/src/projections/mod.rs`. Old `type:` categorical signal folded into description as italic prefix (`*Doctrine.* ...`); old `connectsTo` folded into description as `**Refs**: [[wikilink]], ...` line; legacy free-form confidence values mapped to enum (`'VERIFIED' → 'high'`, `'INFERRED' → 'low'`, `'validated' → 'high'`, `'hypothesis' → 'low'`, `'partial-evidence' → 'medium'`) or dropped where not actually confidence (`'stated-by-Kai'` was provenance not confidence — folded as attribution; `'candidate-6th-death-spiral'` was categorization — folded as prefix).
- **PatternCard renderer simpler + bundle smaller** — type badge UI removed (dead code path), `connectsTo` footer removed (dead code path), confidence renders as colored uppercase pill (high=green, medium=amber, low=muted) instead of `'✓ VERIFIED'` / `'? INFERRED'` icon labels. Net `-49 lines` in `packages/render-door/src/components.tsx`; render-door bundle 909.8 KB → 907.7 KB; render-reference 388 KB → 386 KB.

### 🐛 Fixes

- **`outline-explorer` ProvenanceChain no longer renders `NaN%` for non-finite confidence** (`apps/outline-explorer/src/lib/catalog/renderers/visualizations.tsx:113`): the gate `step.confidence != null` caught `null`/`undefined` but not `NaN` (`NaN != null` is `true` in JS). When the agent emits `confidence: NaN` (or any non-numeric), it slipped through and rendered `NaN%`. Replaced with `Number.isFinite(step.confidence)` for proper numeric narrowing. Pre-existing bug surfaced during outline-explorer testing post-FLO-657 deploy.
- **`outline-explorer` ActivityHeatmap legend labels no longer collide on long content** (`apps/outline-explorer/src/lib/catalog/renderers/visualizations.tsx:81-85`): `flex justify-between` with no `gap` and no `min-w-0` let long first/last cell labels butt directly against the `peak: N` middle text. Added `gap-2` + `truncate min-w-0` so labels gracefully truncate instead of overlapping. Pre-existing.
- **`render-door` kanban smoke test restored** ([[FLO-657]] Gap-1, [[PR #283]]): `packages/render-door/src/kanban.test.ts` had been failing to load since [[PR #262]] (b6428cc) — three layered errors compounded. New `packages/render-door/vitest.config.ts` mirrors `apps/floatty/vitest.config.ts` (jsdom env + `vite-plugin-solid` + `resolve.conditions: ['development', 'browser']` for `setStyleProperty`); added `test: vitest run` script + devDeps (`vitest`, `vite-plugin-solid`, `jsdom`, `@testing-library/jest-dom`). Tests: 1 file, 17/17 passing in 1.46s. Fix bundled with FLO-657 Phase 1 rather than separate PR — gives future Set A migration a real regression net.
- **`apps/floatty` vitest test script no longer hangs CI in watch mode** ([[FLO-657]] incidental fix, [[PR #283]]): `"test": "vitest"` was a footgun for turbo orchestration — root `pnpm test` → `turbo run test` → invokes `pnpm test` per package; for floatty this ran `vitest` (watch mode) which never exited, hanging CI until timeout, blocking turbo cache. Changed to `"test": "vitest run"` (one-off, exits) + new `"test:watch": "vitest"` for interactive use. Dropped now-redundant `"test:run"` shortcut from root + apps/floatty turbo.json + README. Standard pattern across `@json-render` packages and most JS monorepos.

### Internal

- **Outline-explorer bumped to `@json-render ^0.18.0`** (was `^0.17.0`, [[FLO-657]] Phase 1 prep, [[PR #283]]): prerequisite for `@float/render-catalog` to declare `@json-render/core: ^0.18.0` while keeping both consumers (render-door + outline-explorer) on the same `defineCatalog` type surface. 0.17→0.18 is no-breaking-change per upstream changelog (additive devtools packages + `formatZodType` Zod 4 bug fix that improves prompt output for `.describe()`-heavy schemas — relevant since explorer-catalog uses `.describe()` extensively). ink-chat still pins `^0.17.0` (out of scope; future consumer work).
- **`render-door` catalog uses canonical `defineCatalog(schema, ...)`** ([[FLO-657]] Phase 1 Step 1, [[PR #283]]): mechanical refactor from `schema.createCatalog({...})` to `defineCatalog(schema, {...})` from `@json-render/core`. Old form was non-canonical — every other `@json-render` consumer (`@json-render/ink`, `@json-render/react-native`, `@json-render/shadcn`, outline-explorer) uses the latter. Same `bbsCatalog` shape; only the constructor call changed. Necessary because the future shared package can only export plain `*ComponentDefinitions` objects.
- **66 redundant TypeScript assertions stripped from catalog files** (post-`/typescript-advanced-types` audit, [[PR #283]]): `slots: ["default"] as string[]` → `slots: ["default"]` (literal already infers as `string[]` without `as const`); `} as const;` outer wrappers removed (fighting the inner widening). Reference: `@json-render/ink/catalog` doesn't use either form. Pattern was copied wrong on first pass. Mechanical fix via sed; zero functional change verified via typecheck + tests.
- **`z.unknown()` over `z.any()` for explorer action params** (post-`/simplify` reuse-review, [[PR #283]]): aligned `outline-explorer`'s `setState`/`pushState` action `value` params from `z.any()` to `z.unknown()` to match `render-door`'s stricter typing. Functional behavior identical; downstream TypeScript inference forces consumers to narrow before use.
- **Local-only paths gitignored** (0ed848c): `.claude/worktrees/` (per-developer ephemeral Agent-isolation worktrees + manual `git worktree add` flows), `.pi/extensions/`, `apps/ink-chat/.devtools/`, and door build zips under `apps/floatty/doors/*.zip` (regenerated on every release). Removed stale `.claude/commands/resolve-pr-comments.md` — superseded by global skill at `~/.claude/skills/resolve-pr-comments/`.

### Doctrine surfaced this cycle

- **"Audit blast radius before changing shared contracts"** — PR #283 caught the lesson TWICE in opposing directions. First (under-reach): I changed PatternCard schema in render-door + my own kanban test, missed 14 callers in `apps/render-reference/src/specs/*` + Rust projection. CodeRabbit caught it; full migration shipped. Second (over-reach): I migrated `apps/floatty/doors/session-garden/showcase-spec.ts` thinking it was a render-door consumer, but session-garden is a SEPARATE door with its own local catalog/renderer cloned from render-door's old shape. Reverted that migration. The lesson: **the blast-radius audit needs to determine NOT JUST who consumes the changed surface, but also confirm grep matches are actual consumers vs unrelated codebases that happen to share a component name.** Banked to memory: `feedback_audit_blast_radius_before_changing_shared_contracts.md`. Why TypeScript didn't save us: `@json-render/core`'s `Spec` type is permissive (allows arbitrary `props: Record<string, unknown>` per element). Spec files using old shape typecheck cleanly even after the schema is narrowed. **Permissive runtime types ≠ no breakage; they hide it until production.**
- **"Forward-declarations without backfill are the load-bearing failure mode"** — three `package.json` exports (`./components/list-shapes`, `./actions/door`, `./actions/explorer`) declared paths to files that would land in future PRs. Two README sections described target state, not shipped state. CodeRabbit + greptile both flagged. Fix: subpath exports MUST point to files that exist in the same PR; README MUST describe shipped state, not target state. Same root cause as the PatternCard breakage.
- **"Shim is just going to be a code branch we come to regret later"** — explicit user direction when CodeRabbit suggested a backward-compat shim in the PatternCard renderer (and again later for the Rust projection). Took the harder path: full caller migration + revert when over-migration was caught. Rust projection kept canonical-only too (legacy stored Y.Doc specs render `### Pattern` with empty body — consistent degradation; one-time migration script if/when it bites). Doctrine: shims pollute the canonical surface forever; decide the contract once, migrate consumers in one PR, accept the migration cost upfront.
- **"`render-reference` is the contract harness"** — meta-finding worth surfacing: `render-reference` is described in its own CLAUDE.md as the harness that catches `@floatty/render-door` type drift via `tsc --noEmit`. It DIDN'T catch the PatternCard breakage because spec files are typed as `Spec` (permissive) not `satisfies Spec` against a per-element-type union. Could add a stronger type binding in a follow-up; real value comes from the discipline change (audit memory above), not type-system gymnastics.

### Known Issues

- **`apps/floatty` vitest can't actually run tests yet** — separate pre-existing esbuild version mismatch (host `0.27.7` vs binary `0.25.12`) prevents floatty's tests from loading. Confirmed pre-existing via stash-and-retest. Fix is `pnpm install --force` to rebuild native binaries (worked locally during this cycle); if it recurs on a fresh clone, run again.
- **Set D list-shape components deferred** — per [[FLO-657]] Apr 20 comment, four shape-distinguished primitives (`Timeline`, `List`, `AnchoredList`, `Narrative`) are queued for follow-up. Schemas declared as empty stub in `listShapeComponentDefinitions`. Net-new components require both schemas AND renderers in both consumers (silent-drop risk per `designing-json-render-catalogs` skill). Their own PR.
- **Apr 11 prompt-wire fix queued for Phase 4** — `bbsCatalog.prompt()` exists in source but each agent's CLAUDE.md is hand-authored 300+ line component table. Now that `@float/render-catalog` is the single source for both consumers, both their hand-authored docs can be replaced with one `catalog.prompt()` call. **Enabled by** this PR; not blocked by it; follow-up work.

---

## [0.12.0] - 2026-04-26

### ✨ Features

- **`AncestorContext` on every block-returning read endpoint** ([[FLO-679]], [[FLO-680]], #282): twelve REST endpoints — `/api/v1/search`, `/api/v1/presence`, `/api/v1/blocks`, `/api/v1/blocks/:id`, `/api/v1/blocks/resolve/:prefix`, `/api/v1/pages/search`, `/api/v1/daily/:date`, `POST /api/v1/pages/:name`, `POST /api/v1/daily/:date/append`, plus all three per-outline equivalents — now return an `ancestorContext` sub-object: `nearestPageBlockId`, `nearestPageName`, `ancestorBlockIds` (rootmost-first, depth-capped 10), `ancestorOutlinks` (deduped union of walked ancestors), `subtreeSize`, `inboundCount`. Two opt-in fields via `?include=`: `effectiveMarkers` (own + inherited markers with `MarkerSource::{Own | Inherited{sourceBlockId}}` provenance) and `inboundSamples` (top-N source blocks linking to this block, top-5 default, `&inbound_sample_count=N` to override). Architectural framing per [[FLO-368]] three-layer model (human → intermediary → query) — the new fields ARE the intermediary surface, applied uniformly so consumers don't have to discover layout rules per-endpoint. Per-outline endpoints previously had FULL asymmetry (no `?include=` context support at all); shared `shape_search_hit` / `parse_include_directives` helpers extracted so future field additions can't drift the per-outline path. New MCP `presence` tool in `outline-explorer` exposes the enriched DTO directly. Symmetry harness at `floatty-server/tests/symmetry_ancestor_context.rs` (10 contract tests) asserts matching `ancestorContext` shape across endpoints from one fixture — regression net for future drift. Wire contract is purely additive (optional sub-object, `skip_serializing_if` per field); existing consumers ignore unknown fields.
- **Tantivy index gains six denormalized ancestor-context fields** (#282): `nearest_page_block_id`, `nearest_page_name`, `ancestor_block_ids` (multi-value), `subtree_size`, `inbound_count`, `inbound_block_ids` (multi-value, top-5 cap). Populated at index time by a single `walk_ancestors` call per block. Free per ephemerality (the index rebuilds on cold start; no migration). Per-search-hit cost now O(STORED-field read) instead of O(walk + reverse-index scan).
- **`PageNameIndex` reverse-index** ([[FLO-679]], #282): new O(1) `block_id_to_page_name` map, maintained on `add_existing_page` / `remove_existing_page` / `clear`. Replaces O(N_pages) linear scans in two hot paths (Tantivy index population + per-search-hit `compute_inbound`).

### 🐛 Fixes

- **`outline-explorer` MCP search restored full hit shape** ([[FLO-679]] Phase 1, #279, #280): `search_blocks` and `get_inbound` were silently dropping `blockId`, `score`, `blockType`, and `metadata.markers` from the floatty-server response — both at the `floattyFetch<>` generic AND the `.map()` projection. Agents calling `search_blocks` couldn't follow up on results because they had no IDs. Restored alongside the existing `read_block` shape convention. Follow-up #280 made `Marker.value` optional in `outline-explorer/src/lib/types.ts` to match the live API (bare prefixes like `ctx::` return without value); same `Marker` interface now used as the type for the restored `markers` field instead of `unknown[]`.

### Internal

- **`walk_ancestors` foundation: ancestor-walk hydra consolidation** ([[FLO-679]] PR 1, [[FLO-368]], #281): six divergent ancestor-walking implementations across `floatty-core` + `floatty-server` (`get_ancestors`, search breadcrumb, reparent cycle detection, export `find_root`, Tantivy `depth`, `InheritanceIndex`) collapsed into one canonical `walk_ancestors` in a new `projections::ancestor_walk` module. Five sites migrated; `InheritanceIndex` deferred as a documented carve-out (hot path on every metadata change, needs benchmark before/after — separate PR queued). Walker is generic over a `ParentLookup` trait with three adapters (`YDocParentLookup`, `StoreParentLookup`, `HashMapParentLookup`) so it serves every parent-resolution shape from one implementation. Surfaces `WalkTermination::{Root | MaxDepth | Cycle}` so mutation-side callers (reparent) can reject pre-existing cycles explicitly — symptom-and-cause from PR #281 review fixed in the same hand. Breadcrumb composer migrated to rootmost-first (`take(5).rev()`) — pre-migration code was wrong per the documented contract; behavior-preservation tests had locked in the bug. New architecture doc at `apps/floatty/docs/architecture/PROJECTIONS_LAYER.md` codifies the read-time projection layer (when to add a projection vs a hook).
- **Telemetry doctrine: OTLP silencers preserved in `tauri:dev` + INFO tier audit** (#278): scrubbed hardcoded ngrok endpoint from `LOGGING_STRATEGY.md` (Greptile P2 security; same shape as PR #237's hardcoded-key cleanup — internal endpoints don't belong in shared docs even when behind auth). Filter defaults documented in `.claude/rules/logging-discipline.md` with `hyper=warn,reqwest=warn,opentelemetry=off` silencers required to prevent telemetry-induced-telemetry loops.
- **Lint discipline sweep — ESLint 64 → 0, Clippy 131 → 0, fmt 644 → 0, ts-rs proc-macro warnings 16 → 2** ([[FLO-665]], #270 → #277, 8 PRs): every lint surface now at zero (with two documented `ts-rs` carve-outs for `deserialize_with` attributes that the crate can't reflect). New `.claude/rules/lint-discipline.md` codifies the doctrine: PR owns its lint output (no "predates this branch" rationalizations), bounded-scope escape hatch for sweep-class findings, edit-time lint hooks forbidden (handoff is the right enforcement boundary, not iteration). PR 4.5 introduced `DoorEnvelope` discriminated union (#274) — pattern-fit-checked against `outputSummaryHook.ts`'s closed message-type system before adoption; `typescript-advanced-types` skill's narrowing-vs-enumeration distinction documented as the deciding rule.
- **`floatty-backend` skill plugin updated** (#282): SKILL.md doctrine extends "Search: always read the full response" with the new `.ancestorContext.*` fields named as navigation-layer signals. New helper `floatty_search_in_project` filters by `effectiveMarkers` containing `project::X`. `floatty_search_context` pretty-printer surfaces `nearestPageName` + subtree/inbound counts. Plugin CHANGELOG bumped; references/api-reference.md mirrored.

### Doctrine surfaced this cycle

- **"A block is not a document"** — graph is between SUBTREES rooted at named ancestors, not between blocks. The `AncestorContext` shape teaches the agent's model — strip the ancestor context and agents file false-positive gap reports. Sysops post: [[2026-04-25-search-hit-dto-enrichment-layer-separation-for-flo]].
- **"Behavior-preservation tests preserve INTENT, not necessarily CORRECTNESS"** — surfaced TWICE this cycle (PR #281's breadcrumb-order bug locked in by parity tests; PR #282's `effective_markers` opt-in test passed `None` for index in both branches, never proving the gate flips). Tests must assert documented contract, not "matches what we did before."
- **"Fast-path optimizations need explicit 'insufficient' signals"** — `WalkTermination` enum (PR #281) and the inbound-samples hint protocol fix (PR #282) are the same shape: when a fast read-path can be insufficient, the protocol needs (a) clear "insufficient" signal AND (b) a fall-back path. Without it, callers silently get truncated/wrong data.
- **"Refactor first when N implementations of the same primitive exist"** — PR #281 is the foundation-first PR ahead of PR #282; the walker hydra was consolidated BEFORE the new field surface was added on top. Pin-sections-to-sidebar precedent. Beats bundling: independent bisect, fast-shipping foundation, comprehensible-in-fresh-context units.

### Known Issues

- **`api::tests::test_search_returns_results` is flaky in isolation** — passes reliably as part of the full workspace test suite, fails when run alone (`cargo test -p floatty-server -- test_search_returns_results`). Pre-existing race on the shared search index path; out of scope for this cycle.
- **`InheritanceIndex` ancestor walk not yet migrated to `walk_ancestors`** — documented carve-out per PR #281. Hot path on every metadata change; needs benchmark before/after migration. Separate dedicated PR queued.

---

## [0.11.11] - 2026-04-23

### ✨ Features

- **Sidebar pin shelf — pinned blocks stay visible while you work elsewhere** ([[FLO-502]], #268): new built-in `pins` tab in the sidebar renders a vertical stack of Outliners, one per child of a `pinned::` root block in your outline. Each child's first `[[wikilink]]` resolves (via `resolveBlockIdPrefix` for hash/UUID, falling back to `findPage` for page-name) and the Outliner below is zoomed at that block. Curate the shelf by editing `pinned::` directly — add children for new pins, reorder by moving children, delete to unpin. No separate data shape; no persistence layer; the outline IS the pin list. Each pin gets a themed 6px drag handle at the bottom for per-pin height resize (native `resize: vertical` doesn't render a visible grip against `overflow: hidden`, so this is a custom pointer-capture handler). Always-visible scrollbar on the stack so the overflow reads as scrollable instead of auto-hiding per macOS default. Architecturally: pins are `<Outliner>` instances registered with `paneStore.registerPane(id, { kind: 'sidebar' })` per [[FLO-668]] — they inherit tree rendering, edit, zoom history, backlinks, wikilink navigation, Cmd+[/Cmd+] — all for free. Pins persist their paneStore registration across sidebar tab switches (CSS `display: contents/none` instead of `<Show>`) so zoom/collapse/focus/nav history survives navigation.
- **Sidebar-pin wikilinks route to a linked tab pane** ([[FLO-671]], #269): clicks on `[[wikilinks]]` inside a pin now navigate in the tab-scoped linked pane set via Cmd+L, instead of zooming within the pin itself. Makes the pin shelf actually usable for pinned bookmarks / TOCs / dashboards: pin an index, click entries, land in the main outline. Uses the existing `sidebarLinks[tabId]` Map that `SidebarDoorContainer`'s chirp listener has always consumed; `PaneLinkOverlay`'s link-mode handler already writes this as a side-effect of every Cmd+L link action, so one overlay invocation sets the shared target for all sidebar-origin wikilink clicks in that tab. `resolveSameTabLink` in `lib/navigation.ts` now falls back to `resolveSidebarTarget(activeTab)` when the source pane is sidebar-hosted. Cmd+L guard in `Outliner.tsx` unified on DOM-focus containment so any pin can initiate linking when it contains the focused element. Known issue tracked as [[FLO-672]]: when multiple tab outliners are open, the Cmd+L overlay currently only lists one — workaround is to focus a pane you don't intend to target before pressing Cmd+L.

### Internal

- **Pane infrastructure sprint — decouple pane identity from tab membership** ([[FLO-667]]): roadmap memo + three-PR refactor that makes "a pane exists" a first-class concept independent of "a pane is a leaf in some `TabLayout.root`". No user-facing behavior change; unblocks pin shelf + five other queued features (floating NSPanel pane, terminal pins, command-bar preview, daily drawer, future pinned-pane state).
  - **[[FLO-668]] — `PaneHost` registry** (#265): new `paneStore.registerPane(paneId, host)` where `host: { kind: 'tab'; tabId } | { kind: 'sidebar' } | { kind: 'floating' }`. `findTabIdByPaneId` rewrites from an O(tabs × panes) layout-tree scan to an O(1) registry lookup. Registration wired into `initLayout`, `splitPane`, and `hydrateLayouts` (all inside batched transactions); unregistration piggybacks on existing `removePane`/`removePanes`. Idempotent re-register is a no-op. Hydration reconciles stale registry entries before replaying the restored layouts (catches the case where a re-hydration runs on a non-empty store). 12 regression tests covering round-trip, cleanup symmetry, stale-entry reconciliation, and the `{kind:'sidebar'}` contract (`findTabIdByPaneId` returns null without scanning layouts).
  - **[[FLO-669]] — navigation funnel nullability audit** (#267): every `findTabIdByPaneId` call site (19 across 7 files) now carries an inline `FLO-668 null contract:` annotation documenting which stance it takes — (a) fall back to `activeTabId()` for sidebar/floating sources, (b) cleanup + bail for deleted panes, or (guard) keybind gated on active-tab hosting. Pure editorial pass; no behavior change. Makes the contract visible at every consumer so future non-tab-hosted pane work doesn't have to rediscover it.
  - **Outliner standalone mount contract**: header comment on `Outliner.tsx` stating it mounts in any flow-layout container given a paneId (no `PaneLayout` DOM coupling). Already true since FLO-668's registry; now documented. `Cmd+Shift+F` and `Cmd+L` keybinds explicitly flagged as still tab-hosted-only until future generalization.
- **Lint sweep — 71 → 62 errors** ([[FLO-665]], #263): trivial lint fixes that make the remaining errors easier to triage (smaller noise floor when adding features).
- **`findRootBlockByPrefix` helper extracted**: `findPagesContainer` + the removed `findPinnedContainer` collapsed into a single generic `findRootBlockByPrefix(prefix)` in `useBacklinkNavigation.ts`. `findPagesContainer` stays as a one-liner wrapper for backward compatibility. Both `pages::` and `pinned::` now share one root-container-lookup implementation.

### Known Issues

- **[[FLO-672]] — Cmd+L from pin may exclude last-active tab pane from candidate overlay** (verification pending): when multiple tab outliners exist and one is the currently-active pane, the Cmd+L overlay was previously showing N-1 candidates (the active pane excluded as "source") because two Outliner document-level keydown listeners fired — the tab-hosted one's guard relied on `layout.activePaneId` which doesn't reflect sidebar focus. The fix (DOM-focus-containment guard) is included in this release via #269 and verified unit-level, but end-to-end verification against the running app was blocked by Vite file-watcher staleness on the dev machine. Validation checklist is in [[FLO-672]] for the next clean dev boot. Workaround if you still see it: focus a pane you don't intend to target (or focus outside any pane entirely) before pressing Cmd+L.

---

## [0.11.10] - 2026-04-19

### ✨ Features

- **Outliner keyboard fluency — jump first/last + send to linked pane** ([[FLO-495]], [[FLO-469]], #247): `⌘⇧↑` / `⌘⇧↓` now focus the first / last visible block of the current view, honouring zoom + expansion state via the existing `getVisibleBlockIds()` memo. `⌘⇧L` sends the currently-focused block to the pane linked via `⌘L`, zooming the linked pane without moving source focus (uses `navigateToBlock`'s `originBlockId`). `⌘↑`/`⌘↓` stay bound to `moveBlockUp`/`moveBlockDown` ([[FLO-75]]) — Shift added for reach semantics. CLAUDE.md keybind table backfilled with the new shortcuts AND the previously-undocumented move-block rows surfaced during the conflict audit.

### 🐛 Fixes

- **`#`-prefixed wikilinks no longer create duplicate pages** ([[FLO-573]], #244): `getPageTitle`'s regex `/^#+\s*/` stripped leading `#`s regardless of whitespace, so `[[#2817]]` normalized to `2817` on lookup while the stored page (content `# #2817`) normalized to `#2817` — mismatch bypassed `findPage` and spawned a new page on every click. Tightened to `/^#+\s+/` (CommonMark: headings require whitespace). Applied symmetrically across the client (`useBacklinkNavigation.getPageTitle`) and the server-side `PageNameIndex` hook (`strip_heading_prefix`) per [[FLO-317]] symmetry discipline.
- **Autocomplete no longer offers "Create new page" for `<hex>|alias` block references** ([[FLO-552]], #245): typing `[[abc123de|my alias]]` against a real block showed a "Create" badge because `buildSuggestionsWithTypedText` classified existence by page-name lookup only. Added a pre-check: when the query contains `|` and the left side is a `BLOCK_ID_PREFIX_RE`-shaped hex prefix that resolves via `resolveBlockIdPrefix`, return a single `exists: true` suggestion. Fuzzy page-name noise is dropped — a block-alias is an unambiguous intent. Plumbed through an optional `resolveAlias` accessor so the pure function stays testable.
- **ink-chat wikilink resolver prefers exact name over fuzzy neighbours** ([[FLO-637]], #246): `resolveWikilinks` used `pages.find((p) => !p.isStub && p.blockId)` on a fuzzy-sorted 3-result window — `[[Foo]]` (stub) silently resolved to adjacent `Foobar` (real page), injecting the wrong subtree into AI context. Widened `limit=3 → limit=10` and made the exact case-insensitive name match authoritative regardless of stub-ness: a stub exact match leaves `page` undefined so we fall through to block search. Typo-tolerance preserved via the fuzzy first-non-stub fallback when no exact name matches.

### Internal

- **Keybind registry discipline** (#247): surfaced that CLAUDE.md's keybind registry was stale — `⌘↑`/`⌘↓` had been declared in `apps/floatty/src/lib/keybinds.ts:152-153` ([[FLO-75]]) without a matching docs row. Backfill + new `.claude` memory rule ("grep both `keybinds.ts` and `Outliner.tsx` tinykeys before proposing shortcuts") to prevent the next conflict.

---

## [0.11.9] - 2026-04-19

### ✨ Features

- **Kanban two-way binding + interactive-view pattern** ([[FLO-587]], #238): kanban becomes the first complete reference implementation of the `floatty-interactive-view` skill — drag, drop, reactive re-projection, inline edit, keyboard boundary navigation. Host dispatches chirp verbs declared in the spec's `on:` map; the door ships with zero handlers. Reactive re-projection via `ctx.server.subscribeBlockChanges` so views re-render when the outline mutates underneath them. Inline edits commit through `update-block` chirps (bypassing json-render-solid's StateProvider gate). Arrow-key navigation flips to a `focus-sibling` verb at column/row boundaries. Drop zones extended to empty column space; source card fades during drag; post-commit refocus locates the new card by `data-kanban-card-id` + rAF retry. Skill docs updated with Reactive Re-Projection, Keyboard Navigation & Boundary Crossing, Drag Drop Zone Design, and Two-Way Binding Pattern sections. Tree, Calendar, and Graph views can follow the same playbook.
- **Click-to-copy in render:: agent footer** (#243): the session UUID, `--continue`, and `--resume <uuid>` snippets are now `<button>`s. Click any of them to copy to clipboard with a transient `✓ copied` label swap. Keyboard-accessible via Tab + Enter/Space.
- **`render::` advance-cursor on Enter** (#243): pressing Enter on a `render::` block now executes the handler AND advances focus to the next visible sibling (creating a trailing block if none), so the user can keep typing while the render compiles. Opt-in via new `advanceCursorOnExecute` flag on `BlockHandler` / `DoorMeta` — selfRender doors can surface the same behavior.

### 🔧 Improvements

- **render:: loading indicator on first press** (#243): `executeHandler` now sets `status='running'` synchronously before `await handler.execute(...)`, and `buildSelfRenderHandler` writes a null-data view envelope before the await so `DoorHost` mounts immediately. Root cause: `DoorHost` only mounts once `block.output` is non-null — for selfRender doors that was after the first full execution, making first-press feel dead. Second-press worked because prior output kept the host mounted. Now first press behaves identically to subsequent presses for every door-backed handler.
- **ai::/chat:: advance cursor immediately, not after the LLM responds** (#243): restructured `conversationHandler` (both `executeConversationTurn` and `executeSingleTurn`) so the continuation block is created and focused BEFORE `await invoke('execute_ai_conversation', …)`. Matches the `::send` pattern and restores the "keep typing while the model thinks" UX. Error path deletes the empty pre-created continuation unless the user typed into it during the roundtrip.

### 🐛 Fixes

- **First Enter on executable blocks now dispatches** ([[FLO-646]], #242): after [[FLO-387]] moved block content commits to boundaries (blur / structural op / unmount), `determineKeyAction` was reading `block.content` from the store before the freshly-typed characters had been flushed. First Enter on a new `sh::`/`ai::`/`render::`/etc. block inserted a newline instead of executing; second press worked because the intervening ArrowUp caused a blur+flush. Fix flushes + re-reads the block at the top of `handleKeyDown` whenever the key is Enter. Perf invariant preserved: `flushContentUpdate` early-returns on `!hasLocalChanges()`, so clean-state Enter is still a no-op on Y.Doc.
- **Markdown export + clipboard copy read stale content under FLO-387** (#242): ⌘⇧M / ⌘⇧J / ⌘⇧B / ⌘C wrote the pre-boundary store snapshot instead of the user's latest typing. ⌘⇧J and ⌘⇧B used a `document.activeElement.blur()` workaround that stole focus. New `flushPendingContent()` exported from `useContentSync.ts` walks a module-level registry of active instances; `Outliner.tsx` export paths and `useOutlinerSelection.ts` copy path call it before reading store content. HMR cleanup per `do-not.md`.
- **Sidebar half-screen on reload** ([[FLO-507]], #239): root-cause fix for the three-times-patched bug. Corvu's `onSizesChange` fires on *every* internal `sizes()` change, not just user drags — during panel registration (and every HMR remount / sidebar toggle / side swap) the main content panel registers first with `sizes = [0.5]`, and the handler was treating `sizes[length-1] = 0.5` as the sidebar fraction and saving ~700px. Fix gates save on actual user drag via `onHandleDragStart`/`onHandleDragEnd` + `isUserResizing` signal. Loaded values are now clamped to `[200px, 40vw]` so already-poisoned localStorage self-heals on next mount. Dead `sidebar_width` field removed from Rust `AggregatorConfig` + TS type (pre-localStorage residue, never read).

### 🗑️ Housekeeping

- **Remove dead `claude-mem` door** (#240): `apps/floatty/doors/manifest/manifest.tsx` (prefix `mem::`, localhost:4077 iframe) and doc references in `docs/guides/DOORS.md` and `EvalOutput.tsx` removed. Historical `CHANGELOG.md` entry preserved.
- **Door housekeeping — three independent steps bundled** (#241): removed `dailylog` door (replaced by `render::`); recovered 5 orphaned door sources that existed only as compiled `~/.floatty/doors/*/index.js` (4 hand-written JS doors + session-garden from pre-monorepo git); preserved `weekly-zine-w10` (Vite + Tailwind project with 10KB SPEC.md) in `docs/archived-doors/`.

### Internal

- **`moveBlock` silent bail-outs now log** ([[PR #238]]): six `return false` paths in `useBlockStore.moveBlock` previously bailed silently — violation of `ydoc-patterns.md` rule 14.6 ("every bail-out gets a diagnostic counter"). Each path now emits a specific `logger.warn`. Regression from FLO-280 surgical-mutation migration.
- **Rule updates** (#238): `floatty-interactive-view` skill rewritten with reactive-reprojection / keyboard-boundary / drag-drop / two-way-binding sections. `verb-catalog.md` adds `update-block` as a first-class verb, clarifies `edit-block` as view-state only, and corrects `focus-sibling` dispatcher location. New failure-mode entries (FM-10: post-compact archaeology paralysis; FM-11: silent bail-outs; FM-12: "reactivity lives in the view layer" as vaporware comment).

### Related

- [[FLO-623]] filed (via #242 follow-up): conflict-resolution UI for the LWW+diagnostic path added in FLO-387.

---

## [0.11.8] - 2026-04-16

### ✨ Features

- **Colocated Apps**: `ink-chat` and `outline-explorer` are now part of the main monorepo for streamlined development and unified release cycles ([[PR #237]])
  - **Outline Explorer**: Advanced outliner with AI-powered analysis, custom catalog renderers, and full MCP server support
  - **Ink Chat**: Block-to-UI compiler with JSON-render catalog integration and structured form generation

### 🔧 Improvements

- **Server-side Markdown Projection**: Door blocks now compute `renderedMarkdown` server-side with fallback chain ([[FLO-633]]): `GET /api/v1/blocks/:id` injects markdown for door blocks whose frontend-hook `renderedMarkdown` is null or empty. New `floatty_core::projections` module walks `output.data.spec` with in-memory LRU caching (block_id, hash(output)). No Y.Doc writes, no WebSocket broadcasts — response-only projection.
- **API Event Coverage**: All block operations now emit corresponding `BlockChange` events for complete hook coverage

### 🛡️ Security

- Added sanitization rules for PII and credentials in colocated applications per test-fixtures-no-pii.md

---

## [0.11.7] - 2026-04-15

### Features

- **Reader view typography** ([[FLO-625]], #235): three new CSS variables (`--content-max-width: 720px`, `--body-line-height: 1.6`, `--text-primary: warm`) constrain body prose to a 720px reading column with roomier line-height and warmer off-white text color (~8:1 contrast, up from ~4:1). Constraint lives on direct block-level children of `.outliner-container` so zoomed door/iframe pane views escape naturally and use the full pane for sidebar+content and dashboard layouts. `.block-content-text`, `.block-content-bullet`, and `.block-content-ctx` pick up `--text-primary`; semantic block-type colors (`sh::`/`ai::`/headings/errors/quotes) remain on the ANSI palette so syntax hierarchy is preserved.

### Performance

- **Commit block content on blur, not every 150ms** ([[FLO-387]], #234): replaced the 150ms-debounced Y.Doc write path with boundary-triggered commits. Keystrokes stay in the DOM between boundaries; Y.Doc only sees user-meaningful commits at blur, structural operations, and unmount. Previously ~7 Y.Doc transactions per second during typing fired `observeDeep`, EventBus hooks, SolidJS reactivity, and OTLP spans — each blocking the writer lock. New model: ~1 transaction per edit session. Dirty-transition `contentAtFocus` snapshot catches remote-while-focused conflicts at commit time; diagnostic logged + `__floattyTestHooks.onConflictDetected` fired for observability (conflict-resolution UI tracked in [[FLO-623]]).
- **Cache cursor boundary snapshot per selection** ([[FLO-387]], #233): WeakMap + monotonic generation counter in `useCursor.ts` caches the four boundary values (offset, atStart, atEnd, contentLength) per element until the selection actually changes. `determineKeyAction` previously made 3 consecutive DOM walks per keystroke — now one walk per selection change, cache hits thereafter. Document-level `selectionchange`/`input`/`compositionupdate` listeners bump the generation; programmatic `innerText` mutations require explicit `cursor.invalidate()`.

### Theming System Cleanup

- **Three orphan CSS variables wired through theme system** ([[FLO-625]], #235): `--color-bg-secondary`, `--color-bg-hover`, `--color-fg-dimmed` were set in `:root` but never applied by `applyThemeToCSS()`. All 5 themes silently used the default-theme values. Added to `FloattyTheme` interface, populated per-theme, pushed through `applyThemeToCSS`.
- **Door variable fallback references fixed** (#235): `doors.css` referenced `--color-fg-primary` and `--color-bg-tertiary`, neither of which existed. Door output silently fell back to hardcoded OneDark-ish hex values regardless of active theme. Now uses `--text-primary`, `--color-fg`, and `--color-bg-hover`.
- **terminalManager theme cache** (#235): `new XTerm({ theme: toXtermTheme(defaultTheme) })` was hardcoded at both terminal-creation sites, so tabs/panes opened after a theme switch booted in the default theme. Added `currentXtermTheme` cache on the singleton; `updateAllThemes()` writes to it, new terminals read from it.
- **Hardcoded Gruvbox colors swapped for theme variables** (#235): `App.tsx` server-error fallback, `BlockOutputView.tsx` door error card, `Outliner.tsx` zoom crash button, and `SidebarDoorContainer.tsx` sidebar door error all contained hardcoded `#fb4934` / `#1d2021` / `#3c3836` / `#ebdbb2` values bypassing the theme system. All swapped for `var(--color-error)` / `var(--color-bg-secondary)` / `var(--color-fg)` / `var(--color-border)`.

### Render Door

- **Prose self-constraint** ([[FLO-625]], #235): `.bbs-entry-body` direct prose children (`p`, `ul`, `ol`, `blockquote`, `h1/h2/h3`) self-constrain to `max-width: var(--content-max-width)` so bare `EntryBody` / `PatternCard` content reads well at any pane width. Tables, `pre` blocks, and `hr` stay at container width so data/code can sprawl — matches the prose-vs-dashboard contract from FLO-625. Agent contract unchanged; same JSON spec now renders readably whether inline or zoomed.

### Internal

- **Rule files: pattern-fit-check, block-type-patterns, rule-audit, verify-citations** (#232): derived from a six-run AI tool evaluation on a `poll::` block design task (2026-04-13). `pattern-fit-check` adds the missing "does this pattern's invariants match my problem's invariants" step between finding a reference and copying it. `rule-audit` is a grep-based walker that verifies rule-file citations against the actual codebase. `verify-citations` runs the same checks on draft prompts/memos before they ship. `floatty-improve-prompt` refreshed with a Step 3 grep-verification requirement plus a chain-to-`verify-citations` rule for compound prompts.

### Documentation

- **`ydoc-patterns.md` rule 5 & 6 rewritten** ([[FLO-387]], #234): rule 5 ("Debounce at the Right Layer") replaced with "Commit at Boundaries, Not Ticks" — documents the new blur-is-the-boundary input-layer model and why keystroke-level debouncing was wrong. Rule 6 ("Blur/Remote-Update Race Condition") rewritten to reflect the dirty-transition snapshot instead of focus-time snapshot, with the full commit-time conflict-detection flow and the rationale for why the autocomplete/structured-paste paths needed the dirty-transition shape.
- **`door-development.md` monorepo paths** ([[FLO-625]], #235): deploy-path section updated with monorepo-aware paths. The compile script moved to `apps/floatty/scripts/` in the monorepo shift; the old rule still listed repo-root paths. Now has both "from `apps/floatty/`" and "from repo root with full paths" examples. Added a second burn entry for the 2026-04-15 monorepo script path case.

### Related

- [[FLO-628]] filed: backend `set_theme` accepts any string without validating against the theme registry — low priority config normalization.
- [[FLO-629]] filed: reader view heading line-height tightening (deferred from FLO-625 scope).
- [[FLO-630]] filed: theming audit — systematic grep for remaining orphan CSS variable references and hardcoded hex.

---

## [0.11.6] - 2026-04-13

### Features

- **Image component in `render::` door** ([[FLO-586]], #230): the render door now supports an `Image` component for displaying images inline in blocks. Filenames without slashes are treated as floatty attachments and fetched with auth; full URLs pass through directly. Includes loading state, error display, 5s timeout, and proper blob URL cleanup on `src` change. Specs using the legacy `"component"` field are normalized to `"type"` automatically so both formats work.
- **OTLP trace export to Tempo** (#230): `floatty-server` now exports traces to Tempo via OTLP when `otlp_endpoint` is configured. Trace and log endpoint resolution are now independent — each follows its own env-var priority chain (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` → `OTEL_EXPORTER_OTLP_ENDPOINT` → config) rather than sharing a single endpoint config.

### Bug Fixes

- **`fetchWithAuth` header merging** (#230): fixed a bug where spreading a `Headers` instance into an object literal produced `{}` (the `Headers` API stores data internally — spreading gives an empty object). `fetchWithAuth` now uses `new Headers(init?.headers)` to normalize incoming headers before setting the auth header, ensuring the auth key always wins regardless of how headers are passed in.
- **Abort vs timeout disambiguation in Image fetch** (#230): the `AbortController` abort fired by the 5s timeout was indistinguishable from the `onCleanup` abort (both are `AbortError`). Added a `timedOut` boolean flag — timeout errors now correctly show "Request timed out" instead of being silently swallowed.

### Documentation

- **Architecture docs cleanup** (#230): added ADRs 001–005 under `docs/adrs/`, wired `docs/architecture/README.md` to the new agentic-runtime docs, fixed broken relative path in `ARCHITECTURE_MAP.md`, added ephemeral search index principle to `SEARCH_ARCHITECTURE_LAYERS.md`.
- **Agentic runtime docs** (#230): new `docs/architecture/agentic-runtime/` tree formalizing outline-native vs external-execution agent boundaries, clerk interface, state model, work log model, provenance, and four ADRs on agent role boundaries.

### Refactoring

- **Lock-poison error deduplication** ([[FLO-586]], #230): extracted `lock_poisoned()` helper in `outline_manager.rs` to replace 4 identical `map_err` closures. No behavior change — pure DRY cleanup.

---

## [0.11.4] - 2026-04-12

### Refactoring

- **Break up api.rs god object** (#225): split the 5,198-line `api.rs` into 7 handler modules + shared infrastructure (`api/mod.rs`). Each module owns one route family: `sync` (Y.Doc state sync), `blocks` (CRUD), `search` (full-text + page search), `export` (binary/JSON export, topology), `backup` (status/list/trigger/restore), `outlines` (outline management + per-outline scoped handlers), `discovery` (markers, stats, daily note, presence, attachments). Router composition via `Router::merge()` with per-module `pub fn router()`. Zero behavior changes — all endpoints return identical responses.

### Observability

- **Handler-level tracing instrumentation** (#225): added `#[tracing::instrument]` to 18 handler functions across all 7 modules. Low-cardinality structured fields: `route_family` (sync|blocks|search|export|backup|discovery|outlines), `handler` (function name), automatic `err` logging. Selective — only write paths, expensive reads, and destructive operations instrumented. Queryable in Grafana/Loki via `{service_name="floatty-server"} | json | route_family != ""`.

### Bug Fixes

- **Async file I/O for backup restore** (#225): replaced blocking `std::fs::read` with `tokio::fs::read` in the backup restore handler to avoid blocking a Tokio worker thread when reading large `.ydoc` backup files.

### Infrastructure

- **Monorepo scaffold** (eb11756..e8055e8): moved floatty into `apps/floatty/`, added `pnpm-workspace.yaml` + `turbo.json`, root-level passthrough scripts, scoped `.claude/rules` paths.

### Related

- [[FLO-605]] filed: restore paths clear search index before validating new state (pre-existing, surfaced by #225 review)
- [[FLO-606]] filed: reindex endpoint doesn't clear stale entries from deleted blocks (pre-existing, surfaced by #225 review)

---

## [0.11.3] - 2026-04-11

### Bug Fixes

- **Zombie floatty-server recovery** (#224): fixes a three-layer failure mode where a wedged `floatty-server` (TCP accept succeeds, HTTP handler never replies) held port 8765 and left the app stuck on "Loading workspace…" requiring manual `kill -9`. `wait_for_server_health` now uses `curl -m 1` so probes can't hang on a dead-responsive zombie. `kill_stale_server` escalates SIGTERM → SIGKILL with `pid_is_alive` re-check after each `send_signal` failure (distinguishes benign race where the process exits between `kill -0` and the actual signal from real delivery failure). `main.rs` bind matches `AddrInUse` explicitly and exits with a diagnostic instead of `.unwrap()` panicking.
- **PID recycling guard** (#224): `kill_stale_server` now calls `verify_pid_is_floatty_server` (`ps -p <pid> -o comm=`) before sending any signal. Between app exits the OS can recycle PIDs; without this guard we could have `kill -9`d an unrelated process that inherited the number.
- **Graceful `axum::serve` error handling** (#224): replaced `.unwrap()` with explicit exit codes (2 for `AddrInUse`, 1 for generic bind errors).

### Internal

- **State-transition table discipline** (#224): `kill_stale_server`'s SIGTERM and SIGKILL paths are now documented inline with the full 2×2 state-transition table (`send_signal` outcome × `pid_is_alive` after). Root-cause response to three rounds of PR review churn that kept finding unrouted cells in forward-pass-only code — the intervention is "write the state table before the code," not "be more careful."
- **Logging consistency sweep** (#224): replaced remaining `log::warn!` / `log::info!` calls in `server.rs` with `tracing::` equivalents (mixed macros violate `logging-discipline.md` rule 6). Replaced silent `.ok()` drops on log dir/file creation and config read/parse with logged warnings. Deleted stale docstring on `spawn_server` claiming `eprintln!` usage (function uses `tracing::` throughout — migration leftover).
- **Sweep Pattern 9** (`.claude/commands/floatty/sweep.md`): added hot-path `#[tracing::instrument]` cardinality tripwire. Promotes the documented warning in `config-and-logging.md` (high-cardinality fields explode Loki label index without `otlp_config.log_attributes` allowlist) to a mechanical sweep check.

### Related

- [[FLO-602]] filed: `feat(reliability): parent-side server watchdog for wedge recovery` — extends the infrastructure in this release so mid-session wedges trigger automatic respawn via `useSyncHealth` instead of requiring app relaunch. Depends on `kill_stale_server` + `verify_pid_is_floatty_server` from this PR.

---

## [0.11.2] - 2026-04-11

### Features

- **Structured JSONL logging for floatty-server** (#223): the server subprocess now writes daily-rotating JSON logs to the same `~/.floatty/logs/floatty.YYYY-MM-DD.jsonl` files as the Tauri process via `tracing-appender`. Both processes appear in one unified log stream distinguishable by `target`. ([[FLO-274]] Tier 1)
- **Optional OTLP log export** (#223): `floatty-server` can ship structured logs to any OTLP HTTP collector (Loki's native receiver, OTel Collector, Alloy, etc.) via the new `[server].otlp_endpoint` config key. Resolution order: `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` env → `OTEL_EXPORTER_OTLP_ENDPOINT` env → config file → off. Resource attributes surfaced as Loki labels: `service.name=floatty-server`, `service.version`, `deployment.environment=dev|release`. Default-off — floatty works normally with file-only logging when unconfigured.
- **Startup phase timing visibility** (#223): added `floatty_startup=info` to the default `EnvFilter` so previously-silent target-override events from `hooks/system.rs` and `store.rs` now land in logs: `phase=ydoc_store_ready`, `search_init_complete`, `cold_start_rehydration_complete`, `hook_system_init_complete`, `phase=server_ready`.

### Bug Fixes

- **Log noise reduction** (#223): demoted `ws::Broadcast N bytes` messages from `info` to `debug` (~214 lines/session). Added `tauri_plugin_pty=warn` to the Tauri-side filter default (~81 lines/session). Combined effect: ~38% drop in Rust-side log volume before remote ingest.
- **`EnvFilter` target matching gotcha** (#223): `tracing::info!(target: "X", ...)` bypasses crate-path filtering and requires an explicit `X=level` filter entry. Fixes three startup-phase events that had been silently dropped.
- **Tauri filter hardening** (#223): pre-emptively added `hyper=warn,reqwest=warn,opentelemetry=off` silencers to the Tauri process filter default so future OTLP wiring on that side doesn't trigger telemetry-induced-telemetry loops.

### Security

- **Credential leak prevention** (#223): removed two INFO-level log lines that were formatting the server API key into tracing events (`"API key: {key}"` and `"Authenticated: curl -H 'Authorization: Bearer {key}'"`). With OTLP export now available, these would have shipped credentials to the remote collector on every startup. API key is now logged as metadata only (`source`, `length`). Curl example moved to `#[cfg(debug_assertions)] eprintln!` so it only prints in dev builds and bypasses the tracing subscriber entirely.
- **OTLP endpoint leak prevention** (#223): the endpoint URL itself is no longer logged — OTLP endpoints can contain basic-auth userinfo, query tokens, or internal hostnames. Startup log is now presence-only: `otlp_log_export_enabled`.

### Documentation

- **New rule file: `.claude/rules/logging-discipline.md`** (#223): six directive-voiced rules codifying secrets-handling, sink routing, failure-mode alignment per subsystem, comment/mechanism drift prevention, `target:` override filter-entry requirements, and canonical filter defaults. Extracted as a root-cause response to three rounds of PR review finding the same class of bug in different shapes.
- **Sweep Pattern 8** (`.claude/commands/floatty/sweep.md`): added Logging Discipline Violations sweep with six greps keyed 1:1 to the rules in `logging-discipline.md` so regressions get caught mechanically on `/floatty:sweep` runs.
- **`do-not.md` cross-reference**: Tracing/OTLP section now points at `logging-discipline.md` as the policy; specific traps still listed there.
- **`docs/architecture/LOGGING_STRATEGY.md`**: added a status note marking which aspirational items from the original doc are now shipped (structured JSONL, OTLP export, startup phase timing) and which remain (trace spans → Tempo, MCP log-query tool, request ID correlation).

### Internal

- Replaced `RollingFileAppender` `.expect()` with `panic!` + explicit "refusing to start without file logging" message. Aligned with log-dir creation failure mode — the local JSONL file is the source of truth; silently running without file logging would hide exactly the startup-hang class of problem this branch was meant to diagnose (see [[FLO-599]]).
- `ServerConfig::load()` switched from `tracing::warn!` to `eprintln!` for early-stage config parse/read errors. `ServerConfig::load()` runs before `setup_logging()` initializes the tracing subscriber — previous calls were silently dropped.
- Aligned server-side `fmt::layer()` field set (`thread_ids`, `thread_names`, `file`, `line_number`) with the Tauri-side setup so `jq` queries against the unified JSONL stream see consistent schemas.
- First real bug caught by the new instrumentation: [[FLO-599]] filed 12 minutes after the filter fix landed — "Hook dispatch lagged by 8262 messages" during cold-start rehydration, diagnosed using the newly-visible `cold_start_rehydration_complete` marker.

---

## [0.11.1] - 2026-04-11

### Features

- **Command bar: cmdk-solid migration**: Replaced hand-rolled keyboard navigation
  (`<ul>/<li>` + `selectedIndex`) with `cmdk-solid` primitives — proper Arrow/Enter
  handling, ARIA attributes, and a foundation for argument-taking commands
- **Command bar: Tab autocomplete**: Tab now fills the query input with the
  highlighted item's label instead of escaping focus (was broken since initial
  implementation)
- **Startup phase timing logs**: Server logs `[startup]` markers with `elapsed_ms`
  at each startup phase (SQLite open, Y.Doc replay, cold-start rehydration, search
  init, server ready) — query with
  `jq 'select(.fields.message | startswith("[startup]"))' ~/.floatty/logs/floatty.*.jsonl`
- **WAL checkpoint on open**: `PRAGMA wal_checkpoint(PASSIVE)` runs automatically
  on every SQLite open, preventing read amplification from large uncheckpointed WAL
  files (40MB+ observed in production)

### Bug Fixes

- **Command bar: Shift+Tab**: Added `!e.shiftKey` guard — Shift+Tab was incorrectly
  triggering Tab autocomplete instead of passing through
- **Page name index cold start**: Pages were showing as stubs on startup due to
  ordering issue in cold-start rehydration — page name events now fire after all
  block data is available
- **Test temp dir leak**: `open_test_store` now returns `TempDir` to caller,
  preventing premature cleanup of test databases

---

## [0.11.0] - 2026-04-10

### Features

- **Multi-outline support**: Switch between named outlines via `outline::` handler,
  native macOS Outlines menu, or command bar — each outline is an independent Y.Doc
  with its own SQLite, search index, and backup namespace
- **outline:: handler**: `outline::` lists available outlines with current marker;
  `outline:: name` switches to that outline (creates if needed, then reloads)
- **Per-outline WebSocket routing**: WS connections carry `?outline=name` so the
  server broadcasts to the correct outline subscribers
- **Active connections + LRU eviction**: Server tracks which outlines have connected
  clients; evicts idle outlines when slot limit is reached
- **Block import endpoint**: `POST /api/v1/blocks/import` for bulk block creation
  with batch Y.Doc transactions
- **outline:: command bar integration**: Type outline name in command bar to switch
- **Command bar ordering** (FLO-466): Matched commands surface above create-page
  option — Enter now selects the command without requiring ArrowDown

### Bug Fixes

- **Error serialization in logger**: `{"err":{}}` in logs is now
  `{"err":{"message":"...","name":"...","stack":"..."}}` — `Error` properties are
  non-enumerable and were silently dropped by `JSON.stringify`
- **outline handler**: Block status no longer stuck `'running'` if outline switch
  is aborted — handler sets `'complete'` after signaling App.tsx
- **appEvents HMR**: Added `import.meta.hot.dispose()` for `pendingOutlineSwitch`
  signal to prevent stale subscribers on hot-reload
- **PTY resize deduplication**: Coalesced resize chatter — dedup gate, drag-end
  settle delay, sourceEvent labels for log tracing
- **Backup scoping**: IDB backup namespace now includes outline name — dev/release
  and different outlines no longer share IndexedDB state

---

## [0.10.10] - 2026-04-07

### Features

- **echoCopy:: handler** (FLO-582): Materializes render door output as plain markdown blocks in the outline — `echoCopy:: [[blockRef]]` resolves short-hash, page name, or UUID refs, reads `renderedMarkdown` metadata, parses to block tree, creates as children
- **outputSummaryHook**: Added `renderedMarkdown` projection — flattens door spec elements to markdown, stored in block metadata
- Backfill output summaries for pre-hook render blocks at startup (no re-render needed)

### Bug Fixes

- **Rust metadata**: Added `rendered_markdown` field to `BlockMetadata` struct — prevents silent field loss during Rust-side metadata round-trips; also added `summary` serialization to `metadata_to_ymap`
- **render door**: Made spec flattener resilient to malformed payloads — cycle guard, `Array.isArray()` checks on props
- **echoCopy**: Falls back to `blockStore.blocks` when `actions.getBlock` is undefined
- **esm.sh imports**: Added `?external=react,react-dom` to non-React packages to prevent duplicate React instances

### Documentation

- Added echoCopy:: guide and help:: topic

---

## [0.10.9] - 2026-04-07

### Bug Fixes

- **render door**: RENDER_TOOL_SCHEMA now derives component enum from catalog (44 components, was hardcoded to 29 — Claude path had 15 fewer components than ollama/agent)
- **render door**: Removed 4 dead catalog actions (selectEntry, filterTag, goBack, scrollTo) that silently no-oped on click
- **render door**: Removed unused DocLayout.sidebarWidth prop (schema advertised control that didn't exist)
- **render door**: Replaced `setTimeout` sizing hacks in BarChart/BarItem with `onMount` lifecycle
- **render door**: Fixed `onfocus`/`onblur` → `onFocus`/`onBlur` casing in TextInput/TextArea (SolidJS event delegation)
- **render door**: Guarded async title generation with execution nonce to prevent stale overwrites on rapid re-execution
- **render door**: Agent JSON extraction now takes the last fenced block instead of first (handles agent explanation text before spec)

---

## [0.10.8] - 2026-04-07

### Features

- Search hits now include `blockType` field (derived from content prefix)
- Topology nodes include `bid` (block UUID) for page blocks

### Bug Fixes

- Fixed `pages::` container detection — config blocks with "pages::" content no longer hijack the container ID, restoring topology block counts (`b` field)
- Used `as_str()` instead of `{:?}` debug format for block type serialization

---

## [0.10.7] - 2026-04-06

### Bug Fixes

- Render door footer now shows full session UUID instead of truncated 8-char prefix, making `--resume` command directly copyable

---

## [0.10.6] - 2026-04-06

### Bug Fixes

- **Terminal text smushing on tab switch** — Hidden tabs no longer get resized to garbage dimensions (11×5) by fitAddon. Visibility restore uses immediate fit with a visibility gate to prevent stale-frame flash

---

## [0.10.5] - 2026-04-06

### Bug Fixes

- **render:: title mode height collapse** (FLO-569) — Block height now matches title, not full prompt. ContentEditable hidden in title mode, replaced with focusable wrapper following table block pattern (#209)
- **render:: raw toggle sync** — Content populates immediately on title→raw toggle via queueMicrotask (same pattern as table blocks)
- **Shift+Enter on executable blocks** (FLO-571) — Creates sibling before when cursor at position 0. Applies to all handler blocks (`sh::`, `render::`, `ai::`, etc.) (#209)
- **Cmd+Enter zoom in title mode** — Zoom into render:: title blocks now works (was unhandled in dedicated keyboard handler)
- **Cmd+Backspace in title mode** — Force-deletes render:: title blocks with children, matching regular block behavior

---

## [0.10.4] - 2026-04-05

### Improvements

- **render:: agent title generation** (FLO-569) — Claude agent now includes a `title` field directly in JSON response, eliminating the Ollama title round-trip. Garbage titles (JSON blobs, >120 chars) are rejected with fallback to spec header (#208)
- **Development Workflow** section added to CLAUDE.md — study existing patterns before fixing UI

### Bug Fixes

- **Terminal columns desync after alt-tab** (FLO-568) — `handleVisibilityRestore` now calls `fitAddon.fit()` + PTY resize notify after WebGL recreation (#207)
- **render:: title mode height** (FLO-569) — block height now matches the displayed content in both directions (title↔raw toggle). Auto-switches to raw on edit (#208)

---

## [0.10.3] - 2026-04-05

### Improvements

- **Centralized config loading** (FLO-559) — replaced 7 independent `get_ctx_config` IPC calls with single `ConfigContext` provider. Three access layers: `useConfig()` (reactive), `getConfig()` (sync), `configReady` (async). Graceful degradation on IPC failure (#205)

### Bug Fixes

- **Double-tap Cmd too aggressive** (FLO-465) — fast Cmd+C → Cmd+V sequences no longer trigger the double-tap wikilink copy. Switched from tinykeys `'Meta Meta'` (1000ms window) to custom bare-tap detection (300ms window, rejects sequences with other keys between) (#206)

---

## [0.10.2] - 2026-04-05

### Features

- **render:: title display** (FLO-548) — render:: blocks show generated title instead of full prompt. Toggle button (⊞/⊟) switches between views. Title comes from render agent output (`data.title`) (#204)
- **GET /api/v1/daily/:date** — resolve daily note page by date string, returns block with children/tree (#190)
- **8 composite render:: components** — StatusPanel, ComparisonGrid, InboxDigest, SprintBoard, KnowledgeCard, ProjectTracker, TimelineView, ContextDashboard (FLO-548) (#203)

### Improvements

- **Bulk blocks endpoint perf** — `GET /api/v1/blocks` skips expensive output blob materialization (`yrs_out_to_json`) via `include_output` flag on `read_block_dto`. Output available on single-block endpoints (#204)
- **BlockDto deduplication** — consolidated 3 copies of inline Y.Doc field extraction into single `read_block_dto` helper (#204)
- **Display mode helpers extracted** — `isOutputBlock`, `hasCollapsibleOutput`, `resolveImgFilename` moved from BlockItem.tsx to `lib/blockItemHelpers.ts` with 26 contract tests encoding mutual-exclusivity invariant (#204)
- **Generated bindings deduplicated** (FLO-561) — 3 directories → 1 (`src/generated/`), ts-gen outputs directly to active copy (#201)
- **Dead code removal** (FLO-556) — removed unused `useBacklinkNavigation()` wrapper (#200)

### Bug Fixes

- **findPagesContainer matching** (FLO-557) — aligned matching logic between page search and container resolution (#202)
- **BarItem scaling** — percentage bars now resolve correctly against container height (#204)
- **outputSummaryHook** — reads envelope shape correctly (`data.spec` not `output.spec`), prefers `data.title` (#204)
- **CSS class rename** — `table-raw-toggle` → `block-mode-toggle` (shared by table and render:: toggles)

### Documentation

- Added Canonical Paths + Protected Architecture sections to CLAUDE.md (FLO-554) (#199)

---

## [0.10.1] - 2026-04-02

### Improvements

- **Structured logging (FLO-555)** — migrated 423 console.* calls across 48 files to `createLogger()` API. All frontend logs now flow through logger.ts with proper level semantics (trace/debug/info/warn/error), structured `js_target` fields in Rust log output, and ESLint `no-console` rule preventing regression (#197)
- **Log hygiene** — removed user-authored content from log payloads (deep-link content, external block content, picker output) — metadata only

### Bug Fixes

- **render:: door** — stripped extra brackets from `connectsTo` values, fixed BarItem scaling (#193)
- **Config grep safety** — anchored `grep '^api_key'` and `grep '^server_port'` across 9 files to prevent matching `anthropic_api_key`

---

## [0.10.0] - 2026-03-27

### Features

- **render:: door system** — json-render/solid pipeline that lets LLMs generate structured UI specs rendered inside outline blocks. 34 component catalog (DocLayout, ArcTimeline, MeetingDiff, DecisionLog, DependencyChain, ContextStream, PatternCard, TuiPanel, TuiStat, BarChart, EntryHeader/Body, NavBrand/Section/Item, WikilinkChip, BacklinksFooter, and more)
- **Spec generation modes** — `render:: demo` (hardcoded), `render:: claude` (structured outputs), `render:: ollama` (local), `render:: agent` (multi-turn Claude Code subprocess with outline context search)
- **Agent session management** — `--continue` / `--resume <id>` for iterative spec refinement across render:: agent calls
- **Deep link write verbs** — `floatty://` handler with navigate, block, execute, upsert verbs for outline mutations from doors and external tools
- **findChildByPrefix + upsertChildByPrefix** — atomic Y.Doc transactions for prefix-based child block lookup and creation (14 tests)
- **chirpWriteHandler** — shared write dispatch for create-child and upsert-child across 3 chirp sites (artifact, inline door, pane door)
- **DoorPaneView** — full-pane zoom into door output via Cmd+Enter
- **outputSummaryHook** — extracts title + headings from door output into `block.metadata.summary` for search discovery
- **BlockMetadata.summary** field added (Rust + TS generated type)
- **LAYOUT_PATTERNS** — agent prompt guidance for when to use sidebar vs vertical stack, DocLayout 2-children rule
- **floatty-dev:// scheme** — dev build scheme isolation so dev and release instances run simultaneously
- **compile-door-bundle.mjs** — esbuild + babel-preset-solid door compilation pipeline

### Improvements

- **BlockItem decomposition** — extracted useContentSync (292 lines), useDoorChirpListener (59 lines), BlockOutputView (387 lines). BlockItem.tsx 1446→891 lines (−38%)
- **ErrorBoundary UX** — shared doorErrorFallback with Clear button across all door rendering sites
- **ArcTimeline memoization** — createMemo for arcEntries, shared entryMatchesArc predicate, pre-computed arc boundaries
- **Single-pass extractRenderSummary** — 3 loops over elements collapsed to 1
- **Agent prompt auto-sync** — replaced static prompt with catalog.prompt() so prompt stays current with component additions

### Bug Fixes

- **Sidebar width persistence** (FLO-507) — moved from config.toml to localStorage, capped max at 40vw, converted Corvu fractions to pixels
- **Server retry on startup** — wraps full IPC+health flow with backoff, prevents dev restart from killing healthy server
- **upsertChild prefix/match mismatch** — LLM used `prefix` param, handler only read `match`. Now accepts both.
- **Raw JSON normalizeSpec bypass** — raw JSON spec path now goes through normalizeSpec like other routes
- **fireHandler content mismatch** — uses existing block content when upsert finds a match, not URL content
- **Server body limit** — bumped 16MB → 64MB for large Y.Doc restores

---

## [0.9.8] - 2026-03-21

### Features

- **Artifact content sniffing** — `artifact::` auto-detects file content type and routes to appropriate renderer: HTML renders directly, JSON gets syntax-highlighted viewer, text/markdown shows in monospace code viewer. ~429 previously-broken artifact files now render
- **Artifact CDN deps** — lucide-react, framer-motion, recharts, zod, rxjs added to import map (lucide-react alone fixes 244 artifacts)
- **Cmd+. on output blocks** — toggle collapse now works on blocks with output (artifact/eval/door), not just blocks with children

### Bug Fixes

- **Expand/collapse 30s hang** — batch() wrapping on all expand/collapse setState loops. 265 children under pages:: triggered 265 individual SolidJS reactivity updates; now batched into one
- **pages:: children default collapsed** — children of the pages:: container now always default to collapsed, showing page titles instead of 265 expanded page trees
- **Indent into large parent** — Tab-indent under pages:: now uses expansion policy to auto-collapse children instead of expanding everything
- **N×M reactivity fix** — isPageChild check uses untrack() for parent content read, preventing 265 memo re-evaluations on every keystroke in parent
- **Artifact language detection** — Python (shebang), Go (package+import), Rust (use/fn/pub), bash scripts detected before JSX check, routed to text viewer instead of Sucrase error
- **Artifact runtime errors** — global error handler in iframe catches CDN import failures and render errors, shows message instead of blank white iframe
- **expandAncestors batched** — consistency with expandToDepth/collapseToDepth
- **JSON.parse size cap** — 64KB cap prevents blocking thread on large non-JSON files starting with `{`

---

## [0.9.7] - 2026-03-19

### Features

- **Unified expansion policy** — five competing expand/collapse systems consolidated into one pure function (`expansionPolicy.ts`) with 20 tests. All triggers (toggle, zoom, navigate, keybind) route through a single policy with smart thresholds (FLO-281, FLO-504, #183)
- **Navigation funnel** — all navigation paths (wikilink click, Cmd+Enter, search/filter/pick results, ⌘K Today, LinkedReferences, deep links) now route through `lib/navigation.ts` with pane link resolution at each call site (FLO-427, FLO-378, FLO-424)
- **Config-driven child render limit** — `child_render_limit` in config.toml (default 0 = no limit). Removes "77 more..." truncation; all children render collapsed
- **Search quality Phase 3** — content preprocessing, field boosting, type exclusion, snippet generation, depth scoring (FLO-368)

### Improvements

- Smart expand on toggle: expanding a block with 10+ children auto-collapses grandchildren
- Zoom auto-expand: large subtrees (500+ nodes) cap at depth 1 to prevent UI freeze
- `expandAncestors` capped at 10 levels to prevent deep-tree navigation hangs (FLO-464)
- `expandToDepth` (Cmd+E) with size cap — bails to depth 1 for 500+ node subtrees (FLO-203)
- Active pane tracks correctly after pane-link navigation (Cmd+J overlay)

### Refactoring

- `findTabIdByPaneId` moved from useBacklinkNavigation to useLayoutStore (layout utility, not backlink concern)
- Dead code removed: `ensureExpandedToDepth`, `useZoomActions.ts`, `scrollToBlockInPane` (-121 lines)
- `resolveSameTabLink` extracted, removing 118 lines of duplication across navigation callers
- HMR dispose fix for module-level `createRoot` in BlockItem config loading

### Documentation

- `docs/architecture/EXPAND_COLLAPSE_NAVIGATION.md` — architecture reference for expand/collapse + navigation routing
- `.claude/rules/architecture.md` updated with expansionPolicy.ts, useTreeCollapse.ts, useLayoutStore.findTabIdByPaneId

---

## [0.9.6] - 2026-03-18

### Features

- Resizable sidebar with @corvu/resizable, ⌘\ toggle, left/right swap (FLO-267, #178)

### Bug Fixes

- Use default import for @corvu/resizable (named export doesn't exist)

### Infrastructure

- Harden sync & tree integrity with parent validation and diagnostics (#180)
  - Parent existence validation in all createBlock operations
  - Y.Doc-authoritative descendant walks in deleteBlock/deleteBlocks
  - Centralized sync diagnostics module (syncDiagnostics.ts)
  - Transaction Authority Rules documented (ydoc-patterns.md §14)

---

## [0.9.5] - 2026-03-17

### Features

- Position-dependent outdent: first child adopts younger siblings, non-first child extracts cleanly (FLO-498, #175)
- Atomic merge: `mergeBlocks()` in single Y.Doc transaction (was 3 transactions, 3 undo entries)
- Flush/cancel discipline across all structural operations (9 actions previously unprotected)

### Bug Fixes

- Pre-flight validation: validate destination before `removeChildId` (prevents orphan on failed lookup)
- `mergeBlocks` guards: self-merge, target-is-descendant-of-source checks
- `liftOk` flag pattern: bail if children can't be safely relocated

### HMR Cleanup

- `funcRegistry`: EventBus subscription leaked on hot reload
- `doorLoader`: Blob URLs from shim creation never revoked
- `syncSequenceTracker`: `resetSharedTracker()` now called in HMR dispose
- `idbBackup`: IDB connection accumulated across reloads

### Documentation

- Compressed CLAUDE.md from 948 to 191 lines (#177)
- Extracted API reference, architecture, and config/logging to focused rules files
- Terrain map committed to `docs/evaluations/`
- Updated `do-not.md` and `ydoc-patterns.md` with new structural mutation rules

### Tests

- 587 new surgical block store tests (outdent, merge, lift, concurrent CRDT scenarios)

## [0.9.4] - 2026-03-15

### Features

- ⌘K command bar surfaces commands above pages when query matches (FLO-466)
- Double-tap ⌘ copies focused block ID as `[[wikilink]]` to clipboard
- ⌘K "Home" command — zoom out to document root
- ⌘K "Today's Daily Note" — navigate to today's date page
- Unfocused outliner panes now scroll with mouse wheel (removed blocking overlay)

### Bug Fixes

- Clear stale command bar pane snapshot when no active tab
- Consolidate BlockItem navigation through `lib/navigation` wrapper (partial FLO-378)

### Reverted

- Todo progress counter (FLO-472) — performance regression, needs parent-level computation
- Double-click checkbox toggle (FLO-473) — event conflict with collapse bullet

## [0.9.3] - 2026-03-15

### Features

- Own vs inherited marker filter — `inherited=false` query param filters to own-only markers (#173, FLO-491)
- `marker_val` param replaces broken `marker_value` — no more `::` URL encoding issues
- Vocabulary discovery endpoints: `GET /markers`, `GET /markers/:type/values`, `GET /stats`
- `BlockIndexData` struct replaces 12-arg writer sprawl

### Bug Fixes

- `q` param now optional in search API — filter-only queries without `q=` no longer return 400

## [0.9.2] - 2026-03-15

### Features

- Search metadata round-trip fix + schema enrichment + API filters (#172)
  - Fixed `has_markers=true` returning 0 results — `extractedAt` stored as f64, serde rejected for `Option<i64>`
  - Lenient timestamp deserializer for legacy Y.Doc data
  - Parser: bare markers (`floatctl::`), ctx:: value capture, `extract_ctx_datetime()` with 12h→24h
  - 5 new Tantivy fields: `outlinks`, `marker_types`, `marker_values`, `created_at`, `ctx_at`
  - 7 new search API filter params: `outlink`, `marker_type`, `marker_value`, `created_after/before`, `ctx_after/before`
  - Filter-only search (empty `q` + filters uses `AllQuery`)
  - Inherited markers included in filter fields via `InheritanceIndex`

### Bug Fixes

- Add `X-Floatty-Confirm-Destructive` header to binary-import script
- `get_block_metadata_json` now handles `Any::Map` and `YMap` variants (was `Any::String` only)
- Pin chrono >= 0.4.31 for `NaiveDateTime::and_utc()`

## [0.9.1] - 2026-03-14

### Bug Fixes

- **Cross-pane drag-and-drop restored** (PR #171, FLO-483): `pane-inactive-overlay` (added for iframe click activation) blocked pointer events on non-active panes, preventing drop target detection. Overlay now becomes pointer-transparent during block drag via `body.block-dragging`.

---

## [0.9.0] - 2026-03-13

### Features

- **Fuzzy page search** (PR #170): `GET /api/v1/pages/search?fuzzy=true` — typo-tolerant page name matching via nucleo-matcher. Existing pages beat stubs at tie scores; deterministic name tie-breaker. Page search now returns `blockId` for existing pages.
- **Presence API** (PR #170): `POST /api/v1/presence` persists last focused block; `GET /api/v1/presence` returns `{ blockId, paneId }` or 204. Validates block still exists before returning.
- **Deep links** (PR #170): `floatty://navigate/<page>?pane=<uuid>` routes to linked outliner pane or active tab fallback.
- **`[[wikilinks]]` clickable in xterm** (PR #170): Custom link provider matches `[[page]]` and `[[hash|alias]]` in terminal output. Click navigates to linked outliner pane.
- **Terminal → outliner pane linking** (PR #170): `Cmd+L` from terminal opens letter overlay. Many→one: multiple terminals can link to same outliner.
- **PTY env injection** (PR #170): `FLOATTY_PANE_ID`, `FLOATTY_URL`, `FLOATTY_API_KEY` injected into every spawned PTY for agent/extension integration.
- **`img::` inline media viewer**: Auth-fetched blob URLs render images, PDFs, and HTML files inline. Full-bleed CSS via `--block-depth`, right-edge resize for images, bottom-edge resize for PDFs. Extension-gated auto-execute prevents 404 mid-type.
- **Expanded `artifact::` read scope**: `~/.rotfield`, `~/Desktop`, `~/Documents` added to Tauri fs capabilities.

### Performance

- **Eliminate O(N) effect cascade** (FLO-452): Untrack `lastUpdateOrigin` from SolidJS store — was triggering full block tree re-render on every keystroke.

### Bug Fixes

- **`resolveTargetPane` fallback**: Returns active tab's outliner when no pane hint provided.
- **Wikilink off-by-one**: `getLine()` 0-based vs `provideLinks(y)` 1-based — underline was on wrong line.
- **`isMac` is boolean not function**: Was throwing TypeError on every keydown.
- **`Cmd+L` dead code**: Handler was after early-return guard; moved before it.
- **`strip_heading_prefix` symmetry**: Core and server now both take first line only, mirroring frontend.
- **Tauri bumped to 2.10** to match `@tauri-apps/api` 2.10.1.

---

## [0.8.5] - 2026-03-12

### Features

- **Short-hash block resolution** (PR #168): All block ID endpoints now accept 6+ hex-char prefix lookups (git-sha style). `GET /api/v1/blocks/resolve/:prefix` returns unique match or conflict list. Client-side `shortHashIndex` singleton in WorkspaceContext provides O(1) prefix lookups without server round-trip.

### Bug Fixes

- **Large container lock-up on zoom-navigate** (PR #169): Block render limit (100 children) now resets when a `BlockItem` is rebound to a new block ID. Prevents stale `childLimit` from over-mounting children when navigating from a large container (e.g. `pages::`) to a new zoom target.
- **dailylog:: date filter misses target file** (PR #169): Removed `head -N` limiter for date-specific and `today` lookups. Previously `dailylog:: 2026-01-15` would silently miss files not in the two most-recent results.
- **dailylog:: project color prefix shadowing** (PR #169): `float-av` entries now correctly get the amber color rather than falling through to the `float` blue. Keys are sorted by descending length before prefix match.
- **stripOSC drops ST-terminated sequences** (PR #169): `@floatty/stdlib` `stripOSC` now handles both BEL (`\x07`) and String Terminator (`\x1b\`) OSC terminators. Shell hooks emitting OSC 133/1337 with ST were corrupting `execJSON` output.
- **Search total count truncated** (PR #168): Search result total now reflects true match count, not the truncated page size.
- **resolve_block_prefix 400 validation** (PR #168): Restored proper validation error responses for short-hash resolution edge cases.

---

## [0.8.4] - 2026-03-11

### Bug Fixes

- **Wikilink block-id zoom overshoots to root** (FLO-432, PR #166): `navigateToBlock` now walks ancestor chain to pick a useful zoom target — stops before root-level blocks like `pages::`. Block-level wikilinks (`[[id|label]]`) land in focused context instead of the entire outline.
- **Full-width toggle broken in multi-pane** (PR #166): `Cmd+Shift+F` now guards against inactive pane, preventing toggle from firing on wrong pane.
- **Per-pane highlight cleanup** (PR #166): Replaced global highlight singleton with `Map<string, () => void>` keyed by paneId. Concurrent multi-pane navigation no longer tears down each other's highlights.
- **Strict pane scoping for highlight retry** (PR #166): Removed global `document.querySelector` fallback from `findBlockInPane`. Per-pane cancellation via Symbol tokens prevents stale retry loops.
- **setCursorAtOffset ReferenceError**: Guarded async cursor positioning against detached DOM nodes and non-contentEditable elements after block merge/navigation.
- **Stale highlight on highlight:false navigation**: Old pane highlights now explicitly cleaned up when navigating with highlight disabled.
- **Event listener leak in highlight dismiss** (PR #166): Fixed split `if/else` listener target so cleanup always removes from the same target that `addEventListener` used.

---

## [0.8.3] - 2026-03-09

### Features

- **Chirp bridge for IframePaneView**: cmd+click navigate works when zoomed into portless block full-pane (previously only EvalOutput's UrlViewer had the postMessage bridge)
- **Stub page dimming**: Wikilinks to pages with no real content (0 children or single empty child) render dim instead of full link color. New `stubPageNameSet` singleton memo in WorkspaceContext
- **Dimmed pane activation overlay**: Clicking inside a dimmed iframe now activates the pane via transparent overlay (iframe clicks don't bubble to parent)

## [0.8.2] - 2026-03-09

### Bug Fixes

- **Image paste lands file icon instead of image** (PR #165): Finder copy-paste produced file type icons because arboard's text clipboard returned filenames that the outliner rendered as text blocks. Now probes Tauri `readFiles()` for actual file paths, with `contentRef` refocus guard for async focus drift.

### Documentation

- **`blockId` vs `id` convention** (FLO-431): Search hits use `blockId` (foreign key, greppable), block CRUD uses `id` (primary key). Documented in `serde-api-patterns.md`.

## [0.8.1] - 2026-03-09

### Features

- **Short-hash block resolution** (PR #164): `GET /api/v1/blocks/resolve/:prefix` resolves 6+ hex-char prefixes to full block UUIDs. Client-side `shortHashIndex` singleton memo in WorkspaceContext for O(1) 8-char lookups
- **selfRender doors** (PR #164): `DoorMeta.selfRender` flag lets doors render inline via `setBlockOutput()`, bypassing adapter child-block envelope
- **Unified chirp navigate** (PR #164): `handleChirpNavigate()` replaces duplicated iframe→outline navigation logic across EvalOutput and DoorHost
- **blockInput sub-hook scaffold** (PR #164): `useBlockInput` split into `blockInput/` sub-hooks (editing, navigation, execution, zoom) for future delegation

### Bug Fixes

- **UUID validation tightened**: Resolve endpoint validates dash positions and hex digits, not just string length
- **Canonical ID on case-insensitive match**: Returns stored key casing, not request casing
- **Door hot-reload kind change**: Stale view unregistered from doorRegistry when door changes from view→block
- **Door selfRender error handling**: try/catch in both initial load and hot-reload paths
- **Dead imports removed**: Unused sub-hook imports cleaned from useBlockInput.ts

### Documentation

- Accessibility baseline rule (ARIA landmarks, focus indicators, motion preferences)
- YJS decoupling audit document (`docs/architecture/AUDIT_2026-03.md`)
- CLAUDE.md updated with resolve endpoint, door types, blockInput sub-hooks, shortHashIndex
- floatty-backend skill updated: stale "use search to resolve" gotcha replaced with resolve endpoint

---

## [0.8.0] - 2026-03-06

### Features

- **Door plugin system** (Units 1.0–12.0, PR #158, #159): Extensible door architecture — `func::` meta-handlers with iframe rendering, `eval::` JS expression engine with outline access, `timestamp::` validation door, `claude-mem` door, full-width block mode, sidebarEligible phases, hot reload via file watcher, config integration for plugin settings, help docs
- **Artifact handler & chirp protocol** (PR #162): `artifact::` renders Claude.ai JSX artifacts in sandboxed iframes via Sucrase transform + esm.sh import maps. Bidirectional chirp bridge — artifacts write blocks to outline (`window.chirp()`), outline pokes artifacts (`window.onPoke`). Supports TSX, anonymous default exports, `</script>` escape
- **Pane linking** (FLO-223, PR #162): tmux-inspired cross-pane navigation — `⌘L` links source pane to target, wikilink clicks and chirp navigates route through linked pane. Chaining supported (A→B→C)
- **Focus overlay** (PR #162): `⌘J` jumps to any pane (terminals + outliners) via letter overlay picker
- **Unfocused pane dimming** (PR #162): Configurable opacity for non-active panes, linked panes get cyan tint at midpoint brightness. Toggle via `⌘K` command
- **Context retrieval API** (FLO-338): `GET /api/v1/blocks/:id` supports `include` query param for ancestors, siblings, children, tree, token estimates. Search endpoints support breadcrumb and metadata includes
- **Copy Block ID** command: `⌘K` → "Copy Block ID" copies git-sha style 8-char block UUID prefix to clipboard

### Bug Fixes

- **Block ID wikilinks** created pages instead of navigating — added hex-prefix guard at 3 navigation sites (wikilink click, chirp navigate, DoorHost navigate). Hex-looking strings never fall through to page creation
- **Stale pane link indicators**: `hasBlockLink()`/`hasPaneLink()` validated pane existence instead of raw map membership
- **Chirp rate limiting**: Per-block 100ms cooldown prevents runaway iframe `setInterval` from creating unbounded child blocks
- **Anonymous default exports** in artifact transform: `export default function() {}` now handled correctly
- **Import map subpath URLs**: Fixed `esm.sh` format from `pkg/sub@ver` to `pkg@ver/sub`
- **`</script>` injection**: Escaped in artifact HTML to prevent document parser breakage
- **ReactDOM import detection**: Checks for default import binding specifically, not just any react-dom import
- **Hardcoded CSS**: Replaced last `rgba()` in pane-link styles with theme-aware `color-mix()`
- **fs read scope**: Narrowed `fs:allow-read-text-file` from `$HOME/**/*` to specific project paths
- **Unicode-correct token estimates** in API response
- **API overflow guards**: Parameter caps on sibling_radius and max_depth

### Documentation

- CLAUDE.md updated with pane linking, artifact handler, chirp protocol sections
- Keybind registry updated with `⌘L`, `⌘J`, `⌘⌥Arrow`

---

## [0.7.42] - 2026-03-01

### Performance

- **Batch Y.Doc transactions for paste/import** (FLO-322, PR #154): Paste and `sh::` output now create all blocks in a single Y.Doc transaction instead of 2N individual transactions. 100 pasted blocks = 1 transaction (was 200). Single `observeDeep` fire, single SolidJS batch, single undo step. Uses `bulk_import` origin to skip synchronous EventBus — metadata (ctx:: markers, [[wikilink]] outlinks) extracted asynchronously via ProjectionScheduler.
- **Singleton pageNames memo** (FLO-322): Lifted identical `pageNames` computation from per-BlockItem (N copies, all identical) to WorkspaceContext singleton. Eliminates N×M recomputation on every keystroke with 500+ blocks.

### Bug Fixes

- **WebSocket reconnect gap** (sweep find): `new WebSocket()` throwing synchronously left connection permanently dead — no reconnect scheduled, no error status set. Added catch with exponential backoff reconnect timer.
- **Homebase keybind fallback**: `⌘⇧0` collapse-to-depth used `?? 0` (disabled) when config missing — changed to `?? 2` for sensible default.
- **ExecutorActions missing batch API**: `batchCreateBlocksAfter` was available on the store but not wired through `ExecutorActions` interface — handlers couldn't batch-create siblings. Wired in both action builders.

### Documentation

- Project rules updated: SolidJS patterns #10 (lift identical memos), Y.Doc patterns #11 (batch transactions), #12 (observer API return type)

---

## [0.7.41] - 2026-02-28

### Features

- **Typed text first in autocomplete** (FLO-400, PR #153): User's typed text always appears as the first suggestion in `[[` wikilink and `⌘K` command bar autocomplete. Selecting it creates a new page (or navigates if exact match exists). Removes the old "Create" item from the bottom of the list. Case-insensitive exact match resolves to canonical page name.

### Bug Fixes

- **Dead else-if branch** (FLO-400): Removed unreachable branch in CommandBar Enter handler that could never fire after typed-text-first reordering.

---

## [0.7.39] - 2026-02-24

### Bug Fixes

- **Echo gap storm** (FLO-391, PR #151): Server-side hooks (MetadataExtraction, InheritanceIndex) consumed seq numbers without broadcasting via WebSocket, causing ~20 gap-fill HTTP requests/sec during typing. Fixed with server broadcast callback on hook mutations + client-side 200ms echo gap debounce. Downstream: resolves FLO-392 selection+delete corruption caused by gap-storm-triggered resyncs.
- **info:: build health endpoint** (sweep find): Fixed wrong URL (`/health` → `/api/v1/health`) — `info:: build` was always showing "(health endpoint unreachable)".

---

## [0.7.38] - 2026-02-24

### Bug Fixes

- **WebGL font corruption on wake** (FLO-390, PR #149): Recreate WebGL addons on `visibilitychange` to prevent garbled terminal glyphs after sleep/display changes. Consolidated 3 inline creation sites into `recreateWebGL()`.
- **Multi-line page title matching** (PR #150): Pages with metadata on subsequent lines (`[board:: recon]`, `[relates:: ...]`) couldn't be found via `[[Title]]`. New `getPageTitle()` extracts first line only before matching. Autocomplete also shows clean titles.

---

## [0.7.37] - 2026-02-24

### Features

- **Fuzzy autocomplete** (FLO-389, PR #148): Typo-tolerant matching for `[[` wikilinks and `⌘K` command bar via fuse.js. `[[sun` finds "fun in the sun". Pinned recent: top 3 most-recently-edited pages shown first, rest alphabetical.

---

## [0.7.36] - 2026-02-18

### Features

- **Command bar ⌘K** (FLO-276, PR #147): Modal command palette for page navigation and built-in commands. Type to filter pages (recency-sorted) and commands (Export JSON/Binary/Markdown). Enter navigates to page or creates new one under `pages::`. Keyboard nav with wrap, click support, ARIA combobox pattern. Theme-aware via CSS variables.

### Bug Fixes

- **Focus after ⌘K navigation**: First child block of the target page receives DOM focus so keyboard works immediately — no mouse click needed.
- **Outliner pane targeting**: When focus is in a terminal pane, ⌘K now finds the first outliner pane in the layout instead of targeting the terminal.
- **Platform-aware command dispatch**: Export commands triggered via command bar use `Ctrl` on Windows/Linux instead of hardcoded `Meta`.

---

## [0.7.33] - 2026-02-18

### Bug Fixes

- **Blank line navigation** (PR #144): ArrowDown/Up now correctly step through blank lines in multi-line blocks instead of getting trapped or skipping. Rewrote boundary detection as offset-based comparison (`getAbsoluteCursorOffset >= getContentLength`) replacing broken structural DOM checks. Fixed edge case where cursor at `(root, childCount)` returned wrong offset for trailing `<br>`.
- **Cmd+A tiered selection** (PR #144): First Cmd+A selects all text within block, second escalates to block selection. Uses `Range.compareBoundaryPoints` for robust detection (old string-length comparison broke on multi-line blocks).
- **Delete focus priority** (PR #144): Deleting a block now focuses the previous sibling instead of jumping to parent. Priority: prev sibling → next sibling → parent.
- **Ghost selection states** (PR #144): Block selection borders now clear when clicking into a contentEditable block. Arrow keys escape block selection mode and restore editing focus.

### Tests

- Added 29 `cursorUtils` tests covering offset calculation, boundary detection, and `setCursorAtOffset` roundtrips against real DOM structures (bare `<br>` model matching floatty's actual contentEditable behavior).

### Documentation

- Promoted "Inspect real DOM before writing cursor code" to section 0 meta-rule in contenteditable-patterns.md.

---

## [0.7.32] - 2026-02-18

### Features

- **`[[` Inline Autocomplete** (FLO-376, PR #143): Type `[[` in any block to trigger autocomplete popup showing pages from `pages::` container. Arrow keys navigate, Enter/Tab selects, Escape dismisses. Filters by case-insensitive substring match. Popup viewport-clamped, dismiss-on-scroll, mouse hover support. ARIA listbox pattern for accessibility.

### Bug Fixes

- **Export keybind dedup** (FLO-367, PR #142): Export keybinds (Cmd+Shift+M/J/B) fired once per Outliner pane instead of once. Deduplicated via tinykeys on the active pane only.

---

## [0.7.31] - 2026-02-16

### Bug Fixes

- **Hook thread starvation** (FLO-361, PR #141): Metadata extraction and inheritance index hooks ran synchronously on the Yrs observe callback thread, blocking all Y.Doc writes during processing. Moved to `spawn_blocking`, batched metadata updates (N write locks → 1), and added incremental `update_affected()` to InheritanceIndex (only recomputes changed blocks + descendants instead of full rebuild).
- **Shell command PATH** (PR #140): `sh::` blocks using `-li` (interactive login shell) hung on machines with starship/p10k prompt init. Switched to `-lc` with explicit `.zshrc` source to get PATH without requiring a TTY.
- **Batch metadata read lock consolidation**: Replaced N individual `get_block_metadata_json()` calls with single read lock using `parse_metadata_from_out()`, which correctly handles all 3 metadata formats (legacy JSON string, Any::Map, native Y.Map).

### Improvements

- **Sweep hardening** (P1-P5): `setApplyingRemote` guarded with try/finally (3 call sites), `deny_unknown_fields` on `PresenceRequest`, `.catch()` on fire-and-forget async (`validateSyncedState`, `loadInitialState`, `autoExecute`).
- **`data_dir()` consolidation** (FLO-317): Four identical implementations collapsed into single `floatty_core::data_dir()`. Prevents sibling drift.

### Testing

- 12 store-backed unit tests for `InheritanceIndex::rebuild()` and `update_affected()` covering root blocks, deleted blocks with descendants, depth >50, and stale inheritance removal (229 Rust tests, 731 JS tests).

---

## [0.7.30] - 2026-02-15

### Bug Fixes

- **GUI edits missing metadata** (FLO-358, PR #139): `MetadataExtractionHook`, `InheritanceIndexHook`, and `PageNameIndexHook` all rejected `Origin::Remote` — meaning ~90% of blocks (created/edited via GUI) had `metadata: null`. Added `Origin::Remote` to all three hooks and updated `triggers_metadata_hooks()`. Server is sole metadata extractor; the "already extracted at source" assumption was wrong.

---

## [0.7.29] - 2026-02-15

### Features

- **Metadata inheritance** (FLO-351, PR #134): Blocks inherit `ctx::`, `project::`, `mode::` markers from ancestors. O(1) `InheritanceIndex` rebuilt on block changes replaces compute-on-get traversal. Inherited markers included in Tantivy search index and API responses.
- **Block repositioning API** (FLO-283, PR #135): `PATCH /api/v1/blocks/:id` now accepts `afterId` (place after sibling) and `atIndex` (place at position) for precise block ordering. Self-referential `afterId` rejected.
- **Ratatui TUI spike** (PR #136): Read-only terminal UI for floatty outliner with presence broadcast for cursor following.

### Bug Fixes

- **Data integrity hardening** (FLO-348/349/350, PR #133): Recursive delete for blocks with children, export validation guards, orphan block detection and re-homing on startup.
- **Config save deprecation** (PR #137): Removed deprecated `load()`/`save()`/`default_config_path()` from `config.rs`, threaded explicit `config_path` through `AppState`. Prevents config clobber from feature branches.
- **Short block ID panic** (4e50c7b): TUI status bar and focus log no longer panic on block IDs shorter than expected.
- **Y.Map metadata parsing** (3d2d7d6): `store.get_block()` now correctly parses metadata stored as Y.Map (not just plain JSON).

---

## [0.7.28] - 2026-02-11

### Bug Fixes

- **Export ACL failure**: Fixed JSON (⌘⇧J) and binary (⌘⇧B) export failing with "Command plugin:fs|write_text_file not allowed by ACL". Root cause: `tauri-plugin-fs` wasn't installed. Added plugin to `Cargo.toml`, registered in `lib.rs`, and configured proper scope permissions in `capabilities/default.json` with `$HOME/**/*` path allowlist for dialog-selected files.

---

## [0.7.25] - 2026-02-08

### Features

- **Diagnostics strip**: Replaced hardcoded "DEV" badge with dynamic diagnostics strip showing server port, build type (`debug`/`release`), and config path. Toggled via `Ctrl+Shift+D`. Removed orange accent override — diagnostics is informational, not an alarm.

### Bug Fixes

- **`info::` showing undefined values**: Fixed `is_dev_build` and `data_dir` returning `undefined` in IPC responses. Changed `#[serde(skip)]` to `#[serde(skip_deserializing, default)]` with explicit filtering in `save_to` to prevent runtime fields leaking into config.toml.

### Improvements

- **Renamed dev-mode → diagnostics concept**: `dev_mode_visuals` → `show_diagnostics` (config field, with `alias` for backward compat), `toggle_dev_visuals` → `toggle_diagnostics` (Tauri command), `applyDevModeOverride` → `setDiagnosticsVisible` (frontend). 14 files updated.

---

## [0.7.24] - 2026-02-08

### Features

- **Dev mode visual distinction** (FLO-259): Orange accent override, DEV badge in status bar, port display, `Ctrl+Shift+D` toggle (persists to config.toml). Runtime-only `is_dev_build` and `data_dir` config fields.
- **`info::` diagnostic handler**: Dumps build/config/sync diagnostics as child blocks in outliner with topic filtering (`info:: sync`, `info:: config`, `info:: build`). Idempotent re-run via output block pattern.

### Bug Fixes

- **Terminal clipboard mediation** (FLO-310): Bracketed paste mode for nvim/helix, OSC 52 via `@xterm/addon-clipboard` with custom Tauri clipboard provider (tmux copy → system clipboard), clickable URLs via `@xterm/addon-web-links` with Tauri IPC handler.
- **WebLinksAddon clicks silently failing**: `window.open()` no-ops in Tauri webview. Added `open_url` command with http/https scheme validation, routed through native `open` command.
- **Serde config fields**: Changed `skip_deserializing` to `skip` on runtime-only config fields to prevent serialization of transient state.

### Improvements

- **Sync gap detection** (FLO-269): Handle heartbeat-only sequence gaps without fetching updates. Prevents unnecessary full resyncs from idle heartbeat increments.

---

## [0.7.23] - 2026-02-08

### Features

- **Cross-pane block drag-and-drop** (FLO-115, PR #127): Drag blocks between outliner panes using drag handles. Pointer-based drop resolution with above/below/inside zones, cycle prevention, undo isolation via `stopUndoCaptureBoundary()`, and `block:move` event emission. Auto-expands collapsed targets on drop, scrolls dropped block into view, and flashes subtree highlight for 1.2s.

### Bug Fixes

- **Block text vanishing while typing `::`** (PR #128): Fixed display overlay rendering empty when `hasInlineFormatting()` hint fired but parser produced no tokens. BlockDisplay now falls back to raw content instead of empty overlay. Tightened prefix marker detection to line-leading or bracketed `[word::` only.
- **UTF-8 panic in log previews** (45ece30): Fixed byte-slice panic on multi-byte characters (box-drawing, arrows) in metadata extraction and ctx parser — use `.chars().take(N)` instead of `&content[..N]`.

### Improvements

- **Event system**: `block:move` event type with `BlockMoveDetails` payload (source/target pane, drop position, old/new parent and index). Block updates now populate `changedFields` in event envelopes.
- **Sync reliability**: Force full recovery on reconnect buffer overflow. Seed workspace save sequence from persisted state. Drain projection scheduler queue during active flush. Prevent stale async saves from overwriting newer state.
- **Architecture**: Event-driven ctx sidebar refresh (replaces polling). Scoped terminal keybind capture to global actions. Explicit dependency control for workspace bootstrap. Version-signal persistence tracking replaces deep object diffing.

---

## [0.7.22] - 2026-02-07

### Features

- **Layout**: Outer edge drop zones for full-height column snapping (PR #126). Dragging a pane to the absolute left or right edge of the layout creates a full-height column alongside the entire existing layout tree.

### Bug Fixes

- **Layout**: Fixed ghost resize dividers lingering after pane drag-drop rearrangement. ResizeOverlay now re-syncs handle positions when the layout tree structure changes.

---

## [0.7.21] - 2026-02-07

### Features

- **Pane drag-and-drop rearrangement** (FLO-120, PR #124): Drag handles on terminal and outliner panes for rearranging split layouts via drop zones (left/right/up/down). Pure immutable tree operations, event-driven resize sync, Esc to cancel, visual glyph hints.

### Improvements

- **Accessibility**: `prefers-reduced-motion` media query disables drag handle and drop zone transitions
- **Debuggability**: `fitAndFocusWhenPaneRefsReady` logs warning on retry exhaustion instead of silent fallthrough

---

## [0.7.20] - 2026-02-06

### Features

- **Box-drawing pretty-print** (PR #122): Block tree debug output uses box-drawing characters with ANSI coloring for readable hierarchy visualization
- **Bidirectional resync** (PR #123): `triggerFullResync()` now pushes local-only diff via state vector before pulling server state — prevents silent data loss when local edits haven't reached server
- **Post-resync health verification** (PR #123): After full resync, re-checks block counts and shows yellow "drift" indicator instead of false green if counts still diverge

### Bug Fixes

- **Surgical Y.Array mutations** (FLO-280, PR #123): Replaced destructive delete-all-then-push pattern on `childIds` Y.Arrays with surgical helpers (`insertChildId`, `removeChildId`, `appendChildId`, etc.) — prevents CRDT duplication when divergent docs merge during bidirectional resync or crash recovery. 17 call sites migrated, 6 helpers added.
- **Cross-parent childIds duplication** (PR #123): Startup integrity check detects and fixes blocks appearing in multiple parents' `childIds` arrays — keeps the canonical parent, removes stale references
- **Orphan block re-homing** (PR #123): Blocks whose `parentId` points to a parent that doesn't list them in `childIds` are now re-homed on startup
- **Tree integrity check** (PR #123): Comprehensive startup validation covers orphans, cross-parent duplication, and parent↔child consistency
- **Insert index clamping** (PR #123): `insertChildId` and `insertChildIds` clamp `atIndex` to valid range, preventing Y.Array out-of-bounds errors
- **Drift status protection** (PR #123): `setSyncStatus('synced')` now guards with `!isDriftStatus()` to prevent health check drift indicator from being clobbered by normal sync paths

---

## [0.7.19] - 2026-02-05

### Features

- **Block lifecycle hooks** (PR #120): Hook system using `blockEventBus` for metadata extraction
  - `ctxRouterHook` extracts `ctx::` markers and `[project::X]`, `[mode::Y]`, `[issue::Z]` tags → `block.metadata.markers`
  - `outlinksHook` extracts `[[wikilink]]` targets → `block.metadata.outlinks` (enables backlink queries)
  - Hooks use Origin filtering to prevent infinite loops
  - Null-safe metadata merge guards against legacy data
  - Stale metadata cleared when patterns removed from blocks

---

## [0.7.18] - 2026-02-05

### Features

- **Server health endpoint** (b2b0c49): Added version and git info to health endpoint for operational visibility

### Bug Fixes

- **Scroll lock race condition** (FLO-278, PR #121): Replaced inline `overflow: hidden` manipulation with CSS class toggle (`scroll-locked`), eliminating race between focus routing and RAF-based scroll preservation that caused scroll to stop responding after zoom/paste/wikilink/history operations
- **Stale server cleanup** (427031a): Kill stale servers by port before rebuild to prevent port conflicts

---

## [0.7.17] - 2026-02-05

### Features

- **Sequence number sync hardening** (PR #119): Complete CRDT sync layer with gap detection, incremental reconnect, and 30-second heartbeat for reliable message ordering
- **SyncSequenceTracker** (PR #119): Extracted pure state machine class for sequence tracking with 23 unit tests — tracks `lastSeenSeq`, `lastContiguousSeq`, gap queue management
- **Incremental reconnect** (PR #119): On WebSocket reconnect, fetch only missing updates via `/api/v1/updates?since=X` instead of full resync — bandwidth optimization for stable connections
- **REST→WS broadcast** (PR #119): External tools (CLI agents, automation) can write via REST `/api/v1/update` and changes automatically broadcast to all WebSocket clients

### Bug Fixes

- **Split-brain prevention** (PR #119): Persist `lastContiguousSeq` instead of `lastSeenSeq` — prevents missing updates after reload when gaps exist (lastSeenSeq can jump on out-of-order messages)
- **Gap detection on echo** (PR #119): Own messages returning with higher-than-expected seq now trigger gap detection (your update at seq 105 reveals you missed 101-104)
- **HMR timer cleanup** (PR #119): Fixed reference to renamed timer variable in HMR disposal block
- **API unknown fields rejection** (PR #119): Added `deny_unknown_fields` to all request structs — snake_case `parent_id` now returns 400 instead of being silently ignored

### Documentation

- **Architectural audit report** (`docs/ARCHITECTURAL_AUDIT.md`): Complete review of sync layer including known risks and mitigations
- **Sequence number review** (`docs/architecture/SEQUENCE_NUMBER_REVIEW.md`): Deep dive into gap detection, persistence safety, and edge cases
- **serde API patterns rule** (`.claude/rules/serde-api-patterns.md`): Codifies `deny_unknown_fields` requirement and camelCase conventions

---

## [0.7.16] - 2026-02-04

### Bug Fixes

- Fixed first API PATCH not rendering in client by skipping redundant HTTP fetch on initial WS connect (FLO-269)
- Bumped server broadcast logging to info level for sync diagnostics
- Redirected floatty-server stderr to `server.log` for release build visibility

---

## [0.7.15] - 2026-02-03

### Features

- **Inline breadcrumb tree expansion** (FLO-263, PR #118): Search result breadcrumbs unfold inline as a tree — click `▸` between crumbs to peek at siblings, on-path child continues with remaining trail, multiple peeks supported concurrently
- **Output block keyboard navigation** (FLO-263, PR #118): Arrow keys enter/exit search results, Escape deselects, Enter navigates to focused result, Cmd+Enter opens in split. Output blocks are no longer keyboard dead zones
- **Output block operations** (FLO-263, PR #118): Tab/⇧Tab indent/outdent, ⌘↑↓ move, Backspace delete (with child-protection guard) — all work on search/daily output blocks

### Bug Fixes

- **Output block focus routing** (FLO-263): Separate `outputFocusRef` wrapper prevents focus from being stolen by the main contentEditable routing effect
- **Platform-aware modifier keys**: Use `isMac ? metaKey : ctrlKey` consistently across output block keyboard handler and search result split-click
- **Breadcrumb empty ancestors**: Empty parent blocks show `(empty)` placeholder instead of being silently skipped (prevents peek index misalignment)
- **Breadcrumb sibling rendering**: Siblings appearing after the on-path child in tree order are now rendered
- **ARIA on non-focused element**: Removed `aria-activedescendant` from display-only listbox (focus lives on parent wrapper)

### Documentation

- **Architecture map** (`ARCHITECTURE_MAP.md`): Canonical four-layer model with status markers, six invariants, document index
- **Keyboard control patterns** (`KEYBOARD_CONTROL_PATTERNS.md`): Four keyboard patterns with decision tree
- **Rich output handler guide** (`RICH_OUTPUT_HANDLER_GUIDE.md`): Step-by-step guide for adding new `prefix::` handlers
- **Inline expansion patterns** (`INLINE_EXPANSION_PATTERNS.md`): Per-item state signals within output views
- **MDX-lite vision** (`MDX_LITE_VISION.md`): Ghost spec for outline hierarchy as component container syntax
- **Output block patterns rule** (`.claude/rules/output-block-patterns.md`): Display-only views, single focus point, dual-focus anti-pattern

---

## [0.7.14] - 2026-02-03

### Features

- **Search reindex endpoint** (FLO-261, PR #117): `POST /api/v1/search/reindex` triggers full rehydration from Y.Doc without restart

### Bug Fixes

- **Search query escaping** (FLO-261, PR #117): Escape all Tantivy query syntax characters (`::`, `[]`, `()`, `*`, `?`, etc.) — queries containing `ctx::`, `[[wikilinks]]`, or `[project::X]` no longer cause 500 errors
- **Search error status code**: Query parse errors now return 400 Bad Request instead of 500 Internal Server Error
- **Search error logging**: Frontend handler properly serializes non-Error objects with cyclic-safe fallback (was logging `{}`)

---

## [0.7.13] - 2026-02-03

### Bug Fixes

- **Nuke Tantivy index on restart** (FLO-186, PR #116): Delete `search_index/` directory on server startup before creating fresh index — eliminates ghost IDs and stale entries that persisted across restarts
- **Backup failure log level**: Escalated Y.Doc IndexedDB backup failure from `console.warn` to `console.error` — backup is the crash recovery path, failures shouldn't be quiet

---

## [0.7.12] - 2026-02-03

### Features

- **MCP bridge plugin** (PR #115): Added `tauri-plugin-mcp-bridge` for dev-mode automation — WebSocket on port 9223 enables screenshot capture, DOM inspection, console log reading, and keyboard/mouse automation from Claude Code

### Bug Fixes

- **Backspace merge newline** (PR #115): Blocks now merge with `\n` separator when pressing backspace at start, turning siblings into multi-line blocks instead of concatenating content

---

## [0.7.11] - 2026-02-03

### Bug Fixes

- **WebSocket reconnect sync race** (FLO-256, PR #114): Added `reconnect-authority` origin that bypasses `hasLocalChanges()` guard, allowing authoritative server state to sync during reconnect
- **HMR store preservation**: Preserved `blockStore` instance across hot module replacement via `import.meta.hot.data` to prevent empty state after dev mode file edits
- **Reconnect echo prevention**: Wrapped reconnect Y.Doc apply with `isApplyingRemoteGlobal` guard to prevent update observer from echoing state back to server
- **Stale debounce on authority sync**: Cancel pending content debounce and clear dirty flags when authoritative update arrives, preventing stale local content from overwriting server state
- **Image paste path quoting**: Temp file paths with spaces now quoted before sending to PTY
- **HTTP client init race**: Moved `initPromise = null` from catch to finally block, preventing stuck rejected promise on transient init failures

### Improvements

- **Clipboard paste visibility**: Image and text paste failures now display inline warnings in terminal instead of silent console errors
- **Workspace load error banner**: Yellow warning banner when workspace fails to load instead of silent failure
- **Friendly PUT error message** (FLO-255): Returns 405 with "Did you mean PATCH?" when agents try PUT on `/api/v1/blocks/:id`

---

## [0.7.10] - 2026-02-02

### Features

- **Automated rolling backup daemon** (FLO-251, PR #113)
  - Hourly backups to `~/.floatty/backups/` (configurable)
  - Tiered retention: 24h hourly, 7d daily, 4w weekly
  - `backup::status` - Daemon health and timing
  - `backup::list` - Show recent backups with sizes
  - `backup::trigger` - Force immediate backup
  - `backup::config` - View retention settings
  - `backup::restore <file> --confirm` - Restore from backup

- **Export endpoints for agents/cron** (FLO-249)
  - `GET /api/v1/export/binary` - Download raw .ydoc
  - `GET /api/v1/export/json` - Download human-readable JSON

### Improvements

- Use `chrono` crate for UTC timestamps (replaces 50+ lines of manual date calc)
- Async file writes in backup daemon (`tokio::fs::write`)
- Proper error propagation in config serialization

---

## [0.7.9] - 2026-02-02

### Features

- **Binary restore endpoint** (`/api/v1/restore`) for disaster recovery (FLO-247, PR #111)
  - Destructive replacement of Y.Doc state from binary backup
  - Clears search index and rehydrates hooks after restore
  - Broadcasts new state to all connected WebSocket clients

- **Rolling backup insurance** (FLO-247, PR #110)
  - `⌘⇧B` - Binary Y.Doc export (perfect restore with CRDT metadata)
  - `⌘⇧J` - JSON export with validation (human-readable fallback)
  - Export validation catches structural issues before download

- **IndexedDB namespace isolation** (FLO-247): Prevents dev/release data mixing
  - Database names now include build type and workspace: `floatty-backup-{dev|release}-{workspace}`

- **Build profile data isolation**: Dev and release can't cross-contaminate
  - Different bundle identifiers for dev builds
  - Distinct default ports: dev (33333) vs release (8765)

### Bug Fixes

- **16MB body limit** for large .ydoc restores (was 2MB axum default)
- **Timestamped export filenames** to avoid `(1)` `(2)` collisions
- **Unified port config** - server reads `server_port` from top level
- **Export script** (FLO-247): Fixed `export-outline.mjs` to use `childIds` for sibling order

---

## [0.7.8] - 2026-02-01

### Features

- **API reparenting** (FLO-224, PR #108): Blocks can now be moved between parents via PATCH `/api/v1/blocks/:id`
  - `parentId: null` moves block to root
  - `parentId: "<id>"` moves block under specified parent
  - Children automatically travel with reparented block
  - Cycle detection prevents parenting under self or descendants
  - Emits `BlockChange::Moved` event for hook integration

### Bug Fixes

- **Server auth**: Skip auth for localhost connections (dev ergonomics)

---

## [0.7.7] - 2026-01-30

### Features

- **Markdown table rendering** (FLO-58, PR #107): Full interactive table support in the outliner
  - Parses markdown table syntax (`| A | B |`) into structured table view
  - Cell editing with Tab/Shift+Tab navigation between cells
  - Column resizing via drag handles (zero-sum model, Shift+drag for proportional)
  - Text wrapping in all cells
  - Toggle between table view and raw markdown (≡ button)
  - Inline formatting preserved in cells (bold, italic, wikilinks)
  - Column widths persist in block metadata

---

## [0.7.6] - 2026-01-29

### Bug Fixes

- **Terminal scroll**: Replaced broken `onScroll` detection with wheel events (FLO-220)
  - xterm's `onScroll` only fires on content changes, not user scroll ([xterm #3201](https://github.com/xtermjs/xterm.js/issues/3201))
  - Wheel events reliably detect user scroll intent
  - Added visual indicator (⇡) in tab bar when detached from output
  - Fixed memory leak: wheel listener now cleaned up on dispose

---

## [0.7.5] - 2026-01-29

### Bug Fixes

- **Terminal scroll**: Fixed race condition where programmatic `scrollToBottom()` calls would yank user back after scrolling up (FLO-220)
  - Removed auto-reattach on reaching bottom - only explicit `Cmd+End` or `Cmd+Down` reattaches now
  - Added `Cmd+Down` (`Ctrl+Down` on Linux/Windows) as alternative for compact keyboards without End key

---

## [0.7.4] - 2026-01-29

### Bug Fixes

- **Terminal scroll**: Fixed user scroll detection during output (FLO-220)
  - v0.7.3's `pendingWrites` guard blocked ALL scroll events during output
  - Now uses direction detection: scroll UP (viewportY decreases) = detach, at bottom = reattach
  - Removes stale state capture - callback checks current `stickyBottom` value

---

## [0.7.3] - 2026-01-29

### Fixed

- **Terminal scroll behavior** (FLO-220, PR #106): Fixed two scroll issues that became more frequent with recent Claude Code updates:
  - Random scroll jumps to top during heavy output
  - Mouse scroll not quite reaching bottom (requiring arrow key)

  New sticky-bottom mode tracks user scroll intent - scrolling up detaches from output, scrolling to bottom reattaches. Added `Cmd+End` / `Ctrl+End` shortcut to explicitly scroll to bottom and reattach.

---

## [0.7.2] - 2026-01-28

### Features

- **Split Ollama model configuration** - Configure separate models for ctx:: sidebar parsing (`ctx_model`) and `/send` conversations (`send_model`) in config.toml. Inline override with `/send:model-name` syntax. (FLO-216, #105)

### Documentation

- Added `/send` command guide (`docs/guides/SEND.md`)
- Added `send` topic to help handler

### Maintenance

- Fixed unused import lint warning in workspace.rs

---

## [0.7.1] - 2026-01-27

### Bug Fixes

- **Outliner**: Back navigation (`⌘[`) now restores focus to the exact block you navigated from, not just the zoom level (FLO-211, PR #104)
  - Added `originBlockId` capture to `zoomTo()` API
  - `expandAncestors()` ensures restored block is visible even if parent was collapsed
  - Fixed memory leak in `historyNavigationPending` Set cleanup

---

## [0.7.0] - 2026-01-27

### New Features

- **Navigation history** (`⌘[`/`⌘]`) - Browser-style back/forward navigation in the outliner (FLO-180, PR #103)
  - Each pane maintains its own navigation history (up to 50 entries)
  - History skips deleted blocks automatically
  - History persists across sessions
  - Split panes start with empty history (like browser tab duplication)

---

## [0.6.2] - 2026-01-27

### Bug Fixes

- **Nested zoom navigation**: Fixed keyboard navigation after zooming into a child block. Changed `blockId: props.id` to `getBlockId: () => props.id` to ensure event handlers read fresh props when SolidJS updates the same component instance. (PR #102)

### Documentation

- Added SolidJS stale closure pattern to rules documentation (`solidjs-patterns.md`, `do-not.md`) to prevent similar bugs.

---

## [0.6.1] - 2026-01-27

### Bug Fixes

- **Outliner**: Scroll viewport to keep focused block visible during keyboard navigation (ArrowUp/ArrowDown)

---

## [0.6.0] - 2026-01-27

### New Features

- **Scoped expand keybinds** (PR #101) - `⌘E` now expands focused subtree only instead of entire outline
  - Fixes jank with large outlines (2,774+ root blocks)
  - `⌘⇧E` provides global expand (all roots, capped at depth 3)
  - `⌘⇧0` adds "homebase reset" to collapse all to `initial_collapse_depth`
  - Config is now cached at startup for keybind access

- **Block timestamps in API** (PR #100) - `createdAt`/`updatedAt` exposed in floatty-server `/api/v1/blocks` response
  - Enables age-based queries and sorting

### Documentation

- Added "Permeable Boundaries" section to PHILOSOPHY.md (architectural principle for context boundaries)

---

## [0.5.1] - 2026-01-26

### Bug Fixes

- **Outliner**: Fixed backspace at blank lines incorrectly triggering block merge - now correctly uses absolute offset (`getOffset() === 0`) instead of DOM position (`isAtStart()`) for merge decisions
- **Outliner**: Fixed ArrowUp/Down navigation when cursor is surrounded by only newlines (browser can't navigate, now handled manually)
- **Outliner**: Fixed IndexSizeError crashes by adding rangeCount guards and offset clamping in cursor utilities
- **Outliner**: Blocks with expanded children can now merge (children lifted to siblings); collapsed children still protected

### Performance

- **Terminal**: Batched clipboard IPC calls (3 → 1) reducing paste latency

### Internal

- Wired `useBlockInput` hook as single source of truth for keyboard handling (~400 lines removed from BlockItem.tsx)
- Added `liftChildrenToSiblings()` to block store for merge operations
- Updated contenteditable-patterns.md with §7-10 documenting cursor edge cases

---

## [0.5.0] - 2026-01-24

### Fixed

- **Content sync race condition** - Added `hasLocalChanges` dirty flag to prevent remote updates from overwriting pending debounced edits (FLO-197 P0)
- **Focus race on pane click** - `OutlinerPane.focus()` now respects `focusedBlockId` instead of always focusing first block (FLO-197 P1)
- **Sync health false positives** - Replaced broken hash comparison with block count (Y.Doc encoding includes client IDs, so hashes never match) (FLO-197 P4)
- **Startup freeze with large outlines** - Gate render on config loaded to apply collapse BEFORE mounting 10K+ BlockItem components (FLO-197 P5)
- **Version sync** - `tauri.conf.json` was stuck at 0.2.3, now properly synced

### Added

- **Configurable collapse depth on split** - New config `split_collapse_depth` to force-collapse blocks deeper than N when splitting panes (FLO-197 P3)
- **Initial collapse depth** - New config `initial_collapse_depth` for controlling expansion on app startup
- **Scroll-to-focus on split** - New pane centers the focused block instead of starting at scroll top 0
- **Y.Doc garbage collection** - Enabled `gc: true` to prevent tombstone accumulation

### Documentation

- Added AGENTS.md for multi-agent floatty development patterns
- Added floatty-server query reference to CLAUDE.md
- Updated `/floatty:release` command to sync all THREE version files (package.json, Cargo.toml, tauri.conf.json)

---

## [0.4.4] - 2026-01-23

### Bug Fixes

- **IndexedDB backup migration** (PR #97) - Fixed Y.Doc backup storage
  - Migrated from localStorage (5MB limit) to IndexedDB (50MB+)
  - Prevents silent data loss when Y.Doc exceeds localStorage quota
  - Automatic migration: existing localStorage backups move to IndexedDB on first access
  - Added error logging for database initialization failures
  - Added objectStore guard for future version upgrades

### Documentation

- Updated CLAUDE.md logging section (debug logs in dev scripts)
- Clarified hasLocalBackup() docstring (only checks localStorage, not IndexedDB)

---

## [0.4.3] - 2026-01-18

### New Features

- **FLOATTY_DATA_DIR** (PR #95) - Multi-workspace data isolation
  - All paths derive from single `FLOATTY_DATA_DIR` env var (default: `~/.floatty`)
  - Dev builds default to `~/.floatty-dev` for automatic isolation
  - Config-driven `workspace_name` shows in title bar
  - Config-driven `server_port` for per-workspace server isolation
  - New `paths.rs` module centralizes path resolution

- **/floatty:float-loop** - Generic work track command for Claude Code skills
  - Session-type-aware Stop hook
  - PostToolUse lint + Stop validation hooks

### Infrastructure

- Enhanced title bar: `floatty (dev) - workspace v0.4.3 (abc1234)`
- Git commit embedding via `vergen-gix` at build time
- `serial_test` crate for env mutation test isolation

### Documentation

- Updated CLAUDE.md with DataPaths architecture, FLOATTY_DATA_DIR usage
- Updated README.md with Multi-Workspace Support section

---

## [0.4.2] - 2026-01-15

### New Features

- **filter:: handler** (PR #94, FLO-170) - Dynamic query blocks that filter outline by markers
  - Query syntax: `filter:: project::floatty status::active`
  - Filter functions: `include(marker)`, `exclude(marker)`, `children()`
  - Live results panel with match highlighting, click to navigate
  - Respects zoom scope - searches within focused subtree

- **help:: handler** (PR #94) - Documentation viewer in outliner
  - Usage: `help:: filter`, `help:: keyboard`, `help:: handlers`
  - Hierarchical markdown parsing preserves heading structure
  - Results insert at top for quick iteration

### Bug Fixes

- **Path traversal vulnerability** (PR #94) - Fixed `read_help_file` to use `starts_with()` instead of `contains()` for proper path validation
- **Verbose logging** (PR #94) - Changed metadata extraction `info!` logs to `debug!` to reduce noise

### Documentation

- Added FILTER.md comprehensive guide (247 lines) covering query syntax, functions, and use cases
- Updated CLAUDE.md keyboard table with command block terminology
- Added inline parsing lesson to do-not.md rules (hasInlineFormatting gatekeeper)

### Tests

- 475 tests (up from 420 in 0.4.1)
  - 55 new filterParser tests (parsing, escaping, complex queries)
  - 4 new inlineParser tests (hasInlineFormatting gatekeeper coverage)

---

## [0.4.1] - 2026-01-14

### New Features

- **/send handler** (PR #88) - Execute blocks with LLM using conversation context
  - Walks zoomed subtree to build multi-turn conversation (## user / ## assistant markers)
  - Respects zoom scope - sends only the focused context, not full document
  - Hook architecture with `execute:before` / `execute:after` lifecycle

- **Executor system** - Unified block execution with typed actions
  - Actions: `execute`, `stream`, `abort` for different execution modes
  - Origin tracking: `Origin.Executor` for executor-generated changes
  - Hook support for validation, logging, transformation

- **Event system** - Two-lane architecture for Y.Doc changes
  - `EventBus` (sync) - Immediate UI updates, validation
  - `ProjectionScheduler` (async) - Batched index writes with 2s flush interval
  - `EventFilters` - Composable predicates for handler targeting

- **Hook registry** - Priority-ordered hooks with error isolation
  - Type-safe registration by event type (block lifecycle, execution)
  - `HookContext` with abort capability, shared data passing
  - HMR-safe with `import.meta.hot.dispose()` cleanup

### Bug Fixes

- **Multi-line cursor offset** (PR #88) - Extended contentEditable patterns rule with `<div>` boundary edge cases
- **HMR timer cleanup** - Added dispose handlers to ProjectionScheduler singleton

### Documentation

- Updated solidjs-patterns.md with store proxy clone pattern
- Updated ydoc-patterns.md with event timing guidelines
- Added contenteditable-patterns.md edge case documentation

### Tests

- 420 tests (up from 318 in 0.4.0)
  - 19 sendContextHook tests (zoom scoping, multi-turn, implicit first turn)
  - 13 executor tests (lifecycle hooks, abort handling)
  - 18 eventBus tests (subscription, filtering, error isolation)
  - 19 projectionScheduler tests (batching, flush, HMR)
  - 26 hookRegistry tests (priority ordering, context passing)

---

## [0.4.0] - 2026-01-13

### New Features

- **search:: handler** - Inline search results view with score-ranked hits, clickable navigation to blocks
- **pick:: handler** - Interactive fzf-style fuzzy picker for block selection (uses $tv pattern)
- **Multi-turn conversations** (FLO-200) - Role inference (user/assistant/system prefixes), context directives, conversation tree walking for ai:: blocks
- **JS console logging** - `console.log/warn/error` bridged to Rust tracing via `[target]` prefix parsing

### Bug Fixes

- **ContentEditable cursor offset** (PR #84) - Fixed multi-line offset calculation to count `<div>` boundaries as newlines, preventing block split corruption
- **UTF-8 truncation** - Search results use char-safe truncation (200 chars) instead of byte slicing
- **CSS variables** - Added `--color-bg-secondary`, `--color-bg-hover`, `--color-fg-dimmed` for search UI theming
- **Picker resize** - Added ResizeObserver for dynamic terminal sizing in picker overlay

### Documentation

- Added FLO-200 multi-turn conversation architecture spec
- Added contentEditable patterns rule (cursor offset edge cases)

---

## [0.3.2] - 2026-01-13

### Bug Fixes

- **HMR cleanup**: Added `import.meta.hot.dispose()` handlers across 5 modules to prevent state accumulation during development hot reload (useSyncedYDoc, useSyncHealth, handlers, httpClient, terminalManager)
- **Sync hygiene**: Fixed race condition in httpClient initialization; wrapped terminalManager dispose in try/finally; fixed TypedArray boundary issue in useSyncHealth hash computation
- **Handler registration**: Added guard against duplicate handler registration; added `.catch()` on async handler executions
- **UI**: Removed font-size transition on ctx:: tags

### New Features

- **Dev workflow commands**: Added `/floatty:plan`, `/floatty:pr-check`, `/floatty:sweep` slash commands encoding six-pattern bug taxonomy for systematic development hygiene

## [0.3.1] - 2026-01-12

### Bug Fixes

- **WebSocket reconnect race condition** (FLO-152, PR #82) - Fixed race where incoming WS messages during reconnect could be processed before full state sync completed, causing stale overwrites. Added message buffering during reconnect and connection ID guards against stale async handlers.

## [0.3.0] - 2026-01-11

### Search Infrastructure (Work Units 0.x - 3.6)

Complete Tantivy-backed search system with hook-based metadata extraction.

#### Architecture
- **Hook system** (Work Units 1.5.x) - Origin-filtered hook registry for block change events
- **Change emitter** (Work Units 1.x) - Y.Doc observer wrapper with debouncing and deduplication
- **Writer actor** (Work Unit 3.2) - Async Tokio actor for non-blocking Tantivy index writes
- **Search service** (Work Unit 3.4) - HTTP endpoint with block ID + score results

#### Search Features
- **Marker extraction** (Work Unit 3.6) - Extracts `ctx::`, `project::`, `mode::`, `issue::` from block content
- **Wikilink indexing** - `[[Page Name]]` and `[[Page|Alias]]` extracted to `outlinks` field
- **Full-text search** - Tantivy query syntax on content and extracted markers
- **API endpoints** - `/api/v1/search?q=...` returns ranked block IDs

#### Metadata Schema
```rust
BlockMetadata {
    markers: Vec<Marker>,      // ctx::, project::, mode::, issue::
    outlinks: Vec<String>,     // [[wikilink]] targets
    has_markers: bool,         // fast filter
}
```

### Backend Modularization (PR #76)

- **Services pattern** - Business logic extracted from Tauri commands to `src-tauri/src/services/`
- **Thin command adapters** - Tauri commands delegate to services for testability
- **Handler registry** - Consolidated block type executors (`sh::`, `ai::`, `daily::`)

### Frontend Handler Registry (PR #77)

- **Unified handler API** - `executeHandler(type, block, context)` pattern
- **Removed legacy handlers** - Consolidated `ai.ts` and `sh.ts` into registry

### Structured Logging (PR #75)

- **tracing migration** - Replaced tauri-plugin-log with tracing + tracing-subscriber
- **JSON log format** - `~/.floatty/logs/floatty-YYYY-MM-DD.jsonl`
- **Queryable with jq** - Structured fields for duration, targets, errors

### Bug Fixes

- **Text selection bleeding** (FLO-145, PR #74) - Selection no longer crosses block boundaries
- **Cursor/text sync** (PR #73) - Focus-based ctx tag styling fixed
- **CSS containment revert** (PR #71) - Removed rules causing text to vanish
- **10 code review issues** (PR #72) - Address findings from 6-agent parallel review

### Documentation

- **Architecture snapshot** (PR #78) - 15k line comprehensive pattern analysis
- **Search work units** - Detailed specs for all 20+ implementation units
- **Handoff documents** - Per-unit completion notes with test evidence

### Developer Experience

- **search-test.sh** - Helper script for testing search API
- **318 tests** - Up from 283 in 0.2.x

### Linear Tickets Closed
FLO-145, FLO-146

---

## [0.2.3] - 2026-01-06

### Ephemeral Panes / Quick Peek (FLO-136, PR #64)

Preview panes that auto-replace until you engage with content.

#### Click Behaviors
- **Opt+Click** on [[wikilink]] → ephemeral horizontal split (replaces previous)
- **Shift+Opt+Click** → ephemeral vertical split
- **Cmd+Click** → permanent horizontal split (unchanged)
- **Cmd+Shift+Click** → permanent vertical split (unchanged)

#### Pin Triggers (ephemeral → permanent)
- Typing in the pane
- 5-second timeout

#### Visual
- Dashed border indicates ephemeral state
- Stronger accent when active

### Performance

- **CSS containment** - `content-visibility: auto` on block children, `contain: layout style paint` on blocks
- Large documents significantly faster (poor man's virtualization)

### Developer Experience

- **Window title** shows `(dev)` or `(release)` build mode
- No more guessing which floatty instance you're testing

### Documentation

- **FLO-137 spec** - Pinned panes design document for future implementation

### Linear Tickets Closed
FLO-135, FLO-136

---

## [0.2.1] - 2026-01-03

### Keyboard Navigation & Selection (PR #54)

Major improvements to outliner keyboard behavior and visual feedback.

#### Bug Fixes
- **Backspace merge** - Fixed cursor detection using `cursor.isAtStart()` instead of unreliable `getOffset()===0`
- **Cmd+A selection** - First press selects text, second press selects block (progressive expansion)
- **Shift+Arrow** - New 'anchor' mode properly selects starting block on first press

#### Visual Distinction
- Editing blocks show accent border (`:focus-within`)
- Selected blocks show cyan border (`.block-selected`)
- Clear separation prevents confusion between states

#### New Features
- **⌘⇧M Export** (FLO-102) - Export outline to clipboard as markdown
- Clipboard error handling with graceful fallback (#55)

### Outliner Improvements (PR #50, #51)

- **Block movement** (FLO-75) - ⌘⇧↑/↓ to move blocks within siblings
- **Pane state cloning** (FLO-77) - Clone-on-split preserves focused block + zoom
- **Progressive expand/collapse** (FLO-66) - ⌘E/⌘⇧E with depth sequences
- **Extended Cmd+A** (FLO-95) - Selection includes collapsed subtrees, 10 indent levels

### Sync Reliability (PR #48, #49)

- **Ref-counted handlers** - Fixed multiple handlers per pane causing 3x network traffic
- **Backup preservation** - Partial sync failures no longer clear local backup
- **Echo prevention** - Transaction ID tracking prevents broadcast loops
- **WS reconnect sync** - Proper state fetch after reconnection

### Backend Cleanup (PR #53)

- Modularized `lib.rs` (1141→648 lines)
- Extracted `config.rs` (154 lines) + `server.rs` (327 lines)
- Renamed `CtxDatabase` → `FloattyDb` (reflects actual scope)

### Linear Tickets Closed
FLO-66, FLO-75, FLO-77, FLO-95, FLO-102

---

## [0.2.0] - 2026-01-03

### Headless Architecture (PR #47)

Major architectural shift: floatty is now headless-first. The block store lives in a standalone HTTP server.

#### floatty-core Extraction
- Extracted `floatty-core` crate with Block types, YDocPersistence, YDocStore
- Schema v2: Nested Y.Map structure for proper CRDT sync
- Tauri commands are now thin wrappers over floatty-core

#### floatty-server (HTTP API)
- Standalone Axum HTTP server at `127.0.0.1:8765`
- REST endpoints: `/blocks` (GET/POST), `/blocks/:id` (GET/PATCH/DELETE)
- Y.Doc sync: `/state`, `/update`, `/health`
- API key authentication via Bearer token
- WebSocket broadcast for realtime sync across clients

#### UI Wiring
- Frontend uses HTTP client instead of Tauri IPC for Y.Doc sync
- Server auto-spawned by Tauri on app start
- Blocks created via curl appear instantly in UI

#### Testing
- 9 API tests for floatty-server (Axum tower ServiceExt pattern)
- 283 frontend tests (Vitest)
- 13 floatty-core tests

#### Bug Fixes
- Fixed Axum route syntax (`:id` not `{id}`)
- Fixed tilde expansion in `watch_path` config
- Fixed Ollama endpoint config (pointed to wrong host)

### Linear Tickets Closed
FLO-87 (External write API)

---

## [0.1.0] - 2025-12-28

### 10-Day Sprint (Dec 19-28) - Foundation to Usable

This sprint took floatty from "barely works" to "daily driver capable" - a terminal emulator with integrated outliner and consciousness siphon.

### Core Infrastructure (Week 1)

- **Multi-tab terminals** (PR#1) - Independent PTY per tab with platform-aware keybinds
- **Split pane support** (PR#2) - Focus navigation (⌘⌥Arrow), draggable resize handles
- **SolidJS migration** (PR#3) - Moved from React to SolidJS for better reactivity

### Outliner Features (Week 2)

- **Block zoom** (FLO-40, PR#9) - Cmd+Enter focuses on subtree with breadcrumb navigation
- **Keybind unification** (PR#11) - Centralized keybind system, platform-aware
- **Inline formatting** (FLO-51, PR#17) - Two-layer overlay for bold/italic/code styling
- **Markdown parser** (FLO-42, PR#16) - Auto-formats command output into block hierarchy
- **Multi-block selection** (FLO-74, PR#30) - Click, Shift+Click, Cmd+Click, Shift+Arrow
- **Progressive Cmd+A** - Select block → heading scope → all (tinykeys sequences)

### Terminal Features

- **OSC 133/1337 integration** (FLO-54/55, PR#20) - Shell integration with status bar
- **Terminal config** (PR#19) - Shift+Enter, clipboard paste, new icon
- **Scroll position fix** (FLO-88, PR#27) - Preserved during pane resize

### Persistence & State

- **Y.Doc append-only** (FLO-61, PR#21) - CRDT deltas instead of full doc writes
- **Y.Doc singleton** (PR#25) - Fixed lifecycle for outliner persistence
- **Workspace persistence** (FLO-81, PR#26) - Layout, split ratios, pane types restored
- **Close button fix** (FLO-85) - Red X works after onCloseRequested change

### Theming

- **Theme system** (FLO-50, PR#15) - 5 bundled themes, hot-swap via ⌘;

### Testing & Architecture

- **Testing infrastructure** (FLO-73, PR#23-24) - Store-first testability, mock factories
- **Keyboard architecture refactor** - 5-layer architecture documented, BlockContext type
- **268 tests** - Up from 0 at project start

### Bug Fixes

- **Split pane block structure** (FLO-41) - No longer reverts to single text block
- **ArrowDown navigation** (FLO-92, PR#29) - Creates trailing block at tree end
- **Focused pane targeting** (FLO-43, PR#12) - Split/close operates on focused pane
- **Shift+Arrow selection** - Works regardless of cursor position
- **Markdown export** - No longer double-adds prefixes

### PRs Merged

29 PRs merged in 10 days:
- #1-3: Tabs, splits, SolidJS
- #6-9: Context sidebar, identity fixes, block zoom
- #11-17: Keybinds, panes, resize, themes, markdown, formatting
- #19-27: Terminal, persistence, testing
- #28-29: UX fixes, navigation
- #30: Multi-select (in progress)

### Linear Tickets Closed

FLO-6, FLO-7, FLO-40, FLO-41, FLO-42, FLO-43, FLO-50, FLO-51, FLO-54, FLO-55, FLO-60, FLO-61, FLO-73, FLO-81, FLO-85, FLO-88, FLO-92

---

*floatty: Terminal + Outliner + Consciousness Siphon*
