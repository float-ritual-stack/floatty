/**
 * Showcase data — demonstrates all catalog components with real-ish data.
 * Used by `garden:: showcase` route.
 */

import type { Entry } from './session-garden';

export const SHOWCASE_ENTRIES: Entry[] = [
  {
    id: 'tui-metrics',
    type: 'synthesis',
    title: 'TUI Metrics Dashboard',
    tags: ['tui', 'metrics', 'barchart'],
    content: `## TuiPanel + TuiStat + BarChart

These components render dense data in terminal-style containers.

### How They Compose

- **TuiPanel**: Bordered container with a title floating on the top border
- **TuiStat**: Centered metric card — label above, bold value below
- **BarChart + BarItem**: Normalized vertical bars, height scaled to max value

The stats below are rendered as TuiStat components inside a horizontal Stack,
and the bar chart shows weekly PR activity.

···`,
    date: '2026-03-24',
    author: 'kitty',
    refs: ['shipped-work', 'pattern-notes'],
  },
  {
    id: 'shipped-work',
    type: 'bbs-source',
    title: 'Shipped Items & Wikilinks',
    tags: ['shipped', 'wikilinks', 'backlinks'],
    content: `## ShippedItem + WikilinkChip + BacklinksFooter

Components for tracking completed work and navigating the outline.

### ShippedItem
Green asterisk bullets for shipped/completed work:

- **[[PR #1826]]** — per-occurrence follow-up config (5 E2E scenarios)
- **[[PR #1838]]** — none option enhancements (458 tests pass)
- **[[PR #1806]]** — switch node skipped-branch fix (424 tests)
- **[[PR #1807]]** — assessment footer scroll-to-top

### WikilinkChip
Standalone clickable bracket-wrapped links: [[PR #1758]], [[Issue #1779]], [[FLO-280]]

### BacklinksFooter
Shows bidirectional connections between entries — what references this, what this links to.

···`,
    date: '2026-03-24',
    author: 'kitty',
    board: 'showcase',
    refs: ['tui-metrics', 'pattern-notes'],
  },
  {
    id: 'pattern-notes',
    type: 'archaeology',
    title: 'Pattern Cards & Data Blocks',
    tags: ['patterns', 'code', 'expandable'],
    content: `## PatternCard + DataBlock

Components for technical documentation and pattern capture.

### PatternCard
Expandable cards with type badges (pattern/reference/field-note), confidence indicators (VERIFIED/INFERRED), markdown body, and connectsTo footer. Click the header to collapse.

### DataBlock
Monospace pre blocks with floating labels — for code snippets, config files, terminal output.

···`,
    date: '2026-03-24',
    author: 'kitty',
    refs: ['tui-metrics', 'shipped-work'],
  },
];
