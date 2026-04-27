/**
 * Output Summary Hook
 *
 * Subscribes to blockEventBus for block:update events where outputType changes.
 * Extracts a short summary from door/render output and stores it in
 * block.metadata.summary — making rich door output discoverable via search.
 *
 * Currently handles render:: door specs (type "door" with spec.elements).
 * Extensible to other output types.
 *
 * @see docs/architecture/FLOATTY_HOOK_SYSTEM.md
 */

import {
  blockEventBus,
  Origin,
  type EventEnvelope,
  EventFilters,
} from '../../events';
import { blockStore } from '../../../hooks/useBlockStore';
import { createLogger } from '../../logger';
import type { DoorEnvelope } from '../doorTypes';

const logger = createLogger('outputSummaryHook');

// ═══════════════════════════════════════════════════════════════
// TYPES — door output envelope shape
// ═══════════════════════════════════════════════════════════════

/**
 * Props on a json-render spec element. Each component type (EntryHeader,
 * EntryBody, PatternCard, ...) has its own prop schema defined in its
 * catalog; we don't enumerate them here. Use `unknown` for value access
 * and narrow at the use site (`typeof p.title === 'string'` etc.).
 *
 * The string-indexed signature lets us read arbitrary props without
 * adding each one to the type — necessary because the catalog is
 * extensible and this hook handles every door's output.
 */
type SpecElementProps = Record<string, unknown>;

interface SpecElement {
  type: string;
  props?: SpecElementProps;
  children?: string[];
}

interface DoorSpec {
  root?: string;
  elements?: Record<string, SpecElement>;
}

/**
 * Door-specific data shape we expect when `kind === 'view'` and the door
 * emits json-render output. The framework's `DoorViewOutput.data` is just
 * `JsonValue | null` (intentionally — each door's data is its own); this
 * interface is the contract render-style doors follow inside that envelope.
 */
interface DoorOutputData {
  title?: unknown;
  spec?: DoorSpec;
  // doors emit other fields here (entries, week, etc.); accessed only when
  // the surrounding code has narrowed via type guards.
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY EXTRACTION
// ═══════════════════════════════════════════════════════════════

/**
 * Unwrap door output envelope to get data + spec.
 *
 * Routes via the framework's discriminated union (`DoorEnvelope =
 * DoorViewOutput | DoorExecOutput`, keyed on `kind`). Exec doors carry no
 * spec — they short-circuit to `undefined / undefined`, which is what
 * downstream extractors expect (they early-return on missing spec).
 */
function unwrapDoorOutput(output: unknown): { data: DoorOutputData | undefined; spec: DoorSpec | undefined } {
  if (!output || typeof output !== 'object') return { data: undefined, spec: undefined };
  const env = output as DoorEnvelope;
  // Only view doors emit specs; exec doors have a different envelope shape.
  if (env.kind !== 'view') return { data: undefined, spec: undefined };
  // env.data is JsonValue | null; narrow to a record before accessing fields.
  const rawData = env.data;
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    return { data: undefined, spec: undefined };
  }
  const data = rawData as unknown as DoorOutputData;
  return { data, spec: data.spec };
}

/**
 * Extract a short summary from render door output.
 * Pulls title from EntryHeader, section headings from EntryBody markdown,
 * and key component types used.
 */
