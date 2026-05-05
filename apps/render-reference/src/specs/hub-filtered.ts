/**
 * Hub Page — TabNav Filtered (Option 3)
 *
 * Interactive: TabNav at top switches a single body section via $bindState.
 * Bet: when a hub has 4+ domains, vertical-collapsibles still ask the reader
 * to scroll-and-scan; tabs make it one-click to land on Recent vs Decisions
 * vs Meetings vs Docs. Persistent header + footer; only the body cycles.
 *
 * The state-switching pattern is the load-bearing demo here — same primitive
 * as conceptual-patterns.ts uses for its own pattern walkthrough.
 *
 * All names + IDs are synthetic demo content (Demo Alex/Dana/Sam, ABC-NNN
 * tickets, etc.) — see test-fixtures-no-pii.md.
 */
import type { Spec } from '@json-render/core';

export const hubFilteredSpec: Spec = {
  root: 'doc',
  state: { hub_view: 'recent' },
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12, padding: 16 },
      children: ['head', 'tabs', 'body-recent', 'body-decisions', 'body-meetings', 'body-docs', 'foot'],
    },

    head: {
      type: 'MetadataHeader',
      props: {
        title: 'Skills Platform',
        subtitle: '[project::acme/skills-platform] · [status::active] · alias [[skills-platform]] · Demo Alex (lead) · current-week',
        date: 'date-3',
        stats: [
          { label: 'open prs', value: '1' },
          { label: 'commits wk', value: '14' },
          { label: 'decisions', value: '8' },
        ],
      },
    },

    tabs: {
      type: 'TabNav',
      props: {
        tabs: [
          { id: 'recent', label: 'Recent Work' },
          { id: 'decisions', label: 'Decisions' },
          { id: 'meetings', label: 'Meetings' },
          { id: 'docs', label: 'Docs & Refs' },
        ],
        active: { $bindState: 'hub_view' },
        variant: 'pills',
      },
    },

    // ─── RECENT ──────────────────────────────────────────────────
    'body-recent': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 6 },
      children: ['rec-list'],
      visible: { $state: '/hub_view', eq: 'recent' },
    },
    'rec-list': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 6 },
      children: ['rec1', 'rec2', 'rec3', 'rec4'],
    },
    rec1: { type: 'ShippedItem', props: { content: '[[PR #42]] feat/chat-bones-scaffold — full chat loop end-to-end (Streamdown caret-on-stream + json-render rich-callout, a11y 3/3 green)' } },
    rec2: { type: 'ShippedItem', props: { content: '[[1a2b3c4]] Streamdown wired · [[5d6e7f8]] json-render foundation — overnight cowboy execution' } },
    rec3: { type: 'ShippedItem', props: { content: 'foundation-context v2 published — stack lock confirmed live (ai 6.0.170, gateway 3.0.105, streamdown 2.5.0, json-render 0.18)' } },
    rec4: { type: 'ShippedItem', props: { content: 'plan-trim discipline applied: 1100 → 190 lines · cruft routed to BBS digests + week headlines' } },

    // ─── DECISIONS ───────────────────────────────────────────────
    'body-decisions': {
      type: 'DecisionLog',
      props: {
        decisions: [
          {
            date: 'date-3', meeting: 'Demo Alex DM (AI Gateway thread)',
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
            date: 'date-2', meeting: 'foundation context walkthrough',
            topic: 'Streaming-markdown library choice',
            text: 'Streamdown — caret-on-stream UX is the differentiator over react-markdown.',
            status: 'active',
          },
          {
            date: 'date-1', meeting: 'foundation context v1',
            topic: 'Full stack lock for the chat slice — pin versions live, or floor-only?',
            text: 'Stack lock at exact versions: ai 6.x + @ai-sdk/gateway + Streamdown + json-render. Verified live.',
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
      visible: { $state: '/hub_view', eq: 'decisions' },
    },

    // ─── MEETINGS ────────────────────────────────────────────────
    'body-meetings': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['mt1', 'mt2', 'mt3', 'mt4'],
      visible: { $state: '/hub_view', eq: 'meetings' },
    },
    mt1: { type: 'TimeEntry', props: { time: 'date-3 · 1:30 PM', title: 'Stack-decisions sync — AI Gateway + region residency', body: 'Demo Alex + Demo Dana. BYOK via Gateway locked. Region residency still open — Dana needs answer for §X.Y.Z.', tags: ['demo-alex', 'demo-dana', '45min'] } },
    mt2: { type: 'TimeEntry', props: { time: 'date-2 · 10:00 AM', title: 'Foundation context v2 walkthrough', body: 'Demo Alex + Demo Sam. Trimmed plan (1100→190 lines) end-to-end. Cowboy-overnight scope agreed.', tags: ['demo-alex', 'demo-sam', '60min'] } },
    mt3: { type: 'TimeEntry', props: { time: 'date-1 · 3:00 PM', title: 'Compliance scoping — §X.Y.Z residency', body: 'Demo Dana. Mapped region requirements. Open: embedded-doc residency.', tags: ['demo-dana', '30min'] } },
    mt4: { type: 'TimeEntry', props: { time: 'date-0 · 11:00 AM', title: 'Stack-decisions sync — provider routing (initial)', body: 'Demo Alex. Initial framing was Direct provider. Superseded by date-3 Gateway BYOK decision.', tags: ['demo-alex', '45min', 'superseded-framing'] } },

    // ─── DOCS ────────────────────────────────────────────────────
    'body-docs': {
      type: 'RefSection',
      props: { label: '' },
      children: ['d1', 'd2', 'd3', 'd4', 'd5'],
      visible: { $state: '/hub_view', eq: 'docs' },
    },
    d1: { type: 'RefCard', props: { id: 'foundation-context-v2', type: 'context-pack', title: 'foundation context v2 — stack lock + retrieval shape' } },
    d2: { type: 'RefCard', props: { id: 'chat-bones', type: 'build-slice', title: 'chat-bones — the build slice cowboy executed against' } },
    d3: { type: 'RefCard', props: { id: 'ABC-101', type: 'compliance', title: 'Region residency — embedded-doc for §X.Y.Z' } },
    d4: { type: 'RefCard', props: { id: 'ABC-102', type: 'compliance', title: 'Data upload — Region-X privacy-law transition flag' } },
    d5: { type: 'RefCard', props: { id: 'ABC-103', type: 'compliance', title: 'Privacy-law transition state machine' } },

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
