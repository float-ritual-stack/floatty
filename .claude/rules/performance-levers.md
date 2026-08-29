# Performance Levers — Don't Rediscover the Virtualization Crater

Doctrine for floatty performance work. Codified 2026-08-29 after a [[FLO-936]] investigation re-surfaced "just virtualize the outliner" for the third time, and archaeology showed the project has **already run that experiment in two distinct forms**, both of which collided with floatty-specific invariants — while the boring adjacent levers from the same review quietly shipped and helped.

The point of this rule is not "never virtualize." It is: **stop paying the cost of rediscovering a known dead end**, and reach for the levers that fit floatty's grain first.

## The doctrine

> **Do not propose renderer virtualization as floatty's default performance remedy.**
>
> Prior attempts (both reached a dead end against floatty-specific invariants):
> - **CSS containment / `content-visibility`** caused display-layer *correctness* failures (text intermittently vanished).
> - **Flat JS virtualization** (TanStack-style windowing) reached a WIP dead end because floatty depends on a **recursive tree model** and **mounted stateful heavy children** whose lifecycle cannot tolerate unmount/remount.
>
> Prefer **reducing work while preserving mounted structure**:
> - batch invalidations,
> - narrow reactive dependencies,
> - window data / materialization (not the DOM),
> - defer or gate expensive offscreen computation,
> - profile the specific hot path *before* changing rendering architecture.
>
> Reconsider virtualization **only if the relevant architectural constraint has materially changed** — and when you do, name **which prior failure mode no longer applies**.

That last clause is load-bearing. Without it this rule fossilizes into "never virtualization" dogma, and some future floatty could genuinely change enough (single-layer rendering, stateless children, a flat model) to make it viable. The rule is falsifiable on purpose.

## The two walls (why it's an invariant clash, not an effort problem)

| Approach | Collides with | Symptom | Receipts |
|---|---|---|---|
| CSS containment / `content-visibility: auto` | the **two-layer inline overlay** (display layer absolutely positioned over the transparent edit layer — see `contenteditable-patterns.md`). `content-visibility` *is* paint containment. | intermittent display-layer text disappearance; collapse/expand forced a repaint that "fixed" it | PR #64 added it (2026-01-06) → multi-commit revert firefight `6d246b1c`, `70e902c2`, revert #66, remove #71, cleanup #72 (2026-01-07). Currently absent from the codebase. |
| Flat JS windowing (`@tanstack/solid-virtual`, virtua) | the **recursive tree** (indentation, collapse, selection ranges assume it) + **heavy children lose all state on unmount** (iframes, xterm, render doors) — and unmounting is exactly where JS windowing's perf win comes from | "flat list ~40 nodes vs 25k" but the tree/selection/heavy-child semantics broke | `feat/virtual-tree-rendering`, commit `38b50701` (FLO-316, 2026-02-13): *"NOT DONE, known bugs."* Abandoned. |

## The boring levers shipped; the dramatic one didn't

`ARCHITECTURE-REVIEW-2026-01-08.md` declared *"the performance problem isn't the framework — it's the lack of virtualization"* and ranked virtual scrolling the **#1 priority, "biggest UX win."** What actually happened to that review's roadmap:

| Recommendation | Reality |
|---|---|
| #1 Virtual scrolling ("biggest UX win") | **never shipped** — died twice (see the two walls) |
| #2 Search API | ✅ shipped (`/api/v1/search`) |
| #3 Backlink index | ✅ shipped (`useBacklinkNavigation`) |
| Tantivy full-text | ✅ shipped |
| Debounce / batch Y.Doc observers | ✅ shipped ([[FLO-387]] blur-is-the-boundary, batch fixes) |
| CRDT compaction policy | ✅ shipped |
| "lazy subtree loading" | superseded by **windowed rehydration** (2026-02-13: 25,598 blocks → 198 materialized at collapse depth 2) |

