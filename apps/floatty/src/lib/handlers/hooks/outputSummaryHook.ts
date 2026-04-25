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
      } else if (el.type === 'PatternCard' && typeof title === 'string') {
        if (!parts.includes(title)) parts.push(title);
      }
    }
  }

  if (parts.length === 0) return null;

  const summary = parts.slice(0, 8).join('. ');
  return summary.length > 300 ? summary.slice(0, 297) + '...' : summary;
}

/**
 * Flatten a render spec into a markdown projection.
 * Walks the element tree in document order (following children refs),
 * extracting text content from each component type.
 */
export function flattenSpecToMarkdown(output: unknown): string | null {
  const { data, spec } = unwrapDoorOutput(output);
  if (!spec?.elements || !spec?.root) return null;

  const elements = spec.elements;
  const lines: string[] = [];
  const visiting = new Set<string>();

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
        lines.push(`### ${p.title || 'Pattern'}${p.type ? ` [${p.type}]` : ''}${p.confidence ? ` (${p.confidence})` : ''}`);
        if (p.content) lines.push('', p.content);
        if (Array.isArray(p.connectsTo) && p.connectsTo.length) lines.push('', `connects to: ${p.connectsTo.map((c: string) => `[[${c}]]`).join(', ')}`);
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
        // Skip nav chrome
        break;
      case 'NavSection':
      case 'NavItem':
      case 'NavFooter':
        // Skip nav chrome
        break;
      case 'Divider':
        lines.push('---', '');
        break;
      // Layout containers — just recurse children
      default:
        break;
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
