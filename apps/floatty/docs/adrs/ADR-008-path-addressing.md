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
(`parseWikilinkInner`), the target splits on **whitespace-delimited `>`**
(at least one whitespace character on each side) at top level only — the
same `[[`/`]]` depth-guard loop, so `[[a > [[b|c]] > d]]` splits into three
segments. Bare `a>b` does NOT split: every FLO-474 example uses spaced
separators, and bare `>` would mis-split targets containing generics or
arrows (`Vec<String>`, `A->B`). Segments are trimmed; empty segments are a
parse error (the path is treated as opaque, preserving old behavior).
Boundary clarification (stage 1): a `>` at end-of-string preceded by
whitespace counts as a trailing separator — it produces an empty final
segment, so `a > b >` is opaque. Whitespace is strictly required on the
left of a separator; end-of-string qualifies on the right.

- `[[page > section > block]]` — three segments, first is always a page.
- Alias interplay: `[[a > b|label]]` → target path `a > b`, alias `label`.
- `parseWikilinkInner`'s output shape is untouched; `parsePathSegments` is a
  new pure function (TS + Rust twins). **Interpretation happens at USE time
  (click, API call) — never at parse/extraction time.** Render, backlink
  scanning, and outlink extraction remain `>`-naive except where Decision 4
  says otherwise.

## Decision 2 — Two resolution modes over one grammar

| | READ (`GET /resolve`) | WRITE (mkdir-p) |
|---|---|---|
| Matching | Fuzzy ladder per [[FLO-474]]: exact → markdown-stripped → contains (ci) → marker match | **Exact-canonicalized only** |
| Segment semantics | **Descendant** selector — may skip levels | **Direct child** — linear chain, no skipping |
| On miss | Land at deepest-resolved segment; trace reports the unresolved tail. Read-only — never creates (Decision 3) | Create the missing remainder |
| On ambiguity | Deterministic total order: match quality × depth proximity × recency, final tie-break oldest-createdAt. v1 auto-picks top; picker UX arrives with alias:: (stage 3) | Oldest-createdAt wins (never creates a duplicate sibling) |

**On-miss behavior splits by caller** (Decision 3): the `GET /resolve` API read
is pure — on a miss it lands at the deepest resolved segment and reports the
unresolved tail read-only, never creating. A **click** is a mkdir-p hybrid: it
uses the READ column's fuzzy ladder to resolve the frontier, then the WRITE
column's create semantics (exactly-as-written, direct-child chain) to scaffold
the unresolved tail, then navigates. Same read machinery, different tail
disposition — `GET /resolve` reports it, the click creates it.

**The coupling invariant: rung 1 of the read ladder IS the write predicate —
literally the same `match_exact` function.** If they diverge, write-then-read
round-trips land in different blocks. Enforced by shared fixture corpus
(round-trip properties: "write to P creates X; resolving P returns X") run by
both the read and write PRs.

Ladder refinement (stage 1): rung 3 (`contains`) runs against
**marker-stripped** content. Under lowercase-only canonicalization a
marker's value is always a literal substring of its content, so a plain
`contains` would subsume rung 4 entirely — stripping `[key::value]`
markers from rung 3's input keeps rung 4 (marker-value match) genuinely
reachable. The shared corpus asserts the rung, not just the hit.

**Oldest-createdAt-wins is a grammar-level invariant implemented ONCE per
side, inside the matcher module.** Walkers and mkdir-p call the matcher; no
new code re-derives the tie-break (four legacy sites exist; retrofitting them
is optional cleanup, not part of this track). Missing/zero `createdAt`
compares as +∞ (never steals), matching `PageNameIndex` semantics.

## Decision 3 — Create policy: clicks are mkdir-p

> **Rewritten 2026-07-19 (Evan).** This decision previously read "Miss policy:
> never create from a read — no client-side mkdir-p-on-click." That is
> **reversed**: clicking a multi-segment path wikilink now behaves like
> `mkdir -p`. The reversal is deliberate and load-bearing; the paragraphs below
> are the current policy, not the prior one.

Clicking `[[a > b > c]]` **fuzzy-resolves its frontier as far as reality goes,
then CREATES the unresolved tail exactly-as-written, then navigates to the
destination.** Every click succeeds — there is no miss state, no notice, no
failure return.

Mechanics:

- **Frontier resolve (read ladder).** `resolveWikilinkPath` runs the FLO-474
  fuzzy ladder over the local Y.Doc. Existing content is **FOUND, not
  duplicated** — the ladder absorbs case / markdown-heading / marker-value
  variance and most typos, so a re-click of a path that already exists resolves
  fully and creates nothing (idempotent).
- **Tail create (exactly-as-written, direct-child chain).** The segments that
  did not resolve are created as a linear parent→child chain — each segment the
  sole child of the previous, content the raw segment text (no canonicalization,
  no `# ` heading prefix). All in **ONE batch transaction** (single undo step)
  with **origin `'user'`** so it syncs like any user edit.
