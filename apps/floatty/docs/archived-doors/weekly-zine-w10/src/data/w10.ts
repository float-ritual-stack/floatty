export interface Door {
  label: string;
  type: 'outline-block' | 'outline-page';
  target: string;
}

export interface ShipItem {
  type: 'pr' | 'release' | 'entry' | 'quote';
  title: string;
  summary: string;
  scope?: string;
  doors: Door[];
  tags?: string[];
  status?: 'merged' | 'open' | 'fixed' | 'shipped';
  highlight?: boolean;
}

export interface StatItem {
  label: string;
  value: string;
}

export interface Section {
  id: string;
  title: string;
  accent: string;
  items: ShipItem[];
}

export interface WeekData {
  week: string;
  dateRange: string;
  stats: StatItem[];
  sections: Section[];
}

export const W10_DATA: WeekData = {
  week: 'W10',
  dateRange: 'Mar 1-6, 2026',
  stats: [
    { label: 'PRs Shipped', value: '8' },
    { label: 'Released', value: 'v0.8.0' },
    { label: 'History Doc', value: '6600w' },
    { label: 'Linear Issues', value: '12' },
  ],
  sections: [
    {
      id: 'rangle',
      title: 'Rangle / Pharmacy',
      accent: '#4ade80',
      items: [
        {
          type: 'pr',
          title: '#1682 — feat: visual grouping for assessment builder',
          summary:
            'Adds visual grouping to the assessment flow builder. Admins select 2+ sections and press Ctrl+G to group them. Named, color-coded, with rich-text notes. xyflow parentId nesting gives free drag-together, copy/paste ID remapping, and extent clamping. Non-destructive delete ungroups children. Single-level lock (Figma-style).',
          scope: '+948 -61 · 10 files · 381 tests',
          status: 'merged',
          highlight: true,
          tags: ['feature', '#1530'],
          doors: [
            { label: 'PR #1682', type: 'outline-page', target: 'PR #1682' },
            { label: '#1530', type: 'outline-page', target: '#1530' },
          ],
        },
        {
          type: 'pr',
          title: '#1671 — fix: block BMI switch routing until both inputs present',
          summary:
            'BMIData object with bmi: null is truthy, bypassing the !questionResponse guard. Replaced falsy check with isEmptyValue() from form-validation.ts in both assessment-logic.ts and path-resolver.ts.',
          scope: '+11 -7 · 3 files · 8 new tests',
          status: 'fixed',
          highlight: true,
          tags: ['bugfix', '#1528'],
          doors: [
            { label: 'PR #1671', type: 'outline-page', target: 'PR #1671' },
            { label: '#1528', type: 'outline-page', target: '#1528' },
          ],
        },
        {
          type: 'pr',
          title: '#1664 — feat: between operator for numeric switch conditions',
          summary:
            'Range-based routing for numeric conditions (e.g., BMI 18.5-24.9). Dead branch detection using interval math flags unreachable conditions. Readable "between" label, fixed-width operator dropdown.',
          scope: '+230 -24 · 7 files · 135 new condition-eval tests',
          status: 'merged',
          tags: ['feature', '#1526'],
          doors: [
            { label: 'PR #1664', type: 'outline-page', target: 'PR #1664' },
            { label: '#1526', type: 'outline-page', target: '#1526' },
          ],
        },
        {
          type: 'pr',
          title: '#1656 — feat: number input + switch node for numeric comparisons',
          summary:
            'Number Input question type for the assessment builder. Numeric comparison routing in Switch node with <, <=, =, >=, > operators. Fixed handleId collision bug (index-based IDs that collided after delete+add) and orphaned edges on condition deletion.',
          scope: '+729 -36 · 16 files · 13 new tests',
          status: 'merged',
          tags: ['feature', '#1526'],
          doors: [
            { label: 'PR #1656', type: 'outline-page', target: 'PR #1656' },
            { label: '#1526', type: 'outline-page', target: '#1526' },
          ],
        },
        {
          type: 'pr',
          title: '#1633 — feat: BMI-based routing in switch node',
          summary:
            'Response extraction layer that converts complex question responses (BMI object -> traffic light string) before condition evaluation. BMISwitchForm admin UI for configuring Red/Yellow/Green routing. Human-readable edge labels. data-testid attributes on all builder node types.',
          scope: '+482 -22 · 16 files',
          status: 'merged',
          tags: ['feature', '#1528'],
          doors: [
            { label: 'PR #1633', type: 'outline-page', target: 'PR #1633' },
            { label: '#1528', type: 'outline-page', target: '#1528' },
          ],
        },
        {
          type: 'pr',
          title: '#1678 — feat: disambiguate duplicate question titles in switch nodes',
          summary:
            'getDuplicateNodeIds() utility detects questions sharing the same title. Shows 4-char ID badge on canvas nodes when duplicates exist. Zoom-to-question on selection with viewport shift to compensate for config panel.',
          scope: '+182 -8 · 5 files',
          status: 'open',
          tags: ['feature', '#1622'],
          doors: [
            { label: 'PR #1678', type: 'outline-page', target: 'PR #1678' },
            { label: '#1622', type: 'outline-page', target: 'Issue #1622' },
          ],
        },
        {
          type: 'pr',
          title: '#1676 — fix: QA fixes for Recommend Treatments node',
          summary:
            'Rename sidebar title per Scott sync (Products -> Treatments). onWheel stopPropagation on PopoverContent — React Flow\'s document-level wheel listener was capturing scroll events inside the Radix Portal dropdown, preventing mouse-wheel scrolling through product options.',
          scope: '+11 -7 · 3 files',
          status: 'open',
          tags: ['bugfix', '#1525'],
          doors: [
            { label: 'PR #1676', type: 'outline-page', target: 'PR #1676' },
            { label: '#1525', type: 'outline-page', target: 'Issue #1525' },
          ],
        },
        {
          type: 'pr',
          title: '#1648 — fix: single-variant qty stepper + add-on message',
          summary:
            'Quantity stepper for single-variant products instead of pill selectors. "Additional product(s) will be added to your basket" message when includeAddOns is enabled. New isSingleStandardVariant memo, hasProductAdditions boolean threaded through server page.',
          scope: '+362 -76 · 8 files',
          status: 'merged',
          tags: ['bugfix', '#1525'],
          doors: [
            { label: 'PR #1648', type: 'outline-page', target: 'PR #1648' },
            { label: '#1525', type: 'outline-page', target: 'Issue #1525' },
          ],
        },
        {
          type: 'pr',
          title: '#1631 — fix: align Recommend Products wording + description rendering',
          summary:
            'Replaced broken descriptionComponents renderer with shared <RichText /> component. Lists, bold, and headings from Sanity now render consistently with PDP and detail tabs.',
          scope: '+10 -24 · 5 files',
          status: 'merged',
          tags: ['bugfix'],
          doors: [
            { label: 'PR #1631', type: 'outline-page', target: 'PR #1631' },
          ],
        },
        {
          type: 'pr',
          title: '#1607 — fix: independent selection paths for bundle/standard ATB buttons',
          summary:
            'Bundle and standard "Add to Basket" shared coupled selection state — selecting a bundle cleared attribute selections and vice versa. Explicit SKU on submit, independent price display, auto-select single valid dependent. Error handling hardening with catch blocks + toast.error().',
          scope: '+821 -220 · 13 files',
          status: 'merged',
          highlight: true,
          tags: ['bugfix', '#1525'],
          doors: [
            { label: 'PR #1607', type: 'outline-page', target: 'PR #1607' },
            { label: '#1525', type: 'outline-page', target: 'Issue #1525' },
          ],
        },
      ],
    },
    {
      id: 'floatty',
      title: 'Floatty',
      accent: '#fb923c',
      items: [
        {
          type: 'release',
          title: 'v0.8.0 — doors, chirp, pane linking, context API',
          summary:
            'Major milestone. Door plugin system (Units 1.0-12.0), artifact handler + chirp protocol (PR #162), pane linking with tmux-style Cmd+L/Cmd+J, focus overlay letter picker, context retrieval API (GET /blocks/:id with ancestors/siblings/children/tree/token_estimate), search breadcrumbs. 976 tests.',
          status: 'shipped',
          highlight: true,
          doors: [
            { label: 'FLO-223', type: 'outline-page', target: 'FLO-223' },
            { label: 'FLO-338', type: 'outline-page', target: 'FLO-338' },
            { label: 'FLO-283', type: 'outline-page', target: 'FLO-283' },
            { label: 'PR #162', type: 'outline-page', target: 'PR #162' },
          ],
        },
        {
          type: 'entry',
          title: 'Architecture Course Correction',
          summary:
            'Floatty is NOT the agent loop. It\'s home base — the persistent navigable surface where work accumulates. The agent works in the terminal. Results land in the outline. The outline doesn\'t need to become the agent.',
          tags: ['architecture', 'decision'],
          doors: [],
        },
        {
          type: 'entry',
          title: 'evna-next Vision',
          summary:
            'Three layers crystallized: (1) Floatty as Readwise-for-thoughts — ephemeral processing surface. (2) Inbox queue pattern — siblings drop work into queues, evna is the gardener. (3) Outliner-first agent — evna lives in the outline, thinks in blocks, uses doors as capabilities.',
          tags: ['evna', 'vision'],
          doors: [],
        },
        {
          type: 'entry',
          title: 'Doors + Chirp Protocol shipped (PR #162)',
          summary:
            'Artifact handler, chirp protocol, pane linking. Doors are first-class citizens that talk to the outline via postMessage. Bidirectional chirp bridge, Sucrase transform, esm.sh import maps.',
          doors: [
            { label: 'FLO-223', type: 'outline-page', target: 'FLO-223' },
            { label: 'FLO-420', type: 'outline-page', target: 'FLO-420' },
            { label: 'PR #162', type: 'outline-page', target: 'PR #162' },
          ],
        },
      ],
    },
    {
      id: 'infra',
      title: 'Infrastructure',
      accent: '#60a5fa',
      items: [
        {
          type: 'entry',
          title: 'float-pipeline.sh',
          summary:
            'Full pipeline: autorag -> floatctl -> loki -> BBS -> readwise. All bash. The plumbing that moves context through the system without manual intervention.',
          status: 'shipped',
          tags: ['pipeline', 'automation'],
          doors: [],
        },
        {
          type: 'entry',
          title: 'FLOAT History Document',
          summary:
            '6-pass history document synthesized from 96 source files. 6600 words. Earliest FLOAT trace: March 17, 2025. One year of infrastructure archaeology compressed into a single artifact.',
          tags: ['history', 'archaeology'],
          doors: [],
        },
        {
          type: 'entry',
          title: 'Doctrine Updates',
          summary:
            'userStyle v2 (markers as native syntax, type:: routing). userPreferences v2 (session lifecycle, capture discipline, routing table). Memory edit #28 (type:: routing instruction).',
          tags: ['doctrine'],
          doors: [],
        },
        {
          type: 'entry',
          title: 'MCP Bridge on Release Builds',
          summary:
            'Removed debug_assertions guard from tauri_plugin_mcp_bridge. Release floatty now exposes MCP on localhost-only via Builder::new().bind_address("127.0.0.1").',
          status: 'shipped',
          tags: ['tauri'],
          doors: [],
        },
      ],
    },
    {
      id: 'chaos',
      title: 'Sacred Chaos',
      accent: '#c084fc',
      items: [
        {
          type: 'entry',
          title: 'NotebookLM Deliveries',
          summary:
            '4 transcripts: architecture analysis, leather-logic critique, Posadas psychoanalytic mapping, infrastructure-as-consciousness.',
          tags: ['notebooklm'],
          doors: [],
        },
        {
          type: 'entry',
          title: 'Walking Talks Unearthed',
          summary:
            '3 raw Otter transcripts surfaced: Feb 2021, ~2022 Rangle L&D, March 2025 Rosetta Stone. The oral history layer — thinking that happened on sidewalks.',
          tags: ['otter', 'archaeology'],
          doors: [],
        },
        {
          type: 'entry',
          title: 'RA Ticket Archaeology',
          summary:
            'Ticket history back to 2014. Breakandenter/Minilogue through Standard Time 186/189 to Jeff Mills 30yr Liquid Room Mix. Next: Format x Apollo, Mar 13.',
          tags: ['music'],
          doors: [],
        },
        {
          type: 'quote',
          title: '',
          summary: 'The outline is where you WORK on things, not where they REST.',
          tags: ['evna-next vision, W10'],
          doors: [],
        },
      ],
    },
  ],
};
