/**
 * Outlinks Extraction Hook
 *
 * Subscribes to blockEventBus for block:create and block:update events.
 * Extracts [[wikilink]] targets from content and stores them in block.metadata.outlinks.
 *
 * This enables backlink queries: "what blocks link to [[Page X]]?"
 *
 * @see docs/architecture/FLOATTY_HOOK_SYSTEM.md
 */

import {
  blockEventBus,
  Origin,
  type EventEnvelope,
  EventFilters,
} from '../../events';
import { hasWikilinkPatterns, parseAllInlineTokens } from '../../inlineParser';
import { blockStore } from '../../../hooks/useBlockStore';

// ═══════════════════════════════════════════════════════════════
// OUTLINK EXTRACTION
// ═══════════════════════════════════════════════════════════════

/**
 * Extract outlinks (wikilink targets) from block content.
 * Returns deduplicated array of page names.
 */
function extractOutlinks(content: string): string[] {
  if (!hasWikilinkPatterns(content)) return [];

  const tokens = parseAllInlineTokens(content);
  const outlinks = new Set<string>();

  for (const token of tokens) {
    if (token.type === 'wikilink' && token.target) {
      outlinks.add(token.target);
    }
  }

  return Array.from(outlinks);
}

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Handle block events - extract and store outlinks.
 */
function handleBlockEvent(envelope: EventEnvelope): void {
  // Skip if origin is Hook (prevents infinite loops)
  if (envelope.origin === Origin.Hook) return;

  for (const event of envelope.events) {
    // Only process creates and updates
    if (event.type !== 'block:create' && event.type !== 'block:update') continue;

    const block = event.block;
    if (!block) continue;

    // Extract outlinks (may be empty if wikilinks were removed)
    const outlinks = extractOutlinks(block.content);

    // Check if outlinks changed (skip no-op updates)
    const existingOutlinks = block.metadata?.outlinks ?? [];
    if (outlinksEqual(existingOutlinks, outlinks)) continue;

    // Store outlinks in block metadata (empty array clears stale outlinks)
    if (outlinks.length > 0) {
      console.log('[outlinksHook] Extracted outlinks:', {
        blockId: block.id,
        outlinks,
      });
    }

    blockStore.updateBlockMetadata(block.id, {
      outlinks,
      extractedAt: Date.now(),
    }, 'hook');
  }
}

/**
 * Compare two outlinks arrays for equality (order-independent).
 */
function outlinksEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every(link => setA.has(link));
}

// ═══════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════

let _subscriptionId: string | null = null;

/**
 * Register the outlinks hook with the EventBus.
 * Safe to call multiple times - will skip if already registered.
 */
export function registerOutlinksHook(): void {
  if (_subscriptionId) {
    console.log('[outlinksHook] Already registered');
    return;
  }

  _subscriptionId = blockEventBus.subscribe(handleBlockEvent, {
    filter: EventFilters.any(
      EventFilters.creates(),
      EventFilters.updates()
    ),
    priority: 50,  // Standard processing
    name: 'outlinks-extractor',
  });

  console.log('[outlinksHook] Registered with EventBus');
}

/**
 * Unregister the hook (for testing/cleanup).
 */
export function unregisterOutlinksHook(): void {
  if (_subscriptionId) {
    blockEventBus.unsubscribe(_subscriptionId);
    _subscriptionId = null;
    console.log('[outlinksHook] Unregistered from EventBus');
  }
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unregisterOutlinksHook();
  });
}
