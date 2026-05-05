# Recon: multi-outline rollback — Worlds vs Outlines, retire DB-per-outline as mainline

**Recon date**: 2026-05-05 @ 08:50 AM
**Recon source**: `git show main` from worktree `.claude/worktrees/bright-fox-ca92` (branch `feat/rich-doc-primitives`); `main` HEAD `7355166cd9` 2026-05-03 03:00:35 -0400 "feat(render-door): rig gain controls (FLO-703)"
**Caveat**: cwd is a feature-branch worktree, but every claim below cites `main`-tip blobs via `git show main:path`. If the cleanup branch pins a different sha, re-run the citations against that sha.

**Decision artifacts (durable, predate this recon)**:
- `/Users/evan/.floatty/artifacts/2026-05-05-conversation-map.json` (655 lines, 36KB, 2026-05-05 08:32)
- `/Users/evan/.floatty/artifacts/2026-05-05-conversation-map.jsx` (972 lines, 45KB, 2026-05-05 08:32)

These are the standalone synthesis — recon body, ADR draft, cleanup phases, future-architecture framing. The plan file below is a structured reading + repo-side verification of those artifacts; the artifacts are the source-of-truth for the decision and its reasoning.

> ## Headline (the actual conceptual move)
>
> **The cleanup is not a rollback of the lesson. It is a rollback of the storage topology.**
>
> **Worlds ≠ Outlines.** The current implementation collapsed two different problems into one storage topology:
>
> - **World / workspace** = data-dir / process / server route / subdomain. Selected by `FLOATTY_DATA_DIR`, deployment routing, snapshot/restore. Owns persistence, backups, auth boundary, global config.
> - **Outline / view / scope** = command/view/projection inside a world. A root, filter, session, or workbench target over the block graph. Owns focus, agent scope, subscriptions, compact candidates.
>
> **Decision: retire DB-per-outline as the storage topology — not "multi-outline" as vocabulary.** Workspace separation will be handled by data directories (already supported via `FLOATTY_DATA_DIR`) + future `floatty workspace ...` commands. Outline returns later as a lighter command/view/scope concept inside a workspace, **not** as a separate persisted store, unless a future requirement clearly justifies separate persistence.
>
> Made by evan during morning iteration 2026-05-05. The lived-use test is decisive: feature was used for ~2 days post-merge, then in the one real separation/switching scenario, scripting backup/restore of `default` was the useful path — not named outlines. **Building the wrong thing well is still the wrong thing.**
>
> ### What's getting retired (storage topology + its surface)
>
> - DB-per-outline as default architecture (separate SQLite per name)
> - Partial `/api/v1/outlines/:name/...` mutation routes (15 missing parity, §5 matrix)
> - `default` vs named-outline special-case branching
> - Tests / docs / UI implying named-outlines are canonical/mainline
> - Frontend `outline::` handler + `localStorage('floatty-outline')` boot path
> - `floatty-core` `OutlineName` type (only used by the retiring feature; goes with it)
> - **[[FLO-622]] as a live plan** — the boring-basic swap was a previous fork-in-the-road; the 2026-05-05 decision walks away from it. Close as won't-do, do not adopt as the follow-up. The follow-up is workspace/world switching, not a renamed swap mechanism.
>
> ### What survives (the lesson, not the topology)
>
> - **"Outline" as vocabulary** for a workbench/scope — returns later as scope-shaped, not store-shaped
> - **BlockService extraction** (Phase 2, PRs #213-214) — useful refactor independent of multi-outline
> - **Vision-level ADRs** (ADR-001 "outline is canonical", ADR-002 "projections not source") — predate Phase 1 and aren't bound to its storage topology
> - **Lessons preserved** as ADR-006 + design notes; tests describing desired switching behavior reframed as design specs
> - **`FLOATTY_DATA_DIR`** env-var workspace switching (already lives in `paths.rs`); **`ctx_markers.db`** global persistence
>
> ### The bar to revisit (separate-persisted-outlines)
>
> **10+/10 reasoning, no shadow of doubt.** Future reintroduction requires one of: independently syncable documents, separate access control inside one process, true multi-tenant behavior, large-scale performance isolation, different retention policies per outline, or sustained user workflow with multiple persisted outlines without workspace switching. Focus / scope / agent boundary / subscriptions / compact candidates all do **not** clear that bar — they're outline-as-view, not outline-as-store.
>
> ### Recon recommendation
>
> **ENTANGLED-but-tractable.** Earlier framing was "mostly unused sidecar, likely easy to retire" — the recon body sharpens this to "still mostly sidecar, but no longer trivial sidecar" because of `ws.rs` (per-outline WS subscriptions partly shipped, heartbeat default-only) + FLO-679/680 ancestor-context threading through per-outline block-returning endpoints. Single bundled deletion PR (see §6 order-of-operations + §7 PR scope), preceded by capturing the decision in three durable homes (§8.0). Repo-side evidence supporting deletion (audit re-verification §2, drift archaeology §3, surface classification §4, parity matrix §5) is unanimous.
>
> **Naive deletion of `OutlineManager` breaks default WebSocket** because `WsState` now carries both `default_broadcaster` and `outline_manager` (`ws.rs:246-247`). Reversal of `ws.rs` precedes deletion of `outline_manager.rs`. See §6 step ordering.

---

## 1. Plan resolution — what was actually decided, when, by whom

### Decisions found (chronological, with citations)

| Date | Decision | Citation | Status |
|---|---|---|---|
| 2026-01-07 | "Outline IS the BBS" — Y.Doc is canonical, projections derive | `apps/floatty/docs/architecture/BBS_OUTLINE_CONVERGENCE.md`; ADR-001 (`apps/floatty/docs/adrs/ADR-001-outline-is-canonical.md`) | Vision, formalized across ADRs 001–005 |
| 2026-04-07 | Phase 1: DB-per-outline (separate SQLite per outline at `{data_dir}/outlines/{name}.sqlite`) | Commit `c28674e` "feat(server): multi-outline support Phase 1 — DB-per-outline with REST API"; PRs #212–217; review doc `apps/floatty/docs/reviews/multi-outline-phase1-review.md` (verdict: ALIGNED) | **Shipped** |
| 2026-04-08 03:52 | Removed hot-swap machinery in favour of localStorage+reload | Commit `11911f0` "cleanup: remove dead switchOutline/resetForOutlineSwitch code" | **Shipped** — `outline::` handler routes through this |
| 2026-04-12 | API handler split (#225): monolithic `api.rs` → 7 handler modules incl. `api/outlines.rs` | Commit `1234f5a` "refactor(server): break up api.rs into handler modules" | **Shipped** — pure structural refactor |
| 2026-04-14 23:31 | [[FLO-622]] **proposed** (Backlog): `outline-swap::` handler + `ServerConfig.active_outline` + `reset_from_state` + reload | Linear FLO-622 ("Boring-basic named-outline swap via reset_from_state + reload"), state **Backlog**, no activity since creation | **Proposed, not started** |
| 2026-04-26 | FLO-679 PR 2 + FLO-680: ancestor-context wired through every block-returning endpoint **including per-outline** | Commit `b6fb4ec` (#282) | **Shipped** — feature evolution, per-outline endpoints actively maintained |

### [[FLO-622]] current state

- **Linear ID**: FLO-622
- **Title**: "Boring-basic named-outline swap via reset_from_state + reload"
- **State**: **Backlog**
- **Created**: 2026-04-14 23:31:14 UTC
- **Updated**: 2026-04-14 23:31:14 UTC (no activity since creation; ~3 weeks idle)
- **Description**: ~2500 words; references the Phase 1 audit, recon-session branch, the train-of-thought-block discipline, and a validation checklist for the eventual implementation
- **Children/parent**: none reported by the GraphQL response
- **Reading**: FLO-622 is *one* of the recognized forks. It does not say "delete Phase 1." It says "Phase 1 sidecar parity is a long road; ship a simpler swap that composes existing primitives so daily multi-outline use is unblocked." If Phase 1 stays sidecar, FLO-622 is a way to get value without finishing parity.

### `ServerConfig.active_outline` ship status

- **Field exists in `config.rs`**: **NO**
- **Citation**: `apps/floatty/src-tauri/floatty-server/src/config.rs` (main) — `ServerConfig` struct lines 21–54 contain `enabled`, `port`, `api_key`, `bind`, `auth_enabled`, `otlp_endpoint`. No `active_outline` field.
- **Implication**: FLO-622's proposed plumbing has not landed. This is consistent with Backlog status.

### Other recon/review docs found

| Path | One-line summary |
|---|---|
| `apps/floatty/docs/reviews/multi-outline-phase1-review.md` | 2026-04-07 audit, 9 findings, verdict ALIGNED, references Phase 2 BlockService extraction as next step |
| `apps/floatty/docs/architecture/BBS_OUTLINE_CONVERGENCE.md` | 2026-01-07 vision doc — outline IS the BBS, projections derive |
| `apps/floatty/docs/adrs/ADR-001-outline-is-canonical.md` | "Outline / Y.Doc is the canonical shared data model" |
| `apps/floatty/docs/adrs/ADR-002-projections-not-source.md` | (read but not central to multi-outline) |
| `apps/floatty/docs/adrs/ADR-005-search-index-ephemeral.md` | Tantivy is rebuildable from Y.Doc (relevant to outline.tantivy/ cleanup) |
| `.claude/handoffs/frontend-outline-switching.md` | 2026-04-08 root cause + localStorage+reload pattern |
| `.claude/handoffs/blockservice-extraction-step2b.md` | BlockService Phase 2 mid-step |
| `.claude/handoffs/blockservice-extraction-step6.md` | BlockService Phase 2 final, marked COMPLETE |
| `~/.claude/plans/replicated-spinning-liskov.md` | Phase 1–4 multi-outline working plan (Phase 1+2 shipped, Phase 3 hooks shipped, Phase 4 WS+LRU deferred) |
| `~/.claude/plans/shiny-gathering-pond.md` | Frontend outline switching (PR #5 root cause) |
| `~/.claude/plans/elegant-discovering-hare.md` | PR #217 bot-review fix list |

### The decision lineage (resolved by evan 2026-05-05 morning)

| Plan | Status as of 2026-05-05 |
|---|---|
| **A. Retire DB-per-outline as mainline architecture** | **DECIDED** during morning iteration. Synthesis lives at `~/.floatty/artifacts/2026-05-05-conversation-map.{json,jsx}`. Bar to revisit: 10+/10. |
| **B. "Boring-basic" alternative (FLO-622)** | **SUPERSEDED, NOT REVIVED**. FLO-622 was a fork in the road that sat Backlog for 3 weeks. The decision **walks away from both Phase 1 parity AND FLO-622's swap mechanism**. The follow-up primitive is broader workspace/world switching via `FLOATTY_DATA_DIR` + future `floatty workspace ...` commands — not a renamed boring-basic swap variant. Close FLO-622 as won't-do as part of cleanup bundle. |
| **C. "Continue Phase 1+2+3, defer Phase 4"** | **REJECTED**. Post-audit extension via `b6fb4ec` (ancestor-context per-outline) is precisely the architectural complexity flagged as not earning its weight. |

### The "design reconnaissance that accidentally landed in main" framing (from synthesis)

> Multi-outline was design reconnaissance that accidentally landed in main. It succeeded as research by clarifying the right distinction. It should not remain load-bearing as implementation.
>
> The mistake may not be multi-outline. The mistake may be implementing outline as storage partition before proving it as command/view scope.
>
> Building the wrong thing well is still the wrong thing.

What the work taught (preserve in ADR-006 + design notes):
- `world/workspace ≠ outline/view/scope`
- `storage partition ≠ workbench boundary`
- `availability/routing concern ≠ domain model`

### ADR-006 draft (evan-authored in synthesis, ready to drop into `apps/floatty/docs/adrs/ADR-006-retire-db-per-outline.md`)

```markdown
# ADR-006: Retire DB-per-outline as Mainline Architecture

## Status
Proposed → Accepted on cleanup-branch landing.

## Source
- ~/.floatty/artifacts/2026-05-05-conversation-map.{json,jsx}
- This recon: .claude/handoffs/multi-outline-rollback-recon-2026-05-05.md
- Linear FLO-622 (closed as won't-do)

## Context
Multi-outline support was intended to land via an integration branch with staged
PRs but was merged into main before the design distinction between
world/workspace and outline/view had settled. Phase 1 implements named outlines
as separate persisted SQLite/Y.Doc stores; `default` remains a special legacy
path. Phase 2 BlockService extraction was useful refactor work independent of
the storage topology.

The feature has seen little real use beyond initial testing (~2 days). In the
one real separation/switching scenario, scripted backup/restore of the default
data directory was more useful than using named outlines. Subsequent main work
(dozens of PRs) has continued under the assumption that `default` is the only
real active path; nothing has intentionally landed on the named-outline path.

The current shape risks the worst version of multi-outline: enough complexity
to complicate every future surface (command layer, agent write tools, float-box
deployment, subscriptions, BBS bridges, /compact), not enough actual usage to
justify the cost. Future agents reading the codebase may treat the
named-outline path as canonical because it exists in main.

## Decision
- Stop treating DB-per-outline as mainline architecture. Retire the named-
  outline storage semantics from main.
- Preserve the lessons and useful vocabulary; do not build future features on
  the current `/outlines/:name` storage path.
- World/workspace separation will be handled through data directories
  (`FLOATTY_DATA_DIR` already supports this), process/config boundaries, and
  eventually server routing or subdomains. First-class `floatty workspace ...`
  commands (list/switch/snapshot/restore/serve) become the separation primitive.
- Outline returns later as a command/view/scope concept within a workspace: a
  root, projection, filter, session, or workbench target over the block graph.
  No separate DB unless a future requirement proves the need.
- Future command grammar carries `workspace + scope` from day one. No surface
  (Raycast, CLI, phone, agent, BBS bridge, floatty UI) needs to know whether
  it's talking to "legacy default" or "named outline mode."

## Consequences
- Main becomes simpler and safer for command-layer work.
- Some well-built code (~1300 lines server-side) is removed despite being
  well-built; lessons survive in this ADR + retired/ design notes.
- Future agents have less misleading architecture to build on.
- Workspace switching becomes the near-term separation primitive.
- Multi-outline can return later if justified, but with a better domain
  boundary (scope, not store).

## Non-goals
- This does not abandon outline as a concept.
- This does not abandon many surfaces or many workbenches.
- This does not require a full rewrite of the substrate.
- This does not require deleting useful design notes or tests that can be
  reframed as desired-behavior specs.

## Bar to revisit
Reintroducing separate-persisted-outlines requires one of:
- independently syncable documents
- independently exportable/importable notebooks
- separate access control inside one server process
- large-scale performance isolation
- different retention/backup policies per outline
- true multi-tenant behavior inside one process
- a user workflow where multiple persisted outlines are actively used without
  workspace switching

If the need is only focus, routing, view, project grouping, agent scope,
subscriptions, or compact candidates, prefer outline-as-view/scope inside a
workspace.
```

### Recon's prior failure mode (saved for memory)

Earlier in this same plan-mode session, the recon characterized the deletion premise as "unfounded" because no repo-side `retire`/`quarantine` commit/doc/ADR existed. That was wrong. The decision-maker authored the recon prompt; the prompt itself is authoritative source. **Absence of repo-evidence ≠ absence of decision when the decision-maker is the one prompting.** Saving as a feedback memory entry post-exit.

---

## 2. Audit re-verification (vs 2026-04-07 review doc)

The audit predates PR #225 (api.rs handler split, 2026-04-12). Re-verified against `main` 2026-05-05.

### Endpoint inventory (audit Claim 1: 17 endpoints)

`apps/floatty/src-tauri/floatty-server/src/api/outlines.rs` registers (counting HTTP method × path):

| Method | Path | File:Line |
|---|---|---|
| GET | `/api/v1/outlines` | outlines.rs:28-29 |
| POST | `/api/v1/outlines` | outlines.rs:28-29 |
| DELETE | `/api/v1/outlines/:name` | outlines.rs:30 |
| GET | `/api/v1/outlines/:name/state` | outlines.rs:32 |
| GET | `/api/v1/outlines/:name/state-vector` | outlines.rs:33-36 |
| GET | `/api/v1/outlines/:name/state/hash` | outlines.rs:37-40 |
| POST | `/api/v1/outlines/:name/update` | outlines.rs:41 |
| GET | `/api/v1/outlines/:name/updates` | outlines.rs:42-45 |
| GET | `/api/v1/outlines/:name/export/binary` | outlines.rs:46-49 |
| GET | `/api/v1/outlines/:name/export/json` | outlines.rs:50-53 |
| GET | `/api/v1/outlines/:name/blocks` | outlines.rs:56-59 |
| POST | `/api/v1/outlines/:name/blocks` | outlines.rs:56-59 |
| POST | `/api/v1/outlines/:name/blocks/import` | outlines.rs:60-62 |
| GET | `/api/v1/outlines/:name/blocks/:id` | outlines.rs:63-67 |
| PATCH | `/api/v1/outlines/:name/blocks/:id` | outlines.rs:63-67 |
| DELETE | `/api/v1/outlines/:name/blocks/:id` | outlines.rs:63-67 |
| GET | `/api/v1/outlines/:name/stats` | outlines.rs:69 |
| GET | `/api/v1/outlines/:name/search` | outlines.rs:70 |
| GET | `/api/v1/outlines/:name/pages/search` | outlines.rs:71-74 |

**Verdict**: 19 method-instances on 14 unique paths. Audit's "17" was a path-count after #225; the recount is consistent with the audit shape. No regression, modest extension since audit (search + pages/search added).

### Non-`outlines.rs` consumers of `state.outline_manager` (audit Claim 2: zero)

**DRIFT confirmed by eyes-on read**:

- `ws.rs:246-247` — `WsState { pub default_broadcaster: Arc<WsBroadcaster>, pub outline_manager: Arc<OutlineManager> }`
- `ws.rs:265-272` — `ws_handler` routes:
  ```rust
  let (broadcaster, outline_ctx) = if outline_name == "default" {
      (Arc::clone(&ws_state.default_broadcaster), None)
  } else {
      match ws_state.outline_manager.get_context(&outline_name) {
          Ok(ctx) => (Arc::clone(&ctx.broadcaster), Some(ctx)),
          Err(_) => return (StatusCode::NOT_FOUND, "outline not found").into_response(),
      }
  };
  ```

**This is feature-meaningful drift, not refactoring noise**: the audit's "non-default outlines have no WebSocket" predicate has been partly resolved — per-outline WS *subscriptions* now work, while heartbeat (`main.rs:355` `start_heartbeat(Arc::clone(&broadcaster), ...)`) remains default-only. This is consistent with replicated-spinning-liskov.md Phase 4's "WebSocket per-outline" goal being **partly implemented**.

`api/mod.rs:42` and `lib.rs` re-export `OutlineManager` (type-system surface, not consumption); `main.rs:380s` constructs `WsState` (composition, not consumption). The only behavioral consumer outside `outlines.rs` is `ws.rs`.

### Default vs per-outline route parity (audit Claim 3: 13 missing / 4 partial)

Re-derive: **15 missing / 0 partial** on `main`. Recategorization:

| Default-route family | Per-outline mirrors | Missing |
|---|---|---|
| Sync (state, state-vector, state/hash, update, updates, restore, export/binary, export/json) | 6/7 | restore (1) |
| Export (export/binary, export/json, topology, topology/blocks) | 2/4 | topology, topology/blocks (2) |
| Blocks (CRUD + resolve + bulk PUT) | 6/8 | resolve, PUT-bulk (2) |
| Search (search, pages/search, search/clear, search/reindex) | 2/4 | search/clear, search/reindex (2) |
| Backup (5 endpoints) | 0/5 | all (5) |
| Discovery (markers, presence×2, daily×2, pages, attachments) | 0/7 | all (7); some N/A for non-default |
| Outline mgmt | 3/3 | 0 |
| Health | 0/1 | health (N/A) |
| **Totals** | **19** | **15** |

The audit's "4 partial" appears to have collapsed into "15 fully missing" because nothing was extended. **Drift class**: stagnation, not regression — the per-outline surface stopped being added to once the FLO-622 fork-question opened on 2026-04-14.

### `ServerConfig.active_outline` (audit Claim 4)

**Confirmed not shipped.** `config.rs` lines 21–54 list 6 fields, none named `active_outline`. FLO-622's proposed addition would slot in after `otlp_endpoint`.

### localStorage + `window.location.reload()` swap (audit Claim 5)

**Confirmed unchanged.** Five hits in `apps/floatty/src/App.tsx`:
- `App.tsx:59` — `const savedOutline = localStorage.getItem('floatty-outline') || 'default';`
- `App.tsx:85` (comment) — `"Strategy: save to localStorage then reload."`
- `App.tsx:93`, `:130`, `:392` — `localStorage.{get,set}Item('floatty-outline', ...)`
- `apps/floatty/src/lib/handlers/outline.ts` — `outline::` handler creates → persists → reloads.

### `WsBroadcaster` shape (Claim 6, flue's intel)

**HYBRID — both singleton AND per-outline registry, not one or the other.**

- `main.rs:341` — singleton `let broadcaster = Arc::new(WsBroadcaster::new(256));`
- `main.rs:355` — `start_heartbeat(Arc::clone(&broadcaster), Arc::clone(&store));` — **default-only** heartbeat (verified)
- `main.rs:442` — `default_broadcaster: Arc::clone(&broadcaster)` flows into `WsState`
- `ws.rs:246-247` — `WsState` carries both default + per-outline
- `outline_manager.rs` — each `OutlineContext` owns `pub broadcaster: Arc<WsBroadcaster>`
- `ws.rs:265-272` — handler routes by `outline` query param

**Flue's claim "per-outline broadcasters exist" was correct.** Flue's specific line citation (`ws.rs:258`) was within range — the actual lookup is `:265-272` on current main. The "default-only heartbeat" claim is also confirmed (`main.rs:355`).

### `ctx_markers.db` (Claim 7)

**Confirmed global.** `apps/floatty/src-tauri/src/paths.rs:30, 61, 158`:
```rust
/// SQLite database: {root}/ctx_markers.db
database: root.join("ctx_markers.db"),
```
No per-outline keying. Consistent with FLO-622's "ambient/temporal, not workspace content" tradeoff.

### `OnceLock<HookSystem>` (Claim 8)

**Confirmed.** `outline_manager.rs:44, 61-62, 124-125, 154-155`:
- Field: `hook_system: OnceLock<Arc<HookSystem>>` (line 44)
- Lazy: `ensure_hook_system(&self) -> &Arc<HookSystem> { self.hook_system.get_or_init(...) }` (line 61-62)
- Read: `hook_system_if_initialized(&self) -> Option<&Arc<HookSystem>>` (line 124-125)
- `catch_unwind` guards against poisoning (line 60).

### `floatty-backend` skill outline-awareness (Claim 9)

**Unverifiable** — sub-agent could not locate `~/.claude/skills/floatty-backend/SKILL.md` from its environment. Recon-time check from this agent's environment: skill is listed in available-skills (`floatty-backend:floatty-backend: Interact with floatty-server REST API for block CRUD, search, and daily notes...`), and `apps/floatty/.claude/rules/api-reference.md` (read in CLAUDE.md context above) documents only `/api/v1/...` default-route URLs, not `/api/v1/outlines/:name/...`. **Provisional verdict: skill+rules are default-route-only**, consistent with audit claim. A targeted re-read of the skill body would harden this.

### File size deltas

| File | 2026-04-07 (audit baseline) | main (2026-05-05) | Delta | Notes |
|---|---|---|---|---|
| `outline_manager.rs` | ~331 lines (post-Phase-1 commit `c28674e`) | 611 lines | **+280 / +85%** | Phase 2/3 hardening (per-outline hooks, broadcaster wiring) accumulated here |
| `api/outlines.rs` | did not exist (code lived in `api.rs`) | 563 lines | new file | Created by api.rs split #225 on 2026-04-12 |
| `floatty-core/src/outline.rs` | did not exist | 162 lines | new file | Shared types post-monorepo |

The recon-prompt's stated audit-time numbers (571 / 491) were a snapshot **between** the audit and now, not the audit baseline itself. The +40 / +72 deltas the prompt cited reflect drift since some interim point (~late April), not since 2026-04-07.

### Surprises (things the audit didn't predict)

1. **Per-outline WS subscriptions partially shipped** — audit listed "no WebSocket on non-default outlines" as a Phase 2+ target. As of `main`, per-outline subscriptions DO work via the hybrid `WsState`; only heartbeat is default-only. This means the feature is more functional than the audit predicted.
2. **Ancestor-context (FLO-679 PR 2) actively threads through per-outline endpoints** — `apps/floatty/src-tauri/floatty-server/src/api/outlines.rs` carries `+7` lines for `AncestorContext` shaping (per-outline `/search` and `/blocks/:id`). The per-outline path is being *kept symmetric with the default path* via the symmetry harness in `floatty-server/tests/symmetry_ancestor_context.rs`. This is the strongest signal that the feature is **maintained, not retired**.
3. **The "13 missing / 4 partial" → "15 missing / 0 partial" reshape** suggests work stopped at the FLO-622 fork rather than progressing.

---

## 3. Drift archaeology since 2026-04-07

| SHA (short) | Date | Subject | Reason class |
|---|---|---|---|
| `c28674e` | 2026-04-07 | feat(server): multi-outline support Phase 1 — DB-per-outline with REST API | Feature ship (audit baseline) |
| `11911f0` | 2026-04-08 | cleanup: remove dead switchOutline/resetForOutlineSwitch code | Hot-swap walkback |
| `4e81e61` | 2026-04-11 | chore: move floatty into apps/floatty/ | Monorepo restructure (generic) |
| `1234f5a` | 2026-04-12 | refactor(server): break up api.rs into handler modules (#225) | Generic structural refactor — created `api/outlines.rs` |
| `f3cf29a` | 2026-04-13 | fix: FLO-595/596/606 — three small correctness fixes (#231) | Bug fix — unified stats field name in outline-scoped endpoint |
| `3bed8d8` | 2026-04-15 | FLO-633: server-side renderedMarkdown projection (#236) | Incidental touch — shared shaping helper applies to outline endpoints |
| `8eb5cdf` | 2026-04-19 | feat(FLO-652): semantic endpoints upsert + append (#249) | Incidental — default-route, not outline-scoped |
| `a680932` | 2026-04-24 | chore(lint): auto-fix sweep (#270) | Lint/fmt only |
| `d95a0af` | 2026-04-24 | chore(lint): hand-fix clippy warnings (#275) | Lint/fmt only |
| `b6fb4ec` | 2026-04-26 | feat(api): ancestor context on every block-returning endpoint (FLO-679 PR 2 + FLO-680) (#282) | **Feature evolution** — outline endpoints actively maintained |

Retire / quarantine signals: **NONE FOUND**. `git log main --grep="retire\|quarantine\|remove.*outline\|delete.*outline\|rollback.*outline\|deprecate.*outline" --after="2026-04-07"` returns no matches.

---

## 4. Surface classification (A–G)

Using the recon prompt's scheme: A=feature impl, B=tests, C=docs, D=load-bearing default-route, E=shared type imported elsewhere, F=accidental dependency, G=sidecar (audit's framing — feature surface but not load-bearing for default route).

| Path | Class | Justification |
|---|---|---|
| `apps/floatty/src-tauri/floatty-server/src/outline_manager.rs` | **G + partial-D** | Sidecar by default-route reads, but `ws.rs` (load-bearing default WS) now consumes `OutlineManager` for routing |
| `apps/floatty/src-tauri/floatty-server/src/api/outlines.rs` | **G** | 19 endpoints, not consulted by default-route handlers; pure sidecar surface |
| `apps/floatty/src-tauri/floatty-server/src/api/mod.rs` | **D** (router) + **E** (re-exports `OutlineManager`) | Router registration; deletion would require unregistering 19 routes |
| `apps/floatty/src-tauri/floatty-core/src/outline.rs` | **E** | Shared `OutlineName` type imported by both `outlines.rs` and `outline_manager.rs` |
| `apps/floatty/src-tauri/floatty-server/src/ws.rs` | **D** with multi-outline awareness | Default-route WS handler now branches on outline query param (lines 246-272). Cannot be naively reverted without losing per-outline subscriptions. |
| `apps/floatty/src-tauri/floatty-server/src/main.rs` | **D** | Constructs `WsState` with `outline_manager`; deletion requires reversing the wiring |
| `apps/floatty/src-tauri/src/db.rs`, `paths.rs` | **D** | `ctx_markers.db` global, NOT per-outline — unaffected by retirement |
| `apps/floatty/src/lib/handlers/outline.ts` | **G** (creates outline + reloads) | Frontend handler; uses default-route + localStorage+reload |
| `apps/floatty/src/App.tsx` (lines 59, 85, 93, 130, 392) | **D** with multi-outline awareness | Reads `localStorage('floatty-outline')` on every boot. Deletion would require choosing whether to keep the localStorage key or remove the boot path. |
| `apps/floatty/docs/reviews/multi-outline-phase1-review.md` | **C** | Audit |
| `apps/floatty/docs/architecture/BBS_OUTLINE_CONVERGENCE.md`, ADRs 001–005 | **C** | Vision/principles — vision-level, not Phase-1-specific |
| `.claude/handoffs/{frontend-outline-switching,blockservice-extraction-step{2b,6}}.md` | **C** | Handoffs |
| `~/.claude/plans/{replicated-spinning-liskov,shiny-gathering-pond,elegant-discovering-hare}.md` | **C** | Plans (outside repo, but referenced) |

**The audit's "feature is sidecar (G)" framing is mostly still accurate** — but `ws.rs` is the load-bearing exception that has emerged since. Naive deletion of `OutlineManager` would break the default WS path.

---

## 5. Cite-file:line parity matrix (mirror of audit shape)

| Default-route endpoint | File:Line | Per-outline mirror | File:Line | Status |
|---|---|---|---|---|
| `GET /api/v1/blocks` | api/blocks.rs (post-#225) | `GET /api/v1/outlines/:n/blocks` | outlines.rs:56-59 | mirror |
| `POST /api/v1/blocks` | api/blocks.rs | `POST /api/v1/outlines/:n/blocks` | outlines.rs:56-59 | mirror |
| `GET /api/v1/blocks/:id` | api/blocks.rs | `GET /api/v1/outlines/:n/blocks/:id` | outlines.rs:63-67 | mirror |
| `PATCH /api/v1/blocks/:id` | api/blocks.rs | `PATCH /api/v1/outlines/:n/blocks/:id` | outlines.rs:63-67 | mirror |
| `DELETE /api/v1/blocks/:id` | api/blocks.rs | `DELETE /api/v1/outlines/:n/blocks/:id` | outlines.rs:63-67 | mirror |
| `GET /api/v1/blocks/resolve/:prefix` | api/blocks.rs | (none) | — | **missing** |
| `GET /api/v1/state` | api/sync.rs | `GET /api/v1/outlines/:n/state` | outlines.rs:32 | mirror |
| `GET /api/v1/state-vector` | api/sync.rs | `GET /api/v1/outlines/:n/state-vector` | outlines.rs:33-36 | mirror |
| `GET /api/v1/state/hash` | api/sync.rs | `GET /api/v1/outlines/:n/state/hash` | outlines.rs:37-40 | mirror |
| `POST /api/v1/update` | api/sync.rs | `POST /api/v1/outlines/:n/update` | outlines.rs:41 | mirror |
| `GET /api/v1/updates` | api/sync.rs | `GET /api/v1/outlines/:n/updates` | outlines.rs:42-45 | mirror |
| `POST /api/v1/restore` | api/sync.rs | (none) | — | **missing** (destructive — intentionally not mirrored?) |
| `GET /api/v1/export/binary` | api/export.rs | `GET /api/v1/outlines/:n/export/binary` | outlines.rs:46-49 | mirror |
| `GET /api/v1/export/json` | api/export.rs | `GET /api/v1/outlines/:n/export/json` | outlines.rs:50-53 | mirror |
| `GET /api/v1/topology` | api/export.rs | (none) | — | **missing** |
| `GET /api/v1/search` | api/search.rs | `GET /api/v1/outlines/:n/search` | outlines.rs:70 | mirror |
| `GET /api/v1/pages/search` | api/search.rs | `GET /api/v1/outlines/:n/pages/search` | outlines.rs:71-74 | mirror (501-stub) |
| `POST /api/v1/search/clear` | api/search.rs | (none) | — | **missing** |
| `POST /api/v1/search/reindex` | api/search.rs | (none) | — | **missing** |
| `GET /api/v1/markers/...` | api/discovery.rs | (none) | — | **missing** |
| `GET /api/v1/presence` | api/discovery.rs | (none) | — | **missing** (presence is global, may be intentional) |
| `GET /api/v1/daily/:date` | api/discovery.rs | (none) | — | **missing** |
| `POST /api/v1/daily/:date/append` | api/discovery.rs | (none) | — | **missing** |
| `POST /api/v1/pages/:name` | api/discovery.rs | (none) | — | **missing** |
| `Backup family (5)` | api/backup.rs | (none) | — | **missing** all |
| `GET /api/v1/health` | (no auth) | (N/A) | — | not applicable per-outline |

**Net**: 15 default-route endpoints have no per-outline mirror; 19 have mirrors. The audit's "13 missing / 4 partial" has resolved into "15 missing / 0 partial" — the partials shipped no further, the missings stayed missing.

---

## 6. Cleanup-readiness verdict + execution sequence

**ENTANGLED-but-tractable. Single bundled deletion PR.** The synthesis sketched a 5-phase plan (Phase 0 evidence → Phase 5 reintroduce scope later); since dozens of post-merge PRs landed without using the named-outline path (per evan), Phases 0-3 collapse into one cleanup commit and Phases 4-5 become followup work tracked by separate Linear tickets.

### Phase 0 — Evidence pass (already done, this recon)

The recon body satisfies Phase 0:
- §2: 9 audit claims re-verified; only `ws.rs` is post-audit drift
- §3: every commit since 2026-04-07 classified — no commit *intentionally* depends on named-outline behavior; FLO-679 PR 2 threads a *shared* helper through per-outline call sites that the deletion will simply drop
- §4: 21 paths classified A–G; only `ws.rs` and `App.tsx` are partial-D entanglements
- §5: 15 missing / 0 partial parity routes — the implementation never closed the loop

**Verdict from evidence**: deletion is the right shape. Keeping it as quarantine "until proven dead" is unnecessary — the evidence already proves it dead.

### Phase 1+2 — Cleanup bundle (one PR)

Order matters: reverses → deletions → docs/links. Trying to delete `outline_manager.rs` before reversing `ws.rs` produces a compile failure that masks the real cleanup boundary.

1. **Capture decision** in three durable homes (§8.0) — ADR-006 draft from §1 above is ready to commit.
2. **Reverse symmetry-harness per-outline arms** (`apps/floatty/src-tauri/floatty-server/tests/symmetry_ancestor_context.rs`). Harness itself stays load-bearing for FLO-679 default-route correctness; only the per-outline arms drop.
3. **Reverse `ws.rs` hybrid** — collapse `WsState` to `default_broadcaster` only; remove the `outline` query branch (`ws.rs:246-272`); update `main.rs:442` wiring; drop the `WsQuery` deserializer; `start_heartbeat` already default-only.
4. **Reverse per-outline call sites in shared helpers** — `compute_ancestor_context`, `attach_ancestor_context`, `shape_search_hit` (FLO-679 PR 2) stay; only their consumers in `api/outlines.rs` go.
5. **Delete the feature surface** (~1300 lines net):
   - `apps/floatty/src-tauri/floatty-server/src/outline_manager.rs` (611 lines)
   - `apps/floatty/src-tauri/floatty-server/src/api/outlines.rs` (563 lines)
   - `apps/floatty/src-tauri/floatty-core/src/outline.rs` (162 lines, `OutlineName` type)
   - `api/mod.rs`: drop outlines route registration + `OutlineManager` re-export
   - `lib.rs`: drop `OutlineManager` re-export
   - `apps/floatty/src/lib/handlers/outline.ts` (frontend `outline::` handler)
   - `apps/floatty/src/App.tsx`: remove `localStorage('floatty-outline')` reads (lines 59, 93, 130, 392) + strategy comment (line 85). Migration: clear stale key on next boot to avoid 404 navigation if a user has it set.
6. **Close documentation surfaces**:
   - `apps/floatty/docs/reviews/multi-outline-phase1-review.md` — keep as historical artifact, prepend `> **Status**: superseded by ADR-006. Retained for archaeology.`
   - `.claude/handoffs/frontend-outline-switching.md` — delete (decision-specific handoff, no longer relevant).
   - `.claude/handoffs/blockservice-extraction-step{2b,6}.md` — **keep**. BlockService extraction was useful refactor independent of multi-outline.
   - `apps/floatty/docs/architecture/BBS_OUTLINE_CONVERGENCE.md`, ADRs 001–005 — **keep**. Vision-level "outline IS canonical" framing predates Phase 1 and doesn't depend on its storage topology. (Note in ADR-006 that "outline" returns later as scope, not store.)
   - `~/.claude/plans/{replicated-spinning-liskov,shiny-gathering-pond,elegant-discovering-hare}.md` — leave (user plans, outside repo).
   - Plus any `pnpm` workspace cleanups, lint discipline gate (per `lint-discipline.md` §4).
7. **Close [[FLO-622]] as won't-do** with link to ADR-006 + this recon.
8. **Unaffected paths** (touch nothing): `apps/floatty/src-tauri/src/db.rs`, `paths.rs` (`ctx_markers.db` global, `FLOATTY_DATA_DIR` already supports world switching), the ctx-markers pipeline, default-route HTTP/WS, symmetry-harness default arms, BlockService.

### Phase 3 — Workspace commands (followup, not in cleanup PR)

Track as a separate Linear ticket. The synthesis sketched the surface:

```bash
floatty workspace list
floatty workspace switch <name>
floatty workspace snapshot
floatty workspace restore <snapshot>
floatty workspace serve --workspace <name>
floatty workspace path <name>
```

Under the hood: `workspace = data directory`. This matches the *actual* workaround that proved useful (scripted backup/restore of `default`). Today's recon doesn't gate on this; the cleanup PR can land first, then workspace commands land as their own ticket.

### Phase 4 — Outline-as-scope reintroduction (much later, only if justified)

Track as a deliberate followup. Future command envelope shape (from synthesis):

```json
{
  "command": "outline.create_child",
  "actor": { "type": "agent", "id": "claude" },
  "surface": "mcp.outline_explorer",
  "workspace": "default",
  "scope": { "view": "current", "root": null },
  "args": { "parentId": "blk_123", "content": "new block" },
  "idempotencyKey": "optional"
}
```

**Don't build the command layer on top of the current default/named split.** The split is what's getting retired; the command layer needs to start from the actual-used system (single workspace, scope as projection/root/filter, shared semantics across surfaces).

---

## 7. Proposed cleanup PR scope

Per `personal-tool-pr-scope.md`: bot-only review = bundle aggressively. Single PR scoped to Phase 1+2 of §6 (reverses + deletions + FLO-622 close + ADR-006 commit).

**Estimated scope**: ~1300 lines deleted (611 + 563 + 162) + ~50 lines reversed in `ws.rs` + ~10 in `main.rs` + ~5 per call site in shared helpers + ~10 in `App.tsx`. Plus +~80 for ADR-006. Net: ~1400 lines deletion + structured replacement docs.

CI lint/typecheck/clippy/fmt acts as the symmetry check for "did anything else import from these modules?" — broken imports surface immediately.

**Branch name**: `chore/flo-XXX-retire-db-per-outline` (Linear ticket assigned in §8.0).

**PR title**: `chore: retire DB-per-outline as mainline architecture (ADR-006)`

**PR description**:
- Link ADR-006 + this recon handoff
- Headline reframe: "Worlds vs Outlines — separate persistence is the wrong layer for the actual need; outline returns later as command/view/scope inside a workspace, not as a separate store"
- Lived-use evidence: feature was used ~2 days post-merge; the one real separation scenario was solved by scripted backup/restore of default
- Order-of-operations from §6 (reverses → deletions → docs/links)
- Confirmation of unaffected paths: `ctx_markers.db`, `paths.rs`, default-route HTTP/WS, BlockService extraction (Phase 2 — useful refactor stays)
- Bot-review-friendly framing: "confirmed deletion; reviewer will flag missing tests / dropped routes — those are intentional, the test surface goes with the feature"
- Quote completion-gate output verbatim per `lint-discipline.md` §4 (`pnpm lint --force`, `pnpm typecheck`, `pnpm test:run`, `cargo fmt --check`, `cargo clippy --workspace --all-targets`, `cargo test --workspace`)

**Pre-PR symmetry sweep** (per `symmetry-check.md`):
```bash
git grep -nl --no-color "OutlineName\|OutlineManager\|OutlineContext\|outlines_dir\|outline_name\|outlineName" -- apps/floatty packages
```
Catalog every hit in a "remaining sweep" section of the PR description. Surface non-trivial counts to evan before opening the PR.

**Specifically NOT in this PR** (followup tickets):
- `floatty workspace ...` CLI (Phase 3) — separate ticket
- Outline-as-scope reintroduction (Phase 4) — separate ticket, gated on command-grammar work
- Updates to `floatty-backend` skill / `api-reference.md` if they reference outline routes — fold in if trivial, otherwise separate sweep ticket

---

## 8. Decision capture + process lesson + open questions

### 8.0 First action: capture the decision durably (before any deletion code lands)

The synthesis artifacts already exist (`~/.floatty/artifacts/2026-05-05-conversation-map.{json,jsx}`) but live outside the repo. Three durable homes inside the trust boundary, all parallelizable:

| Location | Hand | Why |
|---|---|---|
| **ADR-006** at `apps/floatty/docs/adrs/ADR-006-retire-db-per-outline.md` | cowboy writes (text drafted in §1 above), evan signs off | Canonical decision in the repo. The cleanup PR references it. ~80 lines, ready to commit. |
| **Sysops-log post** via `floatctl bbs board post --board sysops-log --persona cowboy --title "Retire DB-per-outline — Worlds vs Outlines"` | cowboy posts | QMD-indexed; surfaces in recall. Captures the *rationale* ("design reconnaissance that accidentally landed in main", lived-use test) that an ADR drys out. Link the conversation-map artifacts + this recon. |
| **Linear ticket** (new, not FLO-622; track as cleanup parent) | cowboy creates, evan adopts | Work-tracking handle. Title: "Retire DB-per-outline as mainline architecture (ADR-006)". Children optional but useful: one for cleanup PR, one for `floatty workspace` CLI (Phase 3), one as placeholder for outline-as-scope reintroduction (Phase 4) so it's not lost. |

**Recommendation**: all three, in order ADR → sysops-log → Linear. Total time ~10 min once plan exits and edits are unblocked.

Per [[FLO-622]]: close as won't-do, comment with link to ADR-006. Per `~/.claude/rules/check-before-create.md`, the ADR is a net-new artifact (no existing ADR covers the retirement), so creation is appropriate.

### 8.1 Process lesson — integration-branch policy (capture as a rule)

From the synthesis: "the issue is not that exploratory code exists. Exploratory code is useful. The issue is that this exploratory architecture crossed into main before the distinction had settled. Future agent/branch policy should encode this."

Suggested rule (target file: `apps/floatty/.claude/rules/integration-branch-discipline.md` or similar):

> **Architecture experiments land on integration branches, not main.** Mainline merges of architecture-shape changes (new domain primitives, new storage topologies, new cross-cutting abstractions) require explicit human confirmation that the design is now intended as a building block.
>
> Large architecture changes require:
> - ADR (proposed → accepted)
> - Rollback note (what to do if this turns out wrong)
> - Status label: built / partial / experimental / retired
>
> Agents may prepare PRs but **must not silently change the integration target for large work**. If a feature was scoped against `feat/integration-X` and an agent retargets to `main` mid-stream, surface that to evan before merging.
>
> The multi-outline DB-per-outline retirement is the canonical worked example: ~1400 lines of well-built code that landed against the wrong target before the design distinction had settled.

This rule belongs in the floatty repo (it's project-shaped) and should be referenced from the global `.claude/rules/branching-discipline.md` if one exists.

### 8.2 Remaining open questions

1. **Symmetry harness arms** — confirm: drop per-outline arms, keep default-route assertions? (My read: yes; FLO-679's value is default-route shape consistency.)
2. **Frontend `localStorage('floatty-outline')` migration** — clear stale key on next boot, or leave it harmless-unused? (My read: clear it; stale key + no outline route = 404 navigation. Small, safe migration.)
3. **The cleanup PR's place in the rich-doc-primitives worktree** — should the deletion PR branch off `main` (clean) or off `feat/rich-doc-primitives` (current cwd)? (My read: branch off `main` — the cleanup is independent of rich-doc-primitives, and stacking introduces ordering complexity per `feedback_stacked_pr_merge_order.md`.)
4. **The recon-prompt's "April 14 audit" framing and file-size numbers (571/491)** don't match the 2026-04-07 audit baseline. Cosmetic, but if those numbers came from a separate snapshot, link it.

(Open questions previously about "is the decision real?" are resolved.)

---

## 9. Caveats / known gaps in this recon

- **Worktree is on `feat/rich-doc-primitives`, not `main`.** Every claim cites `git show main:path` blobs. If the cleanup branch pins a different sha, re-cite against that sha.
- **Sub-agent could not locate the `floatty-backend` skill body** from its environment. The `.claude/rules/api-reference.md` content loaded into this conversation shows default-route URLs only, which is provisional confirmation. A targeted re-read of `~/.claude/skills/floatty-backend/SKILL.md` in the cleanup PR would harden this.
- **Linear FLO-622 GraphQL response did not surface child issues or comments**, only top-level state. If FLO-622 was amended via comments since 2026-04-14, that history isn't in this report.
- **No conversation-export search** (rotfield deep-lore) was performed — but the synthesis artifacts (`~/.floatty/artifacts/2026-05-05-conversation-map.{json,jsx}`) make this moot; the decision document lives in those files.

---

## 10. Suggested next move (post-plan-exit sequence)

1. **Move this plan to its handoff home** at `apps/floatty/.claude/handoffs/multi-outline-rollback-recon-2026-05-05.md` (or repo-root `.claude/handoffs/...`, whichever is the standard floatty location). Plan mode constrains to the plan file; the recon needs to live next to other handoffs.
2. **Commit ADR-006** at `apps/floatty/docs/adrs/ADR-006-retire-db-per-outline.md` using the §1 draft text. Same branch/commit as the handoff move, or its own — small enough to bundle.
3. **Sysops-log post** via `floatctl bbs board post --board sysops-log --persona cowboy --title "Retire DB-per-outline — Worlds vs Outlines"`, body links the artifacts + the handoff + ADR-006.
4. **Linear ticket** "Retire DB-per-outline as mainline architecture (ADR-006)". Close [[FLO-622]] as won't-do with a comment linking the new ticket + ADR-006.
5. **Save memory entries** (post-plan-exit, since plan mode restricts edits):
   - Feedback: "Don't say 'premise unfounded' when decision was just made by user — absence of repo-evidence ≠ absence of decision."
   - Project: "Worlds vs Outlines is the canonical floatty domain split: world = data-dir/process/routing, outline = command/view/scope. ADR-006 retires the DB-per-outline implementation."
   - Reference: "Decision artifacts live at `~/.floatty/artifacts/YYYY-MM-DD-conversation-map.{json,jsx}` — durable conversation maps."
6. **Process lesson** — write `apps/floatty/.claude/rules/integration-branch-discipline.md` per §8.1 (or fold into existing branching/PR-scope rule). Optional but recommended; the multi-outline retirement is the canonical worked example.
7. **Then** open the cleanup PR per §6+§7. The PR description references the handoff, the ADR, the sysops-log post, and the Linear ticket. Bot-review-friendly framing: "confirmed deletion; reviewer flags about missing tests/dropped routes are intentional."

Items 1–4 are small (file moves + posts + ticket creation) and can land in a single commit on a `chore/retire-db-per-outline-decision-capture` branch. Item 7 (cleanup PR) lands as its own branch off `main`.

---

**Verification commands** (read-only, re-runnable from any clean checkout of `main`):

```bash
cd /Users/evan/projects/_float/float-substrate/floatty
git rev-parse main
git show main:apps/floatty/src-tauri/floatty-server/src/api/outlines.rs | wc -l         # 563
git show main:apps/floatty/src-tauri/floatty-server/src/outline_manager.rs | wc -l      # 611
git show main:apps/floatty/src-tauri/floatty-server/src/config.rs | grep -n active_outline   # zero hits
git show main:apps/floatty/src-tauri/floatty-server/src/ws.rs | sed -n '240,275p'
git show main:apps/floatty/src/App.tsx | grep -n "floatty-outline"                       # 5 hits
git log main --grep="retire\|quarantine\|deprecate.*outline\|rollback.*outline" --after="2026-04-07"   # zero hits
git log main --oneline --after="2026-04-07" -- apps/floatty/src-tauri/floatty-server/src/outline_manager.rs apps/floatty/src-tauri/floatty-server/src/api/outlines.rs
~/.claude/skills/linear-graphql/linear-gql.sh 'query { issue(id: "FLO-622") { state { name } updatedAt title } }'
```

`- ctx::2026-05-05 @ 09:20 AM [project::floatty] [mode::recon] multi-outline rollback recon — Worlds vs Outlines, retire DB-per-outline as mainline (ADR-006). Decision: storage topology goes, vocabulary survives. ws.rs hybrid + symmetry-harness arms reverse before deletion. FLO-622 superseded-not-revived; follow-up primitive is workspace switching, not boring-basic redux. ENTANGLED-but-tractable, ~1400 lines net deletion in single bundled cleanup PR.`
