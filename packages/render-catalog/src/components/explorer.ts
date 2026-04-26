// Set C — 24 explorer-only components. Moved from outline-explorer's inline
// catalog per FLO-657 Step 5. These are the briefing-genre / outline-tree
// vocabulary specific to the React MCP renderer. No semantic-overlap with
// door; pure mechanical move.

import { z } from "zod";

export const explorerComponentDefinitions = {
  BlockRef: {
    props: z.object({
      title: z.string().describe("Display text for the block reference"),
      blockId: z.string().optional().describe("Block UUID if known"),
      page: z.string().optional().describe("Page title for navigation"),
    }),
    description:
      "A clickable reference to a block or page in the graph. Renders as a wikilink-style chip.",
  },

  WalkChip: {
    props: z.object({
      page: z.string().describe("Page title to suggest exploring"),
      reason: z.string().optional().describe("Why this page is worth visiting"),
    }),
    description:
      "A clickable suggestion for the next page to explore. Renders as a compact chip.",
  },

  Prose: {
    props: z.object({
      content: z.string().describe("Markdown-ish text content"),
    }),
    description:
      "A block of analysis text. Use for narrative explanations between structured components.",
  },

  StepIndicator: {
    props: z.object({
      tool: z.string().describe("Tool name that was called"),
      target: z.string().describe("What was fetched"),
      result: z.string().optional().describe("Brief result summary"),
    }),
    description:
      "Shows a tool call step: what was fetched and why. Renders as a compact status line.",
  },

  // ── AI response components (mockup-derived) ─────────────────────────

  Chip: {
    props: z.object({
      label: z.string().describe("Chip text"),
      color: z
        .string()
        .optional()
        .describe("Color token name: cyan, magenta, coral, amber, green, purple, dim"),
      icon: z
        .string()
        .optional()
        .describe("Lucide icon name"),
      clickable: z.boolean().optional().describe("Whether chip is clickable"),
    }),
    description:
      "General-purpose inline pill/tag with optional icon and color.",
  },

  SectionLabel: {
    props: z.object({
      label: z.string().describe("Section label text"),
      color: z
        .string()
        .optional()
        .describe("Color token name"),
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
    description:
      "Numbered, expandable observation card for bridge walks. Severity determines left border color.",
  },

  PatternCluster: {
    props: z.object({
      name: z.string().describe("Pattern cluster name"),
      color: z
        .string()
        .optional()
        .describe("Color token name"),
      instances: z
        .array(z.string())
        .describe("Specific instances of the pattern"),
      connections: z
        .array(z.string())
        .optional()
        .describe("Related clusters or concepts"),
    }),
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
    description:
      "Enhanced tool step card with reason and expandable preview. Upgrade from StepIndicator.",
  },

  // ── Typography primitives ────────────────────────────────────────

  Heading: {
    props: z.object({
      level: z.number().min(1).max(3).describe("Heading level 1-3"),
      content: z.string().describe("Heading text"),
    }),
    description: "Styled heading for AI responses. Level 1 = large cyan, 2 = medium, 3 = small muted.",
  },

  Paragraph: {
    props: z.object({
      content: z.string().describe("Body text — supports **bold** and `code` inline markers"),
    }),
    description: "Body text paragraph with proper line height and spacing. Parses **bold** and `code` inline.",
  },

  Bold: {
    props: z.object({
      content: z.string().describe("Bold text content"),
    }),
    description: "Inline bold text span.",
  },

  InlineCode: {
    props: z.object({
      content: z.string().describe("Code text"),
    }),
    description: "Inline monospace code span with background.",
  },

  BulletList: {
    props: z.object({
      items: z.array(z.string()).describe("List items"),
    }),
    description: "Bulleted list of items.",
  },

  StatusLine: {
    props: z.object({
      label: z.string().describe("Status label (e.g. URGENT, SHIPPED, HELD)"),
      color: z
        .string()
        .optional()
        .describe("Color token for the label: coral, green, purple, amber, cyan"),
      content: z.string().describe("Status body text"),
    }),
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

  // ── Block primitives (outline tree rendering) ──────────────────────

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
    description:
      "ctx:: timestamped event marker with project/mode badges",
  },

  ShellCommand: {
    props: z.object({
      command: z.string().describe("Shell command text"),
      hasOutput: z
        .boolean()
        .optional()
        .describe("Whether this block has output children"),
    }),
    slots: ["default"],
    description: "sh:: executable shell command block",
  },

  RenderPrompt: {
    props: z.object({
      prompt: z.string().describe("Render prompt text"),
      hasOutput: z
        .boolean()
        .optional()
        .describe("Whether render output exists"),
    }),
    description:
      "render:: trigger for render agent — content is a prompt",
  },

  SearchQuery: {
    props: z.object({
      query: z.string().describe("Search or pick query text"),
      resultCount: z
        .number()
        .optional()
        .describe("Number of results found"),
    }),
    description: "search:: or pick:: executable query block",
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
