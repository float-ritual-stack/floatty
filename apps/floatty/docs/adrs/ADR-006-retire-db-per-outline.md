# ADR-006: Retire DB-per-outline as Mainline Architecture

## Status

Proposed → Accepted on cleanup-branch landing.

## Source

- `~/.floatty/artifacts/2026-05-05-conversation-map.{json,jsx}` — synthesis artifacts (durable conversation maps from morning iteration 2026-05-05)
- `.claude/handoffs/multi-outline-rollback-recon-2026-05-05.md` — recon body with cite-file:line audit re-verification, drift archaeology, surface classification, parity matrix
- Linear FLO-622 — superseded fork-in-the-road, to be closed as won't-do

## Context

Multi-outline support was intended to land via an integration branch with staged PRs but was merged into `main` before the design distinction between world/workspace and outline/view had settled. Phase 1 implements named outlines as separate persisted SQLite/Y.Doc stores under `{data_dir}/outlines/{name}.sqlite`; `default` remains a special legacy path. Phase 2 BlockService extraction (PRs #213-214) was useful refactor work independent of the storage topology.

The feature has seen little real use beyond initial testing (~2 days post-merge). In the one real separation/switching scenario, scripted backup/restore of the default data directory was more useful than using named outlines. Subsequent main work (dozens of PRs) has continued under the assumption that `default` is the only real active path; nothing has intentionally landed on the named-outline path.

The current shape risks the worst version of multi-outline: enough complexity to complicate every future surface (command layer, agent write tools, float-box deployment, subscriptions, BBS bridges, `/compact`), not enough actual usage to justify the cost. Future agents reading the codebase may treat the named-outline path as canonical because it exists in `main`.

The conceptual error was implementing **outline as storage partition** before proving it as **command/view scope**. Two distinct concerns got collapsed into one storage topology:

- **World / workspace** = data-dir / process / server route / subdomain. Selected by `FLOATTY_DATA_DIR`, deployment routing, snapshot/restore. Owns persistence, backups, auth boundary, global config.
- **Outline / view / scope** = command/view/projection inside a world. A root, filter, session, or workbench target over the block graph. Owns focus, agent scope, subscriptions, compact candidates.

## Decision

- Stop treating DB-per-outline as mainline architecture. Retire the named-outline storage semantics from `main`.
- Preserve the lessons and useful vocabulary; do not build future features on the current `/api/v1/outlines/:name` storage path.
- World/workspace separation will be handled through data directories (`FLOATTY_DATA_DIR` already supports this), process/config boundaries, and eventually server routing or subdomains. First-class `floatty workspace ...` commands (list/switch/snapshot/restore/serve) become the separation primitive.
- Outline returns later as a command/view/scope concept within a workspace: a root, projection, filter, session, or workbench target over the block graph. No separate DB unless a future requirement proves the need.
- Future command grammar carries `workspace + scope` from day one. No surface (Raycast, CLI, phone, agent, BBS bridge, floatty UI) needs to know whether it's talking to "legacy default" or "named outline mode."

## Consequences

- Main becomes simpler and safer for command-layer work.
- Some well-built code (~1300 lines server-side) is removed despite being well-built; lessons survive in this ADR + retired/ design notes.
- Future agents have less misleading architecture to build on.
- Workspace switching becomes the near-term separation primitive.
- Multi-outline can return later if justified, but with a better domain boundary (scope, not store).

## Non-goals

- This does not abandon outline as a concept.
- This does not abandon many surfaces or many workbenches.
- This does not require a full rewrite of the substrate.
- This does not require deleting useful design notes or tests that can be reframed as desired-behavior specs.

## Bar to revisit

Reintroducing separate-persisted-outlines requires one of:

- Independently syncable documents
- Independently exportable/importable notebooks
- Separate access control inside one server process
- Large-scale performance isolation
- Different retention/backup policies per outline
- True multi-tenant behavior inside one process
- A user workflow where multiple persisted outlines are actively used without workspace switching

If the need is only focus, routing, view, project grouping, agent scope, subscriptions, or compact candidates, prefer outline-as-view/scope inside a workspace.

## Process lesson

This ADR is also a worked example of the integration-branch discipline rule (`.claude/rules/integration-branch-discipline.md`). Architecture experiments belong on integration branches with explicit human "this is now a building block" confirmation before mainline merge. Multi-outline crossed that line silently and became accidental architecture; the retirement is the cost. Future architecture-shape changes (new domain primitives, new storage topologies, new cross-cutting abstractions) require ADR + rollback note + status label (built / partial / experimental / retired) before mainline.
