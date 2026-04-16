---
name: spec-components
description: Full component catalog reference for emitting structured spec blocks. Load this when you need the complete list of available components.
---

# Component Catalog

Emit structured UI by writing a ```spec fenced block. Inside, write one JSON patch per line (RFC 6902).

## Layout & Structure

- **Section** (title, variant?: "default"|"highlight"|"warning") — collapsible section with heading. Has children slot.
- **SectionLabel** (label, color?, icon?) — lightweight section header with divider line. Has children slot. Colors: cyan, magenta, coral, amber, green, purple, dim. Icons: Compass, FileText, Sparkles, Zap, Brain, GitBranch, Clock, BarChart3.
- **Prose** (content) — short inline text inside structured components.

## Analysis

- **ObservationCard** (number, title, body, severity?: "surprising"|"structural"|"gap"|"thread"|"meta", links?: string[]) — expandable numbered observation. links are wikilink targets.
- **PatternCard** (label, description, confidence?: "high"|"medium"|"low") — pattern/theme card.
- **PatternCluster** (name, color?, instances: string[], connections?: string[]) — cluster visualization.
- **GapItem** (description, severity?: "info"|"warning"|"critical", gapType?: "stub"|"orphan"|"empty"|"asymmetric"|"unanswered", evidence?, target?) — gap finding with type badge.

## Metrics & Timeline

- **StatPill** (label, value, color?) — numeric stat counter.
- **TimelineEvent** (time, label, color?) — timeline dot.
- **ConfidenceDot** (level: "high"|"medium"|"low"|"partial") — inline confidence indicator.

## References & Navigation

- **BlockRef** (title, page?, blockId?) — clickable wikilink reference.
- **WalkChip** (page, reason?) — walk suggestion chip.
- **Chip** (label, color?, icon?, clickable?) — general-purpose pill/tag.

## Rich Visualizations

- **LinkGraph** (nodes: [{id, label, color?, weight?, center?, ring?, type?}], edges: [[fromId, toId]]) — SVG radial graph.
- **ActivityHeatmap** (data: [{label, value}], color?) — block activity grid.
- **ProvenanceChain** (steps: [{source, content, docId?, confidence?, lines?}]) — vertical chain. source: qmd|conversation|bbs|outline|loki|autorag.
- **RiskMatrix** (items: [{label, severity: "high"|"medium"|"low", impact: "structural"|"content"|"cosmetic"}]) — severity x impact grid.
- **TimelineDiff** (before: {date, items: [{text, removed?}]}, after: {date, items: [{text, added?}]}) — side-by-side comparison.

## Typography

- **Heading** (level: 1|2|3, content) — styled heading.
- **Paragraph** (content) — body text. Renders **bold** and `code` inline.
- **Bold** (content) — inline bold.
- **InlineCode** (content) — inline code.
- **StatusLine** (label, color?, content) — colored label prefix with body text.
- **BulletList** (items: string[]) — bulleted list.
- **Divider** — horizontal rule.

## Important

- For narrative text use **Paragraph** (not Prose). Paragraph renders inline markers.
- For section titles use **Heading**. For lists use **BulletList**.
- Mix prose text with spec blocks freely. Text outside the fence renders as normal text.
