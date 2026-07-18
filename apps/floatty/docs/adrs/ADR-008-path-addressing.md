# ADR-008: Path addressing — grammar, two resolution modes, parity contract

## Status

**Proposed — 2026-07-18.** Governs the `feat/addressing` integration branch
(revamp-spine wave 1, P1). Flips to Accepted only at the mainline gate:
read + write proven in scratch/dev use, the acceptance checks below passing,
and the explicit human "this is now a building block" confirmation per
`integration-branch-discipline.md`. Stage PRs on the integration branch may
land against this ADR in Proposed state.

Design detail lives in [[2026-07-12-revamp-spine]] §P1 and the approved build
plan (`.float/work/addressing/STATE.md` links it) — this ADR records the
grammar, the resolution semantics, the wire shapes, and the rollback story;
it does not duplicate the staging.

## Context

Floatty addresses blocks by UUID/short-hash ([[FLO-417]]), pages by name
(PageNameIndex ↔ `findPage`, oldest-createdAt-wins), and single-hop semantic
writes ([[FLO-652]]: `POST /pages/:name`, `POST /daily/:date/append`). There
is no multi-segment addressing: `>` is inert inside `[[...]]`, so
`[[page > section]]` is one opaque page name. Today that is actively harmful:

- Clicking `[[a > b]]` creates a junk page literally named "a > b".
- `extract_wikilink_targets` registers `"a > b"` as a referenced page name →
  phantom stub pages in PageNameIndex; Tantivy indexes the opaque string as
  an outlink facet.
- Agents writing to a spot in the tree must search → hunt block-id → POST
  with `parentId`; ensure-scripts that skip this create root orphans (the
  bug class `outline-interpretation.md` documents).

P1 adds path addressing on both sides: read navigation with fuzzy descendant
matching ([[FLO-474]]) and mkdir-p path-addressed writes ([[FLO-796]]),
with alias:: ([[FLO-476]]) riding the same grammar later.

## Decision 1 — Grammar: one path syntax, parsed additively

Inside `[[...]]`, after the existing top-level `|`-alias split
(`parseWikilinkInner`), the target splits on `>` at top level only — the
same `[[`/`]]` depth-guard loop, so `[[a > [[b|c]] > d]]` splits into three
segments. Segments are trimmed; empty segments are a parse error (the path
is treated as opaque, preserving old behavior).

- `[[page > section > block]]` — three segments, first is always a page.
- Alias interplay: `[[a > b|label]]` → target path `a > b`, alias `label`.
- `parseWikilinkInner`'s output shape is untouched; `parsePathSegments` is a
  new pure function (TS + Rust twins). **Interpretation happens at USE time
  (click, API call) — never at parse/extraction time.** Render, backlink
  scanning, and outlink extraction remain `>`-naive except where Decision 4
  says otherwise.

## Decision 2 — Two resolution modes over one grammar

| | READ (nav, `GET /resolve`) | WRITE (mkdir-p) |
|---|---|---|
| Matching | Fuzzy ladder per [[FLO-474]]: exact → markdown-stripped → contains (ci) → marker match | **Exact-canonicalized only** |
| Segment semantics | **Descendant** selector — may skip levels | **Direct child** — linear chain, no skipping |
| On miss | Land at deepest-resolved segment + notice (Decision 3) | Create the missing remainder |
| On ambiguity | Deterministic total order: match quality × depth proximity × recency, final tie-break oldest-createdAt. v1 auto-picks top; picker UX arrives with alias:: (stage 3) | Oldest-createdAt wins (never creates a duplicate sibling) |

**The coupling invariant: rung 1 of the read ladder IS the write predicate —
literally the same `match_exact` function.** If they diverge, write-then-read
round-trips land in different blocks. Enforced by shared fixture corpus
(round-trip properties: "write to P creates X; resolving P returns X") run by
both the read and write PRs.

**Oldest-createdAt-wins is a grammar-level invariant implemented ONCE per
side, inside the matcher module.** Walkers and mkdir-p call the matcher; no
new code re-derives the tie-break (four legacy sites exist; retrofitting them
is optional cleanup, not part of this track). Missing/zero `createdAt`
compares as +∞ (never steals), matching `PageNameIndex` semantics.

## Decision 3 — Miss policy: never create from a read

Full or partial read miss lands at the deepest segment that resolved, with a
notice; a full miss on segment 1 falls back to existing page behavior only
for **single-segment** targets (unchanged today). Multi-segment targets never
create pages from the click path — the junk-page behavior is retired.

