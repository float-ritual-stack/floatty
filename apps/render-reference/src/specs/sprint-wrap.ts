/**
 * Sprint Wrap / Dispatch — W15 style.
 * MetadataHeader + StatsBar + TuiPanel (SHIPPED/SLIPPED) + PatternCard for crystallized patterns.
 */
import type { Spec } from '@json-render/core';

export const sprintWrapSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 16, padding: 16 },
      children: ['header', 'tagline', 'stats', 'pharma-app-h', 'pharma-app-intro', 'shipped-panel', 'slipped-panel', 'golive-status', 'patterns-h', 'pattern-1', 'pattern-2'],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'FLOAT.DISPATCH :: W15',
        subtitle: 'SIGNAL RECOVERED FROM SEVEN LAYERS OF LOKI',
        date: 'Apr 6 – 12, 2026 · Week Fifteen',
      },
    },

    tagline: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: 'W15 was not a sprint. It was a controlled detonation. Six days of active Code sessions, 218 prompts on Monday alone (amplification: 8× — turns out a human was actually at the keyboard), and somewhere in the middle: a friend was found not living, a keyboard arrived, and the chipper produced an actual engineering blueprint of a slutty jockstrap. Vector misalignment 12°.',
      },
    },

    stats: {
      type: 'StatsBar',
      props: {
        layout: 'row',
        stats: [
          { label: 'shells', value: '16', color: '#00e5ff' },
          { label: 'bbs posts', value: '7', color: '#00e5ff' },
          { label: 'shell loc', value: '~28k', color: '#00e5ff' },
          { label: 'agents', value: '5', color: '#ffb300' },
          { label: 'rounds', value: '2', color: '#ffb300' },
          { label: 'queries→fix', value: '94→5', color: '#ff4444' },
        ],
      },
    },

    'pharma-app-h': { type: 'Text', props: { content: '>>> pharma-app', size: 'lg', weight: 'bold', color: '#ffb300' } },
    'pharma-app-intro': {
      type: 'Text',
      props: {
        content: "The week opened with a database query that was summoning SQL like a pentagram: the coupons **94 statements per page load**. Cowboy batch-fixed it to 5. The benches `query()` / `serviceQuery()` mismatch was generating 30-second loads from stale 5-status predicates. Confirmed. Sam sync approved both fixes same-day, correctness-first posture before Thursday launch-prep.",
      },
    },

    'shipped-panel': {
      type: 'TuiPanel',
      props: { title: 'SHIPPED (pharma-app)', titleColor: '#98c379' },
      children: ['s1', 's2', 's3'],
    },
    s1: { type: 'ShippedItem', props: { content: '[[PR #2075]] — any_of checkbox match logic. serviceQuery migration, N+1 fix (94 → 5)' } },
    s2: { type: 'ShippedItem', props: { content: '[[PR #2080]] — BMI traffic light display bugs. hardcoded end:100, ordering assumption, NumberInput state reset loop' } },
    s3: { type: 'ShippedItem', props: { content: '[[PR #2131]] — BMI validation + routing [see: SLIPPED for the adventure]' } },

    'slipped-panel': {
      type: 'TuiPanel',
      props: { title: 'SLIPPED (pharma-app)', titleColor: '#ff4444' },
      children: ['sl1', 'sl2'],
    },
    sl1: {
      type: 'Text',
      props: {
        content: "[[PR #2131]] committed directly to main — *like a contractor who reno'd the bathroom without closing the water main first.* Hard reset to eb54cf02, reverts on main, cherry-picks to fix/bmi-validation-routing → branch cleaned, PR pending Monday.",
      },
    },
    sl2: {
      type: 'Text',
      props: { content: 'Follow-up assessment E2E tests dispatched to cowboy — scope scoped, will land W16' },
    },

    'golive-status': {
      type: 'QuoteBlock',
      props: {
        type: 'note',
        text: 'GO-LIVE STATUS: Mon Apr 13–16\n>>> [[PR #2131]]: pending Nico confirm before Sam announce\n>>> Morgan\'s E2E ownership → Amir\n>>> 482 tests green',
      },
    },

    'patterns-h': { type: 'Text', props: { content: '>>> Patterns that crystallized this week', size: 'lg', weight: 'bold', color: '#ffb300' } },

    'pattern-1': {
      type: 'PatternCard',
      props: {
        label: 'Schema-as-vocabulary / constraint-lattice prompting',
        confidence: 'high',
        description: '*Doctrine.* Discovered via floatty render agent. JSON schema with typed component definitions collapses vague prompts into precise output. The schema does the intent-translation work. Applicable to: floatctl capture, evna synthesis, woodchipper receive pattern.',
      },
    },
    'pattern-2': {
      type: 'PatternCard',
      props: {
        label: 'Approval inertia / green-light drift',
        description: '*Anti-pattern — candidate sixth death spiral.* Reviewer builds momentum toward approval on familiar code and carries it through unfamiliar code without slowing. Live case study: ConfigContext adversarial review found 4 real bugs that default review missed. The adversarial trigger is just the words *"adversarial code review."* That\'s it. A phrase.',
      },
    },
  },
};
