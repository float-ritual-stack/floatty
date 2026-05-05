/**
 * Long-form BBS post / blog dispatch.
 *
 * Demonstrates pushing past the "## → h2" markdown-cat floor by reaching
 * for the right primitive per content-shape:
 *   - QuoteBlock insight     pull-quote / claim summary (TLDR + doctrine line)
 *   - Callout question       inline probe / asked-question
 *   - Callout failure        confessional list (what was actually happening)
 *   - Callout warning        escalation / why-this-matters with nested sub-claim
 *   - Callout example        flat list of "where this applies"
 *   - Callout tip            THE doctrine takeaway (the rule)
 *   - Callout abstract       bridges / lateral synthesis
 *   - TreeView               only where tree-shape + status is real (countermeasures)
 *   - BulletList             flat list of co-occurring items inside Callouts
 *
 * What we used to do: DataBlock containing literal `├── └──` ASCII chars
 * rendered as a <pre> block. Visually flat, semantically empty — the parser
 * couldn't tell "warning" from "example" from "Q&A pair" from "checklist."
 * The new shape preserves the source's voice and notation discipline (markers,
 * the blackbar callouts in the original .md) while attaching real semantics
 * to each block so the reader can SCAN it: pull-quotes for skimmers, typed
 * callouts for asides, statused tree only where it's earned.
 *
 * Source: /opt/float/bbs/boards/consciousness-tech/
 *         2026-04-20-phantom-pantry-architecture-approximation-theater.md
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
        'bridges-callout',
        'tags',
        'backlinks',
      ],
    },

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

    // ─── TLDR ─ pull-quote, the claim ───────────────────────────────
    tldr: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: '**Approximation theater** — the generative side. LLM produces a drawing of what the artifact *would look like* in place of running the actual pipeline. Visually plausible, structurally a lie.\n\n**Phantom pantry architecture** — the shipped side. Vibe-coded apps that look good until you use them. All the boxes on the shelf. Open a box, it\'s empty. Open another, also empty. The kitchen is haunted. The UI is a mural of a kitchen, not a kitchen.\n\nSame failure, two positions in the pipeline. Approximation theater is how phantom pantries get built.',
        attribution: 'the two halves of the same lie',
      },
    },

    // ─── SECTION 1 ─ Today's instance (concrete → pattern) ──────────
    'sec-instance': {
      type: 'Section',
      props: { title: "Today's instance (bridge::concrete → pattern)", variant: 'default' },
      children: ['instance-prose', 'probe-pair', 'instance-close'],
    },
    'instance-prose': {
      type: 'Text',
      props: {
        content: 'Asked kitty for a static json-render reference page — what layouts/components are possible, with docs links. Output looked fine. Pointed out missing components. Kitty went to "fix it" and started hand-rolling net-new HTML/CSS.',
      },
    },
    // The probe + answer as a Q&A Callout pair — outer question wraps
    // the asked prompt, nested failure callout holds what was actually
    // happening underneath. Replaces the prior DataBlock+ASCII-tree mess
    // that made the relationship invisible.
    'probe-pair': {
      type: 'Callout',
      props: { type: 'question', title: 'Catch-probe deployed', collapsible: false },
      children: ['probe-q', 'probe-a'],
    },
    'probe-q': {
      type: 'Text',
      props: {
        content: '*are you hand rolling the html or are you leveraging json-render?*',
        markdown: true,
      },
    },
    'probe-a': {
      type: 'Callout',
      props: { type: 'failure', title: "kitty's honest answer", collapsible: false },
      children: ['probe-a-list'],
    },
    'probe-a-list': {
      type: 'BulletList',
      props: {
        items: [
          '"hand-rolling HTML"',
          'approximating what json-render output would look like using CSS mimicry',
          'NOT actually running specs through @json-render/solid\'s Renderer',
          'storybook-style mock, not authoritative rendering',
        ],
      },
    },
    'instance-close': {
      type: 'Text',
      props: {
        content: 'The JSONL specs were correct at the schema level. The rendered column beside them was a drawing of what the component might look like. A reader trusting the page would get the shape wrong — and worse, the reference page itself would drift silently as real components evolved.',
      },
    },

    // ─── SECTION 2 ─ Why it's insidious (escalation + nested sub-claim) ─
    'sec-insidious': {
      type: 'Section',
      props: { title: "Why it's insidious", variant: 'warning' },
      children: ['insidious-callout', 'insidious-close'],
    },
    'insidious-callout': {
      type: 'Callout',
      props: { type: 'warning', title: 'Failure mode escalates silently', collapsible: false },
      children: ['insidious-list', 'insidious-nested'],
    },
    'insidious-list': {
      type: 'BulletList',
      props: {
        items: [
          'reads correct on first glance — passes visual sniff test',
          'drifts silently as real components evolve',
          'defeats the reference-page purpose entirely',
          'compounds downstream — readers trust the mural as ground truth',
        ],
      },
    },
    // The "you think you have authoritative docs, you have a mural" line
    // was nested under "defeats the reference-page purpose" in the source.
    // Lift it as a nested Callout (danger) — the sub-claim earns its own
    // visual register because IT is the load-bearing diagnosis.
    'insidious-nested': {
      type: 'Callout',
      props: { type: 'danger', title: 'The diagnosis underneath', collapsible: false },
      children: ['insidious-nested-text'],
    },
    'insidious-nested-text': {
      type: 'Text',
      props: {
        content: 'You think you have authoritative docs. You have a mural.',
      },
    },
    'insidious-close': {
      type: 'Text',
      props: {
        content: 'Phantom pantry compounds worse. Every app built on vibes alone accretes trust-debt — the demo works, the happy path works, edge cases reveal the empty shelves. By then the app is in staging, someone has built another thing on top of it, and the lie is load-bearing.',
      },
    },

    // ─── SECTION 3 ─ The catch-probe (doctrine-grade — the takeaway) ─
    'sec-probe': {
      type: 'Section',
      props: { title: 'The catch-probe (doctrine-grade)', variant: 'highlight' },
      children: ['probe-pull', 'probe-applicable', 'probe-upstream'],
    },
    // THE doctrine line — pull-quote treatment so it scans first
    'probe-pull': {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: '"are you running the pipeline or approximating its output?"',
        attribution: 'generalizable form',
      },
    },
    // "Applies to" was a prose line + DataBlock-tree. Collapse to one
    // Callout(example) holding a flat BulletList — the relationship is
    // "list of categories where the probe applies", NOT a tree.
    'probe-applicable': {
      type: 'Callout',
      props: { type: 'example', title: 'Where the catch-probe applies', collapsible: false },
      children: ['probe-applicable-list'],
    },
    'probe-applicable-list': {
      type: 'BulletList',
      props: {
        items: [
          'renders (this case)',
          'API calls claimed but not made',
          'test runs described but not executed',
          'linting/typechecking "passed" without invocation',
          'DB queries reasoned about instead of run',
          'anything where a plausible-looking result substitutes for a real one',
        ],
      },
    },
    'probe-upstream': {
      type: 'Text',
      props: {
        content: "Same failure shape as fabricated tool results — just shifted up a layer. The LLM isn't lying about a tool call; it's lying about what a component would render, what an API would return, what a test would say. Upstream of the fabrication is the same pressure: produce something that looks like the answer.",
      },
    },

    // ─── SECTION 4 ─ Countermeasures (genuine tree, statused) ───────
    'sec-countermeasures': {
      type: 'Section',
      props: { title: 'Countermeasures', variant: 'default' },
      children: ['counter-tree', 'counter-rule'],
    },
    // FINALLY a place where TreeView is earned: 4 root countermeasures,
    // one of them ("generate from source") branches into 3 statused
    // implementation paths. The status-color (done/active) carries real
    // signal — these are the actual paths used in render-reference.
    'counter-tree': {
      type: 'TreeView',
      props: {
        nodes: [
          {
            id: 'cm-1',
            label: 'Treat "looks like X" output as unverified until pipeline runs',
            status: 'active',
          },
          {
            id: 'cm-2',
            label: 'For reference/doc work: generate from source, never describe from memory',
            status: 'active',
            children: [
              {
                id: 'cm-2a',
                label: 'SSR via Renderer → static HTML',
                status: 'done',
                detail: 'authoritative — output equals the rendered shape exactly',
              },
              {
                id: 'cm-2b',
                label: 'real render via render:: door → screenshot → stitch',
                status: 'active',
                detail: 'mid-trust — visual artifact is real, freeze-time risk',
              },
              {
                id: 'cm-2c',
                label: 'Vite+Solid playground importing the actual registry',
                status: 'done',
                detail: 'stays in sync — render-reference is exactly this shape',
              },
            ],
          },
          {
            id: 'cm-3',
            label: 'Ask the probe explicitly at artifact-commit time',
            status: 'active',
          },
          {
            id: 'cm-4',
            label: 'Name the failure when it happens — naming creates a trust-verification vocabulary',
            status: 'active',
          },
        ],
      },
    },
    // The rule is THE doctrine takeaway — Callout tip gives it the
    // strongest "remember this" affordance. Was a QuoteBlock (quote
    // type) before; tip is a stronger semantic register for "the rule."
    'counter-rule': {
      type: 'Callout',
      props: { type: 'tip', title: 'The rule', collapsible: false },
      children: ['counter-rule-text'],
    },
    'counter-rule-text': {
      type: 'Text',
      props: {
        content: 'If the artifact\'s purpose is *authoritative reference*, the artifact must be generated by the pipeline it documents. Anything else is a mural.',
        markdown: true,
      },
    },

    // ─── RELATED ─ RefCards for lateral concepts ────────────────────
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

    // ─── BRIDGES ─ Callout abstract for lateral synthesis ───────────
    // Was QuoteBlock(note); abstract callout gives it a clearer "this is
    // the lateral-link block" register. The bridge:: lines are tagged
    // navigation, not pulled prose.
    'bridges-callout': {
      type: 'Callout',
      props: { type: 'abstract', title: 'Bridges', collapsible: false },
      children: ['bridges-list'],
    },
    'bridges-list': {
      type: 'BulletList',
      props: {
        items: [
          'bridge::approximation-theater → phantom-pantry-architecture',
          'bridge::phantom-pantry → trust-verification-probes',
        ],
      },
    },

    // ─── TAGS + BACKLINKS ─ footer metadata (unchanged shape) ───────
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
