# read:: + ls:: Doors — tv-Shape from Floatty Primitives

**Date**: 2026-07-07
**Status**: Accepted design — integration-branch charter (`feat/integration-read-ls-doors`)
**Status label** (per `integration-branch-discipline.md`): `experimental` until mainline merge
**Scope**: Two new doors (`read::` markdown reader with annotations, `ls::` file browser)
plus one deferred core primitive (fs-watch event bridge). PRs merge into the
integration branch, not `main`. Mainline merge requires explicit "this is now a
building block" confirmation + ADR if the annotation schema proves load-bearing.

## Motivation

Floatty as markdown reader / file explorer. The originating train of thought
([[2026-07-06]] late-night session):

- `sh:: floatctl bbs board list` works but the flow could fit nicer — `ls:: /some/path`
  with autocomplete, a live list of files that updates as items arrive/leave,
  a summary line per file (think `file_id.diz`).
- Navigate the list in one pane, contents/preview render in a ⌘L-linked pane.
- "Basically recreating television in floatty, and I'm ok with that."
  (https://alexpasmantier.github.io/television/)

The reframe that survived brainstorming: **this is not tv-in-an-xterm — floatty
already has that** (`$tv()` ephemeral picker, `tvResolver.ts`, FLO-96). It's tv's
*shape* (list + preview + navigation) rebuilt from blocks, so files become outline
citizens: clickable, annotatable, wikilink-able, pin-able.

The reader half is its own long-wanted thing: a **Readwise Reader-style surface** —
read rendered markdown comfortably, highlight spans, attach notes, and dispatch
`@agent` requests from the margin. Evan has previously round-tripped his own notes
*through* Readwise Reader just to highlight them and slurp the highlights back.
Highlights born as outline blocks collapse that loop to zero steps.

## Decisions (brainstorm 2026-07-06 → 07)

| Question | Decision |
|---|---|
| Primary verb | All three (read / browse / pick) — architecture must not foreclose any; thinnest useful slices first |
| List identity | **Hybrid**: listing is ephemeral output (never blocks); **pin** verb materializes a row as a real block |
| Preview shape | **Rendered markdown reader** with annotation powers (Readwise model), not raw text, not slurp-to-blocks |
| Annotation persistence | **Outline blocks** — quote + note + source backlink + quote-anchor metadata. File stays untouched |
| Sequencing | Both thin slices in parallel, separate PRs into this integration branch |
| Door vs core | **Doors own surfaces, core owns primitives.** Both features are doors; the only new core primitive is a deferred fs-watch event bridge |

### Why doors, not native

- `render::` proves the door ceiling: spawns agents, rich interactive views,
  outline mutation via doorStdlib, cross-pane navigation via chirp.
- Hot reload via doorLoader = iteration speed on feel-driven UI (the reader will
  be tuned many times).
- Native views grow BlockItem's conditional cascade — the exact pressure the
  [[2026-07-06-slurp-format-and-box-rendering]] Track B doc is already wrestling with.
- Promotion path proven: render-door graduated `doors/` → `packages/` (PR #262)
  when it earned it.

## `read::` door (the reader)

`read:: ~/path/to/file.md`

### v1 — read

- Renders the file as a **document**: headings, lists, code fences, inline
  formatting, clickable `[[wikilinks]]` (routed through the navigation funnel —
  chirp navigate → pane-link resolution).
- Raw toggle (⊞/≡, TableView precedent).
- Refresh on re-execute. Read-only. **Zero CRDT writes.**

### v2 — highlight

- Select text → popover: highlight / note / @mention.
- Creates a **real annotation block** under a per-file page:
  - Content: quoted span (`> …`) + note beneath.
  - `block.metadata`: **quote-based anchor** — quote text + prefix/suffix context.
    Never byte offsets (they rot on first edit).
- Reader re-anchors on render: exact match → fuzzy → **orphaned-highlights list**
  at the bottom when the file drifted too far (Hypothesis/Readwise pattern).
- This IS the slurp-back loop: highlights are searchable, wikilink-able,
  agent-visible via the REST API from birth.

### v3 — dispatch

- `@cowboy tighten this section` in a note = a block with a marker. Routing is
  convention over existing rails (lifecycle hooks + agents finding work via the
  search API). Minimal new machinery — the reader only needs to *create* the block.

## `ls::` door (the browser)

`ls:: ~/float-hub/inbox`

### v1 — list

- Ephemeral listing as door output (**never child blocks**): filename, diz line, mtime.
- **Diz resolution order** (fits the existing corpus — capture-quality MVR
  frontmatter conventions):
  1. frontmatter `description:` / `tldr:`
  2. real `file_id.diz` sidecar
  3. first heading
  4. first non-empty line
  - Non-markdown files: size/type line.
- Keyboard nav (arrows/j/k).
- **Enter** opens the focused file in the reader:
  - ⌘L link exists → target pane (existing `resolveLink()` at call site).
  - No link → open in place. **No auto-pane magic** (standing rule:
    `feedback_no_obsidian_pane_magic`).
- **p pins** the focused row → persistent block: `[[name]] — diz` + path in metadata.

### v2 — live + autocomplete

- **fs-watch core primitive lands here** (not v1): Tauri command wrapping `notify`
  (same crate ctx_watcher uses), emitting directory events doors subscribe to.
  Listing updates on arrival/removal.
- Path autocomplete while typing the block content.

### v3 — channels

- Sources beyond directories: `ls:: bbs:sysops-log`, git objects, …
- Potentially read the existing tv cable `.toml` `[source].command` definitions
  (~40 channels already configured at `~/.config/television/cable/`).
- This is where "recreated tv" fully lands. Explicitly horizon, not start.

### v1.1 addendum — argument resolution: paths, aliases, context (2026-07-07)

Origin: live dogfooding the night of the charter ([[81b2016c]] / [[0cbf3925]] on
page [[2026-07-07]]) — a glob `sh:: ls` returned two context-lake paths and
reading one meant manually prepending `sh:: cat`. Two gaps surfaced: ls:: should
be able to take its scope from *block context*, and recurring directory sets
want *names*.

The `ls::` argument resolves in order:

1. **Literal path** — `ls:: ~/float-hub/inbox`. The v1 form; ships in PR2.
2. **Alias** — `ls:: rexall` → a configured multi-root set (e.g. the
   `rangle-weekly/rexall` board + the Catalyst-Context-Lake records dir).
   Listing renders grouped by root. Aliases are channels-lite — if v3 channels
   land, aliases become the degenerate "list of directories" channel kind.
3. **Contextual (bare `ls::`)** — no argument: resolve from **ancestor markers**.
   Walk `effectiveMarkers` (inherited provenance — rides the existing
   `InheritanceIndex`; do NOT add a parallel ancestor walk) for a `project::`
   value that has an alias mapping. A parent
   `ctx:: … [project::rangle/rexall-catalyst-context-lake]` block scopes a bare
   `ls::` beneath it to that alias's roots. Same inheritance semantics markers
   already have — the door reads context the way search already does.

**Alias config home** (decided-enough-to-start): `config.toml` `[ls.aliases]` —
simplest, no new outline convention, symmetric with existing config surface.
Revisit outline-native config (an `aliases::` block, like `pages::`) if/when
editing aliases in-outline earns its keep. Sequencing: aliases + contextual
resolution come after PR3 wiring, before or alongside fs-watch liveness.

### v1.2 addendum — remote sources over SSH (2026-07-07)

Applies to **both doors**, not just ls::.

Origin: multi-device reality. Mutagen syncs `/opt/float/bbs` but not everything —
live example the same night as the charter: reading this track's own STATE.md
from the laptop took `sh:: ssh evan@evans-box cat …/.float/work/read-ls-doors/STATE.md`.
The recurring shape: "ssh'd into a place in one pane, wanting to read its files
in another."

- **Syntax**: scp-style `[user@]host:path` accepted anywhere a path is —
  `read:: evans-box:~/projects/…/STATE.md`, `ls:: evans-box:/opt/float/bbs/boards`,
  and **alias roots may be remote**, so one alias can span machines.
- **Transport**: ssh subprocess through the existing executor path. Rides the
  user's `~/.ssh/config` + key auth (agent/keychain) — the door does zero
  credential handling; a host that prompts for a password is a setup problem,
  surfaced as stderr in the output, not something the door solves.
- **Remote listing + diz must be ONE ssh invocation per refresh** — a single
  remote command emitting structured lines (name / mtime / diz source), never N
  round trips per file. Latency budget is one round trip.
- **Liveness**: remote roots are refresh-on-demand only. The v2 fs-watch
  primitive stays local; no remote watching.
- **No local-vs-remote detection — ever.** Host-qualified path → always ssh;
  bare path → always local fs. `ssh evan@evans-box` works the same *from*
  evans-box (Tailscale MagicDNS, ssh-to-self) as from the laptop, so the door
  never asks "which machine am I on?" Loopback ssh overhead is noise for a
  personal tool, and the payoff is that **alias configs are portable verbatim**
  across devices — one config, identical resolution everywhere.
- **Non-goal**: not an sftp browser or FUSE mount. `ssh` + coreutils on the far
  end is the whole contract.
- Sequencing: with the aliases/resolution unit (post-PR3) — `read:: host:path`
  is nearly free once read:: exists (`ssh host cat` instead of local read).

Operational aside (outside the doors): `.float/work/` track state itself isn't
synced across devices by design (`.float/` is gitignored). The low-friction
answer if this bites again is a symlink into a mutagen-synced root — an infra
choice, not a door feature.

## Wiring contract

```
ls:: pane A                     read:: pane B (⌘L-linked)
├── Enter on row ──chirp navigate──▶ read:: block updates path / zooms
├── p on row ────▶ pin block created (real, persists)
└── no link? ────▶ open reader in place (no auto-split, no auto-create)
```

Interaction discipline: `floatty-interactive-view` skill applies (spec-declares-verbs /
host-dispatches-verbs). Output-block focus rules apply (`output-block-patterns.md`) —
parent wrapper owns focus for the ls:: list; the reader is a TableView-class exception
(genuinely needs internal selection handling for highlights).

## Deliberately not doing

- Fuzzy-find-everything — ephemeral `$tv()` picking already exists and stays.
- File mutations from `ls::` (no rename/delete verbs in v1).
- Annotation sidecar export — outline is source of truth; export later if wanted.
- Auto-opening/closing panes.

## PR shape

Independent slices into `feat/integration-read-ls-doors`:

1. **PR1** — `read::` v1 (render, raw toggle, wikilink nav)
2. **PR2** — `ls::` v1 (listing, diz, keyboard nav, pin) — parallel with PR1
3. **PR3** — wiring: Enter-to-reader via pane link
4. **PR4+** — highlights (annotation schema + re-anchoring), then liveness, then dispatch

False starts are expected (that's why the integration branch exists). Rollback =
delete the branch; `main` never sees an experiment.

## Open questions (expected iteration territory)

- Reader text-selection UX inside a door output block — selection APIs are available
  (doors are same-DOM SolidJS, not iframes), but popover positioning + focus
  hand-off will take tuning.
- Quote re-anchor fuzziness threshold — when does a drifted highlight become orphaned?
- Per-file page naming for annotation blocks (full path? basename? collision policy?).
- Whether path autocomplete reuses the wikilink autocomplete infra or needs its own.

## References

- `apps/floatty/src/lib/tvResolver.ts` — existing ephemeral tv picker (FLO-96)
- `~/.config/television/cable/` — existing channel definitions (v3 fuel)
- `.claude/rules/output-block-patterns.md` — display-only output + focus routing
- `.claude/rules/integration-branch-discipline.md` — why this branch exists
- `packages/render-door/` — door ceiling proof + extraction precedent (PR #262)
- [[2026-07-06-slurp-format-and-box-rendering]] — sibling ingestion/rendering work
- https://alexpasmantier.github.io/television/ — the shape being recreated
- https://readwise.io/read — the reader/annotation reference model
