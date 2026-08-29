# Dead-Arch Removal + Backlinks Building Blocks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rip out `filter::` and confirmed-dead architecture (Phase 0), then build the two reusable backlinks primitives — the U1 canonicalizing reverse index (P2) and the U3 BlockRefList row renderer (P3) — that "better backlinks" and, later, transclusion compose from.

**Architecture:** Rip-and-replace, not refactor, per the merged design. Every view is `PREDICATE × SCOPE × RENDER`; `filter::`/`LinkedReferences` die because each hand-fused all three. The backlinks index is **client-only, derived, in-memory, NEVER persisted** — rebuilt off `observeDeep` (mark-dirty → rAF-coalesced → swap-signal), not synchronously and not via EventBus (the remote slim path skips emission > 50 events, so an EventBus-fed index goes silently stale). Main-targeted PRs, bundled aggressively; CodeRabbit + a local `/code-review` do the reviewing (no per-step human gating).

**Tech Stack:** SolidJS (fine-grained reactivity = the invalidation), Yjs/Y.Doc + Yrs, TypeScript, Rust (`BlockType` is a closed union generated from Rust via ts-rs), Vitest + @solidjs/testing-library.

**Spec:** `apps/floatty/docs/design/2026-08-11-backlinks-drawer.md` (D1–D13, U1–U5 unit specs — THE source for Phase 1) and `apps/floatty/docs/design/2026-08-17-projection-surfaces-spine.md` (the P1–P5 primitive grammar). Track memory: `.float/work/backlinks-drawer/STATE.md`. The plan argues from these; executors read both.

## Global Constraints