function extractRenderSummary(output: unknown): string | null {
  const { data, spec } = unwrapDoorOutput(output);

  const parts: string[] = [];

  // Use data.title as lead if it's clean (not a JSON blob or too long)
  if (typeof data?.title === 'string' && data.title.length < 120 && !data.title.trimStart().startsWith('{')) {
    parts.push(data.title);
  }

  // Scan spec elements for section structure
  if (spec?.elements) {
    for (const el of Object.values(spec.elements)) {
      const title = el.props?.title;
      if (el.type === 'EntryHeader' && typeof title === 'string') {
        if (!parts.includes(title)) parts.push(title);
      } else if (el.type === 'MetadataHeader' && typeof title === 'string') {
        if (!parts.includes(title)) parts.push(title);
      } else if (el.type === 'EntryBody' && typeof el.props?.markdown === 'string') {
        const headings = el.props.markdown
          .split('\n')
          .filter((line: string) => line.startsWith('## '))
          .map((line: string) => line.replace(/^##\s+/, '').trim());
        for (const h of headings) {
          if (!parts.includes(h)) parts.push(h);
        }
      } else if (el.type === 'PatternCard' && typeof el.props?.label === 'string') {
        if (!parts.includes(el.props.label)) parts.push(el.props.label);
      }
    }
  }

  if (parts.length === 0) return null;

  const summary = parts.slice(0, 8).join('. ');
  return summary.length > 300 ? summary.slice(0, 297) + '...' : summary;
}

/**
 * Prop keys we consider "text-bearing" for the generic fallback walker.
 * Order matters: keys earlier in the list get emitted first when an
 * unknown component carries multiple of them. Tuned to surface
 * heading-ish keys before body-ish keys.
 */
const STRING_PROP_KEYS = [
  'title', 'heading', 'label', 'name',
  'text', 'content', 'markdown',
  'description', 'summary', 'message', 'caption', 'alt',
  'value',
] as const;

/**
 * Generic prop walker for component types that don't have an explicit
 * markdown shape. Emits known text-bearing string props as plain lines
 * and {label, value/text/content} array shapes as bullet lists.
 *
 * Returns true if anything was emitted — caller uses this to decide
 * whether to wrap in a `<!-- ${type} -->` comment (signals to the reader
 * that the projection went through the generic walker, and grep target
 * for components worth promoting to an explicit case).
 *
 * Components that emit nothing (pure layout chrome like Stack/Grid)
 * still get their children walked by the surrounding switch — this
 * function only handles the parent's own props.
 */
function emitGenericPropLines(props: SpecElementProps, lines: string[]): boolean {
  let emitted = false;

  for (const key of STRING_PROP_KEYS) {
    const v = props[key];
    if (typeof v === 'string' && v.trim()) {
      lines.push(v.trim());
      emitted = true;
    }
  }

  // Array-of-records: {label, value/text/content} → bullet list.
  // Covers TimeEntry[], BarItem[], TagChip[], etc. at the prop level
  // (not the component level — those still get recursion via children).
  for (const v of Object.values(props)) {
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const i = item as Record<string, unknown>;
      if (typeof i.label !== 'string') continue;
      const valueField = i.value ?? i.text ?? i.content;
      if (valueField === undefined) continue;
      lines.push(`- **${i.label}**: ${String(valueField)}`);
      emitted = true;
    }
  }

  return emitted;
}

/**
 * Flatten a render spec into a markdown projection.
 * Walks the element tree in document order (following children refs),
 * extracting text content from each component type.
 *
 * Coverage strategy: ~20 high-frequency component types get explicit
 * cases that produce well-shaped markdown (headings, bullets, code
 * fences, blockquotes). Every other component falls through to a
 * generic prop walker (`emitGenericPropLines`) which emits text-bearing
 * props as plain lines — no silent drops. Pure layout chrome (Stack,
 * Grid, NavBrand, etc.) emits nothing but still recurses into children.
 */
export function flattenSpecToMarkdown(output: unknown): string | null {
  const { data, spec } = unwrapDoorOutput(output);
  if (!spec?.elements || !spec?.root) return null;

  const elements = spec.elements;
  const lines: string[] = [];
  const visiting = new Set<string>();

  // BarChart-scoped max value, threaded via closure so BarItem can scale
  // its filled-block bar relative to its containing chart. Restored on
  // exit so nested charts don't bleed scale into siblings.
  let currentBarMax = 1;

  // Title from data envelope
  if (typeof data?.title === 'string' && !data.title.trimStart().startsWith('{')) {
    lines.push(`# ${data.title}`, '');
  }

  function walk(key: string): void {
    if (visiting.has(key)) return;
    visiting.add(key);
    const el = elements[key];
    if (!el) { visiting.delete(key); return; }

    const p = el.props || {};

    switch (el.type) {
      case 'EntryHeader':
        lines.push(`## ${p.title || ''}${p.date ? ` (${p.date})` : ''}${p.author ? ` — ${p.author}` : ''}`);
        lines.push('');
        break;
      case 'MetadataHeader':
        lines.push(`## ${p.title || ''}`);
        lines.push('');
        break;
      case 'EntryBody':
        if (p.markdown) lines.push(p.markdown, '');
        break;
      case 'Text':
        if (p.content) lines.push(p.content);
        break;
      case 'PatternCard':
        lines.push(`### ${p.label || 'Pattern'}${p.confidence ? ` (${p.confidence})` : ''}`);
        if (p.description) lines.push('', p.description);
        lines.push('');
        break;
      case 'QuoteBlock':
        lines.push(`> ${p.text || ''}${p.attribution ? `\n> — ${p.attribution}` : ''}`);
        lines.push('');
        break;
      case 'TuiStat':
        lines.push(`- **${p.label}**: ${p.value}`);
        break;
      case 'Metric':
        lines.push(`- **${p.label}**: ${p.value}`);
        break;
      case 'StatsBar':
        if (Array.isArray(p.stats) && p.stats.length) {
          for (const s of p.stats) lines.push(`- **${s.label}**: ${s.value}`);
          lines.push('');
        }
        break;
      case 'WikilinkChip':
        lines.push(`- [[${p.target}]]${p.label ? ` ${p.label}` : ''}`);
        break;
      case 'BacklinksFooter':
        if (Array.isArray(p.inbound) && p.inbound.length) lines.push(`inbound: ${p.inbound.map((r: string) => `[[${r}]]`).join(', ')}`);
        if (Array.isArray(p.outbound) && p.outbound.length) lines.push(`outbound: ${p.outbound.map((r: string) => `[[${r}]]`).join(', ')}`);
        if ((Array.isArray(p.inbound) && p.inbound.length) || (Array.isArray(p.outbound) && p.outbound.length)) lines.push('');
        break;
      case 'Code':
        if (p.content) lines.push('```', p.content, '```', '');
        break;
      case 'NavBrand':
      case 'NavSection':
      case 'NavItem':
      case 'NavFooter':
        // Skip nav chrome
        break;
      case 'Divider':
        lines.push('---', '');
        break;

      // ── Added explicit cases (FLO-echo-fallback): high-frequency content
      //    components that have well-defined markdown shape and would lose
      //    structure under the generic walker.
      case 'Section':
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`## ${p.title}`, '');
        } else if (typeof p.heading === 'string' && p.heading.trim()) {
          lines.push(`## ${p.heading}`, '');
        }
        break;
      case 'Card':
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`### ${p.title}`, '');
        }
        if (typeof p.description === 'string' && p.description.trim()) {
          lines.push(p.description, '');
        }
        if (typeof p.content === 'string' && p.content.trim()) {
          lines.push(p.content, '');
        }
        break;
      case 'KanbanColumn':
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`### ${p.title}`, '');
        }
        break;
      case 'KanbanCard':
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`- **${p.title}**${typeof p.status === 'string' ? ` _(${p.status})_` : ''}`);
        }
        if (typeof p.description === 'string' && p.description.trim()) {
          lines.push(`  ${p.description}`);
        }
        break;
      case 'GapItem':
        lines.push(
          `- ${p.severity ? `**[${p.severity}]** ` : ''}${p.label || p.title || ''}${
            p.description ? ` — ${p.description}` : ''
          }`,
        );
        break;
      case 'TimeEntry':
        lines.push(
          `- ${p.time || ''}${p.time && (p.activity || p.label) ? ': ' : ''}${
            p.activity || p.label || ''
          }${p.project ? ` _(${p.project})_` : ''}`,
        );
        break;
      case 'RefCard':
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`### ${p.title}`);
        }
        if (typeof p.ref === 'string' && p.ref.trim()) {
          lines.push(`ref: [[${p.ref}]]`);
        }
        if (typeof p.summary === 'string' && p.summary.trim()) {
          lines.push('', p.summary, '');
        }
        break;
      case 'RefSection':
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`## ${p.title}`, '');
        }
        break;
      case 'TagChip':
      case 'ModeTag':
        if (typeof p.label === 'string') lines.push(`\`${p.label}\``);
        else if (typeof p.mode === 'string') lines.push(`\`${p.mode}\``);
        break;
      case 'Image': {
        const src = typeof p.src === 'string' ? p.src : '';
        const alt = typeof p.alt === 'string' ? p.alt : '';
        if (src) lines.push(`![${alt}](${src})`, '');
        else if (alt) lines.push(`_(image: ${alt})_`);
        break;
      }
      case 'Button':
        if (typeof p.label === 'string' && p.label.trim()) {
          lines.push(`_[button: ${p.label}]_`);
        }
        break;


      // ── Round 2 (FLO-echo-blockdown): explicit cases for the 11 most-frequent
      //    fall-through types found in the live render-door corpus. Borrows
      //    width-agnostic ASCII idioms from the W15 dispatch ([[3d40632d]]):
      //    `▓▓▒▒ TITLE ▒▒▓▓` shading borders for sectioned headers, `█`
      //    filled blocks for value-scaled bars, `· · ·` for ellipsis. Floatty's
      //    terminal renderer highlights these distinctively even outside fences.

      case 'CollapsibleSection':
        if (typeof p.title === 'string' && p.title.trim()) {
          const count = typeof p.count === 'number' ? ` (${p.count})` : '';
          lines.push(`▓▓▒▒ ${p.title}${count} ▒▒▓▓`, '');
        }
        break;
      case 'TuiPanel':
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`▓▓▒▒ ${p.title} ▒▒▓▓`, '');
        }
        break;
      case 'BarChart': {
        // BarChart owns its own children walk so it can pre-compute max
        // and pass it to BarItems via the closure-scoped currentBarMax.
        // We still need the "skip auto-recursion" trick (return early).
        let max = typeof p.max === 'number' ? p.max : 0;
        if (Array.isArray(el.children)) {
          for (const childKey of el.children) {
            const c = elements[childKey];
            const cv = c?.props?.value;
            if (c?.type === 'BarItem' && typeof cv === 'number') {
              max = Math.max(max, cv);
            }
          }
        }
        const prevMax = currentBarMax;
        currentBarMax = Math.max(1, max);
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`### ${p.title}`, '');
        }
        if (Array.isArray(el.children)) {
          for (const childKey of el.children) walk(childKey);
        }
        lines.push('');
        currentBarMax = prevMax;
        visiting.delete(key);
        return; // skip the default child-recursion below
      }
      case 'BarItem': {
        // Horizontal filled-block bar normalized to BAR_WIDTH chars,
        // scaled against the containing BarChart's max. Mirrors the W15
        // dispatch's `Mon Apr 6  ██████████████████ 218` idiom.
        const BAR_WIDTH = 20;
        const value = typeof p.value === 'number' ? p.value : 0;
        const label = typeof p.label === 'string' ? p.label : '';
        const scaled = Math.round((value / currentBarMax) * BAR_WIDTH);
        const fill = '█'.repeat(Math.max(0, Math.min(BAR_WIDTH, scaled)));
        lines.push(`  ${label.padEnd(14)} ${fill.padEnd(BAR_WIDTH)} ${value}`);
        break;
      }
      case 'StatPill':
        if (typeof p.label === 'string') {
          lines.push(`- **${p.label}**: ${typeof p.value === 'string' || typeof p.value === 'number' ? p.value : ''}`);
        }
        break;
      case 'ShippedItem':
        if (typeof p.content === 'string' && p.content.trim()) {
          // Per catalog: "green asterisk bullet item for shipped/completed work"
          lines.push(`* ✦ ${p.content}`);
        }
        break;
      case 'TimelineEvent':
        if (typeof p.time === 'string' || typeof p.label === 'string') {
          const time = typeof p.time === 'string' ? p.time : '';
          const label = typeof p.label === 'string' ? p.label : '';
          lines.push(`- ${time}${time && label ? ' · ' : ''}${label}`);
        }
        break;
      case 'Breadcrumb':
        if (typeof p.label === 'string' && p.label.trim()) {
          lines.push(`_← ${p.label}_`, '');
        }
        break;
      case 'Ellipsis':
        // Per catalog: "Centered · · · separator indicating truncated content"
        lines.push('· · ·', '');
        break;
      case 'DataBlock':
        if (typeof p.content === 'string') {
          if (typeof p.label === 'string' && p.label.trim()) {
            lines.push(`**${p.label}**`);
          }
          lines.push('```', p.content, '```', '');
        }
        break;
      case 'LinkGraph': {
        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`### ${p.title}`, '');
        }
        if (Array.isArray(p.nodes) && p.nodes.length) {
          lines.push('nodes:');
          for (const n of p.nodes) {
            if (n && typeof n === 'object' && !Array.isArray(n)) {
              const node = n as Record<string, unknown>;
              if (typeof node.label === 'string') {
                lines.push(`- ${node.label}`);
              }
            }
          }
          lines.push('');
        }
        if (Array.isArray(p.edges) && p.edges.length) {
          lines.push('edges:');
          for (const e of p.edges) {
            if (
              Array.isArray(e) &&
              e.length === 2 &&
              typeof e[0] === 'string' &&
              typeof e[1] === 'string'
            ) {
              lines.push(`- ${e[0]} → ${e[1]}`);
            }
          }
          lines.push('');
        }
        break;
      }

      case 'TreeView': {
        // TreeView ↔ outline is the same shape: hierarchical {label, status,
        // detail, children}. Emit as indented bullets so parseMarkdownTree
        // reconstructs the tree as nested child blocks (2 spaces = 1 level
        // deeper, see markdownParser.ts). Status enum maps to a leading
        // unicode symbol — colors don't round-trip, but the structure does.
        const TREE_STATUS_SYMBOL: Record<string, string> = {
          done: '✓',
          active: '▸',
          pending: '○',
          deferred: '⊘',
        };

        if (typeof p.title === 'string' && p.title.trim()) {
          lines.push(`## ${p.title}`, '');
        }

        const renderNode = (node: unknown, depth: number): void => {
          if (!node || typeof node !== 'object') return;
          const n = node as {
            label?: unknown;
            status?: unknown;
            detail?: unknown;
            children?: unknown;
          };
          const label = typeof n.label === 'string' ? n.label : '';
          if (!label) return;
          const symbol =
            typeof n.status === 'string' && n.status in TREE_STATUS_SYMBOL
              ? `${TREE_STATUS_SYMBOL[n.status]} `
              : '';
          const detail = typeof n.detail === 'string' && n.detail.trim()
            ? ` — ${n.detail.trim()}`
            : '';
          const indent = '  '.repeat(depth);
          lines.push(`${indent}- ${symbol}${label}${detail}`);
          if (Array.isArray(n.children)) {
            for (const child of n.children) renderNode(child, depth + 1);
          }
        };

        if (Array.isArray(p.nodes)) {
          for (const node of p.nodes) renderNode(node, 0);
          lines.push('');
        }

        if (Array.isArray(p.connectsTo) && p.connectsTo.length) {
          lines.push(
            `connects: ${p.connectsTo
              .filter((r): r is string => typeof r === 'string')
              .map((r) => `[[${r}]]`)
              .join(', ')}`,
            '',
          );
        }
        break;
      }

      // Generic fallback: any component type not enumerated above.
      // Walks known text-bearing props + {label, value} arrays.
      // Wraps emitted output in a `<!-- ${type} -->` comment so future
      // readers can grep echoCopy output for components worth promoting
      // to an explicit case. Pure layout chrome (no text props, no
      // matching arrays) emits nothing — children still recurse below.
      default: {
        const before = lines.length;
        const emitted = emitGenericPropLines(p, lines);
        if (emitted) {
          lines.splice(before, 0, `<!-- ${el.type} -->`);
          lines.push('');
        }
        break;
      }
    }

    // Recurse children
    if (Array.isArray(el.children)) {
      for (const childKey of el.children) {
        walk(childKey);
      }
    }

    visiting.delete(key);
  }

  walk(spec.root);

  const result = lines.join('\n').trim();
  return result.length > 0 ? result : null;
}

