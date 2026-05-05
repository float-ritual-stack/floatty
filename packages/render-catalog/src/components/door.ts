// Set B — 32 door-only components. Moved from render-door's inline catalog
// per FLO-657 Step 5. These are the floatty render door's domain vocabulary
// (sidebar nav, entry layout, TUI primitives, content blocks, composites,
// tree). No semantic-overlap with explorer; pure mechanical move.

import { z } from "zod";

// Enums used only by door-specific components. Moved from
// packages/render-door/src/catalog.ts during the Set B extraction.
const entryTypeEnum = z.enum(["synthesis", "archaeology", "bbs-source"]);
const accentEnum = z.enum(["magenta", "cyan", "coral", "amber", "muted"]);

export const doorComponentDefinitions = {
  // ─── Door-specific Layout ─────────────────────────────
  DocLayout: {
    props: z.strictObject({}),
    slots: ["sidebar", "main"],
    description: "Two-column layout: fixed sidebar + scrollable main content area",
  },

  // ─── Sidebar ──────────────────────────────────────────
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

  // ─── Tags ─────────────────────────────────────────────
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

  // ─── References ───────────────────────────────────────
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

  // ─── Navigation ───────────────────────────────────────
  Breadcrumb: {
    props: z.object({
      label: z.string(),
    }),
    slots: [],
    description: "Back navigation breadcrumb (← label)",
  },

  // ─── Base ─────────────────────────────────────────────
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

  Text: {
    props: z.object({
      content: z.string(),
      size: z.enum(["sm", "md", "lg", "xl"]).optional(),
      weight: z.enum(["normal", "medium", "bold"]).optional(),
      color: z.string().optional(),
      mono: z.boolean().optional(),
    }),
    slots: [],
    description: "Text display",
  },

  BulletList: {
    props: z.object({
      items: z.array(z.string()).describe("Bulleted list items. Inline markdown is supported (bold, italic, [[wikilinks]])."),
      density: z.enum(["comfortable", "compact"]).optional(),
    }),
    slots: [],
    description: "Flat bulleted list, serif body text. Drop into Callout/Section bodies for the common 'list of co-occurring items' shape (failures, examples, applies-to). Use TreeView when items have hierarchy + status; this is for flat-equal lists. density:'compact' tightens spacing.",
  },

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
    description: "Obsidian-style typed callout. Per-type icon + accent color (note/info=cyan, tip/success=green, warning/todo=amber, danger/failure/bug=coral, example=magenta, question=cyan, quote=dim, abstract=cyan). Optionally collapsible (set collapsible:true; defaultExpanded:false to start collapsed). Slots default — children can include other Callouts (nestable). Use for typed sections in long-form content: warnings, examples, quotes, fold-by-default details. Replaces ad-hoc QuoteBlock+wrapping AND CollapsibleSection+styled-text combos.",
  },

  Hero: {
    props: z.object({
      title: z.string(),
      subtitle: z.string().optional(),
      eyebrow: z.string().optional(),
      cover: z.object({
        gradient: z.string().optional(),
        color: z.string().optional(),
        icon: z.string().optional(),
      }).optional(),
      density: z.enum(["full", "compact"]).optional(),
      actions: z.array(z.object({
        label: z.string(),
        href: z.string().optional(),
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
        color: z.string().optional(),
        gradient: z.string().optional(),
        icon: z.string().optional(),
        height: z.string().optional(),
      }).optional(),
      properties: z.array(z.object({
        label: z.string(),
        value: z.string(),
        color: z.string().optional(),
      })).optional(),
      footer: z.string().optional(),
      href: z.string().optional(),
      density: z.enum(["comfortable", "compact"]).optional(),
    }),
    slots: ["default"],
    description: "Notion-style rich card. Optional cover area at top (gradient/color/icon), eyebrow (small uppercase tag) + title + subtitle, optional properties row (key:value pills with optional color), optional footer (dashed-rule separated meta line), optional href (whole-card click target). Children render in body slot below subtitle. density:'comfortable' (default) gives header room to breathe; density:'compact' tightens header (smaller eyebrow/title/padding) for more body room. Pairs with GalleryGrid for collection views. Use anywhere the basic Card feels too plain — dispatch headers, recent-work items, pinned references, gallery cells.",
  },

  Card: {
    props: z.object({
      title: z.string().optional(),
      subtitle: z.string().optional(),
    }),
    slots: ["default"],
    description: "A card container with optional title",
  },

  Metric: {
    props: z.object({
      label: z.string(),
      value: z.string(),
    }),
    slots: [],
    description: "A labeled metric value",
  },

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

  Code: {
    props: z.object({
      content: z.string(),
      language: z.string().optional(),
    }),
    slots: [],
    description: "Code block display",
  },

  // ─── TUI Components ─────────────────────────────────────
  TuiPanel: {
    props: z.object({
      title: z.string().optional(),
      titleColor: z.string().optional(),
    }),
    slots: ["default"],
    description: "Bordered container with title floating on top border edge",
  },

  KanbanCard: {
    props: z.object({
      content: z.string().optional(),
      color: z.string().optional(),
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

  TuiStat: {
    props: z.object({
      label: z.string(),
      value: z.string(),
      color: z.string().optional(),
    }),
    slots: [],
    description: "Centered metric card: label above, bold value below",
  },

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
      color: z.string().optional(),
    }),
    slots: [],
    description: "Single bar in a BarChart. Height = value/max * 100%. Inherits max from parent BarChart if not set on individual item.",
  },

  // ─── Content Blocks ─────────────────────────────────────
  DataBlock: {
    props: z.object({
      label: z.string().optional(),
      content: z.string(),
    }),
    slots: [],
    description: "Monospace pre block with optional floating label",
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
    description: "Before/after grid showing process changes from a meeting. Steps colored by status (red=removed, green=added, gray=unchanged). Includes new decisions list and action items with assignee/status/blocker. Good for post-meeting synthesis.",
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
    description: "Filterable list of project decisions with date, meeting source, and status (active/superseded). Filter tabs at top. Active decisions have cyan border, superseded are dimmed with strikethrough. Good for tracking decisions across meetings.",
  },

  DependencyChain: {
    props: z.object({
      nodes: z.array(z.object({ id: z.string(), title: z.string(), assignee: z.string(), status: z.string(), deps: z.array(z.string()) })),
      blocker: z.string().optional(),
    }),
    slots: [],
    description: "Horizontal linked-card chain showing issue dependencies. Cards connected by → arrows with id/title/assignee/status. Colors: todo=cyan, blocked=amber, done=green. Optional blocker callout below. Good for sprint planning, blocked-work viz.",
  },

  ContextStream: {
    props: z.object({
      captures: z.array(z.object({ time: z.string(), project: z.string(), mode: z.string(), text: z.string() })),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Filterable timeline of ctx:: captures with project color coding, mode badges, and context-switch markers. Click to expand entries. Project filter chips at top. Good for daily dashboards, session archaeology views.",
  },

  // ─── Composites ──────────────────────────────────────
  ModeTag: {
    props: z.object({
      mode: z.enum(["work", "float", "life", "pebble", "rent", "spike"]),
      count: z.number().optional(),
      size: z.enum(["sm", "md"]).optional(),
    }),
    slots: [],
    description: "Colored mode badge. work=cyan, float=magenta, life=green, pebble=amber, rent=coral, spike=coral.",
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

  TimeEntry: {
    props: z.object({
      time: z.string(),
      title: z.string(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      color: z.string().optional(),
    }),
    slots: [],
    description: "Timeline entry row: time dot on left spine, title + optional body + tags on right. Good for timelogs, session entries, daily notes.",
  },

  StatsBar: {
    props: z.object({
      stats: z.array(z.object({
        label: z.string(),
        value: z.string(),
        color: z.string().optional(),
      })),
      layout: z.enum(["row", "grid"]).optional(),
    }),
    slots: [],
    description: "Horizontal row (or grid) of labeled stat values with optional per-stat colors. Good for dashboards, summaries.",
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

  CollapsibleSection: {
    props: z.object({
      title: z.string(),
      expanded: z.boolean().optional(),
      color: z.string().optional(),
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

  // ─── Audio / Synth (FLO-techno-fidget) ───────────────
  // Web Audio API primitives. AudioContext lazy-inits on first click
  // (browser autoplay policy). No external libs — built on `OscillatorNode`.
  //
  // Rig wiring (cross-block sync):
  //   - `rigId` (default 'main') — namespace for clock + FX bus
  //   - `clock: '<rigId>'` — listen to MasterClock on that rig (slave mode);
  //     omit to run own internal transport (master mode, default)
  //   - `sends: { delay, reverb }` — route audio output through MasterFX
  //     bus on the same rigId. 0..1 send levels. No-op if no MasterFX.

  Tone: {
    props: z.object({
      freq: z.number().optional(),
      duration: z.number().optional(),
      wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
      label: z.string().optional(),
      color: z.string().optional(),
      gain: z.number().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "Boring synth primitive: a button that plays one note via Web Audio. Props: freq (Hz, default 440), duration (ms, default 200), wave (sine|square|sawtooth|triangle, default sine), label (default freq label), color (hex), gain (0..2.5, default 1.0 — voice-level attenuation, multiplied into the ADSR peak). Optional rig wiring: rigId + sends={delay, reverb} routes through MasterFX bus on that rig.",
  },

  DrumPad: {
    props: z.object({
      pads: z.array(z.object({
        label: z.string(),
        freq: z.number(),
        duration: z.number().optional(),
        wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
        color: z.string().optional(),
        gain: z.number().optional(),
      })),
      columns: z.number().optional(),
      title: z.string().optional(),
      gain: z.number().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "A grid of clickable pads, each plays a tone. Props: pads (array of {label, freq, duration?, wave?, color?, gain?}), columns (default 4), title (optional header), gain (component-level, 0..2.5, default 1.0 — attenuates whole pad). Per-pad gain (0..2.5, default 1.0) for mix-balance (kick loud, hat quiet). Build kick/snare/hi-hat/perc with different freqs+waves: kick~80Hz sine, snare~200Hz square, hat~6000Hz sawtooth, low-tom~120Hz triangle. Color by role. Optional rig wiring: rigId + sends route all pads through MasterFX bus.",
  },

  StepSequencer: {
    props: z.object({
      bpm: z.number().optional(),
      steps: z.number().optional(),
      gain: z.number().optional(),
      tracks: z.array(z.object({
        label: z.string(),
        freq: z.number(),
        duration: z.number().optional(),
        wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
        color: z.string().optional(),
        gain: z.number().optional(),
        // Per-track FX sends override component-level sends. Useful when
        // kick should stay dry but hat goes wet.
        sends: z.object({
          delay: z.number().optional(),
          reverb: z.number().optional(),
        }).optional(),
      })),
      initial: z.array(z.array(z.boolean())).optional(),
      title: z.string().optional(),
      clock: z.string().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "Step sequencer: tracks × steps grid. Click cells to toggle, PLAY to loop at BPM (16th-note timing). Props: bpm (default 120), steps (default 16), tracks (array of {label, freq, wave?, duration?, color?, gain?, sends?}), initial (optional [tracks][steps] boolean grid to seed the pattern). Current step has amber outline. Built-in transport bar. Gain: component-level gain (0..2.5, default 1.0) attenuates the whole sequencer; per-track gain (0..2.5, default 1.0) attenuates one voice for mix-balance (kick loud, hat quiet). Both layered with rig-level MasterOut. Rig wiring: clock='<rigId>' makes it a slave of MasterClock (no own transport); component-level sends={delay, reverb} routes all tracks through MasterFX on the same rigId, OR set per-track sends on individual tracks (kick dry, hat wet).",
  },

  AcidBass: {
    props: z.object({
      bpm: z.number().optional(),
      steps: z.number().optional(),
      // Per-step semitone offset from baseFreq. null = rest.
      notes: z.array(z.union([z.number(), z.null()])),
      accents: z.array(z.boolean()).optional(),
      slides: z.array(z.boolean()).optional(),
      baseFreq: z.number().optional(),
      wave: z.enum(["sawtooth", "square"]).optional(),
      gain: z.number().optional(),
      cutoff: z.number().optional(),
      resonance: z.number().optional(),
      envAmount: z.number().optional(),
      envDecay: z.number().optional(),
      title: z.string().optional(),
      clock: z.string().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "303-style mono bass step sequencer. 16 steps × {pitch (semitones from baseFreq), accent (louder + brighter), slide (portamento to next note), gate (null = rest)}. Lowpass filter with envelope: cutoff=base cutoff (Hz), resonance=Q, envAmount=Hz added to cutoff at note-on, envDecay=ms. Live knobs: gain/cutoff/resonance/envAmount/envDecay. baseFreq default 55Hz (A1), wave default 'sawtooth', gain default 1.0 (range 0..2.5, attenuates the bass voice — useful when bass is dominating the mix). The squelch lives in cutoff+resonance+envAmount interaction. Rig wiring: clock='<rigId>' = slave; sends={delay, reverb} routes through MasterFX.",
  },

  EuclideanDrums: {
    props: z.object({
      bpm: z.number().optional(),
      steps: z.number().optional(),
      gain: z.number().optional(),
      tracks: z.array(z.object({
        label: z.string(),
        hits: z.number(),
        rotation: z.number().optional(),
        freq: z.number(),
        duration: z.number().optional(),
        wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
        color: z.string().optional(),
        gain: z.number().optional(),
        // Per-track FX sends override component-level sends.
        sends: z.object({
          delay: z.number().optional(),
          reverb: z.number().optional(),
        }).optional(),
      })),
      title: z.string().optional(),
      clock: z.string().optional(),
      rigId: z.string().optional(),
      sends: z.object({
        delay: z.number().optional(),
        reverb: z.number().optional(),
      }).optional(),
    }),
    slots: [],
    description: "Bjorklund-algorithm Euclidean rhythm sequencer. Per-track (hits, steps, rotation) generates the most-evenly-distributed pattern. Live-tweaking hits/steps cascades polyrhythms. Built-in transport. Props: bpm (default 120), steps (default 16), tracks (array of {label, hits, rotation?, freq, wave?, duration?, color?, gain?, sends?}). Gain: component-level (0..2.5, default 1.0) attenuates whole sequencer; per-track gain (0..2.5, default 1.0) for mix-balance. Try (3,8) → tresillo, (5,8) → cinquillo, (7,16) → variable. Rig wiring: clock='<rigId>' = slave; component-level sends={delay, reverb} routes all tracks through MasterFX, OR per-track sends to mix kick-dry-hat-wet style.",
  },

  XYPad: {
    props: z.object({
      baseFreq: z.number().optional(),
      wave: z.enum(["sine", "square", "sawtooth", "triangle"]).optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      color: z.string().optional(),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Press-and-drag pad for sustained drone with continuous filter sweep. X axis = lowpass cutoff (200Hz–8kHz log). Y axis = resonance (0.5–25). Pointer down starts a sustained oscillator through the filter; release stops. Props: baseFreq (default 110Hz), wave (default 'sawtooth'), width (default 280), height (default 220), color (hex). Layer over the AcidBass for ambient pad mode.",
  },

  // ─── Rig: cross-block clock + FX bus ─────────────────
  // Multiple sequencer blocks can attach to the same `rigId`. MasterClock
  // emits step events, slaves listen via clock prop. MasterFX provides
  // shared delay+reverb sends voices opt into via sends prop.

  MasterClock: {
    props: z.object({
      rigId: z.string().optional(),
      bpm: z.number().optional(),
      steps: z.number().optional(),
      swing: z.number().optional(),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Rig clock — drives all sequencers tagged with `clock: '<rigId>'`. Props: rigId (default 'main'), bpm (default 124), steps (master loop length, default 16), swing (0..1, off-beat 16th delay, default 0), title. PLAY/STOP controls all attached slaves. Display shows step indicator. Voices route audio through MasterFX on same rigId if present.",
  },

  MasterFX: {
    props: z.object({
      rigId: z.string().optional(),
      gain: z.number().optional(),
      delayTime: z.number().optional(),
      delayFeedback: z.number().optional(),
      delayMix: z.number().optional(),
      reverbMix: z.number().optional(),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Rig FX bus — shared delay + convolution reverb sends + master output gain. Voices on the same rigId opt into sends via the sends prop ({ delay: 0..1, reverb: 0..1 }) AND all transit a per-rig master GainNode controlled by the gain prop here. Props: rigId (default 'main'), gain (master output level, 0..2.5, default 1.0 — turn down to mix-balance, push past 1.0 for laptop-speaker boost), delayTime (sec, default 0.375 ≈ dotted-eighth at 120 BPM), delayFeedback (0..0.85, default 0.35), delayMix (0..1, default 0.35), reverbMix (0..1, default 0.25). Live knobs.",
  },

  Strudel: {
    props: z.object({
      pattern: z.string(),
      cps: z.number().optional(),
      height: z.string().optional(),
      title: z.string().optional(),
    }),
    slots: [],
    description: "Strudel REPL embed — runs at strudel.cc via iframe with the pattern URL-encoded into the hash. Pattern is mini-notation source (e.g. `note(\"c4 eb4 g4\").s(\"sine\")`). Props: pattern (required, mini-notation string), cps (cycles per second, default 0.5 = 120 BPM), height (default '420px'), title. Note: external dependency on strudel.cc; works offline only if strudel.cc was loaded previously and cached. Doesn't currently sync with MasterClock — runs its own clock.",
  },

  // ─── Tree ────────────────────────────────────────────
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
    description: "Hierarchical tree with expand/collapse, status-colored nodes, and optional detail text. Up to 3 levels deep. Status colors: done=green, active=cyan, pending=dimmed, deferred=amber. Nodes with children are collapsible. Good for work breakdowns, dependency trees, outline structure, step lists with sub-items. connectsTo adds wikilink footer.",
  },
};