- **`BlockType` is a closed union generated from Rust.** Never add/remove a member by editing only TypeScript. Order for removal: strip all TS usages first (keeps the tree green), remove the Rust `block.rs` variant last, then regenerate: `cd apps/floatty/src-tauri && cargo run --bin ts-gen`. The closed union means any missed `=== 'filter'` surfaces as a type error after regen — a useful backstop. (`.claude/rules/adding-block-types.md`)
- **No third wikilink parser.** U1's nested extractor EXTENDS `wikilinkUtils.ts`; the outlinks hook and the index must share one extractor (symmetry-check). (`.claude/rules/symmetry-check.md`)
- **Tests use synthetic PII-free fixtures.** The prototype ran on real data; tests must not. Use `Demo Alice`, synthetic UUIDs `00000000-0000-4000-8000-0000000000NN`. (`.claude/rules/test-fixtures-no-pii.md`)
- **Completion gate per `.claude/rules/lint-discipline.md` §4** — quote actual stdout: `pnpm lint --force` (0/0), `pnpm --filter float-pty typecheck` (clean), `pnpm --filter float-pty test` (N/N), and for Rust-touching tasks `cd apps/floatty/src-tauri && cargo fmt --all -- --check` / `cargo clippy --workspace --all-targets` (2 carve-out warnings) / `cargo test --workspace`.
- **Rust tests:** `cd apps/floatty/src-tauri && cargo test -p float-pty -- <name>` (package is `float-pty`, filter after `--`).
- **Runtime verification** in the dev app (port 33333) per unit with UI. Dev-mode gotcha: `tauri:dev` does NOT rebuild `floatty-server` — run `cargo build -p floatty-server` first if server code changed (Phase 0/1 don't touch it).
- **`architecture-reviewer` gate** runs before U1's `wikilinkUtils.ts` extractor change lands (the one genuinely cross-cutting shared-parser edit).

---

## Phase 0 — Clear the deck (dead-arch removal)

One "clear the deck" main-targeted PR. Rip `filter::` + confirmed-dead siblings (`web`/`link::`, `dispatch` block types; `src/lib/outliner/`; `doors/render.zip`; `doors/render-test/`) and re-anchor the rule docs. Green-tree stepped internally: TS deletes → Rust enum + ts-gen regen last. All file:line refs verified by reconnaissance sweep 2026-08-29.

### Task 0.1: Branch + land the plan

**Files:**
- Create: this plan file (already written)

- [ ] **Step 1: Branch from main**

```bash
cd /Users/evan/projects/_float/float-substrate/floatty
git checkout -b feat/flo-890-deadarch-removal main
```

- [ ] **Step 2: Commit the plan**

```bash
git add apps/floatty/docs/superpowers/plans/2026-08-29-deadarch-and-backlinks-buildingblocks.md
git commit -m "docs(plan): dead-arch removal + backlinks building blocks (FLO-890/FLO-440)"
```

### Task 0.2: Delete the filter:: view + parser (clean whole-file deletes)

**Files:**
- Delete: `apps/floatty/src/components/views/FilterBlockDisplay.tsx`
- Delete: `apps/floatty/src/lib/filterParser.ts` (only importer is FilterBlockDisplay — confirmed)
- Delete: `apps/floatty/src/lib/filterParser.test.ts`
- Delete: `apps/floatty/docs/guides/FILTER.md`

- [ ] **Step 1: Delete the four files**

```bash
git rm apps/floatty/src/components/views/FilterBlockDisplay.tsx \
       apps/floatty/src/lib/filterParser.ts \
       apps/floatty/src/lib/filterParser.test.ts \
       apps/floatty/docs/guides/FILTER.md
```

- [ ] **Step 2: Verify no stragglers import them**

Run: `grep -rn "FilterBlockDisplay\|filterParser" apps/floatty/src` — Expected: only the mount import in `BlockItem.tsx` (removed in Task 0.3) remains.

### Task 0.3: Strip the filter:: mount + prefix detection + classMap

**Files:**
- Modify: `apps/floatty/src/components/BlockItem.tsx` — remove `import { FilterBlockDisplay }` (`:23`), the `<Show when={block()?.type === 'filter'}>…</Show>` branch (`:1192-1195`), and the stale "filter" mention in the output-blocks comment (`:1007`)
- Modify: `apps/floatty/src/lib/blockTypes.ts:137` — remove `if (lower.startsWith('filter::')) return 'filter';`
- Modify: `apps/floatty/src/components/BlockDisplay.tsx:756-757` — remove the `'filter-function'` / `'filter-prefix'` classMap entries
- Modify: `apps/floatty/src/lib/handlers/help.ts` — remove `filter` from the topics comment (`:6`) and the `filter: 'docs/guides/FILTER.md'` entry (`:17`)
- Modify: `apps/floatty/src/components/BlockOutputView.tsx:2` — fix the stale comment that claims it renders filter

- [ ] **Step 1: Make the edits above** (each is a deletion of the named lines; no new code)

- [ ] **Step 2: Typecheck to surface any missed `'filter'` reference**

Run: `pnpm --filter float-pty typecheck` — Expected: still references `'filter'` in the generated union (removed in Task 0.7), but no dangling imports. Fix any dangling reference the compiler names.

### Task 0.4: Excise filter:: from the shared inline parser (THE TRAP)

The `filter-function`/`filter-prefix` tokens are woven into shared boolean chains — miss one reference and it's a compile error. Surgical, not a file delete.

**Files:**
- Modify: `apps/floatty/src/lib/inlineParser.ts` — remove token union members `'filter-function' | 'filter-prefix'` (`:13`), the `functionName` field comment (`:23`), `hasFilterPrefixPattern()` (`:51-56`), `hasFilterFunctionPattern()` (`:69-…`), the `filter::` prefix tokenization branch (`:661-685`), the `include(…)`/`exclude(…)` function tokenization branch (`:704-716`), and EVERY reference in the shared chains: `hasInlineFormatting()` OR-chain (`:799-800`), the early-return guard (`:958`), the whole-line precedence branch (`:964`)
- Modify: `apps/floatty/src/lib/inlineParser.test.ts:597-667` — delete the filter-function / filter-prefix test cases

- [ ] **Step 1: Remove the two `has*Pattern` functions and both tokenization branches**

- [ ] **Step 2: Remove every reference to `hasFilterPrefixPattern`/`hasFilterFunctionPattern` and the two token type names from the boolean chains** (`:799-800`, `:958`, `:964`) and the union (`:13`)

- [ ] **Step 3: Delete the matching tests** (`inlineParser.test.ts:597-667`)

- [ ] **Step 4: Run the inline-parser tests**

Run: `pnpm --filter float-pty test inlineParser` — Expected: PASS (no `filter` references, no missing-symbol errors).

### Task 0.5: Remove the filter:: CSS

**Files:**
- Modify: `apps/floatty/src/index.css` — delete `.block-display .md-filter-function` (`:1301-1306`), `.block-display .filter-inline-prefix` (`:1368-1370`), and the full `.filter-block-display` stylesheet (`:2737-2934`, ~27 rules, ends before `.table-block-container` at `:2935`)

- [ ] **Step 1: Delete the three CSS regions**

- [ ] **Step 2: Grep for orphaned filter classes**

Run: `grep -n "filter-block-display\|md-filter-function\|filter-inline-prefix" apps/floatty/src/index.css` — Expected: no matches.

### Task 0.6: Remove the `web`/`link::` and `dispatch` block-type frontend usages

Both are declared-but-dead (no handler, no CSS, no `type ===` consumer). Frontend first; Rust variants come out in Task 0.7 with filter's.

**Files:**
- Modify: `apps/floatty/src/lib/blockTypes.ts` — remove the `web`/`link::` parse line (`:129`) and the `dispatch` parse line (`:128`)
- Modify: `apps/floatty/src/lib/markdownExport.ts:81` — remove `case 'dispatch'` from the prefix-passthrough group (falls through to default cleanly)

- [ ] **Step 1: Remove the two parse lines + the markdownExport dispatch case**

- [ ] **Step 2: Grep for other consumers**

Run: `grep -rn "'web'\|'link'\|'dispatch'\|web::\|link::\|dispatch::" apps/floatty/src --include=*.ts --include=*.tsx | grep -v "\.test\."` — Expected: only aspirational comments (`WorkspaceContext.tsx:316`, `useBlockStore.ts:59,80`) — remove those comment mentions too so nothing implies these are coming.

### Task 0.7: Delete orphan directories + artifacts

**Files:**
- Delete: `apps/floatty/src/lib/outliner/` (whole dir — `index.ts`, `types.ts`, `README.md`; zero importers, defines a dead second BlockType union)
- Delete: `apps/floatty/doors/render.zip` (stale 44 KB pre-extraction artifact)
- Delete: `apps/floatty/doors/render-test/` (test-only door; `deploy-doors.sh` skips it)
- Modify: `apps/floatty/scripts/deploy-doors.sh` — remove `render-test` from the `SKIP=(...)` list (`:27`) and the doc-comment line (`:14`) now that the dir is gone

- [ ] **Step 1: Delete the dirs + artifact and update the skip list**

```bash
git rm -r apps/floatty/src/lib/outliner apps/floatty/doors/render-test apps/floatty/doors/render.zip
```

- [ ] **Step 2: Edit `deploy-doors.sh`** to drop `render-test` from `SKIP` and the comment.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter float-pty typecheck` — Expected: no import errors from the deleted `lib/outliner` barrel (real callers import from true homes, per sweep).

### Task 0.8: Remove the Rust `BlockType` variants + regenerate

Do the Rust enum LAST so the tree stayed green through the TS edits. Removes `Filter`, `Web`, `Dispatch`.

**Files:**
- Modify: `apps/floatty/src-tauri/floatty-core/src/block.rs` — remove `Filter` variant + doc (`:52-53`), its `as_str` arm (`:86`), its parse arm (`:177-178`); remove the `Web` variant (`:29`) + parse arm (`:159`); remove the `Dispatch` variant (`:27`) + parse arm (`:156`)
- Regenerated: `apps/floatty/src/generated/BlockType.ts` and `apps/floatty/src-tauri/floatty-core/bindings/BlockType.ts` (do not hand-edit — `ts-gen` rewrites them)

- [ ] **Step 1: Remove the three variants + their `as_str`/parse arms from `block.rs`**

- [ ] **Step 2: Regenerate the TS union**

```bash
cd apps/floatty/src-tauri && cargo run --bin ts-gen
```

- [ ] **Step 3: Confirm `"filter"`, `"web"`, `"dispatch"` are gone from both generated copies**

Run: `grep -c 'filter\|web\|dispatch' apps/floatty/src/generated/BlockType.ts apps/floatty/src-tauri/floatty-core/bindings/BlockType.ts` — Expected: 0.

- [ ] **Step 4: Typecheck — the closed union now surfaces any missed `=== 'filter'`**

Run: `pnpm --filter float-pty typecheck` — Expected: clean. Any error names a straggler; fix it.

### Task 0.9: Re-anchor the rule docs from filter:: to artifact::

Removing filter guts the docs that use it as THE sibling-view reference impl. Repoint to `artifact::`.

**Files:**
- Modify: `.claude/rules/adding-block-types.md` — §4 "Reference Implementation: filter::" and every `filter::`/`FilterBlockDisplay`/`blockTypes.ts:137`/`BlockItem.tsx:1072` citation → the `artifact::` sibling-view equivalents (verify artifact's actual mount line)
- Modify: `.claude/rules/pattern-fit-check.md` — the `FilterBlockDisplay` worked-example throughout (`:25,:38,:63-89`) → `artifact::`/`ArtifactBlockDisplay` (or the closest live sibling-view; verify)
- Modify: `apps/floatty/docs/BLOCK_TYPE_PATTERNS.md` — same re-anchor

- [ ] **Step 1: Rewrite the three docs to reference `artifact::`** (read the artifact block's actual definition/mount first so the new citations are accurate, not drifted)

- [ ] **Step 2: Grep the rules for stale filter references**

Run: `grep -rn "filter::\|FilterBlockDisplay" .claude/rules apps/floatty/docs/BLOCK_TYPE_PATTERNS.md` — Expected: no live references (historical CHANGELOG entries excluded).

### Task 0.10: Completion gate + PR

- [ ] **Step 1: Run the full gate and QUOTE the output**

```bash
pnpm lint --force
pnpm --filter float-pty typecheck
pnpm --filter float-pty test
cd apps/floatty/src-tauri && cargo fmt --all -- --check && cargo clippy --workspace --all-targets && cargo test --workspace
```

Expected: lint 0/0, typecheck clean, vitest N/N, fmt exit 0, clippy 2 carve-out warnings, cargo test all passing.

- [ ] **Step 2: Runtime smoke in dev app (port 33333)**

Confirm the app boots, a normal block renders, and a legacy `filter::`-content block now renders as inert text (not a crash). `web::`/`dispatch::`/`link::` likewise inert.

- [ ] **Step 3: Commit + push + PR**

```bash
git add -A && git commit -m "chore(dead-arch): remove filter:: + web/link::/dispatch types, outliner/ scaffolding, render.zip, render-test (FLO-890)"
git push -u origin feat/flo-890-deadarch-removal
gh pr create --base main --title "chore(dead-arch): rip filter:: + confirmed-dead siblings (FLO-890)" --body "<summary of the cut-list + the ts-gen regen + doc re-anchor; note the inlineParser surgical excise; verification quoted>"
```

- [ ] **Step 4: Local `/code-review` + let CodeRabbit review; resolve threads via `/resolve-pr-comments`; merge when green.**

---

## Phase 1 — Backlinks building blocks (P2 index + P3 renderer)

Executed via the `/floatty:loop backlinks-drawer` track. The merged design doc (`2026-08-11-backlinks-drawer.md`) is the exhaustive spec — D1–D13 decisions, U1–U5 unit specs, reference-impl pointers to the live prototype, and per-unit verification gates. This section sequences the slices and carries the load-bearing implementation invariants inline; expand each slice into bite-sized TDD tasks at execution time against the design doc's unit spec. **Slice order and PR grouping are the design's, not re-derived here.**

The four gates from the spine that bound Phase 1: U1 is client-only derived state (no gate); block-id targets need canonical id resolution (carried in U1 below); marker-predicate and transclusion gates (FLO-374 effective markers, ID tombstone/alias, derived-vs-authored) are **out of Phase 1 scope** — they gate the later compositions, not backlinks-of-links.

### Slice 1 — U1: canonicalizing reverse index (`src/lib/backlinkIndex.ts`) + nested extractor

**This is P2 — the first reusable building block.** `architecture-reviewer` gate runs before the `wikilinkUtils.ts` extractor change lands.

**Files:**
- Create: `apps/floatty/src/lib/backlinkIndex.ts`
- Create: `apps/floatty/src/lib/backlinkIndex.test.ts`
- Modify: `apps/floatty/src/lib/wikilinkUtils.ts` — add a `mode: 'outer' | 'nested'` param to the shared extractor (`outer` = today's one-target-per-token first-segment behavior; `nested` = every nesting level of `[[a [[b]] c]]`)
- Modify: `apps/floatty/src/lib/wikilinkUtils.test.ts` — nested fixtures + `outer`-mode byte-identical compatibility fixtures

**Interfaces (Produces — later slices consume these):**
- `buildBacklinkIndex(blocks): BacklinkIndex` — `index.referencing(targetKey: string): string[]` (source block ids), `index.ambiguousTargets: string[]` (dropped prefix collisions, for dev visuals).
- `createBacklinkIndex(): { index: Accessor<BacklinkIndex>, dispose: () => void }` — the observeDeep→rAF→swap reactive wrapper; readers hold the `index` signal, swapped only on completed rebuild.
- `extractWikilinkTargets(content: string, mode: 'outer' | 'nested'): string[]` in `wikilinkUtils.ts`.

**Load-bearing invariants (from design §U1 + STATE.md corrections — do NOT re-derive):**
- **Rebuild off `observeDeep`, mark-dirty → rAF-coalesced → swap-signal.** NOT synchronous inside the observer (37ms rebuild on 26k blocks stalls typing), NOT via EventBus (slim path skips > 50 events → silently stale), NOT via `ProjectionScheduler` (verified dormant, zero consumers). Gate: a test asserting N observer events in one transaction produce exactly one rebuild.
- **Canonicalization order: page-name lookup BEFORE hex test.** All-digit dates (`[[2026-08-11]]` → `20260811`) are valid hex; wrong order silently drops them (63 targets lost live). Fixture required.
- **Id targets resolve to FULL ids; prefixes fail closed.** Prefix→full-id multimap; exactly-one match canonicalizes, two-or-more resolves to nothing (dropped, counted in `ambiguousTargets`), exact full-id always wins. Fixture: two blocks sharing an 8-char prefix → neither gains the backlink, ambiguity reported.
- **Nested extractor extends `wikilinkUtils.ts`** (no third parser). `outlinksHook.ts` stays on `outer`; U1 is the only `nested` caller. Nested targets are NOT written into `metadata.outlinks` in v1. Gate: `outer`-mode output byte-identical to the pre-change hook on existing `outlinksHook.test.ts`/`wikilinkUtils.test.ts` corpora.
- Reference implementation: the live prototype's `topLevelCut`/`targetsOf`/`canonical` (`~/.floatty/artifacts/backlinks-live.html`, STATE.md §Links).

**Verification:** worst-case rebuild latency measured on a synthetic 26k-block fixture; the five fixtures above; completion gate. Then `architecture-reviewer` on the `wikilinkUtils.ts` diff.

**PR:** slice 1 alone (foundation lib + tests, no UI).

### Slice 2 — U2 drawer housing + U4 scope stack + dumb list

**Files (per design §U2/§U4):** `apps/floatty/src/components/BacklinkDrawer.tsx` (new), `src/lib/backlinkScope.ts` (new, U4 pure function), `usePaneStore.ts` (drawer height/open per-pane, instance state — never Y.Doc), a mount in `Outliner.tsx` / `PaneLayout.tsx`.

**Interfaces (Produces):** `resolveScopeGroups(paneId, zoomRoot, focusedBlock, index): ScopeGroup[]` (U4 — pure, DOM-free); the drawer renders a dumb `<ul>` of source-block ids per group end-to-end.

**Load-bearing invariants (design §U2/§U4):** height bounds pane-relative (`min 120px`, `max = min(0.75×paneHeight, paneHeight−160)`), clamp at drag/persist/restore; keyboard-resize contract on the grab strip (`role="separator"`, arrow/shift/Home/End/Enter, same clamp-then-persist path as pointer); scope groups keyed by resolved target id and deduped (focusing the page block yields ONE group). U4 fixtures: focus on page (one group), child no-inbound (page only), child with inbound (focal then page), nested page (nearest-page resolution).

**PR:** slice 2 (drawer skeleton, visible end-to-end).

### Slice 3 — U3: BlockRefList (the shared row renderer = P3)

**This is P3 — the second reusable building block** (later consumed by FLO-833 search surface, FLO-887 ToC). Likely splits into U3a (rows/sorts/filter/facets) → U3b (expand-in-place slice + context-radius dial) → U3c (churn clustering) as commits or sub-PRs.

**Files (per design §U3):** `apps/floatty/src/components/BlockRefList.tsx` (new) + focused sub-components; display-only rows inside a single focus point (`output-block-patterns.md` §2).

**Load-bearing invariants (design D2–D10, verbatim source is the design doc):** row = kind dot ◆/•/· · crumb · content · age; row click = NOTHING (explicit expand/navigate affordances only); expand-in-place slice = parent+block+children, dial widens; breadcrumb segments re-root the slice (crumb segments are the click target, separators `pointer-events:none`); compound sort with `updatedAt`-desc universal tiebreak (`flip * primary || b.u - a.u` — never `out.reverse()`); churn clustering gated on prose-similarity (bigram-Dice ≥ 0.5 over prose-only norm, wikilink spans removed entirely); middle-truncate prose, strip `[[ ]]` at the label layer so ellipsis never lands in a span; facet model PORTED from the qmd-graph-explorer prototype (don't redesign); both empty states are features.

**PR:** slice 3 (the renderer).

### Slice 4 — U5 ⟲n chips + funeral

**Files (per design §U5 + Funeral):** chips trailing lines (reads U1 via a context-level memo — one memo, not N, per `solidjs-patterns.md` §10); then **delete** `useBacklinkNavigation.ts::findBacklinks`, the `LinkedReferences.tsx` page-bottom panel, and the `isPageBlock` guard once the drawer covers them.

**This closes the loop:** [[FLO-456]] (the O(13k) scan) and [[FLO-711]] (block-id backlinks) die here. Navigation from rows still routes through `lib/navigation.ts` (funnel untouched).

**PR:** slice 4 (chips on, old implementation out).

---

## Not in this plan (explicitly deferred)

- **Transclusion (`![[id]]`, [[FLO-375]])** — the next phase, a thin composition on P5 (slice mount) + the ID-resolution this plan's U1 establishes. Its own spec/plan; blocked on the ID tombstone/alias lifecycle for durable embeds (read-only broken-ref embeds can ship ahead).
- **Marker-predicate surfaces** (kanban FLO-897/861, query views FLO-890 rebuild-half, lens FLO-329) — gated on FLO-374 effective markers; out of scope.
- **Server-side / block-level backlink index beyond page-name+id** — v1 is client-only, derived, never persisted.

## Self-review notes

- Phase 0 coverage checked against the filter:: footprint sweep (all file:line refs from the 2026-08-29 recon) and the dead-arch inventory (Tier-1 confirmed-dead only; `fuzzyFilter.ts`, `ran`, `picker`, ADR-006 cleanup explicitly NOT touched).
- Phase 1 coverage checked against the design doc's unit list (U1–U5 + funeral) and PR grouping — all four slices represented; the load-bearing corrections from STATE.md (observeDeep-direct, canonicalization order, prefix-fail-closed, nested-mode compatibility) carried into slice 1.
- Type consistency: `extractWikilinkTargets(content, mode)`, `buildBacklinkIndex`, `resolveScopeGroups`, `BlockRefList` used consistently across slices.
