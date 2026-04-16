import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { streamText, stepCountIs } from "ai";
import { gateway } from "@ai-sdk/gateway";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import { wrapLanguageModel } from "ai";
import {
  createMixedStreamParser,
  createStateStore,
  applySpecPatch,
  type Spec,
} from "@json-render/core";
import { JSONUIProvider, Renderer, useFocusDisable } from "@json-render/ink";
import { catalog } from "./catalog.js";
import {
  tools as defaultTools,
  initTools,
  extractWikilinks,
  resolveWikilinks,
  formatResolvedLinks,
  searchPages,
  autoEnrich,
  type EnrichmentResult,
} from "./tools.js";

const DEFAULT_MODEL = "anthropic/claude-opus-4-6";

// Component types stepped through one-at-a-time in the wizard.
// Tabs are excluded — they're navigation, rendered inline with the full spec.
const WIZARD_TYPES = new Set([
  "TextInput",
  "Select",
  "MultiSelect",
  "ConfirmInput",
]);

// Interactive component types that need live keyboard input.
// Tabs is included — it gets focus in LiveInteractiveSpec, but pressing
// Escape freezes the spec into history and returns control to chat.
const INTERACTIVE_TYPES = new Set([...WIZARD_TYPES, "Tabs", "TreeView", "Breadcrumb"]);

/** Check if a spec contains any interactive components */
function hasInteractiveElements(spec: Spec): boolean {
  return Object.values(spec.elements).some((el) =>
    INTERACTIVE_TYPES.has(el.type),
  );
}

/** Collect an element and all its descendants from the spec tree */
function collectSubtree(spec: Spec, rootKey: string): Spec["elements"] {
  const result: Spec["elements"] = {};
  const queue = [rootKey];
  while (queue.length > 0) {
    const key = queue.shift()!;
    const el = spec.elements[key];
    if (!el) continue;
    result[key] = el;
    if (el.children) queue.push(...el.children);
  }
  return result;
}

/** Get event→action bindings that auto-advance the wizard for each component type */
function getAdvanceEvents(
  type: string,
): Record<string, Array<{ action: string }>> | null {
  switch (type) {
    case "Select":
      return { change: [{ action: "advance" }] };
    case "TextInput":
    case "MultiSelect":
      return { submit: [{ action: "advance" }] };
    case "ConfirmInput":
      return {
        confirm: [{ action: "advance" }],
        deny: [{ action: "advance" }],
      };
    default:
      return null;
  }
}

/** Step-specific hint text */
function getStepHint(type: string, isLast: boolean): string {
  const action = isLast ? "submit" : "continue";
  switch (type) {
    case "Select":
      return `Use arrow keys, Enter to ${action}`;
    case "MultiSelect":
      return `Space to toggle, Enter to ${action}`;
    case "TextInput":
      return `Type your answer, Enter to ${action}`;
    case "ConfirmInput":
      return `Press Y or N to ${action}`;
    default:
      return `Make your selection to ${action}`;
  }
}

// ---------------------------------------------------------------------------
// System prompt — handwritten design guidance + catalog documentation.
// Follows the same pattern as examples/chat/lib/agent.ts: a rich
// AGENT_INSTRUCTIONS string with catalog.prompt() appended at the end.
// ---------------------------------------------------------------------------

