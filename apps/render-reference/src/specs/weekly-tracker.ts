/**
 * Weekly Tracker — generi-co-weekly style.
 * MetadataHeader + EntryBody (tables) + DecisionLog for meeting state.
 */
import type { Spec } from '@json-render/core';

export const weeklyTrackerSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 14, padding: 16 },
      children: ['header', 'focus', 'carry-h', 'carry-table', 'headlines-h', 'headlines', 'decisions', 'ownership-h', 'ownership-table', 'hypothesis-h', 'hypothesis-table'],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: '2026-W17 · generi-co-weekly',
        subtitle: 'Post go-live week + 1 — firefighting window expected',
        date: '2026-04-20 → 2026-04-25',
      },
    },

    focus: {
      type: 'QuoteBlock',
      props: {
        type: 'note',
        text: 'Monday opener quiet. Afternoon sam sync surfaced fresh basket bug (Kai-flagged, Jordan owns). Cowboy post-wrap investigation flagged the 3-fn diagnosis may not match actual code — pending Jordan\'s AM investigation. Follow-up email fix (Dana, W16) looks to be holding; 21-day verification window open.',
      },
    },

    'carry-h': { type: 'Heading', props: { level: 2, content: 'Carry-forward from W16' } },
    'carry-table': {
      type: 'EntryBody',
      props: {
        markdown: `| Item | Status | Notes |
|------|--------|-------|
| [[Issue #2123]] | **IN PROGRESS** | Admin order detail ~33s with assessment responses. Alex's lane. |
| **Basket bug (W17)** | **IN PROGRESS** — Jordan | Kai-flagged. 3 divergent \`createGuestBasket\` fns. **03:06 PM correction**: may not match code. |
| [[PR #2292]] | **MERGED but INCOMPLETE** ⚠ | customs HS-codes — awaiting Yara+Shay approval |
| Admin debug view | Proposal | Alex, unticketed — UI over follow-up-email cron source table |
| [[Issue #2218]] / [[#2219]] | Pending | Perf follow-ups filed W16 |`,
      },
    },

    'headlines-h': { type: 'Heading', props: { level: 2, content: 'Daily Headlines' } },
    headlines: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 6 },
      children: ['h-mon'],
    },
    'h-mon': {
      type: 'Paragraph',
      props: {
        content: '• [[2026-04-20-monday-headlines|Mon Apr 20]]: brain-boot (0 PRs). Sam sync 01:17 PM — basket bug (Kai-flagged, Jordan fixing), code-divergence anti-pattern named, "complete assessment warning" too thin. Alex standby, [project::generi-co/skills-app] until pulled back.',
      },
    },

    // DecisionLog — purpose-built for decisions across meetings
    decisions: {
      type: 'DecisionLog',
      props: {
        title: 'Meeting decisions (W17)',
        decisions: [
          {
            date: '2026-04-20',
            meeting: 'Sam sync',
            text: 'Basket bug — Jordan owns fix, Alex on standby. Consolidate 3 createGuestBasket fns into single helper.',
            status: 'active',
            project: 'generi-co/pharma-app',
          },
          {
            date: '2026-04-20',
            meeting: 'Sam sync',
            text: 'Complete assessment warning — Sam reproduces on staging offline. Ticket too thin for action.',
            status: 'active',
            project: 'generi-co/pharma-app',
          },
          {
            date: '2026-04-20',
            meeting: 'Sam sync',
            text: 'Follow-up emails — Dana\'s fix holds (partial evidence). 21-day verification window.',
            status: 'active',
            project: 'generi-co/pharma-app',
          },
        ],
      },
    },

    'ownership-h': { type: 'Heading', props: { level: 2, content: 'Meeting Ownership' } },
    'ownership-table': {
      type: 'EntryBody',
      props: {
        markdown: `| Owner | Item | Status |
|-------|------|--------|
| Jordan | Basket consolidation fix | **IN PROGRESS** — AM investigation verifies diagnosis |
| Alex | Standby; [project::generi-co/skills-app] until pulled back | **ACTIVE** — [[PR #4]] shipped |
| Sam | Reproduce warning on staging | PENDING — offline dig |
| Team | 21-day follow-up-email verification | MONITORING — patient notes at ~21d |`,
      },
    },

    'hypothesis-h': { type: 'Heading', props: { level: 2, content: 'Hypothesis Validation' } },
    'hypothesis-table': {
      type: 'EntryBody',
      props: {
        markdown: `| Hypothesis | State | Evidence |
|------------|-------|----------|
| Basket bug = 3 divergent \`createGuestBasket\` (Kai) | **DISPUTED** | Cowboy: may not match code. Pending Jordan's AM. |
| "Assessment warning" = dynamic updates mid-flow (Sam) | UNVERIFIED | Sam to reproduce on staging |
| Dana's follow-up email fix is working | PARTIAL | 21-day window open |`,
      },
    },
  },
};
