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
`;
