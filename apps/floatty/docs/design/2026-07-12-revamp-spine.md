---
title: Revamp spine — five primitives under the feature pile
date: 2026-07-12
status: proposed
related: "[[FLO-378]] [[FLO-474]] [[FLO-475]] [[FLO-476]] [[FLO-477]] [[FLO-414]] [[FLO-443]] [[FLO-522]] [[FLO-564]] [[FLO-652]] [[FLO-762]] [[FLO-796]] [[FLO-797]] [[FLO-798]] [[FLO-799]] [[FLO-800]] [[ADR-006]] [[2026-06-26-offline-and-fast-boot]]"
architecture-shape: mixed   # per-primitive verdicts inline — P3 and P5 trip the ADR + integration-branch rule; P2 and P4 do not
---

# Revamp spine — five primitives under the feature pile

## The one-sentence version

The ~18-item revamp pile ([[0da16187]], [[fa34d270]], three sessions of
re-surfaced itches) is five primitives, four of which extend systems that
already exist — the only genuinely new architecture is the **visibility
model** that lets the outline project a public HTTP surface safely.

## Method + hypothesis verdict

Prior synthesis hypothesized four primitives (object store / addressing-alias
model / attribute-query surface / filesystem-watch). Verdict after code recon:

- **Three survive** (P1 addressing, P2 query surface, P3 object store) with
  sharper extend-vs-build boundaries than hypothesized.
- **Filesystem-watch shrinks**: the right implementation is not a generalized
  fs-watcher — it is a second *extractor* on the ctx aggregation watcher that
  already tails `~/.claude/projects` (P4). Much smaller than hypothesized.
- **One was hiding**: the "public filesystem" headline is not a composition of
  the other four — its load-bearing core is a **visibility/permission model**
  (P5) that has no precedent anywhere in the codebase and is the only
  rent-grade piece.

A primitive earned its place only if ≥2 pile features ride it AND it names the
existing subsystem it extends. Coverage matrix in §8 accounts for every pile
item.

---

## P1 — Path addressing (read + write)

**What exists today** (all single-hop, foundation freshly hardened):

- Unified nav funnel: `handleChirpNavigate` (`src/lib/navigation.ts:322`)
  resolves block-id prefix → page name, shared by chirp, doors, and the
  `floatty://` deep-link scheme (`App.tsx:214`; verbs `navigate/block/execute/upsert`).
  This is where [[FLO-378]] actually landed — a verb scheme + single-hop
  resolver unification, **not** a path resolver.
- Block-id prefixes: `resolveBlockIdPrefix` (`src/lib/blockTypes.ts:87`),
  git-sha style, ≥6 hex chars.
- Page names: `findPage` (`useBacklinkNavigation.ts:71`) — case-insensitive,
  heading-stripped, oldest-createdAt wins, mirroring the server.
- Server: `PageNameIndex` with oldest-wins tie-break
  (`page_name_index.rs:295`), id-guarded remove (`:359`), normalization parity
  contract (`page_name_index.rs:444` ↔ `src/lib/pageTitle.ts:22`);
  `find_or_create_page` under `SemanticCache` mutex (`discovery.rs:436`,
  `:405`); semantic endpoints `POST /api/v1/pages/:name` (`discovery.rs:647`)
  and `POST /api/v1/daily/:date/append` ([[FLO-652]]) — **path-addressed
  writes in embryo**, one segment deep.
- Startup healing: `reconcilePageTwins` (`useSyncedYDoc.ts:510`) — quirk-audit
  cluster F just shipped the whole uniqueness ladder.

**The gap**: `>` is inert inside `[[...]]` — `parseWikilinkInner`
(`wikilinkUtils.ts:51`) splits only on top-level `|`, so
`[[page > section > block]]` is one opaque page name today (it will miss, or
worse, create a junk page named "page > section > block"). No descendant-walk
resolver exists on either side; no segment-walking find-or-create exists
server-side.

**Verdict: EXTEND.** Net-new machinery on three surfaces, all sitting on the
hardened single-hop foundation:

1. Path tokenizer in `wikilinkUtils` (split target on `>`, respecting nesting
   and the `|`-alias split) — frontend + a Rust twin.
