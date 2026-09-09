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
import { extractAllMarkers } from '../../markerGrammar';
import type { Marker } from '../../../generated/Marker';
import { blockStore } from '../../../hooks/useBlockStore';
import { createLogger } from '../../logger';

const logger = createLogger('ctxRouterHook');

// ═══════════════════════════════════════════════════════════════
// MARKER EXTRACTION
// ═══════════════════════════════════════════════════════════════

// FLO-954: extraction is the server's grammar, verbatim (`markerGrammar.ts`
// twins `parsing.rs` extract_all_markers; shared corpus asserts both). The
// previous extractor only looked when a `ctx::YYYY-MM-DD` was present and
// only knew six tag keys — so for an API-created `[project::x]` block it
// computed `[]`, and the steady-state remote re-emission below turned that
// into `markers: []` written over the server's extraction.
const extractMarkers = extractAllMarkers;

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

    // Extract markers (may be empty if patterns were removed)
    const markers = extractMarkers(block.content);

    // Check if markers changed (skip no-op updates)
    const existingMarkers = block.metadata?.markers ?? [];
    if (markersEqual(existingMarkers, markers)) continue;

    // A remote block already carries the server's extraction. If ours would
    // EMPTY it, the grammars have drifted — say so and keep the server's
    // result rather than clobbering it (FLO-954). Local edits still clear
    // stale markers as before.
    if (envelope.origin === Origin.Remote && markers.length === 0 && existingMarkers.length > 0) {
      logger.warn('marker grammar drift: remote block has markers this client cannot see — keeping the server\'s', {
        blockId: block.id,
        existing: existingMarkers.map(m => `${m.markerType}::${m.value ?? ''}`),
      });
      continue;
    }

    // Store markers in block metadata (empty array clears stale markers)
    if (markers.length > 0) {
      logger.debug('Extracted markers', {
        blockId: block.id,
        markers: markers.map(m => `${m.markerType}::${m.value ?? ''}`),
      });
    }

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
    logger.debug('Already registered');
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

  logger.info('Registered with EventBus');
}

/**
 * Unregister the hook (for testing/cleanup).
 */
export function unregisterCtxRouterHook(): void {
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
    unregisterCtxRouterHook();
  });
}
