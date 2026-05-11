// Set A — shared components consumed by both render-door (SolidJS) and
// outline-explorer (React). `shared.ts` is the symmetry contract — every
// component declared here MUST have both a Solid impl (render-door
// components.tsx) and a React impl (outline-explorer renderers/). Surface-
// bound exceptions live in door.ts (music — Tauri+Tone+Strudel) and
// explorer.ts (workflow UI — RenderPrompt/SearchQuery/ShellCommand).
//
// Consumer assembly:
//   import { defineCatalog } from '@json-render/core';
//   import { schema } from '@json-render/{solid,react}/schema';
//   import { sharedComponentDefinitions } from '@float/render-catalog/components';
//   defineCatalog(schema, { components: { ...sharedComponentDefinitions, ...domain }, actions: ... });

import { z } from "zod";
import { severityEnum, gapTypeEnum, confidenceEnum, colorTokenEnum } from "./enums";

export const sharedComponentDefinitions = {
  // ─── Layout ──────────────────────────────────────────────────────────────

  Section: {
    props: z.object({
      title: z.string().optional().describe("Section heading; omit for an unlabelled grouping container"),
      variant: z.enum(["default", "highlight", "warning"]).optional().describe("default=gray, highlight=cyan accent, warning=amber accent"),
    }),
    slots: ["default"],
    description: "Titled section container. Use for grouping related content blocks under a heading. Children stack vertically below the title.",
  },

  Divider: {
    props: z.object({}),
    slots: [],
    description: "Horizontal divider line. Use to visually separate sibling sections at the same level of the spec.",
  },

  // ─── Semantic cards ──────────────────────────────────────────────────────

  PatternCard: {
    props: z.object({
      label: z.string().describe("Headline / title for the pattern (one line)"),
      description: z.string().describe("Body content rendered as markdown — prose, evidence, references"),
      confidence: confidenceEnum.optional().describe("Confidence level renders as colored uppercase pill (high=green, medium=amber, low=muted)"),
    }),
    slots: ["default"],
    description: "A card surfacing one discovered pattern, theme, or recurring element. Use when you have one named insight to elevate. Description renders as markdown so [[wikilinks]] and emphasis work.",
  },

  GapItem: {
    props: z.object({
      description: z.string().describe("What's missing or incomplete"),
      severity: severityEnum.optional().describe("How important this gap is — critical=red+⏺, warning=amber+◆, info=cyan+◇"),
      gapType: gapTypeEnum.optional().describe("Classification of the gap — stub/orphan/empty/asymmetric/unanswered"),
      evidence: z.string().optional().describe("Supporting evidence or context for the gap"),
      target: z.string().optional().describe("Target page or issue to link to"),
    }),
    slots: [],
    description: "An identified gap: missing content, orphan link, unanswered question, empty stub. Use for next-action lists, audit findings, asymmetry triage.",
  },

  // ─── Inline / chip ───────────────────────────────────────────────────────

  StatPill: {
    props: z.object({
      label: z.string().describe("Left half of the pill (dark)"),
      value: z.string().describe("Right half of the pill (colored)"),
      color: z.string().optional().describe("Hex or CSS color for the value half (default: theme accent)"),
    }),
    slots: [],
    description: "Inline pill-shaped stat: label half + value half. More compact than a full Metric block. Good for stat rows inside a horizontal Stack.",
  },

  TimelineEvent: {
    props: z.object({
      time: z.string().describe('Time string — typically "HH:MM" or "Mar 9"'),
      label: z.string().describe("Short event description"),
      color: z.string().optional().describe("Color for the spine dot — use to distinguish workstreams (e.g. cyan=float, amber=pharmacy)"),
    }),
    slots: [],
    description: "Single event on a vertical timeline spine. Stack multiple TimelineEvents inside a Section or Stack to render a chronology.",
  },

  WikilinkChip: {
    props: z.object({
      target: z.string().describe("The wikilink target — page name, block hash, or issue ID"),
      label: z.string().optional().describe("Optional display text — defaults to target"),
    }),
    slots: [],
    description: "Clickable [[bracket-wrapped]] link that navigates to an outline page or block. Use inline for cross-references.",
  },

  // ─── Visualizations ──────────────────────────────────────────────────────

  LinkGraph: {
    props: z.object({
      nodes: z.array(z.object({
        id: z.string(),
        label: z.string(),
        color: z.string().optional(),
        weight: z.number().optional(),
        center: z.boolean().optional(),
        ring: z.number().optional(),
        type: z.string().optional(),
      })),
      edges: z.array(z.tuple([z.string(), z.string()])).describe("Pairs of [fromId, toId]"),
      title: z.string().optional(),
    }),
    slots: [],
    description: "SVG radial link graph. One node with center:true at origin, others placed by ring distance (1-3). Edges as [fromId, toId] pairs. Weight affects node size. type:'stub' makes dashed edges and small dots. Good for page topology, dependency graphs, outline neighborhoods.",
  },

  ActivityHeatmap: {
    props: z.object({
      data: z.array(z.object({
        label: z.string(),
        value: z.number(),
      })).describe("Cell list — label is shown on hover, value scales brightness"),
      color: z.string().optional().describe("Base hex color (default: theme accent)"),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Grid of colored squares showing intensity. Each cell label+value, brightness scales with value. Good for session activity over time, block counts by day, commit frequency.",
  },

  ProvenanceChain: {
    props: z.object({
      steps: z.array(z.object({
        source: z.string().describe("Source type — qmd / conversation / bbs / outline / loki / autorag"),
        content: z.string().describe("Quoted content from the source"),
        docId: z.string().optional().describe("Document or block reference"),
        confidence: z.number().min(0).max(1).optional().describe("Confidence score as a 0–1 fraction (NOT 0–100). 0.95 renders as 95%. The schema enforces 0–1, but agent emissions often skip schema validation in permissive Spec catalogs — emit fractions, not percentages, to keep the renderer honest."),
        lines: z.string().optional().describe("Line range citation (e.g. \"42-58\")"),
      })),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Vertical provenance chain showing source trail. Each step has source type with colored dot, content, optional docId and confidence %. Good for showing how information was found, archaeology trails. CONFIDENCE values must be 0–1 fractions — the schema enforces this, and the renderer multiplies by 100 for display. Agents bypassing schema validation should still emit fractions; the renderer auto-detects 0–100 ints as a defensive guard, but that's a safety net, not the contract.",
  },

  RiskMatrix: {
    props: z.object({
      items: z.array(z.object({
        label: z.string(),
        severity: z.enum(["high", "medium", "low"]),
        impact: z.enum(["structural", "content", "cosmetic"]),
      })),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Severity × impact grid. Rows: high/medium/low. Columns: structural/content/cosmetic. Items placed in matching cell. Good for gap analysis, risk assessment, issue triage.",
  },

  TimelineDiff: {
    props: z.object({
      before: z.object({
        date: z.string(),
        items: z.array(z.object({ text: z.string(), removed: z.boolean().optional() })),
      }),
      after: z.object({
        date: z.string(),
        items: z.array(z.object({ text: z.string(), added: z.boolean().optional() })),
      }),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Side-by-side before/after diff. Before items with removed:true get red strikethrough, after items with added:true get green highlight. Good for meeting diffs, process changes, status transitions.",
  },

  // ─── Briefing / narrative atoms (promoted from explorer.ts) ──────────────
  // 21 components moved here as the symmetry contract — both Solid (render-
  // door) and React (outline-explorer) renderers implement these.

  BlockRef: {
    props: z.object({
      title: z.string().describe("Display text for the block reference"),
      blockId: z.string().optional().describe("Block UUID if known"),
      page: z.string().optional().describe("Page title for navigation"),
    }),
    slots: [],
    description:
      "A clickable reference to a block or page in the graph. Renders as a wikilink-style chip.",
  },

  WalkChip: {
    props: z.object({
      page: z.string().describe("Page title to suggest exploring"),
      reason: z.string().optional().describe("Why this page is worth visiting"),
    }),
    slots: [],
    description:
      "A clickable suggestion for the next page to explore. Renders as a compact chip.",
  },

  Prose: {
    props: z.object({
      content: z.string().describe("Markdown-ish text content"),
    }),
    slots: [],
    description:
      "A block of analysis text. Use for narrative explanations between structured components.",
  },

  StepIndicator: {
    props: z.object({
      tool: z.string().describe("Tool name that was called"),
      target: z.string().describe("What was fetched"),
      result: z.string().optional().describe("Brief result summary"),
    }),
    slots: [],
    description:
      "Shows a tool call step: what was fetched and why. Renders as a compact status line.",
  },

  Chip: {
    props: z.object({
      label: z.string().describe("Chip text"),
      color: colorTokenEnum
        .optional()
        .describe("Color token — one of: cyan, magenta, coral, amber, green, purple, dim"),
      icon: z
        .string()
        .optional()
        .describe("Lucide icon name"),
      clickable: z.boolean().optional().describe("Whether chip is clickable"),
    }),
    slots: [],
    description:
      "General-purpose inline pill/tag with optional icon and color.",
  },

  SectionLabel: {
    props: z.object({
      label: z.string().describe("Section label text"),
      color: colorTokenEnum
        .optional()
        .describe("Color token — one of: cyan, magenta, coral, amber, green, purple, dim"),
      icon: z.string().optional().describe("Lucide icon name"),
    }),
    slots: ["default"],
    description:
      "Section header with icon, label, and divider line. Groups related content.",
  },

  ConfidenceDot: {
    props: z.object({
      level: z
        .enum(["high", "medium", "low", "partial"])
        .describe("Confidence level"),
    }),
    slots: [],
    description:
      "Small colored dot with level label indicating confidence.",
  },

  ObservationCard: {
    props: z.object({
      number: z.string().describe("Observation number"),
      title: z.string().describe("Observation heading"),
      body: z.string().describe("Full observation text"),
      severity: z
        .enum(["surprising", "structural", "gap", "thread", "meta"])
        .optional()
        .describe("Observation classification"),
      links: z
        .array(z.string())
        .optional()
        .describe("Related wikilink targets"),
    }),
    slots: [],
    description:
      "Numbered, expandable observation card for bridge walks. Severity determines left border color.",
  },

  PatternCluster: {
    props: z.object({
      name: z.string().describe("Pattern cluster name"),
      color: colorTokenEnum
        .optional()
        .describe("Color token — one of: cyan, magenta, coral, amber, green, purple, dim"),
      instances: z
        .array(z.string())
        .describe("Specific instances of the pattern"),
      connections: z
        .array(z.string())
        .optional()
        .describe("Related clusters or concepts"),
    }),
    slots: [],
    description:
      "Pattern cluster visualization showing instances and connections.",
  },

  EnrichedStepCard: {
    props: z.object({
      tool: z.string().describe("Tool name"),
      target: z.string().describe("What was fetched"),
      reason: z
        .string()
        .optional()
        .describe("Why this tool was called"),
      result: z
        .string()
        .optional()
        .describe("Brief result summary"),
      preview: z
        .string()
        .optional()
        .describe("Expandable preview of fetched content"),
    }),
    slots: [],
    description:
      "Enhanced tool step card with reason and expandable preview. Upgrade from StepIndicator.",
  },

  Heading: {
    props: z.object({
      level: z.number().int().min(1).max(3).describe("Heading level 1-3 (integer)"),
      content: z.string().describe("Heading text"),
    }),
    slots: [],
    description: "Styled heading for AI responses. Level 1 = large cyan, 2 = medium, 3 = small muted.",
  },

  Paragraph: {
    props: z.object({
      content: z.string().describe("Body text — supports **bold** and `code` inline markers"),
    }),
    slots: [],
    description: "Body text paragraph with proper line height and spacing. Parses **bold** and `code` inline.",
  },

  Bold: {
    props: z.object({
      content: z.string().describe("Bold text content"),
    }),
    slots: [],
    description: "Inline bold text span.",
  },

  InlineCode: {
    props: z.object({
      content: z.string().describe("Code text"),
    }),
    slots: [],
    description: "Inline monospace code span with background.",
  },

  BulletList: {
    props: z.object({
      items: z.array(z.string()).describe("List items"),
    }),
    slots: [],
    description: "Bulleted list of items.",
  },

  StatusLine: {
    props: z.object({
      label: z.string().describe("Status label (e.g. URGENT, SHIPPED, HELD)"),
      color: colorTokenEnum
        .optional()
        .describe("Color token for the label — one of: cyan, magenta, coral, amber, green, purple, dim"),
      content: z.string().describe("Status body text"),
    }),
    slots: [],
    description:
      "Colored ▸ LABEL: prefix followed by body text. Use for cold-start briefing status lines.",
  },

  Row: {
    props: z.object({}),
    slots: ["default"],
    description:
      "Horizontal flex row — wraps chip children with gap. Use for metadata chip rows and link rows.",
  },

  Timeline: {
    props: z.object({}),
    slots: ["default"],
    description:
      "Vertical container for TimelineEvent children. Use to group ordered ctx:: events, session arcs, or milestone sequences.",
  },

  HeadingBlock: {
    props: z.object({
      level: z.enum(["h1", "h2", "h3"]).describe("Heading depth"),
      content: z.string().describe("Heading text"),
    }),
    slots: ["default"],
    description: "Page/section heading block",
  },

  ContextMarker: {
    props: z.object({
      content: z.string().describe("Full ctx:: line content"),
      timestamp: z.string().optional().describe("Parsed timestamp"),
      project: z.string().optional().describe("Project marker value"),
      mode: z.string().optional().describe("Mode marker value"),
    }),
    slots: [],
    description:
      "ctx:: timestamped event marker with project/mode badges",
  },

  OutlinerBlock: {
    props: z.object({
      content: z.string().describe("Block text content"),
      blockType: z.string().describe("Original block type string"),
      depth: z.number().optional().describe("Nesting depth"),
      blockId: z.string().optional().describe("Block UUID"),
    }),
    slots: ["default"],
    description:
      "Generic outliner block — fallback for unrecognized types",
  },
};
