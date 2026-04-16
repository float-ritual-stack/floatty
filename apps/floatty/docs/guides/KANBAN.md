# render:: kanban — Two-Way-Binding Board (FLO-587)

Project a block subtree as a drag-and-drop kanban board. The outline is
canonical; the board is a live projection. Moves on the board mutate the
outline; edits to the outline repaint the board.

## Quick Start — Paste This

Create a block anywhere, then paste this tree underneath it:

```text
Sprint Board
  Todo
    Draft the kickoff doc
    Spike on the new caching layer
    Write the migration runbook
  Doing
    Wire drag handlers
    Refactor the image loader
  Done
    Remove legacy scaffolding
    Wire the state bridge
    Emit bindings from the spec
    Add the subscription capability
  Blocked
    Outside-in re-projection (needs refresh wiring)
```

Grab the top-level `Sprint Board` block's ID from the `/blocky-block-peek`
overlay or the URL, then anywhere else in the outline type:

```text
render:: kanban [[paste-id-here]]
```

Press Enter. The board renders with four columns.

## How It Reads the Subtree

```text
<root>              ← the block you point render:: kanban at
  <column-1>        ← direct children = columns (column title = block content)
    <card-1>        ← grandchildren = cards (card text = block content)
    <card-2>
  <column-2>
    <card-3>
```

No `col::` prefix. No special markers. Any block whose direct children you
want to treat as columns qualifies. Grandchildren become cards.

## Column Colors

Titles are normalized (lowercase, non-letters stripped) and matched against
a palette:

| Title (normalized) | Color    | Use for                  |
|--------------------|----------|--------------------------|
| todo               | amber    | haven't started          |
| backlog            | grey     | not prioritized yet      |
| doing / active     | cyan     | in progress              |
| in progress        | cyan     | same as doing            |
| done / shipped     | green    | completed                |
| complete           | green    | same as done             |
| blocked            | coral    | waiting on something     |
| deferred / review  | magenta  | pushed out or in review  |

Any unrecognized title uses the muted default. You can mix and match —
`"Ideas"`, `"Drafts"`, `"Cold Storage"` all render fine, just without the
color pop.

## Card Colors

Card color inherits from its column. Individual cards can override via
status markers in the card text:

- `[x]` or `done ::` ... → green
- `active ::` ... → cyan
- `deferred ::` ... → magenta

(Same status detection the `expand` mode uses.)

## What You Can Do

### Drag cards between columns
Grab a card, drop it on another card or on empty column space. The
board immediately reflects the move, and the outline shows the block
reparented under the target column.

- Drop **above** a card → inserts before it.
- Drop **below** a card → inserts after it.
- Drop on an **empty column** (or blank column space) → appends to the end.

A cyan border indicates the drop target.

### Drag cards within the same column
Same mechanic. Reorders siblings.

### Edit the outline directly
Rename columns (edit the column block's content) or cards (edit the card
block). Changes land in the outline immediately. **Currently the board
does not auto-refresh** — re-run `render:: kanban [[id]]` to repaint.
(Outside-in re-projection is wired through `server.subscribeBlockChanges`
but the refresh trigger is deferred; see FLO-587 plan.)

## Known Limitations (2026-04-16)

- **Outside-in repaint is manual.** Edit the card block in the outline,
  the board won't update until you re-execute the `render:: kanban` block.
- **No click-to-edit on cards.** Cards render as static text. Edit the
  block in the outline to change card content.
- **No swimlanes or WIP limits.** Plain board only.
- **No remote-drag indicators.** Other clients seeing your drag land via
  Y.Doc sync only see the final position, not the drag in progress.

All of these are deliberate MVP cuts. Follow-ups are tracked under FLO-587.

## Under the Hood

- Spec generator: `apps/floatty/doors/render/render.tsx` — `kanbanSpec()`
- Components: `apps/floatty/doors/render/components.tsx` —
  `KanbanCard` (draggable), `KanbanColumn` (drop target)
- Drop → chirp verb `move-block` → `chirpWriteHandler` →
  `useBlockStore.moveBlock()` → surgical Y.Array mutation →
  full hook chain (search index, ctx routing, outlinks) fires.
- No REST, no polling, no `Origin.Renderer` — rides entirely on the
  existing Y.Doc transaction + EventBus infrastructure.

## See Also

- `help:: doors` — the door system in general
- `help:: events` — EventBus + origin semantics
- FLO-587 in Linear for the full work unit
