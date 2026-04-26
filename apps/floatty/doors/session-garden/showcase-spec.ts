/**
 * Showcase spec — a json-render spec that exercises every catalog component.
 * Returns a full spec object ready for the Renderer.
 */

export function buildShowcaseSpec() {
  return {
    root: 'layout',
    elements: {
      layout: {
        type: 'DocLayout',
        props: {},
        children: ['sidebar', 'main'],
      },

      // ─── SIDEBAR ─────────────────────────────────
      sidebar: {
        type: 'Stack',
        props: {
          direction: 'vertical',
          gap: 0,
          width: '240px',
          minWidth: '240px',
          borderRight: '1px solid #222',
          overflow: 'auto',
        },
        children: ['nav-brand', 'nav-sec-tui', 'nav-tui-1', 'nav-tui-2', 'nav-sec-content', 'nav-content-1', 'nav-content-2', 'nav-sec-layout', 'nav-layout-1', 'nav-footer'],
      },
      'nav-brand': { type: 'NavBrand', props: { title: 'CATALOG', subtitle: 'bbsCatalog showcase' }, children: [] },
      'nav-sec-tui': { type: 'NavSection', props: { label: 'TUI COMPONENTS', accent: 'cyan' }, children: [] },
      'nav-tui-1': { type: 'NavItem', props: { id: 'stats', label: 'Stats & Bars' }, children: [], on: { press: { action: 'scrollTo', params: { id: 'stats' } } } },
      'nav-tui-2': { type: 'NavItem', props: { id: 'panels', label: 'Panels' }, children: [], on: { press: { action: 'scrollTo', params: { id: 'panels' } } } },
      'nav-sec-content': { type: 'NavSection', props: { label: 'CONTENT', accent: 'magenta' }, children: [] },
      'nav-content-1': { type: 'NavItem', props: { id: 'patterns', label: 'Pattern Cards' }, children: [], on: { press: { action: 'scrollTo', params: { id: 'patterns' } } } },
      'nav-content-2': { type: 'NavItem', props: { id: 'shipped', label: 'Shipped Items' }, children: [], on: { press: { action: 'scrollTo', params: { id: 'shipped' } } } },
      'nav-sec-layout': { type: 'NavSection', props: { label: 'LAYOUT', accent: 'coral' }, children: [] },
      'nav-layout-1': { type: 'NavItem', props: { id: 'backlinks', label: 'Backlinks & Refs' }, children: [], on: { press: { action: 'scrollTo', params: { id: 'backlinks' } } } },
      'nav-footer': { type: 'NavFooter', props: { content: '24 components<br>json-render/solid' }, children: [] },

      // ─── MAIN CONTENT ────────────────────────────
      main: {
        type: 'Stack',
        props: {
          direction: 'vertical',
          gap: 24,
          flex: '1',
          padding: '24px 32px 80px',
          overflow: 'auto',
        },
        children: ['sec-stats', 'sec-panels', 'sec-patterns', 'sec-shipped', 'sec-backlinks'],
      },

      // ── Section: Stats & Bar Chart ──────────────
      'sec-stats': {
        type: 'Stack',
        props: { direction: 'vertical', gap: 12, sectionId: 'stats' },
        children: ['stats-title', 'stats-row', 'bar-section'],
      },
      'stats-title': { type: 'EntryHeader', props: { type: 'synthesis', title: 'TuiStat + BarChart', date: '2026-03-24', author: 'showcase' }, children: [] },
      'stats-row': {
        type: 'Stack',
        props: { direction: 'horizontal', gap: 8 },
        children: ['stat-1', 'stat-2', 'stat-3', 'stat-4'],
      },
      'stat-1': { type: 'TuiStat', props: { label: 'Blocks', value: '5,438', color: '#00e5ff' }, children: [] },
      'stat-2': { type: 'TuiStat', props: { label: 'Pages', value: '127', color: '#e040a0' }, children: [] },
      'stat-3': { type: 'TuiStat', props: { label: 'PRs (W12)', value: '8', color: '#98c379' }, children: [] },
      'stat-4': { type: 'TuiStat', props: { label: 'Tests', value: '458', color: '#ffb300' }, children: [] },

      'bar-section': {
        type: 'TuiPanel',
        props: { title: 'Weekly PR Activity', titleColor: '#00e5ff' },
        children: ['bar-chart'],
      },
      'bar-chart': {
        type: 'BarChart',
        props: { maxHeight: 100 },
        children: ['bar-mon', 'bar-tue', 'bar-wed', 'bar-thu', 'bar-fri'],
      },
      'bar-mon': { type: 'BarItem', props: { label: 'Mon', value: 3, max: 8, color: '#e040a0' }, children: [] },
      'bar-tue': { type: 'BarItem', props: { label: 'Tue', value: 5, max: 8, color: '#e040a0' }, children: [] },
      'bar-wed': { type: 'BarItem', props: { label: 'Wed', value: 2, max: 8, color: '#e040a0' }, children: [] },
      'bar-thu': { type: 'BarItem', props: { label: 'Thu', value: 8, max: 8, color: '#e040a0' }, children: [] },
      'bar-fri': { type: 'BarItem', props: { label: 'Fri', value: 4, max: 8, color: '#e040a0' }, children: [] },

      // ── Section: TuiPanel ───────────────────────
      'sec-panels': {
        type: 'Stack',
        props: { direction: 'vertical', gap: 12, sectionId: 'panels' },
        children: ['panels-title', 'panel-row'],
      },
      'panels-title': { type: 'EntryHeader', props: { type: 'bbs-source', title: 'TuiPanel Containers', date: '2026-03-24', board: 'showcase' }, children: [] },
      'panel-row': {
        type: 'Stack',
        props: { direction: 'horizontal', gap: 12 },
        children: ['panel-1', 'panel-2'],
      },
      'panel-1': {
        type: 'TuiPanel',
        props: { title: 'Server Health', titleColor: '#98c379' },
        children: ['panel-1-content'],
      },
      'panel-1-content': {
        type: 'Stack',
        props: { direction: 'vertical', gap: 4 },
        children: ['panel-1-a', 'panel-1-b', 'panel-1-c'],
      },
      'panel-1-a': { type: 'Text', props: { content: 'floatty-server: running', size: 'sm', mono: true }, children: [] },
      'panel-1-b': { type: 'Text', props: { content: 'port: 33333 (dev)', size: 'sm', mono: true }, children: [] },
      'panel-1-c': { type: 'Text', props: { content: 'uptime: 4h 22m', size: 'sm', mono: true, color: '#98c379' }, children: [] },
      'panel-2': {
        type: 'TuiPanel',
        props: { title: 'Sync Status', titleColor: '#ffb300' },
        children: ['panel-2-content'],
      },
      'panel-2-content': {
        type: 'Stack',
        props: { direction: 'vertical', gap: 4 },
        children: ['panel-2-a', 'panel-2-b'],
      },
      'panel-2-a': { type: 'Text', props: { content: 'gaps: 0  echo: 0  dedup: 2', size: 'sm', mono: true }, children: [] },
      'panel-2-b': { type: 'Text', props: { content: 'last sync: 12s ago', size: 'sm', mono: true, color: '#98c379' }, children: [] },

      // ── Section: Pattern Cards ──────────────────
      'sec-patterns': {
        type: 'Stack',
        props: { direction: 'vertical', gap: 12, sectionId: 'patterns' },
        children: ['patterns-title', 'pattern-1', 'pattern-2', 'datablock-1'],
      },
      'patterns-title': { type: 'EntryHeader', props: { type: 'archaeology', title: 'PatternCard + DataBlock', date: '2026-03-24' }, children: [] },
      'pattern-1': {
        type: 'PatternCard',
        props: {
          title: 'Surgical Y.Array Mutations',
          type: 'pattern',
          confidence: 'VERIFIED',
          content: 'Y.Array operations like `delete(0, length)` then `push(newItems)` create fresh CRDT ops that **duplicate on merge**.\n\nUse surgical helpers: `insertChildId`, `removeChildId`, `appendChildId`.',
          connectsTo: ['FLO-280', 'ydoc-patterns'],
        },
        children: [],
      },
      'pattern-2': {
        type: 'PatternCard',
        props: {
          title: 'Default Path Problem',
          type: 'field-note',
          confidence: 'INFERRED',
          content: 'A system built for one actor develops implicit behaviors. A second actor follows the explicit rules and hits every unconsidered state.',
          connectsTo: ['multi-actor', 'scar-tissue'],
        },
        children: [],
      },
      'datablock-1': {
        type: 'DataBlock',
        props: {
          label: 'config.toml',
          content: 'server_port = 33333\nworkspace_name = "default"\nollama_endpoint = "http://float-box:11434"\nollama_model = "qwen2.5:7b"',
        },
        children: [],
      },

      // ── Section: Shipped Items ──────────────────
      'sec-shipped': {
        type: 'Stack',
        props: { direction: 'vertical', gap: 4, sectionId: 'shipped' },
        children: ['shipped-title', 'shipped-panel'],
      },
      'shipped-title': { type: 'EntryHeader', props: { type: 'bbs-source', title: 'ShippedItem + WikilinkChip', date: '2026-W12', board: 'rangle' }, children: [] },
      'shipped-panel': {
        type: 'TuiPanel',
        props: { title: 'Shipped This Week', titleColor: '#98c379' },
        children: ['ship-1', 'ship-2', 'ship-3', 'ship-4', 'ship-divider', 'wikilinks-row'],
      },
      'ship-1': { type: 'ShippedItem', props: { content: '[[PR #1826]] — per-occurrence follow-up config (5 E2E scenarios)' }, children: [] },
      'ship-2': { type: 'ShippedItem', props: { content: '[[PR #1838]] — none option enhancements (458 tests)' }, children: [] },
      'ship-3': { type: 'ShippedItem', props: { content: '[[PR #1806]] — switch node skipped-branch fix (424 tests)' }, children: [] },
      'ship-4': { type: 'ShippedItem', props: { content: '[[PR #1807]] — assessment footer scroll-to-top' }, children: [] },
      'ship-divider': { type: 'Divider', props: {}, children: [] },
      'wikilinks-row': {
        type: 'Stack',
        props: { direction: 'horizontal', gap: 12 },
        children: ['wl-1', 'wl-2', 'wl-3'],
      },
      'wl-1': { type: 'WikilinkChip', props: { target: 'PR #1758' }, children: [], on: { press: { action: 'navigate', params: { target: 'PR #1758' } } } },
      'wl-2': { type: 'WikilinkChip', props: { target: 'Issue #1779' }, children: [], on: { press: { action: 'navigate', params: { target: 'Issue #1779' } } } },
      'wl-3': { type: 'WikilinkChip', props: { target: 'FLO-280', label: 'FLO-280 (Y.Array)' }, children: [], on: { press: { action: 'navigate', params: { target: 'FLO-280' } } } },

      // ── Section: Backlinks ──────────────────────
      'sec-backlinks': {
        type: 'Stack',
        props: { direction: 'vertical', gap: 12, sectionId: 'backlinks' },
        children: ['backlinks-title', 'backlinks-1', 'ref-section'],
      },
      'backlinks-title': { type: 'EntryHeader', props: { type: 'synthesis', title: 'BacklinksFooter + RefCard', date: '2026-03-24' }, children: [] },
      'backlinks-1': {
        type: 'BacklinksFooter',
        props: {
          inbound: ['session-garden', 'outline-janitor'],
          outbound: ['FLO-280', 'scar-tissue', 'foreman-pattern'],
        },
        children: [],
      },
      'ref-section': {
        type: 'RefSection',
        props: { label: 'RELATED' },
        children: ['ref-1', 'ref-2'],
      },
      'ref-1': { type: 'RefCard', props: { id: 'session-garden', type: 'synthesis', title: 'Sunday Session Garden' }, children: [] },
      'ref-2': { type: 'RefCard', props: { id: 'foreman-pattern', type: 'bbs-source', title: 'The Foreman Pattern' }, children: [] },
    },
  };
}
