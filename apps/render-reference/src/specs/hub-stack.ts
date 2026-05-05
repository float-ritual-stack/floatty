/**
 * Hub Page — Card Stack (Option 1)
 *
 * Familiar vertical dashboard shape: MetadataHeader → StatsBar → CollapsibleSection
 * for each domain (recent work / decisions / meetings / docs) → BacklinksFooter.
 *
 * Models the shape of a project hub block: project-rooted, status-marked,
 * one column reading top-to-bottom. Sections collapse for scan mode; expand
 * for detail.
 *
 * All names + IDs are synthetic demo content (Demo Alex/Dana/Sam, ABC-NNN
 * tickets, etc.) — see test-fixtures-no-pii.md.
 */
import type { Spec } from '@json-render/core';

export const hubStackSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 16, padding: 18 },
      children: ['header', 'stats', 'recent-sec', 'decisions-sec', 'meetings-sec', 'docs-sec', 'backlinks'],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'Skills Platform',
        subtitle: '[project::acme/skills-platform] · [status::active] · alias: [[skills-platform]] · client lane, public-facing',
        date: 'updated date-3',
        stats: [
          { label: 'open prs', value: '1' },
          { label: 'commits this week', value: '14' },
          { label: 'decisions logged', value: '8' },
          { label: 'meetings', value: '3' },
        ],
      },
    },

    stats: {
      type: 'StatsBar',
      props: {
        layout: 'row',
        stats: [
          { label: 'pipeline', value: 'chat-bones live · /en/chat verified', color: '#98c379' },
          { label: 'gating', value: 'AI Gateway BYOK', color: '#00e5ff' },
          { label: 'open compliance', value: 'region-residency · data-upload', color: '#ffb300' },
          { label: 'team', value: 'Demo Alex (lead) · Demo Dana · Demo Sam', color: '#e040a0' },
        ],
      },
    },

    'recent-sec': {
      type: 'CollapsibleSection',
      props: { title: 'Recent Work', expanded: true, count: 4, color: '#98c379' },
      children: ['recent-list'],
    },
    'recent-list': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 6 },
      children: ['s1', 's2', 's3', 's4'],
    },
    s1: { type: 'ShippedItem', props: { content: '[[PR #42]] feat/chat-bones-scaffold — full chat loop end-to-end (Streamdown caret-on-stream + json-render rich-callout, a11y 3/3 green)' } },
    s2: { type: 'ShippedItem', props: { content: '[[1a2b3c4]] Streamdown wired · [[5d6e7f8]] json-render foundation — overnight cowboy execution against trimmed plan' } },
    s3: { type: 'ShippedItem', props: { content: 'foundation-context v2 published — stack lock confirmed live (ai 6.0.170 · @ai-sdk/gateway 3.0.105 · streamdown 2.5.0 · @json-render 0.18)' } },
    s4: { type: 'ShippedItem', props: { content: 'plan-trim discipline applied: chat-bones plan 1100 → 190 lines · journal cruft routed to BBS digests + week headlines' } },

    'decisions-sec': {
      type: 'CollapsibleSection',
      props: { title: 'Decisions', expanded: true, count: 3, color: '#00e5ff' },
      children: ['decisions-log'],
    },
    'decisions-log': {
      type: 'DecisionLog',
      props: {
        decisions: [
          {
            date: 'date-3', meeting: 'Demo Alex DM (AI Gateway thread)',
            topic: 'Provider routing for prod — direct, BYOK gateway, or third-party gateway?',
            text: 'BYOK via AI Gateway — our keys, our contracts. OpenRouter off-path for compliance.',
            status: 'active',
          },
          {
            date: 'date-2', meeting: 'D4 lock',
            topic: 'Chat-surface component system',
            text: 'ai-elements via shadcn — defer component-system audit.',
            status: 'active',
          },
          {
            date: 'date-1', meeting: 'foundation context v1',
            topic: 'Full stack lock for the chat slice',
            text: 'Stack lock at exact versions: ai 6.x + @ai-sdk/gateway + Streamdown + json-render — verified live.',
            status: 'active',
          },
        ],
      },
    },

    'meetings-sec': {
      type: 'CollapsibleSection',
      props: { title: 'Meetings', expanded: false, count: 3, color: '#e040a0' },
      children: ['meetings-list'],
    },
    'meetings-list': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12 },
      children: ['m1', 'm2', 'm3'],
    },
    m1: { type: 'TimeEntry', props: { time: 'date-3 · 1:30 PM', title: 'Stack-decisions sync — AI Gateway + region residency', body: 'Demo Alex + Demo Dana. BYOK Gateway locked. Region residency still open.', tags: ['demo-alex', 'demo-dana', '45min'] } },
    m2: { type: 'TimeEntry', props: { time: 'date-2 · 10:00 AM', title: 'Foundation context v2 walkthrough', body: 'Demo Alex + Demo Sam. Trimmed plan end-to-end. Cowboy-overnight scope agreed.', tags: ['demo-alex', 'demo-sam', '60min'] } },
    m3: { type: 'TimeEntry', props: { time: 'date-1 · 3:00 PM', title: 'Compliance scoping — §X.Y.Z residency', body: 'Demo Dana. Region requirements mapped. Open: embedded-doc residency.', tags: ['demo-dana', '30min'] } },

    'docs-sec': {
      type: 'CollapsibleSection',
      props: { title: 'Docs & References', expanded: false, count: 4, color: '#ffb300' },
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

    backlinks: {
      type: 'BacklinksFooter',
      props: {
        title: 'Linked from',
        links: [
          { label: '[[date-3]]', href: '#daily' },
          { label: '[[wk-current-tracker]]', href: '#week' },
          { label: '[[skills-platform]]', href: '#alias' },
          { label: 'Team Slack', href: '#slack' },
        ],
      },
    },
  },
};
