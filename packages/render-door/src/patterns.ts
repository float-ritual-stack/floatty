/**
 * Layout pattern guidance for render:: agent.
 *
 * Injected into the agent system prompt so it knows WHEN to use
 * which composition patterns without being told explicitly.
 */

export const LAYOUT_PATTERNS = `
LAYOUT PATTERN GUIDE — choose based on content shape:

DEFAULT: Use a vertical Stack as root. Most content is a scrollable document.
DocLayout with sidebar is the EXCEPTION, not the default. Only use it when
the user explicitly asks for sidebar navigation, or the content is a formal
multi-page document (like a project hub with 3+ distinct views the user
switches between). Dashboards, note summaries, timelines, and aggregations
should be vertical Stacks — even if they have multiple sections.

WHEN TO USE DocLayout + sidebar:
- User explicitly asks for sidebar, navigation, or "hub" layout
- Content is a formal document with 3+ distinct VIEWS (not just sections)
- Each view is a different lens on the same topic (Overview vs Release Plan vs Architecture)
- Pattern: state-driven tab switching with $cond/$state on NavItem.active and section visible

CRITICAL — DocLayout children rule:
DocLayout is display:flex. It renders ALL direct children as side-by-side columns.
You MUST give it EXACTLY 2 children: one "sidebar" Stack and one "main" Stack.
Everything in the sidebar (NavBrand, NavSection, NavItem, NavFooter) goes INSIDE
the sidebar Stack as its children. Everything in the main area goes INSIDE the
main Stack. NEVER put NavBrand, NavSection, or NavFooter as direct children of
DocLayout — that creates multiple columns instead of one sidebar.

CORRECT structure:
  DocLayout children: ["sidebar", "main"]
  sidebar (Stack, vertical): children: ["nav-brand", "nav-section-1", "nav-section-2", "nav-footer"]
  main (Stack, vertical): children: ["header", "section-a", "section-b", ...]

WRONG (creates 4+ columns):
  DocLayout children: ["nav-brand", "nav-section-1", "nav-section-2", "main"]

HOW TO DO SIDEBAR TAB SWITCHING (when appropriate):
- state: {"activeTab": "first-section"}
- NavItem with active: {"$cond": {"$state": "/activeTab", "eq": "section-id"}, "$then": true, "$else": false}
- NavItem on.press: {"action": "setState", "params": {"statePath": "/activeTab", "value": "section-id"}}
- Each main section: visible: {"$state": "/activeTab", "eq": "section-id"}
- First section also visible when no tab set: {"$or": [{"$state": "/activeTab", "eq": "first"}, {"$state": "/activeTab", "not": true}]}

MULTI-BLOCK SPLIT (user asks to split across blocks):
- Create child blocks via upsertChild, each with its own render:: prefix
- The parent renders current view, children render independently
- Children use { } arrows in EntryHeader to navigate between siblings

TIMELOG / DAILY NOTE DATA:
- Use ArcTimeline component for timelog entries grouped into work arcs
- entries: [{time: "HH:MM", label: "...", project: "..."}]
- arcs: [{name: "...", start: "HH:MM", end: "HH:MM", project: "..."}]
- Arcs group contiguous entries by work session. Orphan entries shown separately.
- Project colors are built-in: floatty=cyan, rangle=amber, float-hub=green, json-render=magenta

COMPOSITION RULES:
- TuiPanel for grouped data with a title (Key People, Blockers, etc.)
- PatternCard for expandable items with status badges (releases, features)
- EntryBody for markdown-rich content (meeting notes, descriptions)
- BacklinksFooter at section end for bidirectional outline links
- WikilinkChip for inline [[bracket]] references
- Text with size="sm" + mono=true for structured data lists
- Color-code by severity: #ff4444 critical, #ffb300 warning, #98c379 ok, #00e5ff info

KANBAN (FLO-587 — two-way bound):
When the user asks for a kanban / board / todo-columns view of a block
subtree, use KanbanCard + KanbanColumn. The cards are two-way bound to
the outline: dragging a card to another column emits a move-block chirp
that mutates the outline; editing a card's text commits via update-block
chirp. Re-projection happens automatically.

Required shape:
- state.cards is a map keyed by REAL blockId → { content: "<current>" }.
  Seed from the block you're projecting.
- Each KanbanCard element carries:
    props: { blockId: "<real-uuid>", parentId: "<col-real-uuid>", index: <n>, content: "<current>", color?: "<hex>" }
    bindings: { content: "/cards/<blockId>/content" }
- Each KanbanColumn carries: props: { title: "<col-name>", titleColor: "<hex>", blockId: "<col-real-uuid>", childCount: <n> }
- Columns are children of a horizontal Stack; cards are children of the column.

Minimal shape reference (3 cols, 2 cards — expand with real data):
{
  "root":"board",
  "title":"Sprint Board",
  "state":{"cards":{"<uuid-a>":{"content":"Task A"},"<uuid-b>":{"content":"Task B"}}},
  "elements":{
    "board":{"type":"Stack","props":{"direction":"vertical","gap":10},"children":["header","cols"]},
    "header":{"type":"Text","props":{"content":"Sprint Board","size":"lg","weight":"bold","color":"#00e5ff"},"children":[]},
    "cols":{"type":"Stack","props":{"direction":"horizontal","gap":8},"children":["col-todo","col-doing","col-done"]},
    "col-todo":{"type":"KanbanColumn","props":{"title":"Todo (1)","titleColor":"#ffb300","blockId":"<uuid-col-todo>","childCount":1},"children":["card-a"]},
    "col-doing":{"type":"KanbanColumn","props":{"title":"Doing (1)","titleColor":"#00e5ff","blockId":"<uuid-col-doing>","childCount":1},"children":["card-b"]},
    "col-done":{"type":"KanbanColumn","props":{"title":"Done (0)","titleColor":"#98c379","blockId":"<uuid-col-done>","childCount":0},"children":[]},
    "card-a":{"type":"KanbanCard","props":{"blockId":"<uuid-a>","parentId":"<uuid-col-todo>","index":0,"content":"Task A","color":"#ffb300"},"bindings":{"content":"/cards/<uuid-a>/content"},"children":[]},
    "card-b":{"type":"KanbanCard","props":{"blockId":"<uuid-b>","parentId":"<uuid-col-doing>","index":0,"content":"Task B","color":"#00e5ff"},"bindings":{"content":"/cards/<uuid-b>/content"},"children":[]}
  }
}

Color hint by column status (detect from column content — "todo"/"backlog" → amber,
"doing"/"in progress"/"active" → cyan, "done"/"shipped" → green, "blocked" → coral):
  amber #ffb300, cyan #00e5ff, green #98c379, coral #ff4444, magenta #e040a0

RICH-DOC PRIMITIVES — pick the right shape for the content
==========================================================

The "## → h2 → Stack of Text" pass is the FLOOR. Reach for typed
primitives when the content has a typed register. Each block should
carry semantic load, not just decoration.

CALLOUT — typed asides, foldable, nestable
  When: any block that's an aside, warning, example, quote, or
        Q&A pair. Replaces:
          - QuoteBlock+wrapper combos
          - CollapsibleSection+styled-text combos
          - DataBlock with ├── └── ASCII tree chars (anti-pattern)
  Types (13): note, info, tip, success, warning, danger, failure,
              bug, example, question, quote, abstract, todo
  Type → use:
    note/info       general aside
    tip             THE rule / takeaway / "remember this"
    success         shipped / decision-active
    warning         escalation / "this matters"
    danger/failure  load-bearing diagnosis / known-broken
    bug             folded-by-default known issue
    example         "here's where this applies" + flat list
    question        catch-probe / asked question / open Q
    quote           pulled prose / direct attribution
    abstract        bridges / lateral synthesis / TOC-shape
    todo            unresolved action item
  Nestable: children can be more Callouts. Q&A pattern:
    outer Callout(question) wrapping the question prompt + nested
    Callout(failure) carrying the answer is the canonical Q&A shape.
  Foldable: collapsible: true + defaultExpanded: false hides
    by-default; user clicks header to expand. Use for known-issues,
    long-form details, deep references.

  Anti-pattern: DO NOT put literal box-drawing chars (├── └── ─) in
  Text content as faux-trees. That's the markdown source's notation;
  the spec layer should attach the structure to nested elements
  (BulletList for flat, Callout for typed, TreeView for tree+status).

HERO — page-top visual statement
  When: hub pages, project landings, dispatch covers, weekly zine
        intros. Anywhere you'd write a big serif title with a
        tagline + maybe some "see also" links.
  vs MetadataHeader: Hero is visual+actions; MetadataHeader is
        metadata+stats. Hub pages often use Hero up top + stats
        elsewhere. Daily notes / trackers use MetadataHeader.
  Props: eyebrow (small uppercase tag), title (serif), subtitle,
         cover {gradient/color/icon}, density (full|compact),
         actions (rendered as text-links, not pill buttons —
         intentionally subtle since they're often decorative refs).

GALLERY GRID + CARD COVER — Notion-style collection rendering
  When: 3+ items that benefit from cover-style cards (recent work
        gallery, doc browser, dispatch tiles, pinned references).
  vs ShippedItem list: ShippedItem is a one-line bullet; CardCover
        is a richer card with cover area + properties pills + footer.
        Use ShippedItem for shipped-PR lists; use CardCover when
        each item has its own visual identity worth surfacing.
  vs KanbanCard: KanbanCard is column-bound + drag-target;
        CardCover is layout-only.
  CardCover density:
    'comfortable' (default) — header has room to breathe
    'compact' — tighter header, more body room (use in dense layouts)
  Pattern: GalleryGrid columns:'auto' (CSS auto-fit) for responsive,
           or columns:N for fixed-width grids.

BULLET LIST — flat lists inside Callouts/Sections
  When: list of co-occurring items where order doesn't carry meaning.
  vs TreeView: TreeView is for genuine hierarchy + status. BulletList
        is for the FLAT case where ASCII tree chars would be decoration
        not structure.
  Pattern: drop a BulletList inside a Callout body for the
        canonical "typed-section + bulleted-evidence" shape:
          Callout(failure) "kitty's honest answer"
            └─ BulletList items=[...]
  Inline formatting: items support **bold**, *italic*, [[wikilinks]].

VISUAL HIERARCHY — multi-speed scanning
  Long-form content (BBS posts, doctrine, weekly wraps) should read
  at three speeds:

  SKIM (5s)    pull-quotes (QuoteBlock insight) at TLDR + at the
               doctrine takeaway; section headers; Callout(tip)
               for THE rule.
  BROWSE (30s) typed Callouts catch the eye via colored left-borders
               (cyan info, amber warning, coral danger, green success,
               magenta example, dim quote).
  READ (full)  body prose (Text), bulleted evidence (BulletList),
               statused checklists (TreeView).

  TLDR/pull-quote = QuoteBlock(insight). Doctrine/rule = Callout(tip).
  Asides = typed Callouts. Hierarchy = nested Callouts (depth carries
  weight — "the diagnosis underneath" is a danger-callout nested inside
  the warning-callout, two visual registers deep).

  Anti-pattern: rendering a long doctrine post as one big Stack of
  Text + DataBlock-ASCII-trees. That's the floor (markdown cat). The
  ceiling is typed-callout structure with pull-quotes for the
  load-bearing claims.
`;
