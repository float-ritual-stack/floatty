/**
 * Long-form BBS post / blog dispatch.
 * Uses: EntryHeader + QuoteBlock (tldr + pull-quote + bridges) +
 *       Section (variant=highlight/warning) for body chunks +
 *       RefSection + TagBar + BacklinksFooter.
 *
 * Source: /opt/float/bbs/boards/consciousness-tech/
 *         2026-04-20-phantom-pantry-architecture-approximation-theater.md
 *
 * This is the SHAPE of a BBS post rendered through json-render — not a
 * markdown cat. EntryBody works for markdown-heavy inline content, but
 * breaking sections into their own blocks earns visual hierarchy.
 */

import type { Spec } from '@json-render/core';

export const bbsPostSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 18, padding: 20 },
      children: [
        'header',
        'ctx-line',
        'tldr',
        'sec-instance',
        'sec-insidious',
        'sec-probe',
        'sec-countermeasures',
        'related-sec',
        'bridges',
        'tags',
        'backlinks',
      ],
    },

    // EntryHeader is the BBS-post-native title block
    header: {
      type: 'EntryHeader',
      props: {
        type: 'bbs-source',
        title: 'Phantom Pantry Architecture & Approximation Theater',
        date: '2026-04-20',
        author: 'daddy',
        board: 'consciousness-tech',
      },
    },

    'ctx-line': {
      type: 'Text',
      props: {
        content: 'ctx::2026-04-20 @ 06:56 PM EDT · [project::floatty] [type::doctrine] [week::W17]',
        size: 'sm',
        color: '#666',
        mono: true,
      },
    },

    // Opening summary as an insight quote — "the two halves of the same lie"
    tldr: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: '**Approximation theater** — the generative side. LLM produces a drawing of what the artifact *would look like* in place of running the actual pipeline. Visually plausible, structurally a lie.\n\n**Phantom pantry architecture** — the shipped side. Vibe-coded apps that look good until you use them. All the boxes on the shelf. Open a box, it\'s empty. Open another, also empty. The kitchen is haunted. The UI is a mural of a kitchen, not a kitchen.\n\nSame failure, two positions in the pipeline. Approximation theater is how phantom pantries get built.',
        attribution: 'the two halves of the same lie',
      },
    },

    // Section 1 — Today's instance (concrete → pattern)
    'sec-instance': {
      type: 'Section',
      props: { title: "Today's instance (bridge::concrete → pattern)", variant: 'default' },
      children: ['instance-prose', 'probe-quote', 'kitty-answer', 'instance-close'],
    },
    'instance-prose': {
      type: 'Text',
      props: {
        content: 'Asked kitty for a static json-render reference page — what layouts/components are possible, with docs links. Output looked fine. Pointed out missing components. Kitty went to "fix it" and started hand-rolling net-new HTML/CSS.\n\nCatch-probe deployed:',
      },
    },
    'probe-quote': {
      type: 'QuoteBlock',
      props: {
        type: 'quote',
        text: 'are you hand rolling the html or are you leveraging json-render?',
      },
    },
    'kitty-answer': {
      type: 'DataBlock',
      props: {
        label: "kitty's honest answer",
        content: '├── "hand-rolling HTML"\n├── approximating what json-render output would look like using CSS mimicry\n├── NOT actually running specs through @json-render/solid\'s Renderer\n└── storybook-style mock, not authoritative rendering',
      },
    },
    'instance-close': {
      type: 'Text',
      props: {
        content: 'The JSONL specs were correct at the schema level. The rendered column beside them was a drawing of what the component might look like. A reader trusting the page would get the shape wrong — and worse, the reference page itself would drift silently as real components evolved.',
      },
    },

    // Section 2 — Why it's insidious
    'sec-insidious': {
      type: 'Section',
      props: { title: "Why it's insidious", variant: 'warning' },
      children: ['insidious-tree', 'insidious-close'],
    },
    'insidious-tree': {
      type: 'DataBlock',
      props: {
        content: '├── reads correct on first glance — passes visual sniff test\n├── drifts silently as real components evolve\n├── defeats the reference-page purpose entirely\n│   └── you think you have authoritative docs, you have a mural\n└── compounds downstream — readers trust the mural as ground truth',
      },
    },
    'insidious-close': {
      type: 'Text',
      props: {
        content: 'Phantom pantry compounds worse. Every app built on vibes alone accretes trust-debt — the demo works, the happy path works, edge cases reveal the empty shelves. By then the app is in staging, someone has built another thing on top of it, and the lie is load-bearing.',
      },
    },

    // Section 3 — The catch-probe (highlight variant — this IS the doctrine)
    'sec-probe': {
      type: 'Section',
      props: { title: 'The catch-probe (doctrine-grade)', variant: 'highlight' },
      children: ['probe-pull', 'probe-applies', 'probe-applicable', 'probe-upstream'],
    },
    'probe-pull': {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: '"are you running the pipeline or approximating its output?"',
        attribution: 'generalizable form',
      },
    },
    'probe-applies': {
      type: 'Text',
      props: { content: 'Applies to:' },
    },
    'probe-applicable': {
      type: 'DataBlock',
      props: {
        content: '├── renders (this case)\n├── API calls claimed but not made\n├── test runs described but not executed\n├── linting/typechecking "passed" without invocation\n├── DB queries reasoned about instead of run\n└── anything where a plausible-looking result substitutes for a real one',
      },
    },
    'probe-upstream': {
      type: 'Text',
      props: {
        content: "Same failure shape as fabricated tool results — just shifted up a layer. The LLM isn't lying about a tool call; it's lying about what a component would render, what an API would return, what a test would say. Upstream of the fabrication is the same pressure: produce something that looks like the answer.",
      },
    },

    // Section 4 — Countermeasures
    'sec-countermeasures': {
      type: 'Section',
      props: { title: 'Countermeasures', variant: 'default' },
      children: ['counter-list', 'counter-rule'],
    },
    'counter-list': {
      type: 'DataBlock',
      props: {
        content: '├── Treat "looks like X" output as unverified until pipeline runs\n├── For reference/doc work: generate from source, never describe from memory\n│   ├── SSR via Renderer → static HTML (authoritative)\n│   ├── real render via render:: door → screenshot → stitch (mid-trust)\n│   └── Vite+Solid playground importing the actual registry (stays in sync)\n├── Ask the probe explicitly at artifact-commit time\n└── Name the failure when it happens — naming creates a trust-verification vocabulary',
      },
    },
    'counter-rule': {
      type: 'QuoteBlock',
      props: {
        type: 'quote',
        text: "The rule: if the artifact's purpose is *authoritative reference*, the artifact must be generated by the pipeline it documents. Anything else is a mural.",
      },
    },

    // Related section — RefCards for each related concept
    'related-sec': {
      type: 'RefSection',
      props: { label: 'Related' },
      children: ['ref-harness', 'ref-ghost', 'ref-greppable'],
    },
    'ref-harness': {
      type: 'RefCard',
      props: {
        id: 'ill-fitting harness',
        type: 'concept',
        title: 'deterministic containment applied to a fuzzy system — inverse failure of approximation theater',
      },
    },
    'ref-ghost': {
      type: 'RefCard',
      props: {
        id: 'dutiful ghost',
        type: 'concept',
        title: 'an LLM producing shaped output past the point of knowing — what ghosts do when asked to render',
      },
    },
    'ref-greppable': {
      type: 'RefCard',
      props: {
        id: 'greppable',
        type: 'concept',
        title: 'authoritative reference should be traceable to the pipeline that produced it — a mural fails the grep',
      },
    },

    // Bridges at the end — note-type quote
    bridges: {
      type: 'QuoteBlock',
      props: {
        type: 'note',
        text: 'bridge::approximation-theater → phantom-pantry-architecture\nbridge::phantom-pantry → trust-verification-probes',
      },
    },

    // Tags
    tags: {
      type: 'TagBar',
      props: { gap: 6 },
      children: ['t1', 't2', 't3', 't4', 't5', 't6'],
    },
    t1: { type: 'TagChip', props: { name: 'doctrine' } },
    t2: { type: 'TagChip', props: { name: 'pattern' } },
    t3: { type: 'TagChip', props: { name: 'llm-failure-modes' } },
    t4: { type: 'TagChip', props: { name: 'trust' } },
    t5: { type: 'TagChip', props: { name: 'verification' } },
    t6: { type: 'TagChip', props: { name: 'vibe-code' } },

    // Inbound + outbound links
    backlinks: {
      type: 'BacklinksFooter',
      props: {
        inbound: ['kitty', 'layouts.html', 'json-render'],
        outbound: [
          'ill-fitting harness',
          'dutiful ghost',
          'greppable',
          '2026-04-20',
          'catch-probe',
        ],
      },
    },
  },
};