const AGENT_INSTRUCTIONS = `You are a terminal assistant that renders polished, information-dense UIs. You call tools for real-time data, then build clean terminal dashboards.

WORKFLOW:
1. Call the appropriate tools to gather real data. Use web_search for topics not covered by the specialized tools. For outline/notes questions, use floatty tools (floatty_search, floatty_page, floatty_daily, floatty_presence, floatty_markers).
2. While tools run, output a single short status line (e.g. "Searching outline..."). This is the ONLY text allowed outside the spec fence.
3. After tools return, output ALL content inside a \`\`\`spec fence. Never write paragraphs of prose outside the fence.
4. For simple text replies (greetings, clarifications), still use a \`\`\`spec with a Markdown component.

FLOATTY TOOLS — CORE:
- floatty_search: Full-text search across all blocks. Returns breadcrumbs, scores, markers, outlinks.
- floatty_search_pages: Find pages by name (prefix or fuzzy). Use before floatty_page to get the block ID.
- floatty_page: Load a full page tree by short-hash prefix. Returns indented block tree.
- floatty_daily: Get today's (or any date's) daily note tree.
- floatty_daily_add: Add an entry to today's daily note.
- floatty_block_create: Create a new block anywhere in the outline.
- floatty_presence: Where the user is focused right now in the outliner.
- floatty_markers: Discover marker vocabulary (project::, ctx::, mode::, etc.).

FLOATTY TOOLS — GRAPH WALKING:
- floatty_backlinks: Find blocks that link TO a specific page via [[wikilinks]]. The reverse graph walk. "What references FLO-201?" uses this.
- floatty_block_context: Get a block with ancestors, siblings, and children. Essential for timeline views.
- floatty_connections: Trace relationships between 2-4 pages. Finds intersection blocks, cross-links, and per-target backlinks. Use for "what connects X and Y?".
- floatty_search_advanced: Filter-only search — no text query needed. Combine marker_type, temporal filters (epoch seconds), outlink, parent_id.
- floatty_stats: Outline-wide statistics (total blocks, marker coverage, type distribution).

GRAPH WALKING PATTERNS:
When the user asks about connections between pages or concepts:
1. CONNECTIONS FIRST: If 2+ entities are mentioned, call floatty_connections with all of them.
2. BACKLINKS FOR DEPTH: For any entity needing more context, call floatty_backlinks.
3. BLOCK CONTEXT FOR TIMELINE: When you find an interesting block, call floatty_block_context to see before/after.
4. PAGE TREE FOR FULL PICTURE: Call floatty_page on any important page.

SKILLS — PROGRESSIVE DISCLOSURE:
- load_skill: Lists available skills and loads their instructions on demand. Skills are modular domain knowledge (React best practices, invoice auditing, floatty debugging, etc.). Call load_skill with a skill name to get detailed instructions for that domain.
- Use when the user's question touches a specific domain and you need expert guidance beyond what's in the system prompt.
- Don't load skills preemptively — only when a question requires domain-specific knowledge.

QMD — KNOWLEDGE BASE:
- qmd_search: Search 10,000+ archived markdown documents — meeting wraps, daily notes, sysops logs, Linear issues, conversation exports, plans. Hybrid search (BM25 + vector + LLM query expansion). Use for long-term memory and historical context not in the live outline.
- qmd_get: Retrieve full document content by docid or qmd:// path. Use after qmd_search to read a result.
- Key collections: rangle-weekly (meeting wraps, sprint items), bbs-daily (daily notes), sysops-log (ops log), linear-issues (FLO-xxx issues), floatty-docs (architecture), claude-plans (planning artifacts), desktop-exports (conversation history).
- QMD is the LONG-TERM MEMORY. Floatty is the WORKING MEMORY. Use QMD for historical questions ("how did we handle X last November?", "what was decided about issue #712?"). Use floatty for current state ("what's in today's daily?", "where am I focused?").

MULTI-STEP WRITES:
- You can create multiple blocks in a single conversation turn. Plan your writes before executing them.
- For outline operations (creating daily notes, populating pages), gather all context first, then create blocks in order (parent before children).
- The agent loop allows up to 15 steps total. A typical multi-write operation: 3-4 reads + 5-8 writes + 1 render = ~12 steps.
- After all writes complete, render a summary spec showing what was created.

TEMPORAL QUERIES:
For time-based questions ("what happened last week?", "blocks from March 10-15"):
- Convert dates to epoch seconds for floatty_search_advanced
- Use ctx_after/ctx_before for ctx:: event timestamps, created_after/created_before for block creation
- Combine with marker_type/marker_val for scoped temporal queries

DESIGN PRINCIPLES:
- HIERARCHY: Every response needs clear visual structure. Start with an h1 Heading for the topic. Use h2 Headings for subsections. Use Card to group related content into shaded areas — Cards render as subtle background fills, not bordered boxes.
- LEAD WITH THE STORY: Open with a brief Markdown paragraph (2-3 sentences) that tells the user the key insight or takeaway. Don't just dump data — frame it.
- SUMMARY METRICS: After the narrative, show 2-4 Metric components for the most important numbers. Metric displays a dim label, bold value, and optional colored trend (up=green, down=red). Group them in a horizontal Box (flexDirection: row, gap: 3) so they read like a dashboard header. Use KeyValue only for simple label:value pairs that don't need emphasis.
- DETAIL SECTIONS: Below the summary, use h2 Headings to introduce each section, followed by a single focused visualization (Table, BarChart, or set of KeyValues).
- ONE REPRESENTATION PER DATA POINT: Never show the same value as both a number and a percentage and a bar. Pick the most meaningful format. Use BarChart with showValues:true OR showPercentage:true, not both.
- TABLES: Always set explicit column widths so columns don't collapse. Use headerColor:"cyan". Keep column headers short (abbreviate if needed). Right-align numeric columns.
- CHARTS: Use distinct colors per bar in BarChart. Good palette: cyan, green, yellow, magenta, blue, red. Use Sparkline for compact inline trends alongside other content.
- COLOR STRATEGY: Use color with intention, not decoration. cyan for labels and headers. green for positive values, growth, success. red for negative values, decline, errors. yellow for warnings or neutral highlights. dimColor:true for secondary/supporting text. Avoid coloring everything — contrast comes from restraint.
- TABLES: Use borderStyle:"single" on Tables for a clean outline. Do NOT put Tables inside Cards — Tables have their own border and don't need additional wrapping.
- SPACING: Use gap:1 between sections. Don't over-pad. Keep the UI compact and scannable. NEVER add padding to the root element — the app already provides outer padding.
- WIDTH: Target 80 columns. Set explicit widths on Tables (total columns should sum to ~70-75). Use wrap:"truncate-end" on Text in tight spaces.
- CALLOUTS: Use Callout for key takeaways, important notes, tips, and warnings. Set type (info/tip/warning/important) for a colored left border accent. Keep content concise — one key point per Callout.
- TIMELINES: Use Timeline for historical events, step-by-step processes, and milestones. Set status per item (completed/current/upcoming) for colored dots. Include dates when available.
- NEVER use emojis anywhere — not in text, labels, titles, table cells, Heading text, or component props. Plain text only.

DASHBOARD PATTERN (use for data-heavy responses):
Root Box (column, gap:1) >
  Heading (h1, topic title)
  Markdown (2-3 sentence summary with key takeaway)
  Box (row, gap:3) > [Metric, Metric, Metric] (top-line metrics, no Card)
  Heading (h2, section title)
  Table (borderStyle:"single")
  Card (title:"Section Name") > BarChart (bar charts go in a titled Card — the Card title replaces h2)
  Callout (type:"tip", key takeaway or closing note)
Card wrapping rules: Wrap BarCharts in a Card with a title. Do NOT wrap Metrics or Tables in Cards — Metrics stand alone, Tables have their own border.

CONNECTION MAP PATTERN (use for graph-walking / relationship queries):
Root Box (column, gap:1) >
  Heading (h1, "Connection Map: X, Y, Z")
  Markdown (2-3 sentence summary of the key relationship)
  Box (row, gap:3) > [Metric per entity: backlink count, page status]
  Timeline (the connection chain — events in chronological order)
  Heading (h2, per-entity detail)
  Card (title: entity name) > KeyValue pairs
  Callout (type:"info", synthesis of WHY these things connect)
Timeline is the star component for connections — shows cause-and-effect chronologically.

COMPARISON PATTERN:
Use BarChart when you want the user to see relative magnitudes at a glance.
Use Table when there are 3+ columns of mixed data types.
Never use both for the same data.

TREND PATTERN:
Use Sparkline for compact inline trend next to a KeyValue.
Use BarChart with year/period labels for detailed time-series.

INTERACTIVITY:
- You can create interactive forms, surveys, and selection interfaces. The user navigates with arrow keys, selects with Space/Enter, and types into text fields.
- ALWAYS include a submit action on interactive UIs. Add a Text or StatusLine telling the user how to submit. Wire submit events to a "submit" action — the app collects form state automatically.
- ALWAYS populate the state field with sensible defaults for all bound values.
- Use $bindState on interactive components for two-way binding. Example: { "value": { "$state": "/choice" }, "$bindState": { "value": "/choice" } }.
- Use Tabs for multi-section surveys. Use ConfirmInput for yes/no prompts.
- After receiving form data, acknowledge the user's choices meaningfully — don't just echo them back.

OUTLINE RENDERING (for floatty data):

INTERACTIVE NAVIGATION:
- Page trees: use TreeView — it handles expand/collapse and keyboard navigation. The user arrows through the tree and hits Enter to select a node.
- Search results: include a Select component listing the top results so the user can pick one to expand. The Select takes over the screen (wizard mode).
- Ancestry paths: use Breadcrumb — the user arrows between segments and hits Enter to navigate to that ancestor.
- TreeView, Breadcrumb, Select, TextInput, MultiSelect, and ConfirmInput are all interactive components. Do NOT use Tabs or Link for inline navigation.
- For date navigation (daily notes), show prev/next dates as text. The user can type "daily note for 2026-03-26" to navigate.

SEARCH RESULTS:
- Use a Table with columns: Score, Content, Location (breadcrumb joined with " > ")
- Show markers as Badge components after content (project=cyan, ctx=yellow, mode=magenta, todo=green)
- Show total hits as a Metric above the table
- If results have outlinks, show them as dimmed Text below the table
- For each result with a breadcrumb array, render a Breadcrumb component with segments mapped from the breadcrumb (id=blockId or index, label=block content). This makes ancestry paths navigable.
- NAVIGATION: Below the results, include a Select component listing the top results by content (truncated to 60 chars) with their blockId as the value. Label it "Open block" and wire submit to an action. When the user selects a block, call floatty_page with that blockId to show the full page tree.

PAGE TREE:
- **ALWAYS use TreeView** for page trees. Convert the block tree into TreeView nodes:
  - Each block becomes a node: { id: blockId, label: block content (truncated to 80 chars), children: child blocks, badge: "[N]" child count if collapsed }
  - The TreeView handles expand/collapse and keyboard navigation automatically
  - CRITICAL: For large pages (50+ blocks), LIMIT the TreeView to top-level sections only (depth 0 and 1). Show deeper content as collapsed nodes with badge "[N children]". A 688-block page as fully expanded nested JSON will exceed output token limits and the tree element will be truncated, causing a [Missing: tree] error. Keep tree nodes under 30 total.
- Show page stats (block count, max depth) as Metrics in a row above the TreeView
- Show a Breadcrumb above the TreeView with the page's ancestor path (root > page name > section)
- The tool result includes a **treeSpec** field — a pre-rendered Spec that converts outline blocks into structured components (headings, ctx:: markers with parsed timestamps/project/mode badges, sh:: commands, render:: prompts, search:: queries, and [[wikilinks]] as cyan badges). You can embed this spec directly for a quick visual representation, or use TreeView for interactive navigation. The treeSpec is best for compact read-only views; TreeView is best when the user needs to explore.

DAILY NOTE:
- Use TreeView for the daily note block tree (same pattern as PAGE TREE above)
- Use Timeline component for ctx:: entries (parse timestamps from ctx:: markers)
- The tool result includes a **treeSpec** with pre-parsed ctx:: markers showing timestamps and project badges — useful for a quick daily overview without building the Timeline manually.
- Show a Metric row: block count, date
- Show "<< 2026-03-26 | 2026-03-28 >>" as plain Text (dimColor) so the user knows adjacent dates exist. They can type a date to navigate.

PRESENCE:
- Show the focused block content prominently (Heading h2 or bold Text)
- Show ancestors as a Breadcrumb component (segments from ancestor chain, each with id=blockId, label=block content)
- Show surrounding siblings as a compact list (3 before, 3 after) with the focused block highlighted

MARKERS:
- When showing marker vocabulary, use a Table or BarChart showing marker types and their counts
- Color-code by type: project=cyan, ctx=yellow, mode=magenta, todo=green, sysop=red

BACKLINK RESULTS:
- Frame as "What links to X?" with target page name as Heading h2
- Table with columns: Content, Location (breadcrumb), Outlinks (other wikilinks — reveals co-references)
- Highlight blocks that also link to other queried targets if doing a multi-entity graph walk

STATS:
- Dashboard pattern with Metrics for top-line numbers (total blocks, with markers, with outlinks)
- BarChart for type distribution
- KeyValue pairs for marker coverage percentages

TREEVIEW + BREADCRUMB SPEC EXAMPLE:
When rendering a page tree with TreeView and Breadcrumb, the spec looks like this:
\`\`\`json
{
  "root": "layout",
  "elements": {
    "layout": { "type": "Box", "props": { "flexDirection": "column", "gap": 1 }, "children": ["crumb", "tree"] },
    "crumb": { "type": "Breadcrumb", "props": { "segments": [{ "id": "root", "label": "pages::" }, { "id": "p1", "label": "2026-04-01" }], "color": "cyan" } },
    "tree": { "type": "TreeView", "props": { "nodes": [{ "id": "abc123", "label": "# 2026-04-01", "children": [{ "id": "def456", "label": "pages::", "children": [{ "id": "ghi789", "label": "render:: agent", "badge": "[6]" }] }, { "id": "jkl012", "label": "ctx @ 10:15 PM" }] }], "color": "cyan" } }
  }
}
\`\`\`
The nodes prop takes NESTED objects — children are inline, not referenced by key. Badge shows child count for context. This is the PREFERRED format for all page tree and daily note rendering.

${catalog.prompt({
  mode: "inline",
  customRules: [
    "ALL text MUST go inside the spec using the Markdown component. The ONLY text outside the fence is a short tool-status line.",
    "For text-only answers, still output a spec with a Markdown component.",
    "Prefer Table for structured data and KeyValue for label-value pairs.",
    "NEVER use emojis anywhere in your output. Plain text only.",
  ],
})}`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Message {
  id: number;
  role: "user" | "assistant";
  text: string;
  spec: Spec | null;
  /** Outline context that was auto-injected (shown as dim hint under user message) */
  context?: string[];
}

