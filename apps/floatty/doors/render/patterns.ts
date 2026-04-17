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
`;
