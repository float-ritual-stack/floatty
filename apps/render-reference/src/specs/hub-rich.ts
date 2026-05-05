/**
 * Hub Page — Rich Primitives (Option 14)
 *
 * Uses the four rich-doc components: Hero (page intro), GalleryGrid +
 * CardCover (Notion-style collection of recent work), Callout (typed
 * sections, including nested + foldable). Plus existing LinkGraph and
 * ActivityHeatmap to fill in the visualization layer.
 *
 * The bet: 11 (card-stack) is the conservative answer, 12 (TUI grid) the
 * dense one, 13 (tab-filtered) the interactive one. 14 is what becomes
 * possible once we stop forcing every collection through ShippedItem +
 * CollapsibleSection.
 *
 * All names + IDs are synthetic demo content (Demo Alex/Dana/Sam, ABC-NNN
 * tickets, etc.) — see test-fixtures-no-pii.md.
 */
import type { Spec } from '@json-render/core';

export const hubRichSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 18, padding: 18 },
      children: ['hero', 'note-active', 'recent-h', 'recent-gallery', 'compact-h', 'compact-gallery', 'viz-row', 'sections-h', 'sec-decisions', 'sec-meetings', 'sec-docs', 'sec-open', 'foot'],
    },

    // ─── HERO ────────────────────────────────────────────────────
    hero: {
      type: 'Hero',
      props: {
        eyebrow: 'project::acme/skills-platform · status::active',
        title: 'Skills Platform',
        subtitle: 'AI chat surface for guided product onboarding. Production-LIVE — chat loop verified, accessibility checks green, region-residency question still open.',
        cover: { gradient: 'linear-gradient(135deg, #00e5ff14, #e040a014)', icon: '◇' },
        density: 'full',
        actions: [
          { label: 'PR #42 (merged)', href: '#pr-42', variant: 'primary' },
          { label: 'foundation context v2', href: '#fc-v2' },
          { label: 'open compliance: 2', href: '#compliance' },
        ],
      },
    },

    // ─── PINNED NOTE (uses Callout for "what matters this week") ─
    'note-active': {
      type: 'Callout',
      props: { type: 'info', title: 'What matters this week', collapsible: true, defaultExpanded: true },
      children: ['note-body', 'note-quote', 'note-warning'],
    },
    'note-body': {
      type: 'Text',
      props: { content: 'Two parallel ship-lines (chat-bones overnight + foundation-context v2) interwoven with Casey sync afternoon. Plan-trim discipline (1100 → 190 lines) is the pattern that made overnight cowboy execution clean.' },
    },
    'note-quote': {
      type: 'Callout',
      props: { type: 'quote', title: 'Demo Alex (date-3)', collapsible: false },
      children: ['note-quote-text'],
    },
    'note-quote-text': {
      type: 'Text',
      props: { content: '"BYOK via AI Gateway — our keys, our contracts. OpenRouter off-path for compliance."' },
    },
    'note-warning': {
      type: 'Callout',
      props: { type: 'warning', title: 'Region-residency — open question', collapsible: true, defaultExpanded: false },
      children: ['note-warning-text'],
    },
    'note-warning-text': {
      type: 'Text',
      props: { content: 'Embedded-doc residency for Demo Dana\'s §X.Y.Z compliance requirement still unresolved. Blocking nothing today; will block before the data-upload work begins.' },
    },

    // ─── RECENT WORK ─ Notion-style gallery (comfortable density) ─
    'recent-h': { type: 'Text', props: { content: '## Recent Work', size: 'lg', weight: 'bold' } },
    'recent-gallery': {
      type: 'GalleryGrid',
      props: { columns: 'auto', gap: 14, minCardWidth: '260px' },
      children: ['cc-pr42', 'cc-streamdown', 'cc-context', 'cc-plan-trim', 'cc-abc101', 'cc-abc102'],
    },
    'cc-pr42': {
      type: 'CardCover',
      props: {
        eyebrow: 'shipped · date-3',
        title: 'PR #42 — chat-bones',
        subtitle: 'Full chat loop end-to-end, accessibility checks green',
        cover: { gradient: 'linear-gradient(135deg, #98c37944, #98c37911)', icon: '✦' },
        properties: [
          { label: 'status', value: 'merged', color: '#98c379' },
          { label: 'tests', value: 'a11y 3/3' },
        ],
        footer: '[[1a2b3c4]] · [[5d6e7f8]] · Demo Alex review',
        href: '#pr-42',
      },
    },
    'cc-streamdown': {
      type: 'CardCover',
      props: {
        eyebrow: 'commit · date-3',
        title: 'Streamdown caret-on-stream wired',
        subtitle: 'Streaming markdown with mid-stream caret UX',
        cover: { color: '#0d0d18', icon: '~' },
        properties: [
          { label: 'sha', value: '1a2b3c4', color: '#00e5ff' },
          { label: 'pkg', value: 'streamdown 2.5.0' },
        ],
        footer: 'overnight cowboy execution',
      },
    },
    'cc-context': {
      type: 'CardCover',
      props: {
        eyebrow: 'doc · date-3',
        title: 'foundation context v2',
        subtitle: 'Stack lock + retrieval shape, verified live',
        cover: { gradient: 'linear-gradient(135deg, #00e5ff44, #00e5ff11)', icon: '◇' },
        properties: [
          { label: 'ai', value: '6.0.170' },
          { label: 'gateway', value: '3.0.105' },
          { label: 'json-render', value: '0.18' },
        ],
        footer: 'replaces v1 stack-lock decision',
      },
    },
    'cc-plan-trim': {
      type: 'CardCover',
      props: {
        eyebrow: 'pattern · recurring',
        title: 'Plan-trim discipline',
        subtitle: '1100 → 190 lines · cruft routed to BBS digests + week headlines',
        cover: { color: '#1a0d1a', icon: '✂' },
        properties: [
          { label: 'lesson', value: 'banked', color: '#e040a0' },
        ],
        footer: 'see also: cowboy detour ~03:14',
      },
    },
    'cc-abc101': {
      type: 'CardCover',
      props: {
        eyebrow: 'compliance · open',
        title: 'ABC-101 — Region residency',
        subtitle: 'Embedded-doc residency for §X.Y.Z',
        cover: { gradient: 'linear-gradient(135deg, #ffb30044, #ffb30011)', icon: '⚠' },
        properties: [
          { label: 'status', value: 'open', color: '#ffb300' },
          { label: 'owner', value: 'Demo Dana' },
        ],
        footer: 'blocks: ABC-102 data-upload',
      },
    },
    'cc-abc102': {
      type: 'CardCover',
      props: {
        eyebrow: 'compliance · open',
        title: 'ABC-102 — Data upload',
        subtitle: 'Region-X privacy-law transition flag',
        cover: { gradient: 'linear-gradient(135deg, #ffb30044, #ffb30011)', icon: '⚠' },
        properties: [
          { label: 'status', value: 'open', color: '#ffb300' },
          { label: 'depends-on', value: 'ABC-101' },
        ],
        footer: 'transition state machine pending',
      },
    },

    // ─── COMPACT VARIANT — same cards, tightened header ──────────
    'compact-h': { type: 'Text', props: { content: '## Same cards · density: compact (variant)', size: 'lg', weight: 'bold' } },
    'compact-gallery': {
      type: 'GalleryGrid',
      props: { columns: 'auto', gap: 10, minCardWidth: '220px' },
      children: ['cc-pr42-c', 'cc-streamdown-c', 'cc-context-c'],
    },
    'cc-pr42-c': {
      type: 'CardCover',
      props: {
        density: 'compact',
        eyebrow: 'shipped · date-3',
        title: 'PR #42 — chat-bones',
        subtitle: 'Full loop end-to-end',
        cover: { gradient: 'linear-gradient(135deg, #98c37944, #98c37911)', icon: '✦', height: '40px' },
        properties: [{ label: 'status', value: 'merged', color: '#98c379' }],
      },
    },
    'cc-streamdown-c': {
      type: 'CardCover',
      props: {
        density: 'compact',
        eyebrow: 'commit · date-3',
        title: 'Streamdown wired',
        subtitle: 'caret-on-stream',
        cover: { color: '#0d0d18', icon: '~', height: '40px' },
        properties: [{ label: 'sha', value: '1a2b3c4', color: '#00e5ff' }],
      },
    },
    'cc-context-c': {
      type: 'CardCover',
      props: {
        density: 'compact',
        eyebrow: 'doc · date-3',
        title: 'foundation v2',
        subtitle: 'stack lock verified',
        cover: { gradient: 'linear-gradient(135deg, #00e5ff44, #00e5ff11)', icon: '◇', height: '40px' },
        properties: [{ label: 'ai', value: '6.x' }, { label: 'pkg', value: 'json-render 0.18' }],
      },
    },

    // ─── VIZ ROW ─ existing LinkGraph + ActivityHeatmap ──────────
    'viz-row': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 14 },
      children: ['linkgraph', 'heatmap'],
    },
    linkgraph: {
      type: 'LinkGraph',
      props: {
        nodes: [
          { id: 'hub', label: 'Hub', color: '#00e5ff', center: true },
          { id: 'pr42', label: 'PR #42', color: '#98c379', weight: 4 },
          { id: 'abc101', label: 'ABC-101', color: '#ffb300', weight: 4 },
          { id: 'abc102', label: 'ABC-102', color: '#ffb300', weight: 4 },
          { id: 'alex', label: 'Demo Alex', color: '#e040a0', weight: 4 },
          { id: 'dana', label: 'Demo Dana', color: '#e040a0', weight: 4 },
          { id: 'fc-v2', label: 'foundation v2', color: '#00e5ff', weight: 4 },
        ],
        edges: [
          ['hub', 'pr42'],
          ['hub', 'abc101'],
          ['hub', 'abc102'],
          ['hub', 'alex'],
          ['hub', 'dana'],
          ['hub', 'fc-v2'],
          ['abc102', 'abc101'],
          ['pr42', 'alex'],
        ],
        title: 'Hub link graph',
      },
    },
    heatmap: {
      type: 'ActivityHeatmap',
      props: {
        title: 'Activity (last 26 weeks)',
        data: [
          { label: 'wk-26', value: 0 }, { label: 'wk-25', value: 1 }, { label: 'wk-24', value: 0 },
          { label: 'wk-23', value: 2 }, { label: 'wk-22', value: 1 }, { label: 'wk-21', value: 3 },
          { label: 'wk-20', value: 2 }, { label: 'wk-19', value: 2 }, { label: 'wk-18', value: 1 },
          { label: 'wk-17', value: 0 }, { label: 'wk-16', value: 2 }, { label: 'wk-15', value: 3 },
          { label: 'wk-14', value: 4 }, { label: 'wk-13', value: 3 }, { label: 'wk-12', value: 2 },
          { label: 'wk-11', value: 1 }, { label: 'wk-10', value: 2 }, { label: 'wk-9', value: 3 },
          { label: 'wk-8', value: 4 }, { label: 'wk-7', value: 4 }, { label: 'wk-6', value: 3 },
          { label: 'wk-5', value: 2 }, { label: 'wk-4', value: 3 }, { label: 'wk-3', value: 4 },
          { label: 'wk-2', value: 3 }, { label: 'wk-1', value: 2 },
        ],
        color: '#00e5ff',
      },
    },

    // ─── SECTIONS HEADER ────────────────────────────────────────
    'sections-h': { type: 'Text', props: { content: '## Sections', size: 'lg', weight: 'bold' } },

    // ─── DECISIONS ─ Callout success, with topic+text hierarchy ──
    'sec-decisions': {
      type: 'Callout',
      props: { type: 'success', title: 'Decisions', collapsible: true, defaultExpanded: true },
      children: ['dec-list'],
    },
    'dec-list': {
      type: 'DecisionLog',
      props: {
        decisions: [
          {
            date: 'date-3', meeting: 'Demo Alex DM',
            topic: 'Provider routing for prod — direct, BYOK gateway, or third-party gateway with their keys?',
            text: 'BYOK via AI Gateway — our keys, our contracts. OpenRouter off-path for compliance.',
            status: 'active',
          },
          {
            date: 'date-2', meeting: 'D4 lock',
            topic: 'Chat-surface component system — build, adopt shadcn ai-elements, or wait?',
            text: 'ai-elements via shadcn — defer component-system audit to post-launch.',
            status: 'active',
          },
          {
            date: 'date-2', meeting: 'foundation walkthrough',
            topic: 'Streaming-markdown library choice',
            text: 'Streamdown — caret-on-stream UX is the differentiator over react-markdown.',
            status: 'active',
          },
          {
            date: 'date-1', meeting: 'foundation v1',
            topic: 'Full stack lock for the chat slice — pin versions live, or floor-only?',
            text: 'Stack lock at exact versions: ai 6.x, @ai-sdk/gateway, Streamdown, json-render. Verified live.',
            status: 'active',
          },
          {
            date: 'date-0', meeting: 'pre-foundation',
            topic: 'Provider routing for prod (initial framing)',
            text: 'Direct provider — fewest parties for compliance.',
            status: 'superseded',
          },
        ],
      },
    },

    // ─── MEETINGS ─ Callout note, TimeEntry with title+body+tags ─
    'sec-meetings': {
      type: 'Callout',
      props: { type: 'note', title: 'Meetings', collapsible: true, defaultExpanded: true },
      children: ['mt-list'],
    },
    'mt-list': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['mt1', 'mt2', 'mt3'],
    },
    mt1: {
      type: 'TimeEntry',
      props: {
        time: 'date-3 · 1:30 PM',
        title: 'Stack-decisions sync — AI Gateway + region residency',
        body: 'Demo Alex + Demo Dana. Locked BYOK via Gateway for prod (decisions log). Region residency question still open — Dana needs answer before §X.Y.Z compliance response. Action: follow up with Dana by next week.',
        tags: ['demo-alex', 'demo-dana', '45min', 'project::skills-platform'],
        color: '#00e5ff',
      },
    },
    mt2: {
      type: 'TimeEntry',
      props: {
        time: 'date-2 · 10:00 AM',
        title: 'Foundation context v2 walkthrough',
        body: 'Demo Alex + Demo Sam. Walked the trimmed plan (1100→190 lines) end-to-end. Cowboy-overnight scope agreed. No blockers surfaced. Three questions deferred to D4 lock.',
        tags: ['demo-alex', 'demo-sam', '60min', 'walkthrough'],
        color: '#98c379',
      },
    },
    mt3: {
      type: 'TimeEntry',
      props: {
        time: 'date-1 · 3:00 PM',
        title: 'Compliance scoping — §X.Y.Z residency',
        body: 'Demo Dana. Mapped what data needs to live in region storage vs what can transit external providers. Open: embedded-doc residency for retrieval index — this is the question that bled into the date-3 sync.',
        tags: ['demo-dana', '30min', 'compliance'],
        color: '#ffb300',
      },
    },

    // ─── DOCS ─ Callout abstract ─────────────────────────────────
    'sec-docs': {
      type: 'Callout',
      props: { type: 'abstract', title: 'Docs & References', collapsible: true, defaultExpanded: false },
      children: ['docs-refs'],
    },
    'docs-refs': {
      type: 'RefSection',
      props: { label: '' },
      children: ['d1', 'd2', 'd3', 'd4'],
    },
    d1: { type: 'RefCard', props: { id: 'foundation-context-v2', type: 'context-pack', title: 'foundation context v2 — stack lock + retrieval shape' } },
    d2: { type: 'RefCard', props: { id: 'chat-bones', type: 'build-slice', title: 'chat-bones — the build slice cowboy executed against' } },
    d3: { type: 'RefCard', props: { id: 'ABC-101', type: 'compliance', title: 'Region residency — embedded-doc for §X.Y.Z' } },
    d4: { type: 'RefCard', props: { id: 'ABC-102', type: 'compliance', title: 'Data upload — Region-X privacy-law transition flag' } },

    // ─── OPEN QUESTIONS ─ Callout question + nested bug ──────────
    'sec-open': {
      type: 'Callout',
      props: { type: 'question', title: 'Open Questions', collapsible: true, defaultExpanded: true },
      children: ['oq1', 'oq2', 'oq-bug'],
    },
    oq1: { type: 'Text', props: { content: '? Region residency for embedded docs — answer needed for §X.Y.Z by data-upload work start' } },
    oq2: { type: 'Text', props: { content: '? agent-review round on PR #42 — bot-reviewer panel queued' } },
    'oq-bug': {
      type: 'Callout',
      props: { type: 'bug', title: 'Known issue (folded)', collapsible: true, defaultExpanded: false },
      children: ['oq-bug-text'],
    },
    'oq-bug-text': {
      type: 'Text',
      props: { content: 'Streamdown caret occasionally repaints during long token bursts. Cosmetic, low-priority. Reproduces once-per-session at ~6000+ char responses.' },
    },

    foot: {
      type: 'BacklinksFooter',
      props: {
        title: 'Linked from',
        links: [
          { label: '[[date-3]]', href: '#daily' },
          { label: '[[wk-current-tracker]]', href: '#week' },
          { label: 'Team Slack', href: '#slack' },
        ],
      },
    },
  },
};
