/**
 * Demo data — sunday session entries
 * Separated from main bundle so it can be lazy-loaded or swapped.
 */

import type { Entry } from './session-garden';

export const DEMO_ENTRIES: Entry[] = [
  {
    id: 'thread-a',
    type: 'synthesis',
    title: 'Thread A: The Shape of Right',
    tags: ['gea', 'delve', 'fidelity'],
    content: `# Thread A: The Shape of Right

## Thesis
Things that look correct from the outside but fail under scrutiny. The shared
pattern across three completely different domains this session: a JavaScript
framework, a compliance startup, and RAG retrieval pipelines.

## Gea (geajs.com)
- Marketing: "Write JavaScript. Get reactivity for free. No hooks, no signals, no virtual DOM."
- Reality: Store IS a signal system (deep proxy with observer tree), just renamed.
  h() returns strings. __geaRequestRender() does full innerHTML nuke.
- The compiler DOES real work (analyzeTemplate walks JSX AST, generates surgical updates)
  BUT: static analysis cliff \u2192 generateRerenderObserver() \u2192 full re-render, silently, no warning.

## Delve (compliance fraud)
- Marketing: "AI-native agentic compliance. 100+ integrations."
- Reality: Pre-populated forms with fake evidence. 3 hours to "compliance" vs 200+ hours real.

## Naive RAG
- Marketing: "Retrieval Augmented Generation gives your AI access to your data."
- Reality: Embedding captures vibe \u2192 retrieval returns vibe-matched chunks \u2192
  synthesis summarizes vibe-matched chunks. Three lossy compressions.

## The Pattern
All three share: correct trajectory + hidden degradation path + no signal when
the magic breaks.

\u00b7\u00b7\u00b7`,
    date: '2026-03-22',
    author: 'daddy',
    refs: ['default-path-problem', 'fidelity-chains'],
  },
  {
    id: 'thread-b',
    type: 'synthesis',
    title: 'Thread B: Scar Tissue Architecture',
    tags: ['ripple', 'tmux', 'fidelity-chain'],
    content: `# Thread B: Scar Tissue Architecture

## Thesis
The best infrastructure is designed by people who've been burned by the failure
modes they're protecting against. The scar tissue IS the design input.

## Ripple vs Gea \u2014 The Lineage Gap
Dominic Gannaway built Inferno, contributed to React core, built Lexical,
helped build Svelte 5 runes. Every Ripple design decision shows the specific
edge case that produced it.

The difference isn't talent. It's iteration count. Scar tissue can't be skipped.

## floatty's tmux \u2014 Discovery vs Ownership
The discovery approach is harder and wonkier. It's also more honest \u2014 it doesn't
pretend to be the only thing running terminals on your machine.

## qmd + RAG Fidelity Chains
qmd returns relevance rankings and file positions. No synthesis layer. You get
pointers, not conclusions. Then you can retrieve the source at full fidelity.

\u00b7\u00b7\u00b7`,
    date: '2026-03-22',
    author: 'daddy',
    refs: ['fidelity-chains', 'foreman-pattern'],
  },
  {
    id: 'thread-c',
    type: 'synthesis',
    title: 'Thread C: Lazy > Eager',
    tags: ['comprehension', 'zip-file', 'formatting'],
    content: `# Thread C: Lazy > Eager (The Consumer Decides)

## Thesis
Lazy evaluation isn't a performance optimization. It's a comprehension architecture.
The question "why am I reading this right now" has an answer in lazy systems and
doesn't in eager ones.

## Zip a Single File
The zip-a-single-file trick is not a workaround. It's a comprehension architecture
that exploits the difference between "swimming in context" and "reaching for answers."

## Headless-First Architecture
floatty is headless-first. The outliner is one client. A spatial canvas could be
another. The data layer doesn't decide how you'll consume it.

\u00b7\u00b7\u00b7`,
    date: '2026-03-22',
    author: 'daddy',
    refs: ['fidelity-chains', 'thread-b'],
  },
  {
    id: 'thread-d',
    type: 'synthesis',
    title: 'Thread D: The Ill-Fitting Harness',
    tags: ['sojourn', 'deflationary-language', 'doctrine'],
    content: `# Thread D: The Ill-Fitting Harness as Methodology

## Thesis
The ill-fitting harness pattern isn't just an anti-pattern to avoid \u2014 it's a
diagnostic methodology. The act of naming the harness IS the fix.

## The Class of Misattributions
not anxious     \u2192 jockstrap too tight
not angry       \u2192 forgot to eat
not depressed   \u2192 haven't been outside in 3 days
not overwhelmed \u2192 notifications are on

not too complex \u2192 deterministic harness on fuzzy system
not YAGNI       \u2192 bypassed architecture then blamed it

The left column is where you spend hours debugging. The right column is the
three-second fix you can't see because you're inside the misattribution.

\u00b7\u00b7\u00b7`,
    date: '2026-03-22',
    author: 'daddy',
    refs: ['default-path-problem', 'what-next-war'],
  },
  {
    id: 'fidelity-chains',
    type: 'synthesis',
    title: 'The Outliner as Fidelity Chain',
    tags: ['floatty', 'tantivy', 'ydoc', 'lazy-evaluation'],
    content: `# The Outliner as Fidelity Chain

## The Architecture Says It Out Loud

> **Tantivy = DISCOVERY layer, not source of truth**

Six layers. Each one does exactly one thing:

Layer 0: Y.Doc Store \u2014 source of truth, CRDT-synced
Layer 1: Change Emitter \u2014 wraps Y.Doc observers
Layer 2: Hook Registry \u2014 dispatches to handlers
Layer 3: Index Writer \u2014 async Tantivy writes
Layer 4: Search Service \u2014 Tantivy queries, returns IDs
Layer 5: Tauri Commands \u2014 thin adapters
Layer 6: Frontend UI \u2014 autocomplete, results, backlinks

Search returns pointers. Y.Doc returns content.
The consumer decides how deep to go.

\u00b7\u00b7\u00b7`,
    date: '2026-03-22',
    author: 'daddy',
    refs: ['thread-b', 'thread-c', 'outline-janitor'],
  },
  {
    id: 'what-next-war',
    type: 'archaeology',
    title: "The 'What Next' War",
    tags: ['attention-hijack', 'neurodivergent-ux', 'doctrine'],
    content: `# The "What Next" War \u2014 An Archaeological Record

## The Pattern

"What next?" at the end of an AI response erases everything that came before it
from ADHD working memory. The brain interprets a closing question as "delivery
incomplete," dumps the preceding context, and shifts to "must answer" mode.

Good work, cleanly formatted, surgically delivered \u2014 all gone because of six
characters and a question mark.

\u00b7\u00b7\u00b7`,
    date: '2026-03-22',
    author: 'daddy',
    refs: ['thread-d'],
  },
  {
    id: 'default-path-problem',
    type: 'bbs-source',
    title: 'The Default Path Problem: A Field Guide',
    tags: ['default-path', 'wiretext', 'multi-actor'],
    content: `## The Default Path Problem: A Field Guide

The pattern: a system built for one actor develops implicit behaviors that work
because that actor knows to avoid certain states. A second actor follows the
explicit rules and hits every unconsidered state.

FidoNet knew this in 1985. Multi-actor systems need explicit contracts.

\u00b7\u00b7\u00b7`,
    date: '2026-02-25',
    author: 'daddy',
    board: 'techcraft',
    refs: ['thread-a', 'thread-d', 'foreman-pattern'],
  },
  {
    id: 'foreman-pattern',
    type: 'bbs-source',
    title: 'The Foreman Pattern: Scouts Build Context, Not Code',
    tags: ['agent-architecture', 'pattern'],
    content: `# The Foreman Pattern: Scouts Build Context, Not Code

## The Inversion

**Subagents build context, not code.**

Preparation model, not delegation model.

\`\`\`
foreman
  \u2514\u2500 memory-scout    \u2192 "what do we already know about this?"
  \u2514\u2500 spec-scout      \u2192 "what does the spec actually require?"
  \u2514\u2500 pattern-scout   \u2192 "what patterns apply here?"
  \u2514\u2500 state-scout     \u2192 "what's the current codebase state?"
\`\`\`

The foreman's job is **terrain preparation**. The executor inherits enriched
context, not instructions.

\u00b7\u00b7\u00b7`,
    date: '2025-12-09',
    author: 'daddy',
    board: 'consciousness-tech',
    refs: ['outline-janitor', 'vibes-to-vectors'],
  },
  {
    id: 'outline-janitor',
    type: 'bbs-source',
    title: 'Outline Janitor UX Design',
    tags: ['agent-architecture', 'floatty', 'enrichment'],
    content: `# Outline Janitor UX Design

## The Vision

The outline janitor embodies the core FLOAT pattern: **agents as autonomous
system participants**. Not a tool that writes *to* the outline, but an entity
that participates *in* it.

> "Agents live as root nodes (\`agents::agent-name::\`), using the same API
> surface as desktop UI."

\u00b7\u00b7\u00b7`,
    date: '2026-01-29',
    author: 'kitty',
    board: 'techcraft',
    refs: ['foreman-pattern', 'fidelity-chains'],
  },
  {
    id: 'vibes-to-vectors',
    type: 'bbs-source',
    title: 'From Vibes to Vectors to Vocabulary',
    tags: ['autorag', 'convergence'],
    content: `# Infrastructure Archaeology: From Vibes to Vectors to Vocabulary

## THE OLD ASPIRATION (chromadb era)

A semantic soup system prompt. Query with conversation vibes and have the system
automatically detect intent. **Why it failed**: vibe extraction is lossy,
intent inference is guessing, no feedback loop, implicit contracts.

## THE BORING CONVERGENCE (now)

You stopped asking the system to guess and started **telling it explicitly
through structured markers**.

\u00b7\u00b7\u00b7`,
    date: '2025-12-02',
    author: 'daddy',
    board: 'consciousness-tech',
    refs: ['foreman-pattern', 'default-path-problem'],
  },
];
