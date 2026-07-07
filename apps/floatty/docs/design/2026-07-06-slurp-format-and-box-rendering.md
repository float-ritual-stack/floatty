# Slurp Formatting + Box-Drawing Rendering — Design Spec

**Date**: 2026-07-06
**Status**: Proposed (recon complete; implementation deferred)
**Scope**: Two tracks. **Track A** — how pasted / `sh::`-slurped markdown becomes blocks
(list grouping, code-fence isolation, trailing blank line). **Track B** — how block
content renders (box-drawing trees with collapse + narrow-pane survival; ASCII
box-tables as real tables).

## Motivation

Markdown slurped into floatty (`sh:: cat file.md`, paste) currently:

- **Explodes lists into bare blocks.** Each `- item` becomes its own block with the
  marker stripped — a two-item list reads as two orphan lines. Ground truth captured
  in the live outline at [[ae840d8a]] (`current::` vs `desired::` children):
  desired is the whole list as ONE block with ` - ` markers intact.
- **Melts code fences into prose.** The parser has zero fence handling; ``` lines
  fall into the paragraph accumulator and merge with surrounding text.
- **No visual separation** between slurped blocks (everything `.trim()`'d).
- **Box-drawing trees** (`├── └──`) get per-char *coloring* but wrap destructively
  in narrow panes (`.block-display` is `pre-wrap` + `break-word` — a wide tree line
  wraps mid-glyph and the alignment is gone). No collapse affordance.
- **ASCII box-tables** (`┌─┬─┐ │…│ └─┴─┘`) render as raw art. Claude outputs these
  routinely now, and they express **multi-line cells**, which markdown tables can't.

## Ground truth (recon 2026-07-06, two agents + live-outline probe)

### Ingestion pipeline — one parser, four callers

```
parseMarkdownTree (lib/markdownParser.ts:107)
├── lib/pasteHandler.ts:72        — paste (handleStructuredPaste; gate: hasMarkdownStructure)
├── lib/handlers/commandDoor.ts:97 — sh:: / term:: output (no gate; children of the block)
├── lib/handlers/echoCopy.ts:107   — echoCopy::
└── lib/handlers/help.ts:72        — help::
```

- List explosion + marker strip: the list branch at `markdownParser.ts:173-193`
  (each item → own ParsedBlock) + `stripListPrefix` @ 97-101.
- Fences: **no handling anywhere** — greenfield.
- `parsedToOps` is **duplicated** (`pasteHandler.ts:35` and `handlers/utils.ts:82`) —
  consolidate before touching (anti-hydra).
- `doorStdlib.ts:265` has its own separate `parseMarkdownToOps` (doors only) — NOT
  in blast radius.
- Tests pinning current behavior: `markdownParser.test.ts:132-168` (per-item blocks,
  stripped markers), `pasteHandler.test.ts:84-226`. Update alongside.

### Rendering pipeline — conditional cascade, content-shape precedent exists

- Two-layer display: `BlockDisplay.tsx:850-885` overlay over transparent
  contentEditable; newlines are bare `<br>`; `.block-display` is
  `white-space:pre-wrap; word-break:break-word` (`index.css:970-976`).
- **Box-drawing tokenizer already exists**: `BOX_TREE_RE` etc. at
  `inlineParser.ts:219-285` → `.md-box-tree` dim-gray coloring. Coloring only —
  no structure, no collapse, no wrap protection.
- **TableView is the reference picker pattern**: content-shape trigger
  (`hasTablePattern` @ `inlineParser.ts:406-418`), `isTableBlock` memo →
  `<Show>` branch at `BlockItem.tsx:911`, raw-toggle (⊞/≡), zero-sum column
  resize persisted to `block.tableConfig` (Y.Doc-only). **No Rust changes** for
  content-shape renderers.
- Collapse-within-a-block precedent: render:: title mode (FLO-569) ⊞/⊟ toggle at
  `BlockItem.tsx:944-993`.
- **Pattern-fit caveat (checked)**: TableView's edit path round-trips through
  `serializeToMarkdown` (`BlockDisplay.tsx:255-266`), which flattens `\n` — it
  cannot express multi-line cells. Box-tables reuse TableView's *rendering*, not
  its serializer.

## Track A — Ingestion (parser-level; fixes all four callers at once)

### A0. Consolidate `parsedToOps`

Merge the two copies into one (in `handlers/utils.ts`, imported by pasteHandler).
Refactor-first; no behavior change.

### A1. Code-fence isolation

At the top of the parse loop (`markdownParser.ts:~142`), detect ``` open:
`flushPending()`, accumulate raw lines through the closing fence, emit ONE
`ParsedBlock` whose content includes the fence markers. Attach at the current
stack level. Purely additive; no existing test collisions. (Also feeds Track B:
fenced trees per capture-format doctrine become clean single blocks the tree
detector can recognize.)

