/**
 * Catalog Atoms — every catalog component exercised in isolation,
 * with JSON source shown beside the live render.
 *
 * Structure per atom:
 *   PatternCard (title + category tag + description)
 *     └─ Stack (horizontal)
 *         ├─ Code (the JSON spec that produced the demo)
 *         └─ <the actual demo element>
 *
 * JSON is hand-authored per atom (short, illustrative — not a dump of the
 * whole spec file). Keeps the demo and its JSON visually aligned and lets
 * the JSON be the teaching artifact, not just machine output.
 *
 * 35 atoms in 8 sections. If a PatternCard's demo slot is empty, that
 * component is broken or mis-registered in the render door.
 */
import type { Spec } from '@json-render/core';

// ─── Atom-entry helper ──────────────────────────────────────────────
// Expands {id, title, category, description, demoKey, codeJson} into the
// 4 elements the split-pane layout needs. Returns the new element entries
// which get spread into the top-level elements map.
type AtomEntry = {
  id: string;
  title: string;
  category: string;
  description: string;
  demoKey: string;
  codeJson: string;
};

const atomEntries = (atom: AtomEntry): Record<string, any> => ({
  [`${atom.id}-card`]: {
    type: 'PatternCard',
    // FLO-657: PatternCard schema canonicalized to {label, description, confidence: enum}.
    // The atom.category was rendered as a colored type-badge in the OLD schema; with the
    // new schema we fold it into description as a markdown italic prefix so the
    // categorical signal survives.
    props: {
      label: atom.title,
      description: `*${atom.category}.* ${atom.description}`,
    },
    children: [`${atom.id}-split`],
  },
  [`${atom.id}-split`]: {
    type: 'Stack',
    props: { direction: 'horizontal', gap: 16 },
    children: [`${atom.id}-code`, atom.demoKey],
  },
  [`${atom.id}-code`]: {
    type: 'Code',
    props: { language: 'json', content: atom.codeJson },
  },
});

