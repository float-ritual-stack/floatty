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
