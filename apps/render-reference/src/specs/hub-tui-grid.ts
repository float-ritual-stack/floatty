/**
 * Hub Page — TUI Panel Grid (Option 2)
 *
 * Dense terminal-feel: TuiPanel + TuiStat heavy, two-column flex of panels
 * (recent / decisions / meetings / docs), monospace breath, ASCII-tree
 * decorations for the references column.
 *
 * Bet: a hub for active client work reads like a status board, not a dashboard.
 * Information density wins over whitespace; tabular shape over collapsibles.
 *
 * All names + IDs are synthetic demo content (Demo Alex/Dana/Sam, ABC-NNN
 * tickets, etc.) — see test-fixtures-no-pii.md.
 */
import type { Spec } from '@json-render/core';

export const hubTuiGridSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12, padding: 14 },
      children: ['head', 'stat-row', 'grid'],
    },

    head: {
      type: 'MetadataHeader',
      props: {
        title: '▒▒ Skills Platform · status::active ▒▒',
        subtitle: '[project::acme/skills-platform] · alias [[skills-platform]] · Demo Alex (lead) · current-week',
        date: 'date-3',
      },
    },

    'stat-row': {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 10 },
      children: ['st-prs', 'st-commits', 'st-decisions', 'st-meetings', 'st-flo'],
    },
    'st-prs': { type: 'TuiStat', props: { label: 'OPEN PRS', value: '1', color: '#98c379' } },
    'st-commits': { type: 'TuiStat', props: { label: 'COMMITS WK', value: '14', color: '#00e5ff' } },
    'st-decisions': { type: 'TuiStat', props: { label: 'DECISIONS', value: '8', color: '#e040a0' } },
    'st-meetings': { type: 'TuiStat', props: { label: 'MEETINGS', value: '3', color: '#ffb300' } },
    'st-flo': { type: 'TuiStat', props: { label: 'OPEN', value: 'ABC-101 · 102 · 103', color: '#ff4444' } },

    grid: {
      type: 'Stack',
      props: { direction: 'horizontal', gap: 12 },
      children: ['col-left', 'col-right'],
    },

    'col-left': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12, flex: '1' },
      children: ['recent-panel', 'decisions-panel'],
    },

    'recent-panel': {
      type: 'TuiPanel',
      props: { title: '▒ RECENT WORK ▒', titleColor: '#98c379' },
      children: ['rs1', 'rs2', 'rs3', 'rs4'],
    },
    rs1: { type: 'ShippedItem', props: { content: '[[PR #42]] chat-bones — full loop /en/chat live, rich-callout via json-render, a11y 3/3' } },
    rs2: { type: 'ShippedItem', props: { content: '[[1a2b3c4]] Streamdown caret-on-stream wired · [[5d6e7f8]] json-render foundation' } },
    rs3: { type: 'ShippedItem', props: { content: 'foundation-context v2 published — stack lock confirmed (ai 6.0.170, gateway 3.0.105, streamdown 2.5.0, json-render 0.18)' } },
    rs4: { type: 'ShippedItem', props: { content: 'plan-trim 1100→190 lines · cowboy executed overnight' } },

    'decisions-panel': {
      type: 'TuiPanel',
      props: { title: '▒ DECISIONS ▒', titleColor: '#00e5ff' },
      children: ['dl'],
    },
    dl: {
      type: 'DecisionLog',
      props: {
        decisions: [
          {
            date: 'date-3', meeting: 'Demo Alex DM',
            topic: 'Provider routing for prod',
            text: 'BYOK via AI Gateway — our keys, our contracts. OpenRouter off-path.',
            status: 'active',
          },
          {
            date: 'date-2', meeting: 'D4 lock',
            topic: 'Chat-surface component system',
            text: 'ai-elements via shadcn for chat surface',
            status: 'active',
          },
          {
            date: 'date-1', meeting: 'foundation v1',
            topic: 'Full stack lock',
            text: 'Stack lock: ai 6.x + gateway + Streamdown + json-render',
            status: 'active',
          },
        ],
      },
    },

    'col-right': {
      type: 'Stack',
      props: { direction: 'vertical', gap: 12, flex: '1' },
      children: ['meetings-panel', 'docs-panel', 'open-panel'],
    },

    'meetings-panel': {
      type: 'TuiPanel',
      props: { title: '▒ MEETINGS ▒', titleColor: '#e040a0' },
      children: ['mt1', 'mt2', 'mt3'],
    },
    mt1: { type: 'TimeEntry', props: { time: 'd-3 · 1:30p', title: 'Stack-decisions sync — Gateway + region residency', body: 'Demo Alex + Demo Dana. BYOK locked. Region residency open.', tags: ['demo-alex', 'demo-dana'] } },
    mt2: { type: 'TimeEntry', props: { time: 'd-2 · 10a', title: 'Foundation context v2 walkthrough', body: 'Demo Alex + Demo Sam. Trimmed plan end-to-end.', tags: ['demo-alex', 'demo-sam'] } },
    mt3: { type: 'TimeEntry', props: { time: 'd-1 · 3p', title: 'Compliance scoping — §X.Y.Z residency', body: 'Demo Dana. Region requirements mapped.', tags: ['demo-dana'] } },

    'docs-panel': {
      type: 'TuiPanel',
      props: { title: '▒ DOCS ▒', titleColor: '#ffb300' },
      children: ['rt'],
    },
    rt: {
      type: 'TreeView',
      props: {
        nodes: [
          { id: 'context', label: 'context-packs', status: 'done', children: [
            { id: 'fc-v2', label: 'foundation-context-v2', status: 'done', detail: 'stack lock + retrieval shape' },
            { id: 'cb', label: 'chat-bones', status: 'done', detail: 'build-slice executed' },
          ]},
          { id: 'compliance', label: 'compliance', status: 'active', children: [
            { id: 'abc101', label: 'ABC-101 · Region residency', status: 'active', detail: 'embedded-doc for §X.Y.Z' },
            { id: 'abc102', label: 'ABC-102 · Data upload', status: 'pending', detail: 'Region-X privacy-law transition' },
            { id: 'abc103', label: 'ABC-103 · Privacy-law flag', status: 'pending', detail: 'transition state machine' },
          ]},
        ],
      },
    },

    'open-panel': {
      type: 'TuiPanel',
      props: { title: '▒ OPEN QUESTIONS ▒', titleColor: '#ff4444' },
      children: ['oq1', 'oq2'],
    },
    oq1: { type: 'Paragraph', props: { content: '? Region residency for embedded docs — answer needed for Demo Dana\'s §X.Y.Z' } },
    oq2: { type: 'Paragraph', props: { content: '? agent-review round on PR #42 — bot-reviewer panel queued' } },
  },
};
