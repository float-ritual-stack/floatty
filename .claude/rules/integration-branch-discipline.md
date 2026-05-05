# Integration-branch discipline

Architecture experiments don't land on `main`. Mainline merges of architecture-shape changes need explicit "this is now a building block" confirmation. Codified after the multi-outline DB-per-outline retirement (2026-05-05, [[ADR-006]]) — ~1400 lines of well-built code that landed against the wrong target before the design distinction between world/workspace and outline/view had settled.

## What "architecture-shape" means

Reach for this rule when a change introduces:

- A new domain primitive (a new entity in the block model, a new top-level concept like "outline", "scope", "workspace")
- A new storage topology (per-X SQLite files, new persisted indexes, new on-disk layout under `{data_dir}/`)
- A new cross-cutting abstraction (new lifecycle hook category, new event class, new shared service that multiple endpoints/handlers consume)
- A new public API surface that other code is expected to build on (`/api/v1/<new-noun>/...`, new MCP tool family, new Tauri command category)

Routine refactors, bug fixes, performance work, dependency bumps, lint sweeps, and feature work that *uses* existing primitives without introducing new ones are NOT architecture-shape. They merge to `main` normally.

## The rule

**Architecture-shape changes land on integration branches, not `main`.** The integration branch is where staged PRs accumulate while the design proves itself. Mainline merge of an integration branch requires explicit human confirmation that the design is now intended as a building block — not a research artifact, not a capability test, not a "let's see if this is the right shape."

Large architecture changes require, before mainline merge:

- **ADR** — proposed → accepted. Lives in `apps/floatty/docs/adrs/ADR-NNN-{slug}.md`.
- **Rollback note** — what to do if this turns out wrong. The bar to revisit + the consequences of the decision in the ADR's own consequences section count.
- **Status label** — `built` / `partial` / `experimental` / `retired`. Live status, not aspirational status. If it's `partial` or `experimental` when it lands, say so in the ADR and the route/module headers.

## Agents

Agents may prepare PRs but **must not silently change the integration target for large work**. If a feature was scoped against `feat/integration-X` and an agent retargets to `main` mid-stream, surface that to evan **before** merging.

The retarget can happen for legitimate reasons (the integration branch was abandoned, scope changed, work narrowed enough to land directly). It just can't happen quietly. The decision of "this is now a building block" is human-shaped, not agent-shaped.

## The canonical worked example

Multi-outline DB-per-outline (PRs #212-217, 2026-04-07 → 2026-04-14) was scoped as integration-branch work — staged PRs against an integration target, with frontend switching and workspace plumbing as separate downstream PRs. Somewhere during execution, the integration target shifted to `main` and PRs landed there directly without the explicit "this is now a building block" confirmation. Two consequences:

1. **Lived-use mismatch**: feature was used ~2 days post-merge, then in the one real separation/switching scenario, scripted backup/restore of `default` was the useful path. Building the wrong thing well is still the wrong thing.
2. **Drift accumulation**: post-merge work (FLO-679 PR 2 ancestor-context, `ws.rs` per-outline broadcaster routing) extended the feature surface despite zero real use, because the surface existed in `main` and looked canonical.

The retirement (ADR-006, 2026-05-05) is the cleanup. Roughly 1400 lines of well-built code deleted, plus reversals of `ws.rs` and per-outline call sites in shared helpers. The lesson survives as ADR-006 + this rule + the conversation-map artifacts at `~/.floatty/artifacts/2026-05-05-conversation-map.{json,jsx}`.

## Composes with

- `personal-tool-pr-scope.md` — bot-only review = bundle aggressively. This rule doesn't change PR-scope discipline; it adds branch-target discipline on top of it.
- `symmetry-check.md` — when an architecture change introduces a primitive, grep for siblings before mainline. This rule is what stops a sibling from existing in the first place.
- `lint-discipline.md` — completion-gate is owed regardless of branch target. This rule adds "and the merge target is the right one."

## See also

- [[ADR-006]] — `apps/floatty/docs/adrs/ADR-006-retire-db-per-outline.md`
- [[multi-outline-rollback-recon-2026-05-05]] — `.claude/handoffs/multi-outline-rollback-recon-2026-05-05.md`
- `~/.floatty/artifacts/2026-05-05-conversation-map.{json,jsx}` — durable synthesis
