/**
 * Conceptual Patterns — the JSON IS the lesson.
 *
 * Where catalog-atoms answers "does this component render?", this answers
 * "how do I shape a spec to achieve X?".
 *
 * Each pattern: PatternCard wrapping a horizontal Stack with [Code (JSON),
 * live demo]. The Code block is hand-authored text, not a dynamic serialization
 * — keeps the file self-contained and the JSON authoritative-for-teaching
 * even if the live demo drifts.
 *
 * Ported conceptually from ~/.floatty/doors/render/agent/patterns.html but
 * running through the real @json-render/solid pipeline instead of mimicking
 * it with static HTML. Phantom-pantry retired here.
 */
import type { Spec } from '@json-render/core';

export const conceptualPatternsSpec: Spec = {
  root: 'doc',
  state: {
    // Visibility conditions demo state
    vis_tab: 'overview',
    vis_flag: false,
    // TabNav demo state
    demo_tab: 'overview',
    // Sibling-visibility + $cond value-switch demo state
    cond_role: 'admin',
    // Repeat demo state
    prs: [
      { id: '1', number: '2052', status: 'OPEN' },
      { id: '2', number: '2064', status: 'MERGED' },
      { id: '3', number: '2067', status: 'OPEN' },
      { id: '4', number: '2071', status: 'DRAFT' },
    ],
  },
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 24, padding: 24 },
      children: [
        'header',
        'intro',
        's-visibility-h',
        'p-visibility',
        's-tabnav-h',
        'p-tabnav',
        's-dynamic-h',
        'p-dynamic',
        's-cond-h',
        'p-cond',
        's-repeat-h',
        'p-repeat',
        's-stack-h',
        'p-stack',
      ],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'Conceptual Patterns',
        subtitle: 'How to shape a spec to achieve X. JSON side-by-side with live render.',
        date: '2026-04-21',
        stats: [
          { label: 'patterns', value: '6' },
          { label: '@json-render/solid', value: '0.18.0' },
          { label: 'JSON = lesson', value: 'true' },
        ],
      },
    },

    intro: {
      type: 'QuoteBlock',
      props: {
        type: 'note',
        text: 'Each pattern shows the spec JSON beside what it renders. Where atoms answered "does X render", these patterns answer "how do I compose a spec to do Y".',
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // 1. VISIBILITY CONDITIONS
    // ═══════════════════════════════════════════════════════════════
    's-visibility-h': { type: 'Heading', props: { level: 1, content: 'Visibility Conditions' } },
    'p-visibility': {
      type: 'PatternCard',
      props: {
        label: 'visible — sibling of type/props/children',
        description: '*Dynamic.* `visible` is a TOP-LEVEL field on an element, NOT inside props. Operators: $state (truthy), eq, neq, not, gt/lt, $or, $and.',
      },
      children: ['p-vis-split'],
    },
    'p-vis-split': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 16 },
      children: ['p-vis-code', 'p-vis-demo'],
    },
    'p-vis-code': {
      type: 'Code',
      props: {
        language: 'json',
        content:
          '// truthy check\n"visible": { "$state": "/flag" }\n\n// equality\n"visible": { "$state": "/tab", "eq": "overview" }\n\n// negation\n"visible": { "$state": "/flag", "not": true }\n\n// OR (first-tab default)\n"visible": { "$or": [\n  { "$state": "/tab", "eq": "overview" },\n  { "$state": "/tab", "not": true }\n]}\n\n// AND\n"visible": { "$and": [\n  { "$state": "/role", "eq": "admin" },\n  { "$state": "/active" }\n]}\n\n// always hidden (useful during dev)\n"visible": false',
      },
    },
    'p-vis-demo': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 8 },
      children: ['p-vis-demo-ctrl', 'p-vis-demo-overview', 'p-vis-demo-details', 'p-vis-demo-neither'],
    },
    'p-vis-demo-ctrl': {
      type: 'TabNav',
      props: {
        tabs: [
          { id: 'overview', label: 'overview' },
          { id: 'details', label: 'details' },
          { id: 'other', label: 'other' },
        ],
        active: { $bindState: 'vis_tab' },
        variant: 'pills',
      },
    },
    'p-vis-demo-overview': {
      type: 'QuoteBlock',
      props: { type: 'insight', text: '✓ shown when /vis_tab = "overview"' },
      visible: { $state: '/vis_tab', eq: 'overview' },
    },
    'p-vis-demo-details': {
      type: 'QuoteBlock',
      props: { type: 'note', text: '✓ shown when /vis_tab = "details"' },
      visible: { $state: '/vis_tab', eq: 'details' },
    },
    'p-vis-demo-neither': {
      type: 'QuoteBlock',
      props: { type: 'quote', text: '✓ shown when /vis_tab is neither overview nor details ($or fallback)' },
      visible: {
        $or: [
          { $state: '/vis_tab', eq: 'other' },
          { $state: '/vis_tab', not: true },
        ],
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // 2. TABNAV + VISIBILITY SWITCHING
    // ═══════════════════════════════════════════════════════════════
    's-tabnav-h': { type: 'Heading', props: { level: 1, content: 'TabNav + visibility switching' } },
    'p-tabnav': {
      type: 'PatternCard',
      props: {
        label: 'TabNav bound to state + sibling sections with visible $eq',
        description: '*Interactive.* The canonical "tabs switch content" composition. TabNav uses $bindState to write to a state key; content elements declare visible with $state + eq.',
      },
      children: ['p-tabnav-split'],
    },
    'p-tabnav-split': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 16 },
      children: ['p-tabnav-code', 'p-tabnav-demo'],
    },
    'p-tabnav-code': {
      type: 'Code',
      props: {
        language: 'json',
        content:
          '{\n  "state": { "demo_tab": "overview" },\n  "tabs": {\n    "type": "TabNav",\n    "props": {\n      "tabs": [\n        { "id": "overview", "label": "Overview" },\n        { "id": "details",  "label": "Details"  }\n      ],\n      "active": { "$bindState": "/demo_tab" },\n      "variant": "pills"\n    }\n  },\n  "overview-section": {\n    "type": "Paragraph",\n    "props": { "content": "Overview content" },\n    // first tab: visible when /demo_tab=overview OR not set\n    "visible": { "$or": [\n      { "$state": "/demo_tab", "eq": "overview" },\n      { "$state": "/demo_tab", "not": true }\n    ]}\n  },\n  "details-section": {\n    "type": "Paragraph",\n    "props": { "content": "Details content" },\n    "visible": { "$state": "/demo_tab", "eq": "details" }\n  }\n}',
      },
    },
    'p-tabnav-demo': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 8 },
      children: ['p-tabnav-tabs', 'p-tabnav-overview', 'p-tabnav-details'],
    },
    'p-tabnav-tabs': {
      type: 'TabNav',
      props: {
        tabs: [
          { id: 'overview', label: 'Overview' },
          { id: 'details', label: 'Details' },
        ],
        active: { $bindState: 'demo_tab' },
        variant: 'pills',
      },
    },
    'p-tabnav-overview': {
      type: 'Card',
      props: { title: 'Overview', subtitle: 'default tab — shown on first load' },
      children: ['p-tabnav-overview-body'],
      visible: {
        $or: [
          { $state: '/demo_tab', eq: 'overview' },
          { $state: '/demo_tab', not: true },
        ],
      },
    },
    'p-tabnav-overview-body': {
      type: 'Paragraph',
      props: { content: 'This content shows when /demo_tab is "overview" OR not yet set (first-tab default pattern via $or).' },
    },
    'p-tabnav-details': {
      type: 'Card',
      props: { title: 'Details', subtitle: 'secondary tab' },
      children: ['p-tabnav-details-body'],
      visible: { $state: '/demo_tab', eq: 'details' },
    },
    'p-tabnav-details-body': {
      type: 'Paragraph',
      props: { content: 'This content shows only when /demo_tab = "details" — plain $eq, no $or needed since this is not the default.' },
    },

    // ═══════════════════════════════════════════════════════════════
    // 3. DYNAMIC CONTENT VIA SIBLING VISIBILITY
    // ═══════════════════════════════════════════════════════════════
    's-dynamic-h': { type: 'Heading', props: { level: 1, content: 'Dynamic content (via sibling visibility)' } },
    'p-dynamic': {
      type: 'PatternCard',
      props: {
        label: 'Two elements + opposing visibility = value-switch pattern',
        description: '*Dynamic.* For "show X or Y based on state", use two sibling elements with opposing visible conditions. Always works — use when entire elements differ (not just a prop value). For prop-only differences, prefer $cond (next pattern).',
      },
      children: ['p-dynamic-split'],
    },
    'p-dynamic-split': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 16 },
      children: ['p-dynamic-code', 'p-dynamic-demo'],
    },
    'p-dynamic-code': {
      type: 'Code',
      props: {
        language: 'json',
        content:
          '{\n  "state": { "cond_role": "admin" },\n  "ctrl": {\n    "type": "TabNav",\n    "props": {\n      "tabs": [\n        { "id": "admin", "label": "role: admin" },\n        { "id": "user",  "label": "role: user"  }\n      ],\n      "active": { "$bindState": "/cond_role" },\n      "variant": "pills"\n    }\n  },\n  "title-admin": {\n    "type": "Heading",\n    "props": { "level": 1, "content": "Admin Dashboard" },\n    "visible": { "$state": "/cond_role", "eq": "admin" }\n  },\n  "title-user": {\n    "type": "Heading",\n    "props": { "level": 1, "content": "User Dashboard" },\n    "visible": { "$state": "/cond_role", "eq": "user"  }\n  }\n}',
      },
    },
    'p-dynamic-demo': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 8 },
      children: ['p-dynamic-ctrl', 'p-dynamic-admin', 'p-dynamic-user'],
    },
    'p-dynamic-ctrl': {
      type: 'TabNav',
      props: {
        tabs: [
          { id: 'admin', label: 'role: admin' },
          { id: 'user', label: 'role: user' },
        ],
        active: { $bindState: 'cond_role' },
        variant: 'pills',
      },
    },
    'p-dynamic-admin': {
      type: 'Heading',
      props: { level: 1, content: 'Admin Dashboard' },
      visible: { $state: '/cond_role', eq: 'admin' },
    },
    'p-dynamic-user': {
      type: 'Heading',
      props: { level: 1, content: 'User Dashboard' },
      visible: { $state: '/cond_role', eq: 'user' },
    },

    // ═══════════════════════════════════════════════════════════════
    // 4. $cond — CONDITIONAL PROP VALUES
    // ═══════════════════════════════════════════════════════════════
    's-cond-h': { type: 'Heading', props: { level: 1, content: '$cond — conditional prop values' } },
    'p-cond': {
      type: 'PatternCard',
      props: {
        label: '$cond for prop values that vary by state',
        description: '*Dynamic.* When only a prop VALUE differs (not the whole element), use $cond on the prop. Cleaner than duplicating elements with opposing visibility. $cond/$then/$else is a prop expression — resolves to a single value at render time.',
      },
      children: ['p-cond-split'],
    },
    'p-cond-split': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 16 },
      children: ['p-cond-code', 'p-cond-demo'],
    },
    'p-cond-code': {
      type: 'Code',
      props: {
        language: 'json',
        content:
          '// One element, one prop varies by state\n{\n  "title": {\n    "type": "Heading",\n    "props": {\n      "level": 1,\n      "content": {\n        "$cond": { "$state": "/cond_role", "eq": "admin" },\n        "$then": "Admin Dashboard",\n        "$else": "User Dashboard"\n      }\n    }\n  }\n}',
      },
    },
    'p-cond-demo': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 8 },
      children: ['p-cond-ctrl', 'p-cond-title'],
    },
    'p-cond-ctrl': {
      type: 'TabNav',
      props: {
        tabs: [
          { id: 'admin', label: 'role: admin' },
          { id: 'user', label: 'role: user' },
        ],
        active: { $bindState: 'cond_role' },
        variant: 'pills',
      },
    },
    'p-cond-title': {
      type: 'Heading',
      props: {
        level: 1,
        content: {
          $cond: { $state: '/cond_role', eq: 'admin' },
          $then: 'Admin Dashboard',
          $else: 'User Dashboard',
        },
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // 5. REPEAT + $item / $template
    // ═══════════════════════════════════════════════════════════════
    's-repeat-h': { type: 'Heading', props: { level: 1, content: 'Repeat + $item / $template' } },
    'p-repeat': {
      type: 'PatternCard',
      props: {
        label: 'Render children once per item in a state array',
        description: '*Dynamic.* repeat is a top-level field (sibling of type/props/children), not inside props. Inside the repeated children, use $item to read fields, $index for the array position, $template for string interpolation ({field} = current item, {/path} = global state).',
      },
      children: ['p-repeat-split'],
    },
    'p-repeat-split': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 16 },
      children: ['p-repeat-code', 'p-repeat-demo'],
    },
    'p-repeat-code': {
      type: 'Code',
      props: {
        language: 'json',
        content:
          '{\n  "state": {\n    "prs": [\n      { "id": "1", "number": "2052", "status": "OPEN"   },\n      { "id": "2", "number": "2064", "status": "MERGED" }\n    ]\n  },\n  "pr-list": {\n    "type": "Stack",\n    "props": { "direction": "vertical", "gap": 6 },\n    // repeat at ELEMENT level (sibling of type/props/children)\n    "repeat": { "statePath": "/prs", "key": "id" },\n    "children": ["pr-row"]\n  },\n  "pr-row": {\n    "type": "StatPill",\n    "props": {\n      // $template interpolates {fieldname} from current item\n      "label": { "$template": "PR #{number}" },\n      // $item reads a field directly\n      "value": { "$item": "status" },\n      "color": "#00e5ff"\n    }\n  }\n}',
      },
    },
    'p-repeat-demo': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 6 },
      repeat: { statePath: '/prs', key: 'id' },
      children: ['p-repeat-row'],
    },
    'p-repeat-row': {
      type: 'StatPill',
      props: {
        label: { $template: 'PR #{number}' },
        value: { $item: 'status' },
        color: '#00e5ff',
      },
    },

    // ═══════════════════════════════════════════════════════════════
    // 6. STACK + SECTIONS
    // ═══════════════════════════════════════════════════════════════
    's-stack-h': { type: 'Heading', props: { level: 1, content: 'Stack + Section composition' } },
    'p-stack': {
      type: 'PatternCard',
      props: {
        label: 'Layout primitives: direction, Section variants',
        description: '*Layout.* Stack(vertical|horizontal) is the layout primitive; Section adds titled grouping with variant highlighting (default/highlight/warning).',
      },
      children: ['p-stack-split'],
    },
    'p-stack-split': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 16 },
      children: ['p-stack-code', 'p-stack-demo'],
    },
    'p-stack-code': {
      type: 'Code',
      props: {
        language: 'json',
        content:
          '{\n  "root": {\n    "type": "Stack",\n    "props": { "direction": "vertical", "gap": 12 },\n    "children": ["s-default", "s-highlight", "s-warning"]\n  },\n  "s-default": {\n    "type": "Section",\n    "props": { "title": "Default", "variant": "default" },\n    "children": ["t1"]\n  },\n  "s-highlight": {\n    "type": "Section",\n    "props": { "title": "Highlight", "variant": "highlight" },\n    "children": ["t2"]\n  },\n  "s-warning": {\n    "type": "Section",\n    "props": { "title": "Warning", "variant": "warning" },\n    "children": ["t3"]\n  }\n}',
      },
    },
    'p-stack-demo': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['p-stack-default', 'p-stack-highlight', 'p-stack-warning'],
    },
    'p-stack-default': {
      type: 'Section',
      props: { title: 'Default', variant: 'default' },
      children: ['p-stack-t1'],
    },
    'p-stack-t1': { type: 'Paragraph', props: { content: 'Default variant — gray treatment.' } },
    'p-stack-highlight': {
      type: 'Section',
      props: { title: 'Highlight', variant: 'highlight' },
      children: ['p-stack-t2'],
    },
    'p-stack-t2': { type: 'Paragraph', props: { content: 'Highlight variant — cyan accent, for important groupings.' } },
    'p-stack-warning': {
      type: 'Section',
      props: { title: 'Warning', variant: 'warning' },
      children: ['p-stack-t3'],
    },
    'p-stack-t3': { type: 'Paragraph', props: { content: 'Warning variant — amber accent, for caveats and gotchas.' } },
  },
};
