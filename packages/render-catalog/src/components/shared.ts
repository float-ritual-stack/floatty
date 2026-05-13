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
import { severityEnum, gapTypeEnum, confidenceEnum, colorTokenEnum, accentEnum, entryTypeEnum } from "./enums";
import { directiveOr } from "../directives";

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
      target: directiveOr(z.string()).optional().describe("Target page or issue to link to"),
    }),
    slots: [],
    description: "An identified gap: missing content, orphan link, unanswered question, empty stub. Use for next-action lists, audit findings, asymmetry triage.",
  },

  // ─── Inline / chip ───────────────────────────────────────────────────────

  StatPill: {
    props: z.object({
      label: z.string().describe("Left half of the pill (dark)"),
      value: z.string().describe("Right half of the pill (colored)"),
      color: directiveOr(z.string()).optional().describe("Hex or CSS color for the value half (default: theme accent)"),
    }),
    slots: [],
    description: "Inline pill-shaped stat: label half + value half. More compact than a full Metric block. Good for stat rows inside a horizontal Stack.",
  },

  TimelineEvent: {
    props: z.object({
      time: z.string().describe('Time string — typically "HH:MM" or "Mar 9"'),
      label: z.string().describe("Short event description"),
      color: directiveOr(z.string()).optional().describe("Color for the spine dot — use to distinguish workstreams (e.g. cyan=float, amber=pharmacy)"),
    }),
    slots: [],
    description: "Single event on a vertical timeline spine. Stack multiple TimelineEvents inside a Section or Stack to render a chronology.",
  },

  WikilinkChip: {
    props: z.object({
      target: directiveOr(z.string()).describe("The wikilink target — page name, block hash, or issue ID"),
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
        color: directiveOr(z.string()).optional(),
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
      color: directiveOr(z.string()).optional().describe("Base hex color (default: theme accent)"),
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

  // ─── Door-promoted vocabulary (PR B — 48 components) ────────────────────
  // Promoted from door.ts as part of the parity ship. Both Solid (render-door
  // components.tsx) and React (outline-explorer renderers/) implement these.

  // ── Layout / Container ──────────────────────────────────────────────────

  DocLayout: {
    props: z.object({}),
    slots: ["sidebar", "main"],
    description: "Two-column layout: fixed sidebar + scrollable main content area",
  },

  Stack: {
    props: z.object({
      gap: z.number().optional(),
      direction: z.enum(["vertical", "horizontal"]).optional(),
      sectionId: z.string().optional(),
      width: z.string().optional(),
      minWidth: z.string().optional(),
      flex: z.string().optional(),
      maxWidth: z.string().optional(),
      overflow: z.string().optional(),
      borderRight: z.string().optional(),
      padding: z.string().optional(),
    }),
    slots: ["default"],
    description: "Layout container, stacks children vertically or horizontally. Supports width/flex for column layouts.",
  },

  Hero: {
    props: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      eyebrow: z.string().optional(),
      cover: z.object({
        gradient: z.string().optional(),
        color: directiveOr(z.string()).optional(),
        icon: z.string().optional(),
      }).optional(),
      density: z.enum(["full", "compact"]).optional(),
      actions: z.array(z.object({
        label: z.string(),
        href: directiveOr(z.string()).optional(),
        variant: z.enum(["primary", "secondary"]).optional(),
      })).optional(),
    }),
    slots: [],
    description: "Page-top visual statement. Eyebrow (small uppercase tag) + Title (large serif) + Subtitle + optional cover (gradient/color background + decorative icon) + optional actions row (primary/secondary buttons). Density 'full' (default, big block) or 'compact' (slimmer for sub-sections). Use for hub-page intros, project landings, dispatch covers, weekly zine headers — anywhere you want to set tone visually rather than just label content.",
  },

  GalleryGrid: {
    props: z.object({
      columns: z.union([z.number(), z.literal("auto")]).optional(),
      gap: z.number().optional(),
      minCardWidth: z.string().optional(),
    }),
    slots: ["default"],
    description: "Responsive grid of children, typically CardCovers. columns:'auto' (default) uses CSS auto-fit with minCardWidth (default 260px) so columns collapse on narrow viewports; columns:N forces exact column count. gap in pixels (default 14). Use for galleries of CardCovers, dispatch tiles, doc browsers, recent-work boards.",
  },

  CardCover: {
    props: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      eyebrow: z.string().optional(),
      cover: z.object({
        color: directiveOr(z.string()).optional(),
        gradient: z.string().optional(),
        icon: z.string().optional(),
        height: z.string().optional(),
      }).optional(),
      properties: z.array(z.object({
        label: z.string(),
        value: z.string(),
        color: directiveOr(z.string()).optional(),
      })).optional(),
      footer: z.string().optional(),
      href: directiveOr(z.string()).optional(),
      density: z.enum(["comfortable", "compact"]).optional(),
    }),
    slots: ["default"],
    description: "Notion-style rich card. Optional cover area at top (gradient/color/icon), eyebrow (small uppercase tag) + title + subtitle, optional properties row (key:value pills with optional color), optional footer (dashed-rule separated meta line), optional href (whole-card click target). Children render in body slot below subtitle. density:'comfortable' (default) gives header room to breathe; density:'compact' tightens header (smaller eyebrow/title/padding) for more body room. Pairs with GalleryGrid for collection views.",
  },

  Card: {
    props: z.object({
      title: z.string().optional(),
      subtitle: z.string().optional(),
    }),
    slots: ["default"],
    description: "A card container with optional title",
  },

  // ── Navigation / References ────────────────────────────────────────────

  NavBrand: {
    props: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
    }),
    slots: [],
    description: "Sidebar header with title and optional subtitle",
  },

  NavSection: {
    props: z.object({
      label: z.string(),
      accent: accentEnum.optional(),
    }),
    slots: ["default"],
    description: "Sidebar section header (e.g. SYNTHESIS, ARCHAEOLOGY)",
  },

  NavItem: {
    props: z.object({
      id: z.string(),
      label: z.string(),
      active: z.boolean().optional(),
    }),
    slots: [],
    description: "Sidebar navigation item with dot indicator",
  },

  NavFooter: {
    props: z.object({
      content: z.string(),
    }),
    slots: [],
    description: "Sidebar footer with metadata (dates, counts)",
  },

  TagBar: {
    props: z.object({
      gap: z.number().optional(),
    }),
    slots: ["default"],
    description: "Horizontal flex container for tag chips",
  },

  TagChip: {
    props: z.object({
      name: z.string(),
      active: z.boolean().optional(),
    }),
    slots: [],
    description: "Clickable tag chip with active state",
  },

  RefSection: {
    props: z.object({
      label: z.string().optional(),
    }),
    slots: ["default"],
    description: "Connected references section with header",
  },

  RefCard: {
    props: z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
    }),
    slots: [],
    description: "Clickable reference card linking to another entry",
  },

  Breadcrumb: {
    props: z.object({
      label: z.string(),
    }),
    slots: [],
    description: "Back navigation breadcrumb (← label)",
  },

  // ── Entry Display ───────────────────────────────────────────────────────

  EntryHeader: {
    props: z.object({
      type: entryTypeEnum,
      board: z.string().optional(),
      title: z.string(),
      date: z.string(),
      author: z.string().optional(),
    }),
    slots: [],
    description: "Entry header: type badge, title (serif), date/author",
  },

  EntryBody: {
    props: z.object({
      markdown: z.string(),
    }),
    slots: [],
    description: "Renders markdown content with session-garden styling (serif body, mono code)",
  },

  Ellipsis: {
    props: z.object({}),
    slots: [],
    description: "Centered · · · separator indicating truncated content",
  },

  // ── Form / Input ────────────────────────────────────────────────────────

  Button: {
    props: z.object({
      label: z.string(),
      variant: z.enum(["primary", "secondary", "danger"]).optional(),
    }),
    slots: [],
    description: "Clickable button that emits press event",
  },

  TextInput: {
    props: z.object({
      label: z.string().optional(),
      placeholder: z.string().optional(),
      value: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    }),
    slots: [],
    description: "Single-line text input with optional label. Use $bindState for two-way state binding.",
  },

  TextArea: {
    props: z.object({
      label: z.string().optional(),
      placeholder: z.string().optional(),
      rows: z.number().optional(),
      value: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    }),
    slots: [],
    description: "Multi-line text area with optional label. Use $bindState for two-way state binding.",
  },

  CollapsibleSection: {
    props: z.object({
      title: z.string(),
      expanded: z.boolean().optional(),
      color: directiveOr(z.string()).optional(),
      count: z.number().optional(),
    }),
    slots: ["default"],
    description: "Collapsible section with colored title bar and item count. Click header to toggle. Good for grouping entries, day sections, category lists.",
  },

  FilterButtons: {
    props: z.object({
      filters: z.array(z.object({
        id: z.string(),
        label: z.string(),
        count: z.number().optional(),
      })),
      active: z.union([z.string(), z.record(z.string(), z.unknown())]),
    }),
    slots: [],
    description: "Horizontal row of filter buttons. Active button is highlighted. Use $bindState on active to sync with spec state for visibility switching.",
  },

  TabNav: {
    props: z.object({
      tabs: z.array(z.object({
        id: z.string(),
        label: z.string(),
      })),
      active: z.union([z.string(), z.record(z.string(), z.unknown())]),
      variant: z.enum(["horizontal", "pills"]).optional(),
    }),
    slots: [],
    description: 'Horizontal tab bar. "horizontal" uses underline, "pills" uses pill background. Use $bindState on active to sync with spec state for view switching.',
  },

  // ── Content / Domain Cards ─────────────────────────────────────────────

  Callout: {
    props: z.object({
      type: z.enum([
        "note", "info", "tip", "success", "warning",
        "danger", "failure", "bug", "example", "question",
        "quote", "abstract", "todo",
      ]).optional(),
      title: z.string().optional(),
      collapsible: z.boolean().optional(),
      defaultExpanded: z.boolean().optional(),
    }),
    slots: ["default"],
    description: "Obsidian-style typed callout. Per-type icon + accent color (note/info=cyan, tip/success=green, warning/todo=amber, danger/failure/bug=coral, example=magenta, question=cyan, quote=dim, abstract=cyan). Optionally collapsible (set collapsible:true; defaultExpanded:false to start collapsed). Slots default — children can include other Callouts (nestable).",
  },

  QuoteBlock: {
    props: z.object({
      text: z.string(),
      attribution: z.string().optional(),
      type: z.enum(["quote", "insight", "note"]).optional(),
    }),
    slots: [],
    description: "Styled quote block with left border accent and optional attribution line. quote=gray, insight=cyan, note=amber.",
  },

  ShippedItem: {
    props: z.object({
      content: z.string(),
    }),
    slots: [],
    description: "Green asterisk bullet item for shipped/completed work",
  },

  BacklinksFooter: {
    props: z.object({
      inbound: z.array(z.string()),
      outbound: z.array(z.string()),
    }),
    slots: [],
    description: 'Bidirectional link footer: "referenced by" inbound + "links to" outbound',
  },

  MetadataHeader: {
    props: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      date: z.string().optional(),
      stats: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
    }),
    slots: [],
    description: "Document header with title, optional subtitle, date, and inline stats row.",
  },

  ModeTag: {
    props: z.object({
      mode: z.enum(["work", "float", "life", "pebble", "rent", "spike"]),
      count: z.number().optional(),
      size: z.enum(["sm", "md"]).optional(),
    }),
    slots: [],
    description: "Colored mode badge. work=cyan, float=magenta, life=green, pebble=amber, rent=coral, spike=coral.",
  },

  TimeEntry: {
    props: z.object({
      time: z.string(),
      title: z.string(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      color: directiveOr(z.string()).optional(),
    }),
    slots: [],
    description: "Timeline entry row: time dot on left spine, title + optional body + tags on right. Good for timelogs, session entries, daily notes.",
  },

  Metric: {
    props: z.object({
      label: z.string(),
      value: z.string(),
    }),
    slots: [],
    description: "A labeled metric value",
  },

  // ── TUI primitives ──────────────────────────────────────────────────────

  TuiPanel: {
    props: z.object({
      title: z.string().optional(),
      titleColor: z.string().optional(),
    }),
    slots: ["default"],
    description: "Bordered container with title floating on top border edge",
  },

  TuiStat: {
    props: z.object({
      label: z.string(),
      value: z.string(),
      color: directiveOr(z.string()).optional(),
    }),
    slots: [],
    description: "Centered metric card: label above, bold value below",
  },

  Code: {
    props: z.object({
      content: z.string(),
      language: z.string().optional(),
    }),
    slots: [],
    description: "Code block display",
  },

  DataBlock: {
    props: z.object({
      label: z.string().optional(),
      content: z.string(),
    }),
    slots: [],
    description: "Monospace pre block with optional floating label",
  },

  // ── Visualizations ──────────────────────────────────────────────────────

  BarChart: {
    props: z.object({
      title: z.string().optional(),
      maxHeight: z.number().optional(),
      max: z.number().optional(),
    }),
    slots: ["default"],
    description: "Normalized vertical bar chart. Children are BarItem components. Auto-scales from children values. IMPORTANT: only compare similar-magnitude values — if one value is 10x the rest, the small bars become invisible. For skewed data, exclude outliers or use StatsBar instead.",
  },

  BarItem: {
    props: z.object({
      label: z.string(),
      value: z.number(),
      max: z.number().optional(),
      color: directiveOr(z.string()).optional(),
    }),
    slots: [],
    description: "Single bar in a BarChart. Height = value/max * 100%. Inherits max from parent BarChart if not set on individual item.",
  },

  Image: {
    props: z.object({
      src: z.string(),
      alt: z.string().optional(),
      maxWidth: z.number().optional(),
      maxHeight: z.number().optional(),
      borderRadius: z.number().optional(),
      caption: z.string().optional(),
    }),
    slots: [],
    description: "Image display. src = filename for attachments or full URL. Omit maxWidth for full-width.",
  },

  ArcTimeline: {
    props: z.object({
      entries: z.array(z.object({
        time: z.string(),
        label: z.string(),
        project: z.string(),
      })),
      arcs: z.array(z.object({
        name: z.string(),
        start: z.string(),
        end: z.string(),
        project: z.string(),
      })),
      title: z.string().optional(),
    }),
    slots: [],
    description: 'Collapsible arc timeline for timelogs. Groups entries into arcs (work sessions) with colored left borders. Click arc to expand entry list. Shows DONE milestones, duration, entry count. Entries have time + dot + label. Orphan entries shown separately. Project colors: floatty=cyan, float-hub=green, rangle=amber, json-render=magenta. Times as "HH:MM" (24h). Good for daily note timelogs.',
  },

  KanbanCard: {
    props: z.object({
      content: z.string().optional(),
      color: directiveOr(z.string()).optional(),
      blockId: z.string().optional(),
      parentId: z.string().nullable().optional(),
      index: z.number().optional(),
    }),
    slots: [],
    description: "FLO-587 — draggable card used inside KanbanColumn. Binds to /cards/<blockId>/content for two-way sync. On drop, emits a move-block chirp the host routes to useBlockStore.moveBlock.",
  },

  KanbanColumn: {
    props: z.object({
      title: z.string().optional(),
      titleColor: z.string().optional(),
      blockId: z.string().optional(),
      childCount: z.number().optional(),
    }),
    slots: ["default"],
    description: "FLO-587 — drop-target column that wraps a stack of KanbanCards. Accepts drops to append to the end (e.g. empty column or drop below last card).",
  },

  TreeView: {
    props: z.object({
      title: z.string().optional(),
      nodes: z.array(z.object({
        id: z.string(),
        label: z.string(),
        status: z.enum(["done", "active", "pending", "deferred"]).optional(),
        detail: z.string().optional(),
        children: z.array(z.object({
          id: z.string(),
          label: z.string(),
          status: z.enum(["done", "active", "pending", "deferred"]).optional(),
          detail: z.string().optional(),
          children: z.array(z.object({
            id: z.string(),
            label: z.string(),
            status: z.enum(["done", "active", "pending", "deferred"]).optional(),
            detail: z.string().optional(),
          })).optional(),
        })).optional(),
      })),
      defaultExpanded: z.boolean().optional(),
      connectsTo: z.array(z.string()).optional(),
    }),
    slots: [],
    description: "Hierarchical tree with expand/collapse, status-colored nodes, and optional detail text. Up to 3 levels deep. Status colors: done=green, active=cyan, pending=dimmed, deferred=amber. Nodes with children are collapsible.",
  },

  StatsBar: {
    props: z.object({
      stats: z.array(z.object({
        label: z.string(),
        value: z.string(),
        color: directiveOr(z.string()).optional(),
      })),
      layout: z.enum(["row", "grid"]).optional(),
    }),
    slots: [],
    description: "Horizontal row (or grid) of labeled stat values with optional per-stat colors. Good for dashboards, summaries.",
  },

  // ── Domain / Workflow viz ──────────────────────────────────────────────

  MeetingDiff: {
    props: z.object({
      title: z.string(),
      meeting: z.string(),
      before: z.array(z.object({ step: z.string(), status: z.enum(["unchanged", "removed", "added"]) })),
      after: z.array(z.object({ step: z.string(), status: z.enum(["unchanged", "removed", "added"]) })),
      newDecisions: z.array(z.string()).optional(),
      actions: z.array(z.object({ who: z.string(), what: z.string(), status: z.string(), blocker: z.string().optional() })).optional(),
    }),
    slots: [],
    description: "Before/after grid showing process changes from a meeting. Steps colored by status (red=removed, green=added, gray=unchanged). Includes new decisions list and action items with assignee/status/blocker.",
  },

  DecisionLog: {
    props: z.object({
      decisions: z.array(z.object({
        date: z.string(),
        meeting: z.string(),
        text: z.string().describe("The decision itself — what was chosen, the resolution"),
        topic: z.string().optional().describe("Optional: what was being decided (the question, the choice-frame). Renders as serif-italic kicker above the decision text."),
        status: z.string(),
        source: z.string().optional(),
        project: z.string().optional(),
      })),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Filterable list of project decisions with date, meeting source, and status (active/superseded). Filter tabs at top. Active decisions have cyan border, superseded are dimmed with strikethrough.",
  },

  DependencyChain: {
    props: z.object({
      nodes: z.array(z.object({ id: z.string(), title: z.string(), assignee: z.string(), status: z.string(), deps: z.array(z.string()) })),
      blocker: z.string().optional(),
    }),
    slots: [],
    description: "Horizontal linked-card chain showing issue dependencies. Cards connected by → arrows with id/title/assignee/status. Colors: todo=cyan, blocked=amber, done=green. Optional blocker callout below.",
  },

  ContextStream: {
    props: z.object({
      captures: z.array(z.object({ time: z.string(), project: z.string(), mode: z.string(), text: z.string() })),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Filterable timeline of ctx:: captures with project color coding, mode badges, and context-switch markers. Click to expand entries. Project filter chips at top.",
  },
};
