/**
 * BBS Document Viewer catalog for @json-render/solid
 *
 * Extends the base render:: catalog with components for browsing
 * collections of entries — synthesis threads, archaeological records,
 * BBS board posts. Designed for session garden, board viewers, and
 * any door that renders a navigable collection of documents.
 *
 * Components follow the sunday-session-garden aesthetic:
 * dark theme, monospace nav, serif body, magenta/cyan/coral accents.
 */

import { z } from 'zod';
import { schema } from '@json-render/solid/schema';

// ═══════════════════════════════════════════════════════════════
// SHARED ENUMS
// ═══════════════════════════════════════════════════════════════

const entryTypeEnum = z.enum(['synthesis', 'archaeology', 'bbs-source']);
const accentEnum = z.enum(['magenta', 'cyan', 'coral', 'amber', 'muted']);

// ═══════════════════════════════════════════════════════════════
// CATALOG
// ═══════════════════════════════════════════════════════════════

export const bbsCatalog = schema.createCatalog({
  components: {
    // ─── Layout ───────────────────────────────────────────
    DocLayout: {
      props: z.object({
        sidebarWidth: z.number().optional(),
      }),
      slots: ['sidebar', 'main'],
      description: 'Two-column layout: fixed sidebar + scrollable main content area',
    },

    // ─── Sidebar ──────────────────────────────────────────
    NavBrand: {
      props: z.object({
        title: z.string(),
        subtitle: z.string().optional(),
      }),
      slots: [],
      description: 'Sidebar header with title and optional subtitle',
    },

    NavSection: {
      props: z.object({
        label: z.string(),
        accent: accentEnum.optional(),
      }),
      slots: ['default'],
      description: 'Sidebar section header (e.g. SYNTHESIS, ARCHAEOLOGY)',
    },

    NavItem: {
      props: z.object({
        id: z.string(),
        label: z.string(),
        active: z.boolean().optional(),
      }),
      slots: [],
      description: 'Sidebar navigation item with dot indicator',
    },

    NavFooter: {
      props: z.object({
        content: z.string(),
      }),
      slots: [],
      description: 'Sidebar footer with metadata (dates, counts)',
    },

    // ─── Entry Display ────────────────────────────────────
    EntryHeader: {
      props: z.object({
        type: entryTypeEnum,
        board: z.string().optional(),
        title: z.string(),
        date: z.string(),
        author: z.string().optional(),
      }),
      slots: [],
      description: 'Entry header: type badge, title (serif), date/author',
    },

    EntryBody: {
      props: z.object({
        markdown: z.string(),
      }),
      slots: [],
      description: 'Renders markdown content with session-garden styling (serif body, mono code)',
    },

    Ellipsis: {
      props: z.object({}),
      slots: [],
      description: 'Centered · · · separator indicating truncated content',
    },

    // ─── Tags ─────────────────────────────────────────────
    TagBar: {
      props: z.object({
        gap: z.number().optional(),
      }),
      slots: ['default'],
      description: 'Horizontal flex container for tag chips',
    },

    TagChip: {
      props: z.object({
        name: z.string(),
        active: z.boolean().optional(),
      }),
      slots: [],
      description: 'Clickable tag chip with active state',
    },

    // ─── References ───────────────────────────────────────
    RefSection: {
      props: z.object({
        label: z.string().optional(),
      }),
      slots: ['default'],
      description: 'Connected references section with header',
    },

    RefCard: {
      props: z.object({
        id: z.string(),
        type: z.string(),
        title: z.string(),
      }),
      slots: [],
      description: 'Clickable reference card linking to another entry',
    },

    // ─── Navigation ───────────────────────────────────────
    Breadcrumb: {
      props: z.object({
        label: z.string(),
      }),
      slots: [],
      description: 'Back navigation breadcrumb (← label)',
    },

    // ─── Base (re-exported from render:: catalog) ─────────
    Stack: {
      props: z.object({
        gap: z.number().optional(),
        direction: z.enum(['vertical', 'horizontal']).optional(),
        sectionId: z.string().optional(),
        width: z.string().optional(),
        minWidth: z.string().optional(),
        flex: z.string().optional(),
        maxWidth: z.string().optional(),
        overflow: z.string().optional(),
        borderRight: z.string().optional(),
        padding: z.string().optional(),
      }),
      slots: ['default'],
      description: 'Layout container, stacks children vertically or horizontally. Supports width/flex for column layouts.',
    },

    Text: {
      props: z.object({
        content: z.string(),
        size: z.enum(['sm', 'md', 'lg', 'xl']).optional(),
        weight: z.enum(['normal', 'medium', 'bold']).optional(),
        color: z.string().optional(),
        mono: z.boolean().optional(),
      }),
      slots: [],
      description: 'Text display',
    },

    Divider: {
      props: z.object({}),
      slots: [],
      description: 'Horizontal divider line',
    },

    // ─── TUI Components ─────────────────────────────────────
    TuiPanel: {
      props: z.object({
        title: z.string().optional(),
        titleColor: z.string().optional(),
      }),
      slots: ['default'],
      description: 'Bordered container with title floating on top border edge',
    },

    TuiStat: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        color: z.string().optional(),
      }),
      slots: [],
      description: 'Centered metric card: label above, bold value below',
    },

    BarChart: {
      props: z.object({
        title: z.string().optional(),
        maxHeight: z.number().optional(),
      }),
      slots: ['default'],
      description: 'Normalized vertical bar chart. Children are BarItem components.',
    },

    BarItem: {
      props: z.object({
        label: z.string(),
        value: z.number(),
        max: z.number().optional(),
        color: z.string().optional(),
      }),
      slots: [],
      description: 'Single bar in a BarChart. Height scaled to max value.',
    },

    // ─── Content Blocks ─────────────────────────────────────
    DataBlock: {
      props: z.object({
        label: z.string().optional(),
        content: z.string(),
      }),
      slots: [],
      description: 'Monospace pre block with optional floating label',
    },

    ShippedItem: {
      props: z.object({
        content: z.string(),
      }),
      slots: [],
      description: 'Green asterisk bullet item for shipped/completed work',
    },

    WikilinkChip: {
      props: z.object({
        target: z.string(),
        label: z.string().optional(),
      }),
      slots: [],
      description: 'Clickable [[bracket-wrapped]] cyan link that navigates to outline page',
    },

    BacklinksFooter: {
      props: z.object({
        inbound: z.array(z.string()),
        outbound: z.array(z.string()),
      }),
      slots: [],
      description: 'Bidirectional link footer: "referenced by" inbound + "links to" outbound',
    },

    PatternCard: {
      props: z.object({
        title: z.string(),
        type: z.string().optional(),
        confidence: z.string().optional(),
        content: z.string(),
        connectsTo: z.array(z.string()).optional(),
      }),
      slots: ['default'],
      description: 'Expandable card with type/confidence badges, markdown body, and connectsTo footer',
    },
  },

  actions: {
    selectEntry: {
      params: z.object({ id: z.string() }),
      description: 'Navigate to an entry by ID',
    },
    filterTag: {
      params: z.object({ tag: z.string() }),
      description: 'Filter entries by tag',
    },
    goBack: {
      params: z.object({}),
      description: 'Navigate back in history',
    },
    navigate: {
      params: z.object({ target: z.string() }),
      description: 'Navigate to a page or block in the outline',
    },
    scrollTo: {
      params: z.object({ id: z.string() }),
      description: 'Smooth scroll to a section by ID',
    },
  },
});

export type BbsCatalog = typeof bbsCatalog;