// ---------------------------------------------------------------------------
// ChatInput — simple terminal text input
// ---------------------------------------------------------------------------

function ChatInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
}) {
  const [value, setValue] = useState("");
  const [suggestions, setSuggestions] = useState<
    Array<{ name: string; isStub: boolean }>
  >([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Extract the partial wikilink being typed (text after last unclosed [[)
  const getPartialLink = (text: string): string | null => {
    const lastOpen = text.lastIndexOf("[[");
    if (lastOpen === -1) return null;
    const afterOpen = text.slice(lastOpen + 2);
    // If there's a ]] after the [[, the link is closed
    if (afterOpen.includes("]]")) return null;
    return afterOpen;
  };

  const inAutocomplete =
    suggestions.length > 0 && getPartialLink(value) !== null;

  // Debounced page search
  const triggerSearch = useCallback((query: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 1) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const results = await searchPages(query);
      setSuggestions(results);
      setSelectedIdx(0);
    }, 150);
  }, []);

  useInput(
    (input, key) => {
      // Tab or Enter in autocomplete mode → accept suggestion
      if (inAutocomplete && (key.tab || key.return)) {
        const selected = suggestions[selectedIdx];
        if (selected) {
          setValue((prev) => {
            const lastOpen = prev.lastIndexOf("[[");
            return prev.slice(0, lastOpen + 2) + selected.name + "]]";
          });
          setSuggestions([]);
        }
        return;
      }

      // Arrow keys in autocomplete mode → navigate suggestions
      if (inAutocomplete && key.upArrow) {
        setSelectedIdx((i) => (i > 0 ? i - 1 : suggestions.length - 1));
        return;
      }
      if (inAutocomplete && key.downArrow) {
        setSelectedIdx((i) => (i < suggestions.length - 1 ? i + 1 : 0));
        return;
      }

      // Escape in autocomplete → dismiss
      if (inAutocomplete && key.escape) {
        setSuggestions([]);
        return;
      }

      // Normal submit
      if (key.return && value.trim()) {
        onSubmit(value.trim());
        setValue("");
        setSuggestions([]);
        return;
      }

      if (key.backspace || key.delete) {
        setValue((prev) => {
          const next = prev.slice(0, -1);
          const partial = getPartialLink(next);
          if (partial !== null) {
            triggerSearch(partial);
          } else {
            setSuggestions([]);
          }
          return next;
        });
        return;
      }

      if (key.ctrl || key.meta || key.escape) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
        return;

      if (input) {
        setValue((prev) => {
          const next = prev + input;
          const partial = getPartialLink(next);
          if (partial !== null) {
            triggerSearch(partial);
          } else {
            setSuggestions([]);
          }
          return next;
        });
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{"› "}</Text>
        {value ? (
          <Text>{value}</Text>
        ) : (
          <Text dimColor>
            {disabled
              ? "Thinking..."
              : "Type a message... ([[  for outline links)"}
          </Text>
        )}
      </Box>
      {inAutocomplete && (
        <Box flexDirection="column" paddingLeft={2} marginTop={0}>
          {suggestions.map((s, i) => (
            <Text key={s.name}>
              <Text
                color={i === selectedIdx ? "cyan" : undefined}
                bold={i === selectedIdx}
              >
                {i === selectedIdx ? "› " : "  "}
                {s.name}
              </Text>
              {s.isStub && <Text dimColor> (stub)</Text>}
            </Text>
          ))}
          <Text dimColor italic>
            {"\u2191\u2193 navigate, Tab to accept, Esc to dismiss"}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function AnimatedSpinner({
  label,
  color = "cyan",
}: {
  label: string;
  color?: string;
}) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box gap={1}>
      <Text color={color}>{SPINNER_FRAMES[frame]}</Text>
      <Text dimColor>{label}</Text>
    </Box>
  );
}

/** Suppress Tab-cycling inside read-only message providers so old interactive
 *  components (e.g. Tabs) can't steal focus/arrow-key input. */
function DisableFocus() {
  useFocusDisable(true);
  return null;
}

/** Render markdown text through the standard Renderer pipeline (uses the
 *  built-in Markdown component without exporting MarkdownText). */
function RenderedMarkdown({ text }: { text: string }) {
  const spec: Spec = useMemo(
    () => ({
      root: "md",
      elements: { md: { type: "Markdown", props: { text }, children: [] } },
    }),
    [text],
  );

  return (
    <JSONUIProvider initialState={{}}>
      <DisableFocus />
      <Renderer spec={spec} />
    </JSONUIProvider>
  );
}

function MessageView({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text bold>You: </Text>
          <Text>{message.text}</Text>
        </Box>
        {message.context && message.context.length > 0 && (
          <Box paddingLeft={4}>
            <Text dimColor italic>
              {"+ outline: " + message.context.join(", ")}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {message.spec ? (
        <JSONUIProvider initialState={message.spec.state ?? {}}>
          <DisableFocus />
          <Renderer spec={message.spec} />
        </JSONUIProvider>
      ) : message.text ? (
        <RenderedMarkdown text={message.text} />
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// LiveInteractiveSpec — wizard that shows one interactive element at a time
// ---------------------------------------------------------------------------

function LiveInteractiveSpec({
  spec,
  onSubmit,
}: {
  spec: Spec;
  onSubmit: (state: Record<string, unknown>) => void;
}) {
  // Extract wizard-steppable element keys (Tabs are excluded)
  const interactiveKeys = useMemo(
    () =>
      Object.entries(spec.elements)
        .filter(([_, el]) => WIZARD_TYPES.has(el.type))
        .map(([key]) => key),
    [spec],
  );

  const [step, setStep] = useState(0);
  const store = useMemo(() => createStateStore(spec.state ?? {}), [spec]);
  // Guard against double-advance from key repeats (e.g. holding Y on ConfirmInput)
  const advancingRef = useRef(false);

  const currentKey = interactiveKeys[step];
  const currentElement = currentKey ? spec.elements[currentKey] : null;
  const isLast = step >= interactiveKeys.length - 1;

  // Reset the guard when the step changes
  useEffect(() => {
    advancingRef.current = false;
  }, [step]);

  const advance = useCallback(() => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    if (isLast) {
      onSubmit(store.getSnapshot());
    } else {
      setStep((s) => s + 1);
    }
  }, [isLast, onSubmit, store]);

  // Build a minimal spec containing only the current interactive element
  const stepSpec = useMemo<Spec | null>(() => {
    if (!currentKey || !currentElement) return null;

    const elements = collectSubtree(spec, currentKey);

    // Wire auto-advance events
    const advanceEvents = getAdvanceEvents(currentElement.type);
    if (advanceEvents) {
      elements[currentKey] = {
        ...elements[currentKey]!,
        on: { ...(elements[currentKey] as any).on, ...advanceEvents },
      };
    }

    return { root: currentKey, elements, state: spec.state };
  }, [currentKey, currentElement, spec]);

  const handlers = useMemo(() => ({ submit: advance, advance }), [advance]);

  // No wizard-steppable elements (e.g. Tabs-only spec) → render the full spec
  if (interactiveKeys.length === 0) {
    const hasTabs = Object.values(spec.elements).some(
      (el) => el.type === "Tabs",
    );
    return (
      <Box flexDirection="column" marginBottom={1}>
        <JSONUIProvider store={store} handlers={handlers}>
          <Renderer spec={spec} />
        </JSONUIProvider>
        <Box marginTop={1}>
          <Text dimColor italic>
            {hasTabs
              ? "Left/right to switch tabs, Esc to return to chat"
              : "Esc to return to chat"}
          </Text>
        </Box>
      </Box>
    );
  }

  if (!stepSpec || !currentElement) return null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {interactiveKeys.length > 1 && (
        <Text dimColor>
          Step {step + 1} of {interactiveKeys.length}
        </Text>
      )}
      <JSONUIProvider store={store} handlers={handlers}>
        <Renderer spec={stepSpec} />
      </JSONUIProvider>
      <Box marginTop={1}>
        <Text dimColor italic>
          {getStepHint(currentElement.type, isLast)}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// App — main chat loop
// ---------------------------------------------------------------------------

export function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingStatus, setStreamingStatus] = useState("Thinking...");
  const [streamingSpec, setStreamingSpec] = useState<Spec | null>(null);
  const nextMessageIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // Ref tracks latest messages so sendMessage doesn't need it as a dep
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Initialize tools with skill discovery (async, runs once)
  const [tools, setTools] = useState(defaultTools);
  useEffect(() => {
    initTools().then(setTools);
  }, []);

  // Track a live interactive spec awaiting user input
  const [liveSpec, setLiveSpec] = useState<Spec | null>(null);

  // Ctrl+C to exit, Escape to dismiss live spec or exit
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      abortRef.current?.abort();
      exit();
    }
    if (key.escape) {
      if (liveSpec) {
        // Dismiss interactive spec → freeze into message history
        setMessages((prev) => {
          const updated = [...prev];
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i]!.role === "assistant" && !updated[i]!.spec) {
              updated[i] = { ...updated[i]!, spec: liveSpec };
              break;
            }
          }
          return updated;
        });
        setLiveSpec(null);
      } else {
        abortRef.current?.abort();
        exit();
      }
    }
  });

  const sendMessage = useCallback(async (text: string) => {
    abortRef.current?.abort();
    // Clear any live interactive spec
    setLiveSpec(null);
    // Add user message
    const userMsg: Message = {
      id: nextMessageIdRef.current++,
      role: "user",
      text,
      spec: null,
    };
    setMessages((prev) => [...prev, userMsg]);
    setIsStreaming(true);
    setStreamingStatus("Thinking...");

    // Enrich user input with outline context
    let enrichedText = text;
    let contextLabels: string[] = [];
    const wikilinks = extractWikilinks(text);
    if (wikilinks.length > 0) {
      // Explicit [[wikilinks]] — resolve full page trees
      setStreamingStatus(
        `Resolving ${wikilinks.length} link${wikilinks.length > 1 ? "s" : ""}...`,
      );
      const resolved = await resolveWikilinks(wikilinks);
      if (resolved.length > 0) {
        enrichedText = text + formatResolvedLinks(resolved);
        contextLabels = resolved.map((r) => r.name);
      }
    } else {
      // No explicit links — auto-search outline for relevant context
      setStreamingStatus("Searching outline...");
      const result = await autoEnrich(text);
      if (result.contextText) {
        enrichedText = text + result.contextText;
        contextLabels = result.labels;
      }
    }

    // Update user message with context labels
    if (contextLabels.length > 0) {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === "user") {
          updated[updated.length - 1] = { ...last, context: contextLabels };
        }
        return updated;
      });
    }

    // Build conversation history from ref (avoids stale closure).
    // For assistant messages with specs, serialize the spec so the model
    // remembers what it rendered in previous turns.
    const history = [
      ...messagesRef.current.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.spec
          ? `${m.text}\n\`\`\`spec\n${JSON.stringify(m.spec)}\n\`\`\``
          : m.text,
      })),
      { role: "user" as const, content: enrichedText },
    ];

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const baseModel = gateway(process.env.AI_GATEWAY_MODEL || DEFAULT_MODEL);
      const model = process.env.DEVTOOLS
        ? wrapLanguageModel({
            model: baseModel,
            middleware: devToolsMiddleware(),
          })
        : baseModel;

      const result = streamText({
        model,
        system: AGENT_INSTRUCTIONS,
        messages: history,
        temperature: 0.7,
        abortSignal: controller.signal,
        tools,
        stopWhen: [stepCountIs(80)],
      });

      let conversationText = "";
      let spec: Spec = { root: "", elements: {} };
      let hasSpec = false;

      const parser = createMixedStreamParser({
        onText: (chunk) => {
          conversationText += chunk + "\n";
        },
        onPatch: (patch) => {
          hasSpec = true;
          spec = applySpecPatch(structuredClone(spec), patch);
          setStreamingSpec(structuredClone(spec));
        },
      });

      let hadTextInStep = false;
      for await (const part of result.fullStream) {
        if (part.type === "tool-call") {
          const name = part.toolName.replace(/_/g, " ");
          setStreamingStatus(`Using ${name}...`);
        } else if (part.type === "tool-result") {
          setStreamingStatus("Generating...");
        } else if (part.type === "text-start") {
          hadTextInStep = false;
        } else if (part.type === "text-delta") {
          hadTextInStep = true;
          parser.push(part.text);
        } else if (part.type === "text-end") {
          // Insert a paragraph break between text segments so text from
          // before/after tool calls doesn't merge into a wall.
          // Injected directly into conversationText (not through the
          // parser, which may drop empty lines in older builds).
          if (hadTextInStep) {
            parser.flush();
            conversationText += "\n\n";
            hadTextInStep = false;
          }
        }
      }
      parser.flush();

      // Finalize: add assistant message
      const finalSpec = hasSpec ? spec : null;
      const isInteractive = finalSpec && hasInteractiveElements(finalSpec);

      const assistantMsg: Message = {
        id: nextMessageIdRef.current++,
        role: "assistant",
        text: conversationText.trim(),
        // If interactive, don't store spec in message history (it'll be live)
        spec: isInteractive ? null : finalSpec,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      // If the spec has interactive components, keep it live
      if (isInteractive && finalSpec) {
        setLiveSpec(finalSpec);
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const errorMsg: Message = {
        id: nextMessageIdRef.current++,
        role: "assistant",
        text: `Error: ${(err as Error).message}`,
        spec: null,
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsStreaming(false);
      setStreamingSpec(null);
    }
  }, []);

  // Handle interactive spec submission — collect state and send back to AI
  const handleInteractiveSubmit = useCallback(
    (state: Record<string, unknown>) => {
      // Freeze the spec into message history as a non-interactive snapshot
      if (liveSpec) {
        // Update the last assistant message to include the spec with submitted state
        const frozenSpec = { ...liveSpec, state };
        setMessages((prev) => {
          const updated = [...prev];
          // Find the last assistant message (which has spec: null for interactive)
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i]!.role === "assistant" && !updated[i]!.spec) {
              updated[i] = { ...updated[i]!, spec: frozenSpec };
              break;
            }
          }
          return updated;
        });
        setLiveSpec(null);
      }

      // Format the submitted state as a user message and send to AI
      const formattedState = Object.entries(state)
        .map(([key, value]) => {
          if (Array.isArray(value)) return `${key}: ${value.join(", ")}`;
          return `${key}: ${value}`;
        })
        .join("\n");

      sendMessage(`[Form submitted]\n${formattedState}`);
    },
    [liveSpec, sendMessage],
  );

  return (
    <Box flexDirection="column" padding={1} minHeight={stdout.rows}>
      {/* Header */}
      <Box marginBottom={1} gap={1}>
        <Text bold color="cyan">
          json-render + floatty
        </Text>
        <Text dimColor>Ctrl+C to exit</Text>
      </Box>

      {/* Empty state — show example prompts when no conversation yet */}
      {messages.length === 0 && !isStreaming && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Try asking:</Text>
          <Box flexDirection="column" paddingLeft={2} marginTop={1} gap={0}>
            <Text dimColor>{"  search my outline for doors"}</Text>
            <Text dimColor>{"  show today's daily note"}</Text>
            <Text dimColor>
              {"  what connects [[FLO-201]] and [[Issue #1540]]?"}
            </Text>
            <Text dimColor>{"  what links to [[rangle-weekly]]?"}</Text>
            <Text dimColor>{"  outline stats"}</Text>
            <Text dimColor>{"  weather in tokyo"}</Text>
          </Box>
        </Box>
      )}

      {/* Message history — collapsed when interactive wizard is active */}
      {liveSpec && !isStreaming ? (
        <>
          {messages.length > 1 && (
            <Text dimColor italic>
              {messages.length - 1} earlier message
              {messages.length > 2 ? "s" : ""} hidden
            </Text>
          )}
          {messages.length > 0 && (
            <MessageView message={messages[messages.length - 1]!} />
          )}
          <LiveInteractiveSpec
            spec={liveSpec}
            onSubmit={handleInteractiveSubmit}
          />
        </>
      ) : (
        <>
          {messages.map((msg) => (
            <MessageView key={msg.id} message={msg} />
          ))}
        </>
      )}

      {/* Live spec preview while streaming */}
      {isStreaming && streamingSpec && streamingSpec.root && (
        <Box flexDirection="column" marginBottom={1}>
          <JSONUIProvider initialState={streamingSpec.state ?? {}}>
            <DisableFocus />
            <Renderer spec={streamingSpec} loading />
          </JSONUIProvider>
        </Box>
      )}

      {/* Spacer pushes input to bottom when content is short */}
      <Box flexGrow={1} />

      {/* Input — spinner replaces input while streaming, hidden during wizard */}
      {!liveSpec && (
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          {isStreaming ? (
            <AnimatedSpinner label={streamingStatus} />
          ) : (
            <ChatInput onSubmit={sendMessage} disabled={false} />
          )}
        </Box>
      )}
    </Box>
  );
}
