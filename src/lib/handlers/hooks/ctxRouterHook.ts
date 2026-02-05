/**
 * ctx:: Router Hook
 *
 * Subscribes to blockEventBus for block:create and block:update events.
 * Extracts ctx:: markers from content and stores them in block.metadata.
 *
 * This is the first piece of the "agent loop" - parsing user-written ctx::
 * markers and persisting them to the CRDT for downstream consumers.
 *
 * @see docs/architecture/FLOATTY_HOOK_SYSTEM.md
 */

import {
  blockEventBus,
  Origin,
  type EventEnvelope,
  EventFilters,
} from '../../events';
import { hasCtxPatterns, parseAllInlineTokens } from '../../inlineParser';
import type { Marker } from '../../../generated/Marker';
import { blockStore } from '../../../hooks/useBlockStore';

// ═══════════════════════════════════════════════════════════════
// MARKER EXTRACTION
// ═══════════════════════════════════════════════════════════════

/**
 * Extract Marker[] from block content.
 * Uses inlineParser's parseAllInlineTokens to find ctx:: patterns.
 */
function extractCtxMarkers(content: string): Marker[] {
  if (!hasCtxPatterns(content)) return [];

  const tokens = parseAllInlineTokens(content);
  const markers: Marker[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.type === 'ctx-prefix') {
      // ctx:: prefix - check if followed by a timestamp
      // Look for ctx-timestamp in next few tokens (may have whitespace text between)
      let dateValue: string | null = null;
      for (let j = i + 1; j < Math.min(i + 3, tokens.length); j++) {
        if (tokens[j].type === 'ctx-timestamp') {
          // Extract just YYYY-MM-DD from timestamp (ignore time portion)
          const dateMatch = tokens[j].content.match(/^(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            dateValue = dateMatch[1];
          }
          break;
        }
        // Stop if we hit a non-text token (means no timestamp follows)
        if (tokens[j].type !== 'text') break;
      }
      markers.push({ markerType: 'ctx', value: dateValue });
    } else if (token.type === 'ctx-tag' && token.tagType) {
      // [project::floatty], [mode::work], [issue::123]
      markers.push({ markerType: token.tagType, value: token.content });
    }
  }

  return markers;
}

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Handle block events - extract and store ctx:: markers.
 */
function handleBlockEvent(envelope: EventEnvelope): void {
  // Skip if origin is Hook (prevents infinite loops)
  if (envelope.origin === Origin.Hook) return;

  for (const event of envelope.events) {
    // Only process creates and updates
    if (event.type !== 'block:create' && event.type !== 'block:update') continue;

    const block = event.block;
    if (!block) continue;

    // Skip if no ctx:: patterns in content
    if (!hasCtxPatterns(block.content)) continue;

    // Extract markers
    const markers = extractCtxMarkers(block.content);
    if (markers.length === 0) continue;

    // Check if markers changed (skip no-op updates)
    const existingMarkers = block.metadata?.markers ?? [];
    if (markersEqual(existingMarkers, markers)) continue;

    // Store markers in block metadata
    console.log('[ctxRouterHook] Extracted markers:', {
      blockId: block.id,
      markers: markers.map(m => `${m.markerType}::${m.value ?? ''}`),
    });

    blockStore.updateBlockMetadata(block.id, {
      markers,
      extractedAt: Date.now(),
    }, 'hook');
  }
}

/**
 * Compare two marker arrays for equality.
 */
function markersEqual(a: Marker[], b: Marker[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].markerType !== b[i].markerType) return false;
    if (a[i].value !== b[i].value) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════

let _subscriptionId: string | null = null;

/**
 * Register the ctx router hook with the EventBus.
 * Safe to call multiple times - will skip if already registered.
 */
export function registerCtxRouterHook(): void {
  if (_subscriptionId) {
    console.log('[ctxRouterHook] Already registered');
    return;
  }

  _subscriptionId = blockEventBus.subscribe(handleBlockEvent, {
    filter: EventFilters.any(
      EventFilters.creates(),
      EventFilters.updates()
    ),
    priority: 50,  // Standard processing
    name: 'ctx-router',
  });

  console.log('[ctxRouterHook] Registered with EventBus');
}

/**
 * Unregister the hook (for testing/cleanup).
 */
export function unregisterCtxRouterHook(): void {
  if (_subscriptionId) {
    blockEventBus.unsubscribe(_subscriptionId);
    _subscriptionId = null;
    console.log('[ctxRouterHook] Unregistered from EventBus');
  }
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unregisterCtxRouterHook();
  });
}
