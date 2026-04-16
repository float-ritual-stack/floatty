import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

export const explorerCatalog = defineCatalog(schema, {
  components: {
    Section: {
      props: z.object({
        title: z.string().describe("Section heading"),
        variant: z
          .enum(["default", "highlight", "warning"])
          .optional()
          .describe("Visual style"),
      }),
      slots: ["default"],
      description:
        "A collapsible analysis section with a heading. Use for major findings.",
    },

    PatternCard: {
      props: z.object({
        label: z.string().describe("Pattern name"),
        description: z.string().describe("What this pattern means"),
        confidence: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("How confident you are"),
      }),
      description:
        "A card showing a discovered pattern, theme, or recurring element.",
    },

    BlockRef: {
      props: z.object({
        title: z.string().describe("Display text for the block reference"),
        blockId: z.string().optional().describe("Block UUID if known"),
        page: z.string().optional().describe("Page title for navigation"),
      }),
      description:
        "A clickable reference to a block or page in the graph. Renders as a wikilink-style chip.",
    },

    GapItem: {
      props: z.object({
        description: z.string().describe("What's missing or incomplete"),
        severity: z
          .enum(["info", "warning", "critical"])
          .optional()
          .describe("How important this gap is"),
        gapType: z
          .enum(["stub", "orphan", "empty", "asymmetric", "unanswered"])
          .optional()
          .describe("Classification of the gap"),
        evidence: z
          .string()
          .optional()
          .describe("Supporting evidence or context for the gap"),
        target: z
          .string()
          .optional()
          .describe("Target page or issue to link to"),
      }),
      description:
        "An identified gap: missing content, orphan link, unanswered question, empty stub.",
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

    StatPill: {
      props: z.object({
        label: z.string().describe("Stat label (e.g. 'blocks')"),
        value: z.string().describe("Stat value (e.g. '539')"),
        color: z
          .string()
          .optional()
          .describe("Color token name"),
      }),
      description:
        "Numeric stat counter with label. Use in summary responses.",
    },

    TimelineEvent: {
      props: z.object({
        time: z.string().describe("Timestamp label (e.g. '10:33')"),
        label: z.string().describe("Event description"),
        color: z
          .string()
          .optional()
          .describe("Color token name for the dot"),
      }),
      description:
        "Timeline dot + timestamp + label for session arc visualization.",
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

    Divider: {
      props: z.object({}),
      description: "Horizontal rule / visual separator.",
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

    // ── Rich visualizations (interactive data views) ─────────────────

    LinkGraph: {
      props: z.object({
        nodes: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              color: z.string().optional().describe("Color token name"),
              weight: z.number().optional().describe("Node importance/size"),
              center: z.boolean().optional().describe("Is this the focal node"),
              ring: z.number().optional().describe("Distance ring from center (1-3)"),
              type: z.string().optional().describe("'stub' for missing pages"),
            })
          )
          .describe("Graph nodes"),
        edges: z
          .array(z.array(z.string()).min(2).max(2))
          .describe("Edges as [fromId, toId] pairs"),
      }),
      description:
        "SVG radial link graph with hover interactions. Visualizes page neighborhoods and wikilink connections.",
    },

    ActivityHeatmap: {
      props: z.object({
        data: z
          .array(
            z.object({
              label: z.string().describe("Date or time label"),
              value: z.number().describe("Activity count"),
            })
          )
          .describe("Activity data points"),
        color: z
          .string()
          .optional()
          .describe("Color token for intensity gradient"),
      }),
      description:
        "Block activity heatmap grid. Brighter cells = more activity.",
    },

    ProvenanceChain: {
      props: z.object({
        steps: z
          .array(
            z.object({
              source: z
                .string()
                .describe("Source type: qmd, conversation, bbs, outline, loki, autorag"),
              content: z.string().describe("What was found"),
              docId: z.string().optional().describe("Source document ID"),
              confidence: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe("Confidence score 0-1"),
              lines: z
                .string()
                .optional()
                .describe("Line range in source document"),
            })
          )
          .describe("Provenance chain steps from most to least relevant"),
      }),
      description:
        "Vertical provenance chain showing where a claim came from. Each step is a source with confidence.",
    },

    RiskMatrix: {
      props: z.object({
        items: z
          .array(
            z.object({
              label: z.string().describe("Risk item description"),
              severity: z
                .enum(["high", "medium", "low"])
                .describe("Severity level (rows)"),
              impact: z
                .enum(["structural", "content", "cosmetic"])
                .describe("Impact type (columns)"),
            })
          )
          .describe("Items to place in the matrix"),
      }),
      description:
        "Severity × Impact risk matrix grid. Items placed by AI assessment. Use for gap audits.",
    },

    TimelineDiff: {
      props: z.object({
        before: z.object({
          date: z.string().describe("Before state label"),
          items: z
            .array(
              z.object({
                text: z.string(),
                removed: z.boolean().optional().describe("Was this removed"),
              })
            )
            .describe("Before state items"),
        }),
        after: z.object({
          date: z.string().describe("After state label"),
          items: z
            .array(
              z.object({
                text: z.string(),
                added: z.boolean().optional().describe("Was this added"),
              })
            )
            .describe("After state items"),
        }),
      }),
      description:
        "Side-by-side before/after comparison. Highlights added and removed items.",
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

    WikilinkChip: {
      props: z.object({
        target: z.string().describe("Wikilink target page name"),
      }),
      description:
        "Inline [[wikilink]] — clickable reference to another page",
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
  },
  actions: {
    setState: {
      params: z.object({
        statePath: z.string(),
        value: z.any(),
      }),
      description: "Update a value in the state model",
    },
    pushState: {
      params: z.object({
        statePath: z.string(),
        value: z.any(),
        clearStatePath: z.string().optional(),
      }),
      description: "Append an item to an array in state",
    },
    removeState: {
      params: z.object({
        statePath: z.string(),
        index: z.number(),
      }),
      description: "Remove an item from an array by index",
    },
  },
});
