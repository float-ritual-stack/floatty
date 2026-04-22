/**
 * Meeting Notes — sam sync summary.
 * MetadataHeader + QuoteBlock (tldr) + Section per decision + MeetingDiff + ownership table.
 */
import type { Spec } from '@json-render/core';

export const meetingNotesSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 16, padding: 16 },
      children: ['header', 'tldr', 'decisions-h', 'd1', 'd2', 'd3', 'diff-h', 'diff', 'next-h', 'next-table', 'refs'],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'Pharma Sam Sync — Basket Bug + Assessment Warning + Follow-up Emails',
        subtitle: '[project::generi-co/pharma-app] [meeting::pharma/sam-sync] · 20min · Sam + Alex',
        date: '2026-04-20',
      },
    },

    tldr: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: "Kai-reported basket bug traced to three divergent createGuestBasket fns using mismatched user/profile IDs — Jordan fixing via single-helper consolidation. Alex on standby. 'Complete assessment warning' backlog ticket too thin to action, Sam will dig offline. Dana's follow-up email fix looks to be holding — 21-day verification window.",
        attribution: 'tldr',
      },
    },

    'decisions-h': { type: 'Text', props: { content: '## Key Decisions', size: 'lg', weight: 'bold' } },

    d1: {
      type: 'PatternCard',
      props: {
        title: 'Basket bug — Jordan owns the fix, Alex standby',
        type: 'decision',
        confidence: 'stated-by-Kai',
        content: "Kai flagged client-log errors on basket creation that look RLS-ish but are really ID mismatches from three divergent `createGuestBasket` implementations using different ID sources (user ID vs profile ID).\n\n**Fix approach**: consolidate the three call sites into a single basket-creation helper. Reduces code size and eliminates the divergence class of bugs in one shot.\n\n**Ownership**: Jordan is actively implementing. Alex offered to pair in if Jordan gets pulled into meetings. Agreement: wait for Jordan's update before stepping in.\n\n**03:06 PM correction**: cowboy investigation suggests the 3-fn diagnosis may not actually match the code. Material correction to the 01:42 PM wrap record. Jordan's AM investigation is the confirmation point.",
        connectsTo: ['c587eea7', 'PR #2287', 'PR #2293'],
      },
    },

    d2: {
      type: 'PatternCard',
      props: {
        title: '"Complete assessment warning" — Sam digging offline',
        type: 'decision',
        confidence: 'hypothesis',
        content: "Backlog ticket refers to a red warning on the prescription form: *\"Showing unmatched assessments for this order. Some may not be related to the selected item.\"*\n\nSam walked production live during the sync and couldn't reproduce from the ticket text alone — not enough detail to act on.\n\n**Hypothesis**: dynamic assessment updates mid-flow cause the submission to stop matching the current definition. Sam to reproduce on staging offline.",
      },
    },

    d3: {
      type: 'PatternCard',
      props: {
        title: 'Follow-up emails — Dana\'s fix appears holding',
        type: 'decision',
        confidence: 'partial-evidence',
        content: "No erroneous follow-up emails going out in production right now. Dana's fix looks to be working.\n\n**Caveat**: most follow-up products configured for 21-day delay → 'no emails yet' is partial evidence, not proof. Real verification comes when patient notes start returning assessment results.\n\n**Alex proposal (unticketed)**: minimal admin debug view over the follow-up-email cron source table. Read-only, low-traffic, safe — avoids ad-hoc DB queries.",
      },
    },

    // MeetingDiff — shows process change from the meeting
    'diff-h': { type: 'Text', props: { content: '## Process delta', size: 'lg', weight: 'bold' } },
    diff: {
      type: 'MeetingDiff',
      props: {
        title: 'Basket creation flow — consolidation plan',
        meeting: 'Sam sync 2026-04-20',
        before: [
          { step: 'createGuestBasket (products) — user ID', status: 'unchanged' },
          { step: 'createGuestBasket (assessments) — profile ID', status: 'removed' },
          { step: 'createGuestBasket (third site) — ???', status: 'removed' },
          { step: 'customer-ID equality check fails mid-flow', status: 'removed' },
          { step: 'row falls back to all-defaults', status: 'removed' },
        ],
        after: [
          { step: 'single createGuestBasket helper', status: 'added' },
          { step: 'all 3 call sites migrated', status: 'added' },
          { step: 'customer-ID equality preserved through flow', status: 'added' },
        ],
        newDecisions: [
          'Jordan owns the consolidation fix',
          'Alex on standby, not filing GitHub issue yet',
          'Kai\'s screenshot + client logs are the artifact',
        ],
        actions: [
          { who: 'Jordan', what: 'Ship basket consolidation', status: 'in-progress', blocker: 'AM investigation verifies 3-fn diagnosis' },
          { who: 'Alex', what: 'Standby; SFC focus until pulled back', status: 'active' },
          { who: 'Sam', what: 'Reproduce warning on staging', status: 'pending' },
        ],
      },
    },

    'next-h': { type: 'Text', props: { content: '## Next Steps', size: 'lg', weight: 'bold' } },
    'next-table': {
      type: 'EntryBody',
      props: {
        markdown: `| Owner | Action | Deadline |
|-------|--------|----------|
| Jordan | Ship basket consolidation (single \`createGuestBasket\`, migrate 3 call sites) | AM tomorrow |
| Alex | Standby; [project::generi-co/skills-app] focus until Sam surfaces more | — |
| Sam | Reproduce "complete assessment warning" on staging | Offline |
| Team | 21-day verification of follow-up emails | ~May 11 |`,
      },
    },

    refs: {
      type: 'RefSection',
      props: { label: 'References' },
      children: ['r-daily', 'r-week', 'r-prev'],
    },
    'r-daily': {
      type: 'RefCard',
      props: { id: '2026-04-20', type: 'daily-note', title: "today's daily note" },
    },
    'r-week': {
      type: 'RefCard',
      props: { id: '2026-W17-generi-co-weekly', type: 'tracker', title: 'week tracker' },
    },
    'r-prev': {
      type: 'RefCard',
      props: { id: '2026-04-09-pharma-sam-sync-any-of-bmi', type: 'meeting', title: 'previous sam sync' },
    },
  },
};