// ─── Atom inventory ─────────────────────────────────────────────────
// One entry per atom. demoKey points into the elements map below.
const atoms: AtomEntry[] = [
  // Primitives
  {
    id: 'pc-divider',
    title: 'Divider',
    category: 'primitive',
    description: 'Horizontal rule separator.',
    demoKey: 'pc-divider-demo',
    codeJson: `{\n  "type": "Divider",\n  "props": {}\n}`,
  },
  {
    id: 'pc-card',
    title: 'Card',
    category: 'primitive',
    description: 'Titled container with subtitle and body slot.',
    demoKey: 'pc-card-demo',
    codeJson: `{\n  "type": "Card",\n  "props": {\n    "title": "Example card",\n    "subtitle": "subtitle slot"\n  },\n  "children": ["body"]\n}`,
  },
  {
    id: 'pc-metric',
    title: 'Metric',
    category: 'primitive',
    description: 'Label + value pair. Compact, inline-friendly.',
    demoKey: 'pc-metric-demo',
    codeJson: `{\n  "type": "Metric",\n  "props": {\n    "label": "active sessions",\n    "value": "42"\n  }\n}`,
  },
  {
    id: 'pc-button',
    title: 'Button',
    category: 'primitive',
    description: 'Three variants: primary, secondary, danger. Emits press event.',
    demoKey: 'pc-button-demo',
    codeJson: `// row of 3\n{\n  "type": "Button",\n  "props": { "label": "primary", "variant": "primary" }\n}\n{\n  "type": "Button",\n  "props": { "label": "secondary", "variant": "secondary" }\n}\n{\n  "type": "Button",\n  "props": { "label": "danger", "variant": "danger" }\n}`,
  },
  {
    id: 'pc-ellipsis',
    title: 'Ellipsis',
    category: 'primitive',
    description: 'Centered · · · truncation marker.',
    demoKey: 'pc-ellipsis-demo',
    codeJson: `{\n  "type": "Ellipsis",\n  "props": {}\n}`,
  },
  {
    id: 'pc-code',
    title: 'Code',
    category: 'primitive',
    description: 'Fenced code block with optional language hint.',
    demoKey: 'pc-code-demo',
    codeJson: `{\n  "type": "Code",\n  "props": {\n    "language": "typescript",\n    "content": "const catalog = ..."\n  }\n}`,
  },
  // Display
  {
    id: 'pc-breadcrumb',
    title: 'Breadcrumb',
    category: 'display',
    description: 'Back navigation arrow ← label.',
    demoKey: 'pc-breadcrumb-demo',
    codeJson: `{\n  "type": "Breadcrumb",\n  "props": { "label": "posts to the bbs" }\n}`,
  },
  {
    id: 'pc-wikilink',
    title: 'WikilinkChip',
    category: 'display',
    description: 'Clickable [[target]] chip, cyan. Navigates to outline page via navigate action.',
    demoKey: 'pc-wikilink-demo',
    codeJson: `{\n  "type": "WikilinkChip",\n  "props": {\n    "target": "2026-04-21-json-prompting-died",\n    "label": "json-prompting-died"\n  }\n}`,
  },
  {
    id: 'pc-modetag',
    title: 'ModeTag',
    category: 'display',
    description: 'Mode badge with 6 color-coded values: work · float · life · pebble · rent · spike.',
    demoKey: 'pc-modetag-demo',
    codeJson: `// one per mode\n{ "type": "ModeTag", "props": { "mode": "work",  "count": 12 } }\n{ "type": "ModeTag", "props": { "mode": "float", "count":  7 } }\n{ "type": "ModeTag", "props": { "mode": "life",  "count":  3 } }\n// + pebble · rent · spike`,
  },
  {
    id: 'pc-statpill',
    title: 'StatPill',
    category: 'display',
    description: 'Inline compact label | value pill. More compact than TuiStat.',
    demoKey: 'pc-statpill-demo',
    codeJson: `{\n  "type": "StatPill",\n  "props": {\n    "label": "tests",\n    "value": "488",\n    "color": "#98c379"\n  }\n}`,
  },
  {
    id: 'pc-image',
    title: 'Image',
    category: 'display',
    description: 'src + optional caption + size constraints. Use maxWidth or full-width.',
    demoKey: 'pc-image-demo',
    codeJson: `{\n  "type": "Image",\n  "props": {\n    "src": "…/placeholder.png",\n    "alt": "Placeholder",\n    "maxWidth": 400,\n    "borderRadius": 6,\n    "caption": "Image with caption slot."\n  }\n}`,
  },
  // Navigation
  {
    id: 'pc-collapsible',
    title: 'CollapsibleSection',
    category: 'interactive',
    description: 'Expand/collapse with colored title bar and count pill.',
    demoKey: 'pc-collapsible-demo',
    codeJson: `{\n  "type": "CollapsibleSection",\n  "props": {\n    "title": "Toggle me",\n    "expanded": true,\n    "count": 3,\n    "color": "#00e5ff"\n  },\n  "children": ["body"]\n}`,
  },
  {
    id: 'pc-filter',
    title: 'FilterButtons',
    category: 'interactive',
    description: 'Horizontal filter row. Use $bindState on active to sync with spec state.',
    demoKey: 'pc-filter-demo',
    codeJson: `{\n  "type": "FilterButtons",\n  "props": {\n    "filters": [\n      { "id": "all",        "label": "all",        "count": 35 },\n      { "id": "primitives", "label": "primitives", "count":  6 },\n      { "id": "display",    "label": "display",    "count":  5 },\n      { "id": "viz",        "label": "viz",        "count":  6 }\n    ],\n    "active": { "$bindState": "atoms_filter" }\n  }\n}`,
  },
  {
    id: 'pc-tabnav',
    title: 'TabNav',
    category: 'interactive',
    description: 'Horizontal tabs. horizontal = underline, pills = pill background. Use $bindState on active.',
    demoKey: 'pc-tabnav-demo',
    codeJson: `{\n  "type": "TabNav",\n  "props": {\n    "tabs": [\n      { "id": "primitives", "label": "Primitives" },\n      { "id": "display",    "label": "Display" },\n      { "id": "viz",        "label": "Viz" }\n    ],\n    "active": { "$bindState": "atoms_tab" },\n    "variant": "pills"\n  }\n}`,
  },
  // Input
  {
    id: 'pc-textinput',
    title: 'TextInput',
    category: 'interactive',
    description: 'Single-line input with optional label. Use $bindState on value for two-way binding.',
    demoKey: 'pc-textinput-demo',
    codeJson: `{\n  "type": "TextInput",\n  "props": {\n    "label": "slug",\n    "placeholder": "kebab-case-name",\n    "value": ""\n  }\n}`,
  },
  {
    id: 'pc-textarea',
    title: 'TextArea',
    category: 'interactive',
    description: 'Multi-line input with optional label and rows. Use $bindState on value.',
    demoKey: 'pc-textarea-demo',
    codeJson: `{\n  "type": "TextArea",\n  "props": {\n    "label": "body",\n    "placeholder": "markdown content…",\n    "rows": 4,\n    "value": ""\n  }\n}`,
  },
  // TUI
  {
    id: 'pc-tuistat',
    title: 'TuiStat',
    category: 'tui',
    description: 'Centered metric card: label above, bold value below. Larger than StatPill.',
    demoKey: 'pc-tuistat-demo',
    codeJson: `{\n  "type": "TuiStat",\n  "props": {\n    "label": "OBJECTS",\n    "value": "11,105",\n    "color": "#00e5ff"\n  }\n}`,
  },
  {
    id: 'pc-barchart',
    title: 'BarChart + BarItem',
    category: 'tui',
    description: 'Normalized vertical bars, auto-scaled from children. For skewed data (one value 10× others), use StatsBar instead — tiny bars become invisible.',
    demoKey: 'pc-barchart-demo',
    codeJson: `{\n  "type": "BarChart",\n  "props": { "title": "Components per category", "maxHeight": 120 },\n  "children": ["bi1", "bi2", "bi3", "bi4", "bi5"]\n}\n// each child:\n{\n  "type": "BarItem",\n  "props": { "label": "display", "value": 10, "color": "#00e5ff" }\n}`,
  },
  // Temporal
  {
    id: 'pc-timeentry',
    title: 'TimeEntry',
    category: 'temporal',
    description: 'Timelog row with time dot + title + body + tags. Use in daily note timelogs.',
    demoKey: 'pc-timeentry-demo',
    codeJson: `{\n  "type": "TimeEntry",\n  "props": {\n    "time": "18:13",\n    "title": "autorag audit shipped",\n    "body": "51 objects / 13.5 MiB removed…",\n    "tags": ["infra", "autorag", "cleanup"],\n    "color": "#00e5ff"\n  }\n}`,
  },
  {
    id: 'pc-timelineevent',
    title: 'TimelineEvent',
    category: 'temporal',
    description: 'Single event on a vertical spine. Stack multiple for an event thread.',
    demoKey: 'pc-timelineevent-demo',
    codeJson: `{\n  "type": "TimelineEvent",\n  "props": {\n    "time": "18:07",\n    "label": "generi-co day-off logged in daily note",\n    "color": "#98c379"\n  }\n}`,
  },
  {
    id: 'pc-contextstream',
    title: 'ContextStream',
    category: 'temporal',
    description: 'Filterable timeline of ctx:: captures with project color coding and mode badges.',
    demoKey: 'pc-contextstream-demo',
    codeJson: `{\n  "type": "ContextStream",\n  "props": {\n    "title": "Today (excerpt)",\n    "captures": [\n      { "time": "18:07", "project": "generi-co/pharma-app", "mode": "day-off", "text": "…" },\n      { "time": "18:13", "project": "float-box",       "mode": "infra-audit", "text": "…" },\n      { "time": "18:55", "project": "floatty",         "mode": "build",  "text": "…" }\n    ]\n  }\n}`,
  },
  // Viz
  {
    id: 'pc-linkgraph',
    title: 'LinkGraph',
    category: 'viz',
    description: 'Radial SVG graph. One center node, others on rings 1-3. Good for page topology.',
    demoKey: 'pc-linkgraph-demo',
    codeJson: `{\n  "type": "LinkGraph",\n  "props": {\n    "title": "catalog-atoms neighborhood",\n    "nodes": [\n      { "id": "atoms", "label": "…", "center": true, "color": "#00e5ff", "weight": 2 },\n      { "id": "bbs",   "label": "…", "ring": 1, "color": "#e040a0" },\n      { "id": "catalog", "label": "…", "ring": 2, "type": "stub" }\n    ],\n    "edges": [["atoms","catalog"], ["atoms","bbs"]]\n  }\n}`,
  },
  {
    id: 'pc-heatmap',
    title: 'ActivityHeatmap',
    category: 'viz',
    description: 'Grid of colored squares. Brightness scales with value. Good for session activity.',
    demoKey: 'pc-heatmap-demo',
    codeJson: `{\n  "type": "ActivityHeatmap",\n  "props": {\n    "title": "session activity",\n    "color": "#00e5ff",\n    "data": [\n      { "label": "Tue", "value":  8 },\n      { "label": "Wed", "value": 12 },\n      { "label": "Thu", "value":  4 }\n    ]\n  }\n}`,
  },
  {
    id: 'pc-provenance',
    title: 'ProvenanceChain',
    category: 'viz',
    description: 'Vertical source trail. Each step: source type (qmd/bbs/outline/loki), content, optional docId and confidence.',
    demoKey: 'pc-provenance-demo',
    codeJson: `{\n  "type": "ProvenanceChain",\n  "props": {\n    "title": "how we found the autorag strays",\n    "steps": [\n      { "source": "outline",   "content": "Alex asked …",       "confidence": 100 },\n      { "source": "qmd",       "content": "Retrieved script…",   "confidence":  95 },\n      { "source": "autorag",   "content": "rclone ls revealed…", "confidence":  90 }\n    ]\n  }\n}`,
  },
  {
    id: 'pc-riskmatrix',
    title: 'RiskMatrix',
    category: 'viz',
    description: 'Severity × impact grid. Rows: high/medium/low. Columns: structural/content/cosmetic.',
    demoKey: 'pc-riskmatrix-demo',
    codeJson: `{\n  "type": "RiskMatrix",\n  "props": {\n    "title": "catalog-atoms rollout risks",\n    "items": [\n      { "label": "phantom-pantry recurrence", "severity": "high",   "impact": "structural" },\n      { "label": "component API drift",       "severity": "medium", "impact": "content" },\n      { "label": "styling inconsistency",     "severity": "low",    "impact": "cosmetic" }\n    ]\n  }\n}`,
  },
  {
    id: 'pc-timelinediff',
    title: 'TimelineDiff',
    category: 'viz',
    description: 'Side-by-side before/after. removed:true strikes through red, added:true highlights green.',
    demoKey: 'pc-timelinediff-demo',
    codeJson: `{\n  "type": "TimelineDiff",\n  "props": {\n    "title": "render-reference coverage",\n    "before": {\n      "date": "before atoms",\n      "items": [\n        { "text": "22 / 57 covered" },\n        { "text": "35 untested",  "removed": true }\n      ]\n    },\n    "after": {\n      "date": "after atoms",\n      "items": [\n        { "text": "57 / 57 covered", "added": true }\n      ]\n    }\n  }\n}`,
  },
  {
    id: 'pc-treeview',
    title: 'TreeView',
    category: 'viz',
    description: 'Hierarchical tree (up to 3 levels). Status-colored nodes: done/active/pending/deferred.',
    demoKey: 'pc-treeview-demo',
    codeJson: `{\n  "type": "TreeView",\n  "props": {\n    "title": "catalog coverage plan",\n    "defaultExpanded": true,\n    "nodes": [\n      {\n        "id": "phase0", "label": "Phase 0 — scout", "status": "done",\n        "children": [\n          { "id": "read-app", "label": "read App.tsx",     "status": "done" },\n          { "id": "gap",      "label": "gap analysis",     "status": "done" }\n        ]\n      },\n      { "id": "phase1", "label": "Phase 1 — atoms", "status": "active" }\n    ]\n  }\n}`,
  },
  // Layout
  {
    id: 'pc-layout-note',
    title: 'DocLayout',
    category: 'layout',
    description: 'Two-column full-height layout: fixed sidebar + scrollable main. Typically at page root, not nested. Demonstrated via App shell — tab 7 itself uses it.',
    demoKey: 'pc-layout-note-demo',
    codeJson: `{\n  "type": "DocLayout",\n  "props": {},\n  "slots": {\n    "sidebar": [ /* Nav* family */ ],\n    "main":    [ /* page content */ ]\n  }\n}`,
  },
  {
    id: 'pc-nav',
    title: 'NavBrand · NavSection · NavItem · NavFooter',
    category: 'layout',
    description: 'Sidebar building blocks. NavBrand (title+subtitle) + NavSection (label+accent) + NavItem (active state) + NavFooter (metadata).',
    demoKey: 'pc-nav-demo',
    codeJson: `// NavBrand\n{ "type": "NavBrand", "props": { "title": "render::", "subtitle": "reference v0.1" } }\n\n// NavSection\n{ "type": "NavSection", "props": { "label": "SECTION HEADER", "accent": "cyan" } }\n\n// NavItem\n{ "type": "NavItem", "props": { "id": "b", "label": "…", "active": true } }\n\n// NavFooter\n{ "type": "NavFooter", "props": { "content": "last updated: 2026-04-21" } }`,
  },
];

