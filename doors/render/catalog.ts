/**
 * render:: door catalog — Zod schema catalog for @json-render/solid
 *
 * Defines the component vocabulary that LLMs and specs target.
 * 37 components + 7 actions. Single source of truth for both
 * prompt generation (catalog.prompt()) and runtime rendering.
 */

import { z } from 'zod';
import { schema } from '@json-render/solid/schema';

// ═══════════════════════════════════════════════════════════════
// SHARED ENUMS
// ═══════════════════════════════════════════════════════════════

const entryTypeEnum = z.enum(['synthesis', 'archaeology', 'bbs-source']);
const accentEnum = z.enum(['magenta', 'cyan', 'coral', 'amber', 'muted']);

// ═══════════════════════════════════════════════════════════════
// CATALOG
// ═══════════════════════════════════════════════════════════════

export const bbsCatalog = schema.createCatalog({
  components: {
    // ─── Layout ───────────────────────────────────────────
    DocLayout: {
      props: z.object({
        sidebarWidth: z.number().optional(),
      }),
      slots: ['sidebar', 'main'],
      description: 'Two-column layout: fixed sidebar + scrollable main content area',
    },

    // ─── Sidebar ──────────────────────────────────────────
    NavBrand: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().optional(),
      }),
      slots: [],
      description: 'Sidebar header with title and optional subtitle',
    },

    NavSection: {
      props: z.object({
        label: z.string(),
        accent: accentEnum.optional(),
      }),
      slots: ['default'],
      description: 'Sidebar section header (e.g. SYNTHESIS, ARCHAEOLOGY)',
    },

    NavItem: {
      props: z.object({
        id: z.string(),
        label: z.string(),
        active: z.boolean().optional(),
      }),
      slots: [],
      description: 'Sidebar navigation item with dot indicator',
    },

    NavFooter: {
      props: z.object({
        content: z.string(),
      }),
      slots: [],
      description: 'Sidebar footer with metadata (dates, counts)',
    },

    // ─── Entry Display ────────────────────────────────────
    EntryHeader: {
      props: z.object({
        type: entryTypeEnum,
        board: z.string().optional(),
        title: z.string(),
        date: z.string(),
        author: z.string().optional(),
      }),
      slots: [],
      description: 'Entry header: type badge, title (serif), date/author',
    },

    EntryBody: {
      props: z.object({
        markdown: z.string(),
      }),
      slots: [],
      description: 'Renders markdown content with session-garden styling (serif body, mono code)',
    },

    Ellipsis: {
      props: z.object({}),
      slots: [],
      description: 'Centered · · · separator indicating truncated content',
    },

    // ─── Tags ─────────────────────────────────────────────
    TagBar: {
      props: z.object({
        gap: z.number().optional(),
      }),
      slots: ['default'],
      description: 'Horizontal flex container for tag chips',
    },

    TagChip: {
      props: z.object({
        name: z.string(),
        active: z.boolean().optional(),
      }),
      slots: [],
      description: 'Clickable tag chip with active state',
    },

    // ─── References ───────────────────────────────────────
    RefSection: {
      props: z.object({
        label: z.string().optional(),
      }),
      slots: ['default'],
      description: 'Connected references section with header',
    },

    RefCard: {
      props: z.object({
        id: z.string(),
        type: z.string(),
        title: z.string(),
      }),
      slots: [],
      description: 'Clickable reference card linking to another entry',
    },

    // ─── Navigation ───────────────────────────────────────
    Breadcrumb: {
      props: z.object({
        label: z.string(),
      }),
      slots: [],
      description: 'Back navigation breadcrumb (← label)',
    },

    // ─── Base ─────────────────────────────────────────────
    Stack: {
      props: z.object({
        gap: z.number().optional(),
        direction: z.enum(['vertical', 'horizontal']).optional(),
        sectionId: z.string().optional(),
        width: z.string().optional(),
        minWidth: z.string().optional(),
        flex: z.string().optional(),
        maxWidth: z.string().optional(),
        overflow: z.string().optional(),
        borderRight: z.string().optional(),
        padding: z.string().optional(),
      }),
      slots: ['default'],
      description: 'Layout container, stacks children vertically or horizontally. Supports width/flex for column layouts.',
    },

    Text: {
      props: z.object({
        content: z.string(),
        size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
        weight: z.enum(['normal', 'medium', 'bold']).optional(),
        color: z.string().optional(),
        mono: z.boolean().optional(),
      }),
      slots: [],
      description: 'Text display',
    },

    Divider: {
      props: z.object({}),
      slots: [],
      description: 'Horizontal divider line',
    },

    Card: {
      props: z.object({
        title: z.string().optional(),
        subtitle: z.string().optional(),
      }),
      slots: ['default'],
      description: 'A card container with optional title',
    },

    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
      }),
      slots: [],
      description: 'A labeled metric value',
    },

    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(['primary', 'secondary', 'danger']).optional(),
      }),
      slots: [],
      description: 'Clickable button that emits press event',
    },

    TextInput: {
      props: z.object({
        label: z.string().optional(),
        placeholder: z.string().optional(),
        value: z.union([z.string(), z.record(z.unknown())]).optional(),
      }),
      slots: [],
      description: 'Single-line text input with optional label. Use $bindState for two-way state binding.',
    },

    TextArea: {
      props: z.object({
        label: z.string().optional(),
        placeholder: z.string().optional(),
        rows: z.number().optional(),
        value: z.union([z.string(), z.record(z.unknown())]).optional(),
      }),
      slots: [],
      description: 'Multi-line text area with optional label. Use $bindState for two-way state binding.',
    },

    Code: {
      props: z.object({
        content: z.string(),
        language: z.string().optional(),
      }),
      slots: [],
      description: 'Code block display',
    },

    // ─── TUI Components ─────────────────────────────────────
    TuiPanel: {
      props: z.object({
        title: z.string().optional(),
        titleColor: z.string().optional(),
      }),
      slots: ['default'],
      description: 'Bordered container with title floating on top border edge',
    },

    TuiStat: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        color: z.string().optional(),
      }),
      slots: [],
      description: 'Centered metric card: label above, bold value below',
    },

    BarChart: {
      props: z.object({
        title: z.string().optional(),
        maxHeight: z.number().optional(),
        max: z.number().optional(),
      }),
      slots: ['default'],
      description: 'Normalized vertical bar chart. Children are BarItem components. Auto-scales from children values. IMPORTANT: only compare similar-magnitude values — if one value is 10x the rest, the small bars become invisible. For skewed data, exclude outliers or use StatsBar instead.',
    },

    BarItem: {
      props: z.object({
        label: z.string(),
        value: z.number(),
        max: z.number().optional(),
        color: z.string().optional(),
      }),
      slots: [],
      description: 'Single bar in a BarChart. Height = value/max * 100%. Inherits max from parent BarChart if not set on individual item.',
    },

    // ─── Content Blocks ─────────────────────────────────────
    DataBlock: {
      props: z.object({
        label: z.string().optional(),
        content: z.string(),
      }),
      slots: [],
      description: 'Monospace pre block with optional floating label',
    },

    ShippedItem: {
      props: z.object({
        content: z.string(),
      }),
      slots: [],
      description: 'Green asterisk bullet item for shipped/completed work',
    },

    WikilinkChip: {
      props: z.object({
        target: z.string(),
        label: z.string().optional(),
      }),
      slots: [],
      description: 'Clickable [[bracket-wrapped]] cyan link that navigates to outline page',
    },

    BacklinksFooter: {
      props: z.object({
        inbound: z.array(z.string()),
        outbound: z.array(z.string()),
      }),
      slots: [],
      description: 'Bidirectional link footer: "referenced by" inbound + "links to" outbound',
    },

    PatternCard: {
      props: z.object({
        title: z.string(),
        type: z.string().optional(),
        confidence: z.string().optional(),
        content: z.string(),
        connectsTo: z.array(z.string()).optional(),
      }),
      slots: ['default'],
      description: 'Expandable card with type/confidence badges, markdown body, and connectsTo footer',
    },

    ArcTimeline: {
      props: z.object({
        entries: z.array(z.object({
          time: z.string(),
          label: z.string(),
          project: z.string(),
        })),
        arcs: z.array(z.object({
          name: z.string(),
          start: z.string(),
          end: z.string(),
          project: z.string(),
        })),
        title: z.string().optional(),
      }),
      slots: [],
      description: 'Collapsible arc timeline for timelogs. Groups entries into arcs (work sessions) with colored left borders. Click arc to expand entry list. Shows DONE milestones, duration, entry count. Entries have time + dot + label. Orphan entries shown separately. Project colors: floatty=cyan, float-hub=green, rangle=amber, json-render=magenta. Times as "HH:MM" (24h). Good for daily note timelogs.',
    },

    MeetingDiff: {
      props: z.object({
        title: z.string(),
        meeting: z.string(),
        before: z.array(z.object({ step: z.string(), status: z.enum(['unchanged', 'removed', 'added']) })),
        after: z.array(z.object({ step: z.string(), status: z.enum(['unchanged', 'removed', 'added']) })),
        newDecisions: z.array(z.string()).optional(),
        actions: z.array(z.object({ who: z.string(), what: z.string(), status: z.string(), blocker: z.string().optional() })).optional(),
      }),
      slots: [],
      description: 'Before/after grid showing process changes from a meeting. Steps colored by status (red=removed, green=added, gray=unchanged). Includes new decisions list and action items with assignee/status/blocker. Good for post-meeting synthesis.',
    },

    DecisionLog: {
      props: z.object({
        decisions: z.array(z.object({ date: z.string(), meeting: z.string(), text: z.string(), status: z.string(), source: z.string().optional(), project: z.string().optional() })),
        title: z.string().optional(),
      }),
      slots: [],
      description: 'Filterable list of project decisions with date, meeting source, and status (active/superseded). Filter tabs at top. Active decisions have cyan border, superseded are dimmed with strikethrough. Good for tracking decisions across meetings.',
    },

    DependencyChain: {
      props: z.object({
        nodes: z.array(z.object({ id: z.string(), title: z.string(), assignee: z.string(), status: z.string(), deps: z.array(z.string()) })),
        blocker: z.string().optional(),
      }),
      slots: [],
      description: 'Horizontal linked-card chain showing issue dependencies. Cards connected by → arrows with id/title/assignee/status. Colors: todo=cyan, blocked=amber, done=green. Optional blocker callout below. Good for sprint planning, blocked-work viz.',
    },

    ContextStream: {
      props: z.object({
        captures: z.array(z.object({ time: z.string(), project: z.string(), mode: z.string(), text: z.string() })),
        title: z.string().optional(),
      }),
      slots: [],
      description: 'Filterable timeline of ctx:: captures with project color coding, mode badges, and context-switch markers. Click to expand entries. Project filter chips at top. Good for daily dashboards, session archaeology views.',
    },

    // ─── Composites ──────────────────────────────────────
    ModeTag: {
      props: z.object({
        mode: z.enum(['work', 'float', 'life', 'pebble', 'rent', 'spike']),
        count: z.number().optional(),
        size: z.enum(['sm', 'md']).optional(),
      }),
      slots: [],
      description: 'Colored mode badge. work=cyan, float=magenta, life=green, pebble=amber, rent=coral, spike=coral.',
    },

    QuoteBlock: {
      props: z.object({
        text: z.string(),
        attribution: z.string().optional(),
        type: z.enum(['quote', 'insight', 'note']).optional(),
      }),
      slots: [],
      description: 'Styled quote block with left border accent and optional attribution line. quote=gray, insight=cyan, note=amber.',
    },

    TimeEntry: {
      props: z.object({
        time: z.string(),
        title: z.string(),
        body: z.string().optional(),
        tags: z.array(z.string()).optional(),
        color: z.string().optional(),
      }),
      slots: [],
      description: 'Timeline entry row: time dot on left spine, title + optional body + tags on right. Good for timelogs, session entries, daily notes.',
    },

    StatsBar: {
      props: z.object({
        stats: z.array(z.object({
          label: z.string(),
          value: z.string(),
          color: z.string().optional(),
        })),
        layout: z.enum(['row', 'grid']).optional(),
      }),
      slots: [],
      description: 'Horizontal row (or grid) of labeled stat values with optional per-stat colors. Good for dashboards, summaries.',
    },

    MetadataHeader: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().optional(),
        date: z.string().optional(),
        stats: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
      }),
      slots: [],
      description: 'Document header with title, optional subtitle, date, and inline stats row.',
    },

    CollapsibleSection: {
      props: z.object({
        title: z.string(),
        expanded: z.boolean().optional(),
        color: z.string().optional(),
        count: z.number().optional(),
      }),
      slots: ['default'],
      description: 'Collapsible section with colored title bar and item count. Click header to toggle. Good for grouping entries, day sections, category lists.',
    },

    FilterButtons: {
      props: z.object({
        filters: z.array(z.object({
          id: z.string(),
          label: z.string(),
          count: z.number().optional(),
        })),
        active: z.union([z.string(), z.record(z.unknown())]),
      }),
      slots: [],
      description: 'Horizontal row of filter buttons. Active button is highlighted. Use $bindState on active to sync with spec state for visibility switching.',
    },

    TabNav: {
      props: z.object({
        tabs: z.array(z.object({
          id: z.string(),
          label: z.string(),
        })),
        active: z.union([z.string(), z.record(z.unknown())]),
        variant: z.enum(['horizontal', 'pills']).optional(),
      }),
      slots: [],
      description: 'Horizontal tab bar. "horizontal" uses underline, "pills" uses pill background. Use $bindState on active to sync with spec state for view switching.',
    },
  },

  actions: {
    selectEntry: {
      params: z.object({ id: z.string() }),
      description: 'Navigate to an entry by ID',
    },
    filterTag: {
      params: z.object({ tag: z.string() }),
      description: 'Filter entries by tag',
    },
    goBack: {
      params: z.object({}),
      description: 'Navigate back in history',
    },
    navigate: {
      params: z.object({ target: z.string() }),
      description: 'Navigate to a page or block in the outline',
    },
    createChild: {
      params: z.object({ content: z.string() }),
      description: 'Create a child block under the current render:: block with the given content',
    },
    upsertChild: {
      params: z.object({ content: z.string(), match: z.string().optional(), prefix: z.string().optional() }),
      description: 'Find or create a child block by prefix match ("match" or "prefix" param). Updates content if found, creates if not.',
    },
    scrollTo: {
      params: z.object({ id: z.string() }),
      description: 'Smooth scroll to a section by ID',
    },
  },
});

export type BbsCatalog = typeof bbsCatalog;
