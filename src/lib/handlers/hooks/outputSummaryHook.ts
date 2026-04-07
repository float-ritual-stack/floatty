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

const logger = createLogger('outputSummaryHook');

// ═══════════════════════════════════════════════════════════════
// SUMMARY EXTRACTION
// ═══════════════════════════════════════════════════════════════

/**
 * Extract a short summary from render door output.
 * Pulls title from EntryHeader, section headings from EntryBody markdown,
 * and key component types used.
 */
function extractRenderSummary(output: any): string | null {
  // Door envelope: { kind, doorId, schema, data: { spec, title, ... } }
  const data = output?.data;
  const spec = data?.spec ?? output?.spec;

  const parts: string[] = [];

  // Use data.title as lead if it's clean (not a JSON blob or too long)
  if (data?.title && typeof data.title === 'string' && data.title.length < 120 && !data.title.trimStart().startsWith('{')) {
    parts.push(data.title);
  }

  // Scan spec elements for section structure
  if (spec?.elements) {
    for (const el of Object.values(spec.elements as Record<string, any>)) {
      if (el.type === 'EntryHeader' && el.props?.title) {
        const t = el.props.title;
        if (!parts.includes(t)) parts.push(t);
      } else if (el.type === 'MetadataHeader' && el.props?.title) {
        const t = el.props.title;
        if (!parts.includes(t)) parts.push(t);
      } else if (el.type === 'EntryBody' && el.props?.markdown) {
        const headings = (el.props.markdown as string)
          .split('\n')
          .filter((line: string) => line.startsWith('## '))
          .map((line: string) => line.replace(/^##\s+/, '').trim());
        for (const h of headings) {
          if (!parts.includes(h)) parts.push(h);
        }
      } else if (el.type === 'PatternCard' && el.props?.title) {
        const t = el.props.title;
        if (!parts.includes(t)) parts.push(t);
      }
    }
  }

  if (parts.length === 0) return null;

  const summary = parts.slice(0, 8).join('. ');
  return summary.length > 300 ? summary.slice(0, 297) + '...' : summary;
}

/**
 * Extract summary from any block output based on outputType.
 */
function extractSummary(output: any, outputType: string): string | null {
  if (outputType === 'door') {
    return extractRenderSummary(output);
  }
  // Future: handle search-results, eval-result, etc.
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
      // Output was cleared — remove summary if it existed
      if (block.metadata?.summary) {
        blockStore.updateBlockMetadata(block.id, {
          summary: undefined,
        }, 'hook');
      }
      continue;
    }

    const summary = extractSummary(output, outputType);

    // Skip if summary unchanged
    if (summary === (block.metadata?.summary ?? null)) continue;

    if (summary) {
      logger.debug('Extracted summary', {
        blockId: block.id,
        summary: summary.slice(0, 80),
      });
    }

    blockStore.updateBlockMetadata(block.id, {
      summary: summary ?? undefined,
      extractedAt: Date.now(),
    }, 'hook');
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════

let _subscriptionId: string | null = null;

/**
 * Backfill summaries for existing blocks that have output but no summary.
 * Runs once at startup — no re-rendering needed.
 */
function backfillExistingSummaries(): void {
  const blocks = blockStore.blocks;
  let count = 0;

  for (const block of Object.values(blocks)) {
    if (!block.outputType || !block.output) continue;
    if (block.metadata?.summary) continue;  // Already has summary

    const summary = extractSummary(block.output, block.outputType);
    if (summary) {
      blockStore.updateBlockMetadata(block.id, {
        summary,
        extractedAt: Date.now(),
      }, 'hook');
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
  setTimeout(backfillExistingSummaries, 2000);

  logger.info('Registered with EventBus');
}

export function unregisterOutputSummaryHook(): void {
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