// Build element entries for all atom cards by spreading the helper output
const allAtomCards: Record<string, any> = atoms.reduce(
  (acc, atom) => ({ ...acc, ...atomEntries(atom) }),
  {},
);

export const catalogAtomsSpec: Spec = {
  root: 'doc',
  state: {
    atoms_filter: 'all',
    atoms_tab: 'primitives',
  },
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 24, padding: 24 },
      children: [
        'header',
        'intro-note',
        's-primitives-h',
        's-primitives',
        's-display-h',
        's-display',
        's-navigation-h',
        's-navigation',
        's-input-h',
        's-input',
        's-tui-h',
        's-tui',
        's-temporal-h',
        's-temporal',
        's-viz-h',
        's-viz',
        's-layout-h',
        's-layout',
      ],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'Catalog Atoms',
        subtitle: 'Every catalog component, rendered through the real @json-render/solid pipeline — JSON source beside each live demo.',
        date: '2026-04-21',
        stats: [
          { label: 'catalog total', value: '57' },
          { label: 'in composition specs', value: '22' },
          { label: 'atomic here', value: '35' },
        ],
      },
    },

    'intro-note': {
      type: 'QuoteBlock',
      props: {
        type: 'note',
        text: 'Each atom: PatternCard with category tag, description, and a split-pane — JSON spec on left, live render on right. If the right pane is blank, that component is broken or mis-registered.',
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // PRIMITIVES
    // ═══════════════════════════════════════════════════════════════
    's-primitives-h': { type: 'Heading', props: { level: 1, content: 'Primitives' } },
    's-primitives': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['pc-divider-card', 'pc-card-card', 'pc-metric-card', 'pc-button-card', 'pc-ellipsis-card', 'pc-code-card'],
    },
    'pc-divider-demo': { type: 'Divider', props: {} },
    'pc-card-demo': {
      type: 'Card',
      props: { title: 'Example card', subtitle: 'subtitle slot' },
      children: ['pc-card-demo-body'],
    },
    'pc-card-demo-body': { type: 'Paragraph', props: { content: 'Card body content goes in the default slot.' } },
    'pc-metric-demo': { type: 'Metric', props: { label: 'active sessions', value: '42' } },
    'pc-button-demo': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 8 },
      children: ['pc-btn-p', 'pc-btn-s', 'pc-btn-d'],
    },
    'pc-btn-p': { type: 'Button', props: { label: 'primary', variant: 'primary' } },
    'pc-btn-s': { type: 'Button', props: { label: 'secondary', variant: 'secondary' } },
    'pc-btn-d': { type: 'Button', props: { label: 'danger', variant: 'danger' } },
    'pc-ellipsis-demo': { type: 'Ellipsis', props: {} },
    'pc-code-demo': {
      type: 'Code',
      props: {
        language: 'typescript',
        content: "const catalog = schema.createCatalog({\n  components: { ... },\n});",
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // DISPLAY CHIPS & REFS
    // ═══════════════════════════════════════════════════════════════
    's-display-h': { type: 'Heading', props: { level: 1, content: 'Display chips & refs' } },
    's-display': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['pc-breadcrumb-card', 'pc-wikilink-card', 'pc-modetag-card', 'pc-statpill-card', 'pc-image-card'],
    },
    'pc-breadcrumb-demo': { type: 'Breadcrumb', props: { label: 'posts to the bbs' } },
    'pc-wikilink-demo': { type: 'WikilinkChip', props: { target: '2026-04-21-json-prompting-died', label: 'json-prompting-died' } },
    'pc-modetag-demo': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 6 },
      children: ['pc-mt1', 'pc-mt2', 'pc-mt3', 'pc-mt4', 'pc-mt5', 'pc-mt6'],
    },
    'pc-mt1': { type: 'ModeTag', props: { mode: 'work', count: 12 } },
    'pc-mt2': { type: 'ModeTag', props: { mode: 'float', count: 7 } },
    'pc-mt3': { type: 'ModeTag', props: { mode: 'life', count: 3 } },
    'pc-mt4': { type: 'ModeTag', props: { mode: 'pebble', count: 1 } },
    'pc-mt5': { type: 'ModeTag', props: { mode: 'rent', count: 9 } },
    'pc-mt6': { type: 'ModeTag', props: { mode: 'spike', count: 2 } },
    'pc-statpill-demo': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 8 },
      children: ['pc-sp1', 'pc-sp2', 'pc-sp3'],
    },
    'pc-sp1': { type: 'StatPill', props: { label: 'tests', value: '488', color: '#98c379' } },
    'pc-sp2': { type: 'StatPill', props: { label: 'coverage', value: '57/57', color: '#00e5ff' } },
    'pc-sp3': { type: 'StatPill', props: { label: 'objects', value: '11,105', color: '#e040a0' } },
    'pc-image-demo': {
      type: 'Image',
      props: {
        // Inline SVG data URI — keeps the reference app offline-safe and
        // dist/index.html truly standalone (no external fetch).
        // CodeRabbit: 3120901906
        src: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120" viewBox="0 0 400 120"><rect width="400" height="120" fill="%23161616"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="%2300e5ff" font-family="monospace" font-size="18">placeholder</text></svg>',
        alt: 'Placeholder image demonstrating Image atom',
        maxWidth: 400,
        borderRadius: 6,
        caption: 'Image with caption slot.',
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // NAVIGATION CONTROLS
    // ═══════════════════════════════════════════════════════════════
    's-navigation-h': { type: 'Heading', props: { level: 1, content: 'Navigation controls' } },
    's-navigation': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['pc-collapsible-card', 'pc-filter-card', 'pc-tabnav-card'],
    },
    'pc-collapsible-demo': {
      type: 'CollapsibleSection',
      props: { title: 'Toggle me', expanded: true, count: 3, color: '#00e5ff' },
      children: ['pc-collapsible-body'],
    },
    'pc-collapsible-body': { type: 'Paragraph', props: { content: 'This content lives inside the collapsible slot.' } },
    'pc-filter-demo': {
      type: 'FilterButtons',
      props: {
        filters: [
          { id: 'all', label: 'all', count: 35 },
          { id: 'primitives', label: 'primitives', count: 6 },
          { id: 'display', label: 'display', count: 5 },
          { id: 'viz', label: 'viz', count: 6 },
        ],
        active: { $bindState: 'atoms_filter' },
      },
    },
    'pc-tabnav-demo': {
      type: 'TabNav',
      props: {
        tabs: [
          { id: 'primitives', label: 'Primitives' },
          { id: 'display', label: 'Display' },
          { id: 'viz', label: 'Viz' },
        ],
        active: { $bindState: 'atoms_tab' },
        variant: 'pills',
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // INPUT
    // ═══════════════════════════════════════════════════════════════
    's-input-h': { type: 'Heading', props: { level: 1, content: 'Input' } },
    's-input': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['pc-textinput-card', 'pc-textarea-card'],
    },
    'pc-textinput-demo': { type: 'TextInput', props: { label: 'slug', placeholder: 'kebab-case-name', value: '' } },
    'pc-textarea-demo': { type: 'TextArea', props: { label: 'body', placeholder: 'markdown content…', rows: 4, value: '' } },

    // ═══════════════════════════════════════════════════════════════
    // TUI
    // ═══════════════════════════════════════════════════════════════
    's-tui-h': { type: 'Heading', props: { level: 1, content: 'TUI' } },
    's-tui': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['pc-tuistat-card', 'pc-barchart-card'],
    },
    'pc-tuistat-demo': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 12 },
      children: ['pc-ts1', 'pc-ts2', 'pc-ts3'],
    },
    'pc-ts1': { type: 'TuiStat', props: { label: 'OBJECTS', value: '11,105', color: '#00e5ff' } },
    'pc-ts2': { type: 'TuiStat', props: { label: 'REMOVED', value: '51', color: '#98c379' } },
    'pc-ts3': { type: 'TuiStat', props: { label: 'MIB FREED', value: '13.5', color: '#e040a0' } },
    'pc-barchart-demo': {
      type: 'BarChart',
      props: { title: 'Components per category', maxHeight: 120 },
      children: ['pc-bi1', 'pc-bi2', 'pc-bi3', 'pc-bi4', 'pc-bi5'],
    },
    'pc-bi1': { type: 'BarItem', props: { label: 'display', value: 10, color: '#00e5ff' } },
    'pc-bi2': { type: 'BarItem', props: { label: 'primitives', value: 7, color: '#98c379' } },
    'pc-bi3': { type: 'BarItem', props: { label: 'viz', value: 6, color: '#e040a0' } },
    'pc-bi4': { type: 'BarItem', props: { label: 'nav', value: 5, color: '#ffb300' } },
    'pc-bi5': { type: 'BarItem', props: { label: 'layout', value: 5, color: '#61afef' } },

    // ═══════════════════════════════════════════════════════════════
    // TEMPORAL / TIMELINE
    // ═══════════════════════════════════════════════════════════════
    's-temporal-h': { type: 'Heading', props: { level: 1, content: 'Temporal & timelines' } },
    's-temporal': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['pc-timeentry-card', 'pc-timelineevent-card', 'pc-contextstream-card'],
    },
    'pc-timeentry-demo': {
      type: 'TimeEntry',
      props: {
        time: '18:13',
        title: 'autorag audit shipped',
        body: '51 objects / 13.5 MiB removed from R2; inbox filter added to sync-dispatch-to-r2.sh upstream.',
        tags: ['infra', 'autorag', 'cleanup'],
        color: '#00e5ff',
      },
    },
    'pc-timelineevent-demo': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 6 },
      children: ['pc-te1', 'pc-te2', 'pc-te3'],
    },
    'pc-te1': { type: 'TimelineEvent', props: { time: '18:07', label: 'generi-co day-off logged in daily note', color: '#98c379' } },
    'pc-te2': { type: 'TimelineEvent', props: { time: '18:13', label: 'autorag R2 audit + cleanup', color: '#00e5ff' } },
    'pc-te3': { type: 'TimelineEvent', props: { time: '18:55', label: 'render-reference catalog coverage', color: '#e040a0' } },
    'pc-contextstream-demo': {
      type: 'ContextStream',
      props: {
        title: 'Today (excerpt)',
        captures: [
          { time: '18:07', project: 'generi-co/pharma-app', mode: 'day-off', text: 'generi-co day off marked in daily note + W17 tracker.' },
          { time: '18:13', project: 'float-box', mode: 'infra-audit', text: 'autorag/R2 health check — 11.1k objects, found stray inbox transcripts.' },
          { time: '18:55', project: 'floatty', mode: 'build', text: 'render-reference catalog-atoms coverage spec underway.' },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // VISUALIZATIONS
    // ═══════════════════════════════════════════════════════════════
    's-viz-h': { type: 'Heading', props: { level: 1, content: 'Visualizations' } },
    's-viz': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['pc-linkgraph-card', 'pc-heatmap-card', 'pc-provenance-card', 'pc-riskmatrix-card', 'pc-timelinediff-card', 'pc-treeview-card'],
    },
    'pc-linkgraph-demo': {
      type: 'LinkGraph',
      props: {
        title: 'catalog-atoms neighborhood',
        nodes: [
          { id: 'atoms', label: 'catalog-atoms', center: true, color: '#00e5ff', weight: 2 },
          { id: 'bbs', label: 'bbs-post', ring: 1, color: '#e040a0' },
          { id: 'daily', label: 'daily-note', ring: 1, color: '#98c379' },
          { id: 'sprint', label: 'sprint-wrap', ring: 1, color: '#ffb300' },
          { id: 'catalog', label: 'catalog.ts', ring: 2, type: 'stub' },
          { id: 'registry', label: 'registry.ts', ring: 2, type: 'stub' },
        ],
        edges: [
          ['atoms', 'catalog'],
          ['atoms', 'registry'],
          ['atoms', 'bbs'],
          ['atoms', 'daily'],
          ['atoms', 'sprint'],
        ],
      },
    },
    'pc-heatmap-demo': {
      type: 'ActivityHeatmap',
      props: {
        title: 'session activity (last 7 days)',
        color: '#00e5ff',
        data: [
          { label: 'Tue', value: 8 },
          { label: 'Wed', value: 12 },
          { label: 'Thu', value: 4 },
          { label: 'Fri', value: 15 },
          { label: 'Sat', value: 2 },
          { label: 'Sun', value: 6 },
          { label: 'Mon', value: 11 },
        ],
      },
    },
    'pc-provenance-demo': {
      type: 'ProvenanceChain',
      props: {
        title: 'how we found the autorag strays',
        steps: [
          { source: 'outline', content: 'Alex asked for autorag health check at 18:13.', confidence: 100 },
          { source: 'qmd', content: 'Retrieved sync-dispatch script from float-box filesystem.', docId: 'sync-dispatch-to-r2.sh', confidence: 95 },
          { source: 'autorag', content: 'rclone ls revealed 5,835 stale objects under projects/ prefix.', confidence: 90 },
          { source: 'conversation', content: 'Cross-referenced with disabled sync-projects-to-r2.sh.disabled.', lines: '1-30', confidence: 85 },
        ],
      },
    },
    'pc-riskmatrix-demo': {
      type: 'RiskMatrix',
      props: {
        title: 'catalog-atoms rollout risks',
        items: [
          { label: 'phantom-pantry recurrence', severity: 'high', impact: 'structural' },
          { label: 'component API drift', severity: 'medium', impact: 'content' },
          { label: 'styling inconsistency', severity: 'low', impact: 'cosmetic' },
          { label: 'missing component impl', severity: 'high', impact: 'structural' },
          { label: 'bindState gotcha', severity: 'medium', impact: 'content' },
        ],
      },
    },
    'pc-timelinediff-demo': {
      type: 'TimelineDiff',
      props: {
        title: 'render-reference coverage',
        before: {
          date: 'before atoms',
          items: [
            { text: '6 composition specs' },
            { text: '22 of 57 components covered' },
            { text: '35 components untested in pipeline', removed: true },
          ],
        },
        after: {
          date: 'after atoms',
          items: [
            { text: '6 composition specs + 1 atoms spec' },
            { text: '57 of 57 components covered', added: true },
            { text: 'coverage map = living spec', added: true },
          ],
        },
      },
    },
    'pc-treeview-demo': {
      type: 'TreeView',
      props: {
        title: 'catalog coverage plan',
        defaultExpanded: true,
        nodes: [
          {
            id: 'phase0', label: 'Phase 0 — scout', status: 'done',
            children: [
              { id: 'read-app', label: 'read App.tsx', status: 'done' },
              { id: 'read-catalog', label: 'enumerate catalog', status: 'done', detail: '57 components' },
              { id: 'gap', label: 'gap analysis', status: 'done', detail: '35 uncovered' },
            ],
          },
          {
            id: 'phase1', label: 'Phase 1 — atoms', status: 'done',
            children: [
              { id: 'write-spec', label: 'author catalog-atoms.ts', status: 'done' },
              { id: 'wire-app', label: 'wire into App.tsx', status: 'done' },
              { id: 'patterncard', label: 'PatternCard-per-atom layout', status: 'done' },
              { id: 'splitpane', label: 'JSON beside live render', status: 'done' },
            ],
          },
          { id: 'phase2', label: 'Phase 2 — conceptual patterns', status: 'done', detail: 'tab 8 landed' },
          { id: 'phase3', label: 'Phase 3 — port patterns.html content', status: 'deferred' },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // LAYOUT (DocLayout + Nav family)
    // ═══════════════════════════════════════════════════════════════
    's-layout-h': { type: 'Heading', props: { level: 1, content: 'Layout & sidebar nav' } },
    's-layout': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['pc-layout-note-card', 'pc-nav-card'],
    },
    'pc-layout-note-demo': {
      type: 'QuoteBlock',
      props: { type: 'quote', text: 'DocLayout demo not nested here — see App shell for a live two-column layout.' },
    },
    'pc-nav-demo': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 4, padding: 12, width: '260px', borderRight: '1px solid #2a2a2a' },
      children: ['pc-navbrand', 'pc-navsection', 'pc-navitem-a', 'pc-navitem-b', 'pc-navitem-c', 'pc-navfooter'],
    },
    'pc-navbrand': { type: 'NavBrand', props: { title: 'render::', subtitle: 'reference v0.1' } },
    'pc-navsection': {
      type: 'NavSection',
      props: { label: 'SECTION HEADER', accent: 'cyan' },
      children: [],
    },
    'pc-navitem-a': { type: 'NavItem', props: { id: 'a', label: 'Nav item (default)', active: false } },
    'pc-navitem-b': { type: 'NavItem', props: { id: 'b', label: 'Nav item (active)', active: true } },
    'pc-navitem-c': { type: 'NavItem', props: { id: 'c', label: 'Nav item (default)', active: false } },
    'pc-navfooter': { type: 'NavFooter', props: { content: 'last updated: 2026-04-21' } },

    // ─── Auto-generated PatternCard/split/code entries for every atom ──
    ...allAtomCards,
  },
};