/**
 * Extract summary from any block output based on outputType.
 */
function extractSummary(output: unknown, outputType: string): string | null {
  if (outputType === 'door') {
    return extractRenderSummary(output);
  }
  return null;
}

/**
 * Extract rendered markdown from any block output based on outputType.
 */
function extractRenderedMarkdown(output: unknown, outputType: string): string | null {
  if (outputType === 'door') {
    return flattenSpecToMarkdown(output);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLER
// ═══════════════════════════════════════════════════════════════

function handleBlockEvent(envelope: EventEnvelope): void {
  if (envelope.origin === Origin.Hook) return;

  for (const event of envelope.events) {
    if (event.type !== 'block:update') continue;

    // Only process when output-related fields changed
    const changed = event.changedFields ?? [];
    if (!changed.includes('output') && !changed.includes('outputType')) continue;

    const block = event.block;
    if (!block) continue;

    const outputType = block.outputType;
    const output = block.output;

    if (!outputType || !output) {
      // Output was cleared — remove summary + rendered if they existed
      if (block.metadata?.summary || block.metadata?.renderedMarkdown) {
        blockStore.updateBlockMetadata(block.id, {
          summary: undefined,
          renderedMarkdown: undefined,
        }, 'hook');
      }
      continue;
    }

    const summary = extractSummary(output, outputType);
    const rendered = extractRenderedMarkdown(output, outputType);

    const summaryChanged = summary !== (block.metadata?.summary ?? null);
    const renderedChanged = rendered !== (block.metadata?.renderedMarkdown ?? null);

    if (!summaryChanged && !renderedChanged) continue;

    if (summary) {
      logger.debug('Extracted summary', {
        blockId: block.id,
        summary: summary.slice(0, 80),
      });
    }

    blockStore.updateBlockMetadata(block.id, {
      summary: summary ?? undefined,
      renderedMarkdown: rendered ?? undefined,
      extractedAt: Date.now(),
    }, 'hook');
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════

let _subscriptionId: string | null = null;
let _backfillTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Backfill summaries for existing blocks that have output but no summary.
 * Runs once at startup — no re-rendering needed.
 */
function backfillExistingSummaries(): void {
  const blocks = blockStore.blocks;
  let count = 0;

  for (const block of Object.values(blocks)) {
    if (!block.outputType || !block.output) continue;
    const hasSummary = !!block.metadata?.summary;
    const hasRendered = !!block.metadata?.renderedMarkdown;
    if (hasSummary && hasRendered) continue;

    const updates: Record<string, unknown> = { extractedAt: Date.now() };
    let changed = false;

    if (!hasSummary) {
      const summary = extractSummary(block.output, block.outputType);
      if (summary) { updates.summary = summary; changed = true; }
    }
    if (!hasRendered) {
      const rendered = extractRenderedMarkdown(block.output, block.outputType);
      if (rendered) { updates.renderedMarkdown = rendered; changed = true; }
    }

    if (changed) {
      blockStore.updateBlockMetadata(block.id, updates, 'hook');
      count++;
    }
  }

  if (count > 0) {
    logger.info(`Backfilled summaries for ${count} blocks`);
  }
}

export function registerOutputSummaryHook(): void {
  if (_subscriptionId) {
    logger.debug('Already registered');
    return;
  }

  _subscriptionId = blockEventBus.subscribe(handleBlockEvent, {
    filter: EventFilters.updates(),
    priority: 60,  // After ctx/outlinks hooks (50)
    name: 'output-summary-extractor',
  });

  // Backfill existing blocks that predate the hook
  _backfillTimer = setTimeout(backfillExistingSummaries, 2000);

  logger.info('Registered with EventBus');
}

export function unregisterOutputSummaryHook(): void {
  if (_backfillTimer) {
    clearTimeout(_backfillTimer);
    _backfillTimer = null;
  }
  if (_subscriptionId) {
    blockEventBus.unsubscribe(_subscriptionId);
    _subscriptionId = null;
    logger.debug('Unregistered from EventBus');
  }
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unregisterOutputSummaryHook();
  });
}