### A2. List runs become one block, markers intact

Replace the per-item branch: buffer a contiguous run of list lines (including
indented continuation lines) the same way `pendingContent` buffers prose, and
flush as ONE `ParsedBlock` with the **raw lines preserved** (markers + indentation,
no `stripListPrefix`).

**Decision (recommended default)**: this applies to ALL lists, including nested
ones — a nested markdown list stays one literal block rather than becoming outline
hierarchy. Rationale: the desired:: example is literal; "import markdown as outline
structure" is a different intent that deserves an explicit command (e.g. a future
`import::`), not the default slurp behavior. Headings (`#`) still create hierarchy.
If nested-list-as-children turns out to be missed, reintroduce it behind that
explicit path.

### A3. Trailing blank line

Append `\n\n` to each ingested block's content at parser assembly (universal across
the four callers — visual separation is wanted for all slurped content). Renders as
a trailing blank line via the bare-`<br>` model. Skip appending when the block is
the sole "simple output" that updates a placeholder (`commandDoor.ts:100`
`isSimpleOutput` path) — an `output:: result` one-liner shouldn't grow padding.

### Tests

Update the pinned tests (`markdownParser.test.ts`, `pasteHandler.test.ts`) to the
new shapes; add greenfield fence tests (fence-with-language, unclosed fence,
fence-inside-list-run) and the [[ae840d8a]] sample verbatim as a fixture.

## Track B — Rendering (content-shape branches beside TableView; no Rust)

### B1. BoxTreeView — trees that collapse and survive narrow panes

- `hasBoxTreePattern(content)`: block (or fence-block body) where ≥2 lines start
  with box-tree glyphs (`├ └ │`).
- New `<Show when={isBoxTreeBlock() && !treeShowRaw()}>` branch beside
  `isTableBlock` (`BlockItem.tsx:911`) → `BoxTreeView`.
- **Narrow-pane survival**: render in a `white-space: pre; overflow-x: auto`
  container — wide trees scroll inside their own box instead of wrapping
  (the page/pane never wraps mid-glyph). This matches the capture-format doctrine:
  wide content scrolls in its own container.
- **Collapse**: compute per-line depth from glyph structure (`│  ` prefix count);
  each line that has deeper lines below it gets a toggle; clicking collapses its
  subtree (visual hide, content untouched). v1 can ship with just a whole-tree
  ⊞/⊟ collapse-to-first-line (mirror render-title mode) if per-node proves fiddly —
  but per-node is the actual ask ("able to collapse/expand").
- Reuse the existing `BOX_TREE_RE` tokenizer for glyph coloring inside the view.
- `treeShowRaw` toggle (≡) for editing, exactly like `tableShowRaw`.

### B2. Box-table detection → TableView rendering

- `hasBoxTablePattern(content)`: first non-blank line matches `┌…┬…┐` (or `╔` etc.),
  with `│`-delimited rows and `├─┼─┤` separators.
- `parseBoxTableToken`: split on separator rows; **join continuation lines within a
  row segment into multi-line cell strings** (this is the whole point — `│ Pointer │`
  + `│ (auto-loads) │` become one cell with a newline).
- Render through **TableView's display path** (cells are already
  `white-space:pre-wrap` — multi-line cells work today), column resize via
  `tableConfig` as-is.
- **Read-only v1**: no cell editing; the ≡ raw toggle edits the ASCII art directly.
  Cell-editing would need a box-art serializer (alignment re-layout) — deferred
  until wanted. This sidesteps the `serializeToMarkdown` flatten trap entirely.

### Detector precedence

Picker order in the BlockItem cascade: markdown table → box-table → box-tree →
render-title → regular. Fence-blocks whose body matches a detector render with that
detector (fence markers hidden in display mode, present in raw mode).

## Build order

```
A (one PR): A0 consolidate → A1 fences → A2 list runs → A3 blank line + tests
B1 (one PR): BoxTreeView — detector, scroll container, per-node collapse, raw toggle
B2 (one PR): box-table detector + parser → TableView reuse, read-only v1
```

A is smallest and kills the daily ingestion pain ([[ae840d8a]]); B1 and B2 are
independent of A and of each other (B2 slightly benefits from A1's fence isolation
but doesn't require it).

## Open questions (resolve at implementation)

- A2 nested lists: confirm "always literal one-block" default (recommended above).
- A3: exact `\n\n` vs single `\n` trailing; whether hand-typed blocks ever get it
  (recommendation: ingestion-only, never on typing).
- B1 collapse persistence: per-pane transient (like outline collapse) vs not
  persisted at all for v1 (recommendation: transient signal, no persistence v1).
- B2 alignment column widths: derive initial widths from the ASCII art's actual
  column widths vs equal-split (recommendation: derive from art).