The one item labeled "biggest win" is the only one that never worked. Every other lever on the same page delivered. That is the signature of a **recurring siren song**, not an unexplored hypothesis.

## Review heuristics

Two questions to run before accepting any performance proposal:

1. **When a proposal requires changing floatty's rendering model, first ask whether a narrower lever has already solved the same class of problem elsewhere.** (The project's history is that the dramatic answer was wrong while the boring answer quietly shipped.)
2. **When a big framework/library move is floated adjacent to a perf conversation, check whether it actually touches the profiled hot path.** Example: the Solid 2.0 migration analyzer (2026-08-29) flagged 29 sites across ~5 files — all bootstrap/lifecycle ceremony (`onMount`/`onCleanup`), **zero in the [[FLO-936]] reactive hot path**. A migration that doesn't touch the hot path is not a perf fix.

## Worked example — FLO-936 (the ordered progression)

Profiling ([[PR #407]] investigation) showed: zooming into a large subtree = 2.6–4s synchronous freeze, **per-visible-`BlockItem` reactive re-render** (scales with the visible subtree, **zero DOM mounts**, not a global memo, not one hot function). Cold ≈ 7× warm, where "cold" is entered by any store mutation before the zoom. The interesting question is therefore NOT "how do we get 25k nodes out of the DOM" but:

> **why does one mutation cause hundreds of already-mounted `BlockItem`s to do expensive work on the next zoom?**

The disciplined order to pull levers:

1. **Identify the coarse dependency** causing the cold post-mutation fan-out (why ~400 mounted blocks re-execute, ~1ms→~6.5ms each, after a single-block mutation).
2. **Narrow that dependency** and measure whether it materially reduces the 2.6s. (Fine-grained reactivity should re-run only the mutated block's consumers — a broad `store.blocks` read somewhere is the suspect. See `solidjs-patterns.md` rules #7 and #10.)
3. **Only then** gate remaining expensive per-block *derived* work on visibility (IntersectionObserver `isInViewport`) — keeping every block mounted.
4. **Keep batching symmetry checks as a separate cheap class of fixes** (e.g. [[PR #407]] batched the lone-unbatched zoom `setCollapsed` loop — see `symmetry-check.md`).

### Caution on the IntersectionObserver idea

It fits floatty's grain far better than unmounting — but **prove which reactive work can safely sleep before adding visibility state to every block.** Otherwise you trade one broad reactive graph for another broad reactive graph whose new coarse dependency is `isInViewport`. Steps 1–2 (narrow the real dependency) come first *specifically* so that step 3 gates a small, proven-safe set of computations rather than becoming a second N-wide graph.

## See also

- `symmetry-check.md` — the batch fix in [[PR #407]] was symmetry drift (the zoom path was the lone unbatched sibling of `toggleCollapsed` / `useTreeCollapse`).
- `solidjs-patterns.md` — rule #7 (effect dependency leaks through function calls) and rule #10 (lift identical memos to context) are the mechanisms behind "narrow the coarse dependency."
- `contenteditable-patterns.md` — the two-layer overlay that CSS containment collides with.
- `do-not.md` — this rule contributes the "don't reach for renderer virtualization as the default perf remedy" anti-pattern.
- Artifacts: `ARCHITECTURE-REVIEW-2026-01-08.md` (the siren-song doc), `feat/virtual-tree-rendering` branch / commit `38b50701` (the TanStack dead end), PRs #64/#66/#71/#72 (the CSS-containment firefight), [[FLO-936]] (the current investigation), [[PR #407]] (the batch lever).

## Provenance

Codified 2026-08-29 during a [[FLO-936]] loop. The user's own framing: *"this 'virtualize things to solve all your problems' comes up every time I talk about performance, then we find like 5 other levers we can pull on instead — after trying to do the thing that never works one more time."* The archaeology confirmed it with dates and commit hashes; this rule is the durable form so round four doesn't cost another firefight.