There is **no client-side mkdir-p-on-click**: creation from a path is a
server write verb only. A client twin would be a second walker implementation
with offline/online divergence — the exact hydra this ADR exists to prevent.

Corollary ("wikilinks are not symlinks", FLO-474 comment 2026-07-13): a path
reference is an address, not an ensure-verb. mkdir-p creates empty
intermediates only when explicitly invoked as a write.

## Decision 4 — Outlinks: a path link references its first segment

`metadata.outlinks` for `[[a > b > c]]` contains the canonicalized **first
segment** (`a`) — a page reference. Deeper precision (block-level backlinks)
is P2 territory, not P1. Both extraction hooks (`outlinksHook.ts`,
`parsing.rs`) change together in one PR.

Healing is lazy: existing blocks re-extract on next edit; Tantivy is
ephemeral (ADR-005) and rebuilds clean on restart. No migration sweep.

## Decision 5 — Walker: directional sibling of `walk_ancestors`

Server-side descendant resolution is a new shared primitive in
`floatty-core/src/projections/`: `walk_descendants` + `trait ChildLookup`,
mirroring `walk_ancestors` + `ParentLookup` (adapters, cycle-guard via
visited set, explicit termination enum, cap semantics). It becomes protected
architecture on merge, same as its sibling ([[FLO-679]] PR 1 precedent).
Client resolution is a client-side walk of the local Y.Doc (offline-capable,
fast-boot-aligned) in the protected `lib/navigation.ts` funnel. The two
implementations are parity-by-fixture — same governance as
`findPage` ↔ `PageNameIndex` today.

## Decision 6 — Wire shapes

- **Read**: `GET /api/v1/resolve?path=<urlencoded path>&mode=fuzzy|exact`
  — query param, not a path param (`>` in URL path segments is encoding
  pain). Returns the resolved block in `BlockDto` shape + a per-segment
  resolution trace.
- **Write**: `POST /api/v1/path` with body `{ "path": "...", "content": "..." }`
  — extends the [[FLO-652]] semantic-endpoint family in `api/discovery.rs`,
  per-segment exact find-or-create under the `SemanticCache` mutex. Request
  structs are camelCase + `deny_unknown_fields` (`serde-api-patterns.md`).
- **Payload kinds**: the grammar anticipates a second payload kind — a
  reference to an attachment slug (FLO-796 comment; P3 object store) — but
  v1 ships block-content only. The request shape leaves room
  (`content` today; `attachment` later) rather than encoding payload kind
  into the path grammar.

## Decision 7 — mkdir-p transactional semantics

Per-segment creates are N separate Yrs transactions with N WS broadcasts,
reusing the existing create path. No batch machinery in v1: the operation is
idempotent (exact find-or-create per segment), so partial failure leaves a
usable prefix and a retry converges. Client undo is unaffected (remote-origin
applies don't enter the client undo manager).

## Decision 8 — Parity contract extension

The section canonicalizer is a sibling pair of the page-title pair:
`pageTitle.ts` ↔ `page_name_index.rs`, one canonicalizer per side, shared
JSON fixture corpus asserted on both sides in the same PR. The corpus also
carries the grammar cases (alias interplay, nesting, empty segments) and the
round-trip properties from Decision 2. Fixtures comply with
`test-fixtures-no-pii.md`.

## Acceptance check (gate to Accepted)

1. Fixture corpus green on both sides (tokenizer, canonicalizer, matcher,
   round-trip properties).
2. Hermetic scratch server: seed a known tree → mkdir-p POST creates
   intermediates → `GET /resolve` returns them → re-POST is a no-op
   (idempotency observed, not assumed).
3. Dev app: `[[page > section > block]]` click navigates; multi-segment miss
   lands deepest-resolved with notice; **no junk page created**.
4. Outlinks: a path link appears in Linked References of its first-segment
   page; no phantom stub registered for the opaque string.

## Rollback

All read-side machinery is additive pure functions + a nav-funnel branch:
revert = remove the branch at `handleChirpNavigate` and the walker module;
`[[a > b]]` degrades to the old opaque-page-name behavior. The write endpoint
is a new route: revert = delete route; blocks it created are ordinary blocks,
no schema/storage change anywhere (no Y.Doc shape change, no SQLite change,
no Tantivy schema dependency — outlinks re-extract lazily on the old code).
The riskiest surviving artifact of a rollback is content created at paths —
which is just outline content, and stays valid.

## Status label

`experimental` while on `feat/addressing`; flips with the mainline merge.
