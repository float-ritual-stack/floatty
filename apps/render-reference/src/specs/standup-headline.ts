/**
 * Standup Headline — Apr 13 Monday headlines.
 * Q&A blocks as QuoteBlock (type:note), blockers as GapItem, DependencyChain for issue deps.
 */
import type { Spec } from '@json-render/core';

export const standupHeadlineSpec: Spec = {
  root: 'doc',
  state: {},
  elements: {
    doc: {
      type: 'Stack',
      props: { direction: 'vertical', gap: 14, padding: 16 },
      children: ['header', 'banner', 'highlights-h', 'h1', 'h2', 'h3', 'dep-chain', 'blockers-h', 'unblocked', 'sync-h', 'qa1', 'qa2', 'next-h', 'next'],
    },

    header: {
      type: 'MetadataHeader',
      props: {
        title: 'Monday Apr 13 — Headlines',
        subtitle: '[project::generi-co/pharma-app] [day::Monday] [week::2026-W16]',
        date: '2026-04-13',
      },
    },

    banner: {
      type: 'QuoteBlock',
      props: {
        type: 'insight',
        text: 'GO-LIVE WEEK — Apr 15–16 hard deadline. All hands.',
      },
    },

    'highlights-h': { type: 'Heading', props: { level: 2, content: '## Morning highlights' } },
    h1: {
      type: 'Paragraph',
      props: {
        content: '◆ **[[PR #2131]]** BMI validation + routing ([[#2078]] + [[#2129]]) polished: Vercel build error fixed (discriminated-union spread cast `as BuilderNode`), Zustand direct mutation cleaned up to immutable `setNodes` map, `NodeType`/`QuestionType` enum types replace string literals. 5 commits, **482 tests green**, CodeRabbit clean, Vercel deployments passing.',
      },
    },
    h2: {
      type: 'Paragraph',
      props: {
        content: '◆ **Nico sync confirmed** via Sam: out-of-range BMI → Block (Red) is the right behavior for [[#2129]] — greenlit to ship.',
      },
    },
    h3: {
      type: 'Paragraph',
      props: {
        content: '◆ **[[PR #2156]]** [[#2130]] Block label fix shipped — assessment responses flagged `ReviewFlag.block` now display with "Block" badge + filter label instead of "Warning". 2 files / 2 lines, Chrome-MCP screenshot verified.',
      },
    },

    // DependencyChain — issue chain visualization
    'dep-chain': {
      type: 'DependencyChain',
      props: {
        nodes: [
          { id: '#2078', title: 'BMI validation', assignee: 'Alex', status: 'done', deps: [] },
          { id: '#2129', title: 'BMI range blocking', assignee: 'Alex', status: 'done', deps: ['#2078'] },
          { id: 'PR #2131', title: 'BMI routing PR', assignee: 'Alex', status: 'done', deps: ['#2078', '#2129'] },
          { id: '#2130', title: 'Block label fix', assignee: 'Alex', status: 'done', deps: [] },
          { id: 'PR #2156', title: 'Block label PR', assignee: 'Alex', status: 'done', deps: ['#2130'] },
        ],
      },
    },

    'blockers-h': { type: 'Heading', props: { level: 2, content: '## Blockers' } },
    unblocked: {
      type: 'GapItem',
      props: {
        severity: 'info',
        description: "**~~[[#2113]]~~ UNBLOCKED** — Kai's RLS fix is [[PR #2086]] (merged Apr 10 15:58). Earlier sweep missed it. Alex to resume follow-up assessment verification on staging this afternoon — top priority.",
      },
    },

    'sync-h': { type: 'Heading', props: { level: 2, content: '## 12:12 PM Sam Sync' } },

    qa1: {
      type: 'QuoteBlock',
      props: {
        type: 'note',
        text: 'question:: Is the out-of-range BMI → Block Red the right behavior, or should it be Warning Yellow?\n\nanswer:: Block Red is correct — *"anything that doesn\'t fall within the defined ranges"* (Sam quoting Nico). [[PR #2131]] greenlit.',
        attribution: 'asked-by: Sam · context: sam-sync [[2026-04-13]] · [project::generi-co/pharma-app]',
      },
    },

    qa2: {
      type: 'QuoteBlock',
      props: {
        type: 'note',
        text: 'question:: Should [[#2123]] perf (~33s order detail) ship pre-launch?\n\nanswer:: Wait until Dana\'s [[PR #2150]] hits prod, then recheck. Not launch-blocking.',
        attribution: 'asked-by: Alex · context: sam-sync [[2026-04-13]] · [project::generi-co/pharma-app]',
      },
    },

    'next-h': { type: 'Heading', props: { level: 2, content: '## Next' } },
    next: {
      type: 'Paragraph',
      props: {
        content: 'Afternoon: [[#2113]] staging verification (now unblocked by [[PR #2086]]). Sample orders, run cron endpoint, verify dispatch. Monitor [[PR #2131]] merge status.',
      },
    },
  },
};