2. Descendant-walk resolver: segment 1 via `findPage`/`PageNameIndex`, then
   descend childIds matching content/headings (fuzzy per [[FLO-474]]'s spec).
3. Segment-walking find-or-create for writes ("mkdir -p"): extends the
   [[FLO-652]] semantic-endpoint pattern —
   `POST /api/v1/path/2026-07-12 > rexall > meetings` creates missing
   intermediates under the same `SemanticCache` serialization.

**Architecture-shape: YES (both sides, one ADR).** Path-addressed writes are
a new public API surface with new collision semantics; the descendant-walk
resolver on the read side is itself a new shared walker — the directional
sibling of the protected `walk_ancestors` primitive, whose own consolidation
earned ADR-grade treatment ([[FLO-679]] PR 1). One ADR covers path grammar +
resolution semantics + the extended parity contract for both. New
write-request structs follow serde-api-patterns (`deny_unknown_fields`).

**Invariant hotspot**: the normalization parity contract
(`page_title_from_content` ↔ `getPageTitle`) must extend to whatever section
matching the walker uses, on both sides, in the same PR — this is exactly the
drift class symmetry-check exists for, and exactly the surface quirk-audit §F
just finished healing. One canonicalizer per side, tested for parity.

**Features unlocked**: [[FLO-474]] (nav), [[FLO-476]] (alias + path-scoped
disambiguation — its spec already reuses this syntax), [[FLO-475]]
(normalization), path-addressed API writes (un-ticketed), daily @today landing
(a default address), auto-link bare patterns (address recognition in
`inlineParser`), and P5's slug router.

---

## P2 — Query/recency surface (backlinks, link types, attributes, recency)

**What exists today** (the engine is ~90% built; the gap is surface):

- Filter-only search: empty `q` + `AllQuery` (`api/search.rs:75`,
  `search/service.rs:227`); `marker_type`/`marker_val`, block-type
  include/exclude, created/ctx time ranges all live params.
- `updatedAt` on every hit ([[FLO-684]], `search.rs:150`) — and the Tantivy
  schema already has `updated_at` as a FAST column *"for recency sorting"*
  (`search/schema.rs:65-68`). **No `order_by_fast_field` is wired** — ranking
  is relevance-only (`service.rs:258`). Recency sort is a wiring gap, not a
  build.
- Graph read-side: `GET /api/v1/topology` ([[FLO-394]], `api/export.rs:22`) —
  whole-outline page graph, one call; `AncestorContext` with `inboundCount` /
  `inboundSamples` / `ancestorOutlinks` ([[FLO-679]]) on every block-returning
  endpoint.
- Link-type beachhead: `classifyBacklink` (`src/lib/backlinkClassify.ts:35`)
  and its server mirror `classify_block_kind` — nav_node / content_block /
  leaf_marker classification already exists.
- Backlinks UI: `LinkedReferences.tsx`, page-scoped, frontend-scan based.

**The gap**: recency sort wiring; backlinks for *any* block (not just pages)
that survive zoom; a link-type taxonomy richer than the 3-kind beachhead
(hub/daily/index vs semantic — so 3-hop saturation stops making connections
meaningless); and a browse/facet surface (list `render::` blocks, filter
`[project::xyz]`, faceted explorer).

**Verdict: EXTEND.** Tantivy is ephemeral (nuke-and-rebuild per ADR-005), so
schema changes are free — no migrations, no storage risk.

**Architecture-shape: NO**, with one contract caveat: `classifyBacklink`'s
output is the `kind` field inside `AncestorContext` — a wire contract
enforced by the `symmetry_ancestor_context.rs` harness (protected
architecture). Widening the taxonomy must either land as a **separate field**
(likely right: `kind` stays 3-valued, link-type is a new facet) or update the
harness in the same PR. Decide in the PR, not by drift.

**Features unlocked**: [[FLO-522]] (recently-updated blocks door — recency
sort + `updatedAt` makes it nearly free), any-block backlinks +
zoom-keeps-backlinks (prior art: [[FLO-711]] block-id wikilinks missing from
panel, [[FLO-456]] O(13k) backlink scan perf, [[FLO-763]]/[[FLO-440]] UX
revamp family, [[FLO-514]] neighborhood endpoint), faceted backlink explorer,
`render::`/attribute listing, link-type classification (un-ticketed),
[[FLO-443]] gardening queries ("stale + no inbound links" is a P2 query),
[[FLO-477]] hierarchical tag queries (prefix-match on marker values), and
P5's exposure audit (`public::`-filtered topology).

---

## P3 — Object store (float-box attachments/artifacts)

**What exists today**: serve-only.
`GET /api/v1/attachments/:filename` (`discovery.rs:38`) reads from
`{data_dir}/__attachments` (`:322`) with path-traversal guard, extension-based
content-type (including html), immutable-caching + ETag. Client LRU in
`attachmentCache.ts`.

**The gap**: there is **no upload path anywhere in the server** — no POST/PUT
for binary content exists. Today adding an image means ssh-ing bytes onto
float-box. No slug allocation, no list/browse endpoint, no
unreferenced-attachment detection.

**Verdict: BUILD (small).** The pipeline is upload → slug → serve → browse:

- `POST /api/v1/attachments` (multipart or raw bytes + filename) → stores
  under `__attachments`, returns `{slug, url}`. Reuses the existing traversal
  guard + content-type map.
- `GET /api/v1/attachments` (list + metadata) — the browse half.
- Unreferenced detection = a P2 query (attachments list ⨝ outlink/img
  references), not new machinery.
- Artifacts are the same pipeline with `.html`/`.jsx` content-type — "paste an
  artifact, get a slug" replaces mutagen-synced files.

**Architecture-shape: YES.** New write semantics for binary content + new API
surface on the shared authority → short ADR (storage layout, slug scheme,
size/type limits, backup interaction). Doesn't need a long-lived integration
branch — it's one coherent surface — but the ADR precedes the PR.

**Features unlocked**: [[FLO-414]] (client drag-drop/preview becomes a
consumer), [[FLO-564]] (door attachment API becomes a consumer),
artifacts-served-from-float-box, artifact-as-attachment paste, and P5's
content-negotiated artifact serving.

---

## P4 — Agent-activity extractor (recent files, then watch::)

**What exists today**: `ctx_watcher.rs` — notify-crate watcher (poll-backed,
5s default) recursively tailing `~/.claude/projects` `.jsonl` files with
per-file byte offsets (`ctx_watcher.rs:218-282`), extracting `ctx::` markers
into SQLite `ctx_markers.db`, fed to the sidebar via `get_ctx_markers`. It is
Tauri-shell-side, hardwired to `.jsonl` + `ctx::`.

**The gap and the reframe**: the pile item is "agent writes a file, I go
hunting for it." The hypothesized fix was a filesystem watcher; the better fix
(proposed in the source page itself) is to watch what's *already watched*:
Claude Code session logs contain every Write/Edit tool call with full path +
session context. A second extractor on the same watcher yields recent files
**with provenance** (which session, which project, why) — something a bare
fs-watch can never provide.

**Verdict: EXTEND.** Add a file-write extractor beside `extract_ctx_content`
(`ctx_watcher.rs:286`), a table beside `ctx_markers`, a sidebar surface beside
the ctx sidebar (or a door, per [[FLO-522]]'s shape). Pattern-filter to
markdown/text under watched roots so "every .js file" noise stays out.

**Architecture-shape: NO** — second consumer of an existing pipeline, same
shape as the first. Normal PR.

**Deferred half**: `watch::` live file mirroring into blocks, and
outline→file write-back. Both are real but neither has a settled conflict
story (the fast-boot doc's LWW-plus-conflict-surface decision is the likely
template). Park until P4's read half proves the value. One constraint is
already settled by doctrine, not deferred: per
`architecture/agentic-runtime/provenance-and-links.md`, **no durable
artifact without a backlink into the outline** — the write-back half must
carry the external-ref back-pointer or it is not durable. P4's read half
should *enforce* provenance, not merely surface it.

**Features unlocked**: recent agent-written files w/ session context
(un-ticketed), `@`-mention file autocomplete (the recent-files list is the
index), [[FLO-479]] file browser gets its "recent" spine, watch:: later.

---

## P5 — Visibility model + public projection (the headline)

**What exists today**: nothing — deliberately. `auth.rs` is a single flat
bearer key over every route (`auth.rs:64`), health + CORS-preflight exempt
(`:38-46`), loopback trust **deliberately removed** in the FLO-762 hardening
(`:48-53`). There is no per-route, per-block, or per-path authorization
concept anywhere. The [[FLO-762]] audit history (CORS-Any + loopback bypass →
browser-pivot exfil risk → bypass ripped out in [[PR #313]]) is the precedent:
this tree holds client + personal content, and the last time a trust shortcut
existed it was flagged and removed.

**The design — two tiers** (fork resolved mid-design 2026-07-12: the earlier
default-deny *gate* framing is superseded by the permeable-boundaries
doctrine — "translate at the boundary, not gate." Default-deny survives as
the *outcome* — absent flag = invisible outside the ecosystem — but the
enforcement architecture changes):

- **Tier 1 — float-ecosystem visibility (the main thing).** `public::true`
  is scope metadata, extraction free via the existing marker pipeline.
  Today "the ecosystem" = bearer-key holders, so the flag's first teeth are
  the render layer: a `[[link]]` whose target the viewer can't access
  **degrades to its alias text** — a phrase in the sentence, not a link, not
  a 404. That is a `classifyBacklink` render branch (P2 coupling), not a new
  access-control layer. Per-viewer identity (logged-in-but-not-Evan) is a
  later, separate auth concern — named in the ADR, not built now.
- **Tier 2 — internet-public (neat, later, rarer).** Translate, don't gate:
  `publish::` is a **verb** — an agent authors a public *version* of the
  block (drop internal markers, degrade unpublished links to text, vanish
  unpublished children), written to a **separate public store**, served by a
  dumb static surface. The private floatty-server never faces the public
  endpoint — the [[FLO-762]] browser-pivot class is dead *by construction*,
  not by filter discipline. Prior art is float.dispatch itself: the dispatch
  pipeline IS a boundary translator ("earshot ≠ audience"); this points it
  at an HTTP path. Judgment at publish time ("this half is pharmacy
  internal, cutting it") is something no flag can do.
- **Why translate beat gate**: gate = every read of the live tree filtered
  correctly forever, private tree faces the browser on each request;
  translate = one explicit transform at publish time, audit = `ls` the
  public store. Test the translator once; don't audit flags forever.
- **Reviewer findings, re-scoped**: the router-composition
  (`main.rs:399-433` ws_routes precedent) and cache-control
  (`discovery.rs:347-349` auth-coupled `private`) findings applied to the
  gate model's live-tree `/pub` route. Under translate the ADR's first
  question becomes "does ANY public route live on floatty-server at all?"
  (likely no — static surface). Both findings stay on the ADR checklist for
  whichever route shape survives. CORS `allow_origin(Any)` (`main.rs:388`)
  and the tailnet-vs-internet exposure tiers remain threat-model items.
- **Exposure audit still ships first**: tier 2 audit is enumerate-the-store;
  tier 1 scope review is the `public::`-filtered topology/P2 query. Prior
  art to extend, not build: passenger-manifest's topology lens +
  `getCollection(marker, value)`.
- **The grant is fields, not a boolean** (floated 2026-07-12; the ADR
  enumerates them): `public:: true` (audience scope) · `expire::` (TTL —
  the one field implying a **sweep job**, not just a read-check; an unread
  expired grant must still die) · `password::` (capability-by-knowledge —
  a *different auth axis* from identity-scoped visibility; the
  send-a-client-a-link-without-a-login case) · `slug::` (the address it
  answers to). The exposure audit grows to match: every live grant, its
  scope, expiry, and whether it is password-gated.
- **One slug system, not two**: `slug::` is P1 machinery — a human-chosen
  alias, the addressing family ([[FLO-476]]) cashing in — that P5's router
  *consumes*. The ≥2-features test passing loud; do not build a second slug
  namespace inside P5.
- Write verbs (`PUT`/`POST` to a path — dispatch-as-destination) ride P1's
  path-write API under the *authenticated* surface; public write is out of
  scope entirely.

**Verdict: BUILD (tier 2) + EXTEND (tier 1).** The marker is free; the
link-degradation branch extends P2's classifier; the translator + public
store are new (but shaped like dispatch, which exists).

**Architecture-shape: YES — the strongest case in the pile.** New public API
surface + security boundary → ADR (threat model, grant semantics, inheritance
rules, audit query) + integration branch + rent-grade review. Depends on P1
(resolver) and P3 (artifact serving); P2 supplies the audit.

**Features unlocked**: public `/slug/path` URLs, dispatch-as-destination
(skills PUT to a floatty path instead of Readwise/BBS — the only dispatch
target that stays editable), browser-viewable artifacts, `/conversation-map`
posting into the outline AND being a URL.

---

## §6 Narrowest proof-of-shape spike (P5, translate model)

One block, one translation, one URL:

1. `publish::` fires on one block → transform runs (strip internal markers,
   degrade unpublished `[[links]]` to alias text, drop unpublished children)
   → writes a static artifact to a gateway path in the public store.
2. A dumb static surface serves it — content-negotiated md/html.
3. Verify **the private floatty-server is not network-reachable from the
   public surface** (the no-pivot property, by construction).
4. The audit: `ls` the public store + `marker_type=public` topology query.

No resolver on the live tree, no auth carve-outs, no write verbs. Proves
translation + separate store + no-pivot in one PR-sized spike on an
integration branch.

## §7 Sequencing

The [[2026-06-26-offline-and-fast-boot]] track is `architecture-shape: true`,
already staged (Phase 0 foundation → Phase 1 fast boot → Phase 2 offline), and
its file footprint (`useSyncedYDoc.ts`, `sync.rs`, `store.rs`,
`persistence.rs`, `idbBackup.ts`) is disjoint from the revamp's wave-0/2/3
footprint (`discovery.rs`, `page_name_index.rs`, `search.rs`, `auth.rs`,
`ctx_watcher.rs`, `wikilinkUtils.ts`, `main.rs` router composition for P5,
new routes) — **with one exception**: P1's write side rides
`reconcilePageTwins`, which lives in `useSyncedYDoc.ts:510`, the exact file
fast-boot Phase 0 restructures wholesale (its pre-refactorings A+B).
**Recommendation: run the tracks in parallel, but P1 (wave 1) lands after
fast-boot Phase 0** — or only after confirming P1 needs zero `useSyncedYDoc`
changes. Fast-boot proceeds as planned (it is the daily-pain item and the
capstone's remaining gate); the revamp starts with its no-ADR wave.

```
wave 0 (now, parallel with fast-boot Phase 0; no ADRs, normal PRs)
├── P2: recency sort wiring + FLO-522 door + any-block backlinks
├── P2: render::/attribute listing surface
└── P4: file-write extractor + recent-files surface

wave 1 (one ADR: path grammar + resolution semantics; AFTER fast-boot Phase 0)
└── P1: tokenizer → descendant-walk read (FLO-474) → alias (FLO-476)
        → path-addressed writes (mkdir -p) → auto-link, @today landing

wave 2 (short ADR: storage/slug/limits)
└── P3: upload → slug → browse; FLO-414/FLO-564 become consumers

wave 3 (ADR + integration branch, rent-grade)
└── P5: spike (§6, translate model) → publish:: transform semantics
        → public store + static surface → tier-1 link-degradation (w/ P2)
        → dispatch-as-destination (authed write verbs via P1)

gated capstone (unchanged)
└── active_context-on-floatty: needs fast-boot Phases 1-2 + P1 write API
```

Wave 0 is deliberately first: highest daily-friction-per-effort, zero
architectural risk, and it exercises the exact query surfaces P5's audit will
need.

## §8 Coverage matrix

| Pile item | Primitive | Ticket state |
|---|---|---|
| mkdir-p deep links (read/nav) | P1 | [[FLO-474]] Backlog |
| path-addressed API writes | P1 | [[FLO-796]] |
| alias-not-id display | P1 | [[FLO-476]] Todo |
| link normalization | P1 | [[FLO-475]] Backlog |
| auto-link bare patterns | P1 (feature) | [[FLO-699]] Backlog covers dates; PR#/@name = extension |
| daily @today landing | P1 (feature) | rides P1; no ticket yet |
| hierarchical tags | P2 query side | [[FLO-477]] Todo |
| link TYPES (hub/daily vs semantic) | P2 | [[FLO-797]] |
| any-block backlinks + zoom-stable | P2 | [[FLO-711]] + [[FLO-456]] + [[FLO-763]]/[[FLO-440]] family |
| faceted backlink explorer | P2 (feature) | rides [[FLO-763]]/[[FLO-440]] |
| attribute/prefix search surface | P2 | rides P2 upgrade |
| recently-updated blocks | P2 | [[FLO-522]] Backlog |
| gardening loops (staleness) | P2 consumer | [[FLO-443]] Backlog; metadata-tending noted there |
| attachments upload/browse | P3 | [[FLO-798]] (server pipeline; FLO-414/564 consumers) |
| artifacts from float-box | P3 | [[FLO-798]] |
| artifact ↔ outline subscription | doors/chirp, not a new primitive | parked — existing chirp bridge; revisit after P3 |
| recent agent-written files | P4 | [[FLO-799]] |
| watch:: live mirroring / write-back | P4 deferred half | [[FLO-185]] Backlog — parked, conflict story unsettled |
| public /slug/path + public:: (two-tier) | P5 | [[FLO-800]] |
| render-agent streaming | Renderer role surface | parked — rides upstream SpecStream ([[FLO-575]]/[[FLO-576]] adjacent); not orphaned, see role note below |
| slurp ingestion (Track A) | Clerk role surface | separate track — recon-complete per [[2026-07-06-slurp-format-and-box-rendering]]; has a wave-0 claim (daily capture friction) — **scope call is Evan's**: outline revamp vs agent-runtime revamp boundary |
| multiple outlines | none | parked per [[ADR-006]] — workspace commands are the primitive; bar-to-revisit not met |
| dev/build/deploy + autoupdate | none — ops track | parked — not architecture; separate ops pass |
| active_context-on-floatty | capstone | gated (sync-integrity ✅ v0.19.0; fast-boot pending; P1 write API is its natural interface) |

## §8.5 Role vocabulary (one layer up)

The aspirational agentic-runtime docs
(`architecture/agentic-runtime/agent-roles.md`, [[ADR-003]] — banner'd
unbuilt as of 2026-07-10) are the behavioral names for these primitives:
**Clerk** (chaos→structure) = slurp ingestion + P1's write side;
**Librarian** (query→context) = P2; **Gardener** (structure→better) = the
P2 consumer [[FLO-443]] names; **Renderer** (structure→projection) = P3
artifacts + the parked render-agent. Naming the link keeps the runtime docs
and this spine one conversation instead of two — the primitives are what
the roles *ride*.

## §9 Risks

- **P1**: parity-contract drift between TS and Rust canonicalizers — the bug
  class quirk-audit §F just cured at one segment depth; path matching
  multiplies the surface. One canonicalizer per side + parity tests in the
  same PR, per symmetry-check.
- **P2**: any-block backlinks change `inboundCount` semantics — audit
  consumers of AncestorContext before widening. And the link-type taxonomy
  touches the protected `kind` wire contract (see P2 section) — separate
  field or harness update, never drift.
- **Sequencing footnote**: fast-boot's own doc cites the duplicated reconcile
  sites at `useSyncedYDoc.ts:378` — reviewer found the real duplication at
  `:659`/`:1174`/`:1864` (`:378` is orphan-sweep code). Correct that citation
  when the fast-boot ADR is written.
- **P3**: upload endpoint on the shared authority = new abuse surface even
  authed — size/type limits in the ADR, and backup daemon interaction
  (attachments are outside the Y.Doc/SQLite backup story today).
- **P4**: second extractor must not regress ctx watcher throughput; same
  debounce budget, separate table.
- **P5**: everything — that is why it is last, spiked first, and rent-grade.
  The exposure audit ships before any URL is shared. Under translate the
  bugs move into the transform rules (a bad link-rewrite leaks) — the
  transform is one function, tested hard, which is the point: audit one
  translator, not every flag forever.
