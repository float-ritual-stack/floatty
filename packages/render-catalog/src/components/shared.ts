// Set A — 12 shared components consumed by both render-door (SolidJS) and
// outline-explorer (React). Per FLO-657 + Option A canonicalization decisions
// in .float/work/floatty-catalog-extraction/PLAN.md.
//
// Consumer assembly:
//   import { defineCatalog } from '@json-render/core';
//   import { schema } from '@json-render/{solid,react}/schema';
//   import { sharedComponentDefinitions } from '@float/render-catalog/components';
//   defineCatalog(schema, { components: { ...sharedComponentDefinitions, ...domain }, actions: ... });

import { z } from "zod";
import { severityEnum, gapTypeEnum, confidenceEnum } from "./enums";

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
        confidence: z.number().min(0).max(1).optional().describe("Confidence score 0–1"),
        lines: z.string().optional().describe("Line range citation (e.g. \"42-58\")"),
      })),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Vertical provenance chain showing source trail. Each step has source type with colored dot, content, optional docId and confidence %. Good for showing how information was found, archaeology trails.",
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
};