- **Segment-1 miss creates the page too.** `[[no such page > section]]` creates
  the page via the existing find-or-create path (`ensurePage` → the same
  `createPage` single-segment clicks use, under `pages::`), then scaffolds the
  tail under it. A date-shaped segment-1 name (`2026-07-20`) therefore
  pre-scaffolds a future daily note for free — dailies are just pages named
  `YYYY-MM-DD`.
- **Navigate to the destination.** The deepest (last-created) segment, via the
  same `navigateToBlock` zoom-with-context + highlight as the full-resolve path.
- **ID-threading (doctrine).** The destination is reached by threading the ids
  the create APIs hand back — never by re-resolving a just-written segment by
  name. This carries the stage-0 server rule (fresh writes invisible to async
  indexes) to the client, where the failure mode is weaker (`findPage` is a
  synchronous store scan) but the shape is still required.

**Founding use case — quick-scaffolding daily-note structure.** `[[2026-07-20
> x]]`, `[[2026-07-20 > daily notes > section > subsection]]`: click and the
structure falls out. This is the motivating workflow; the design serves it.

**Accepted property — mkdir-p is literal.** An unmatched typo'd MIDDLE segment
creates a sibling branch rather than healing to the intended block (fuzzy is
best-effort on the read frontier, not a spell-checker on the write). The
structural mitigation is the autocomplete rider (offer existing descendants as
you type a segment), not weakening the create semantics. Accepted, not a bug.

**`GET /resolve` stays read-only.** The mkdir-p behavior is the *click / nav*
path (`navigateWikilinkPath`). The read endpoint `GET /resolve` never creates —
it lands at the deepest resolved segment and returns the unresolved tail in its
trace. Agents create via `POST /path` (Decision 6): **the command creates, `ls`
doesn't.** Same split as a shell — `cd`/`ls` read, `mkdir -p` writes.

**Malformed paths keep old opaque behavior.** The "no junk OPAQUE page" rule
survives: a malformed path (empty leading/middle/trailing segment, unbalanced
`[[`) parses as a single opaque segment (`parsePathSegments` returns
`[target]`), never splits, and keeps the pre-path-addressing single-string page
behavior. mkdir-p only fires for a well-formed multi-segment path.

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

**Server (`POST /path`).** Per-segment creates are N separate Yrs transactions
with N WS broadcasts, reusing the existing create path. No batch machinery: the
operation is idempotent (exact find-or-create per segment), so partial failure
leaves a usable prefix and a retry converges. Client undo is unaffected
(remote-origin applies don't enter the client undo manager).

**Client (click, `navigateWikilinkPath`).** The click-side tail scaffold uses
ONE batch transaction (`batchCreateBlocksInside`, origin `'user'`) — the whole
chain is a single undo step (`ydoc-patterns.md` rule 11) so `Cmd+Z` removes the
scaffolded structure in one shot, and it flows through the normal local Y.Doc →
sync path like any user edit. This is a **deliberate asymmetry** with the
server: the server has no undo manager (undo granularity is meaningless there,
and per-segment idempotent creates give clean retry-convergence over an HTTP
boundary), whereas the client is a live editor where "the click I just made"
must be one undoable action. Same mkdir-p semantics, different transaction
shape because the two sides answer to different constraints.

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
3. Dev app (mkdir-p, Decision 3): `[[page > section > block]]` click navigates
   when fully resolved; a partial- or full-miss click scaffolds the unresolved
   tail (exactly-as-written, correct parentage — direct-child chain) and lands
   on the destination; a segment-1-miss click creates the page too; **re-clicking
   the same path creates nothing new** (idempotent — the fuzzy ladder finds the
   existing structure); a malformed/opaque path keeps the old single-string
   behavior (**no junk OPAQUE page**).
4. Outlinks: a path link appears in Linked References of its first-segment
   page; no phantom stub registered for the opaque string.

## Rollback

The read-side machinery is additive pure functions + a nav-funnel branch:
revert = remove the branch at `handleChirpNavigate` and the walker module;
`[[a > b]]` degrades to the old opaque-page-name behavior.

The **client-side create** (mkdir-p on click, Decision 3) is a branch inside
`navigateWikilinkPath` + the `createPathTail` / `ensurePage` helpers: revert =
remove the create branch (let a multi-segment miss fall back to the prior
land-deepest-or-no-op behavior, or drop path addressing entirely). Blocks a
click created are **ordinary outline content** — plain blocks under `pages::`,
no schema/storage/marker change — and stay valid after the revert, same as the
server `POST /path` story below. The batch transaction carries no special
shape; nothing to migrate.

The **server write endpoint** is a new route: revert = delete route; blocks it
created are ordinary blocks, no schema/storage change anywhere (no Y.Doc shape
change, no SQLite change, no Tantivy schema dependency — outlinks re-extract
lazily on the old code). The riskiest surviving artifact of a rollback (server
or client) is content created at paths — which is just outline content, and
stays valid.

## Status label

`experimental` while on `feat/addressing`; flips with the mainline merge.
