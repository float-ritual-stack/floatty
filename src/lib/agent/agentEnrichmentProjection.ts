/**
 * Agent Enrichment Projection
 *
 * Background ProjectionScheduler handler that enriches block metadata
 * via LLM analysis. Detects ambiguous references and auto-links issue numbers.
 *
 * Architecture:
 * - Registered with blockProjectionScheduler (2s flush interval)
 * - Maintains internal FIFO queue across flush cycles (max 100 block IDs)
 * - Processes up to 5 blocks per cycle to avoid Ollama overload
 * - Writes metadata with Origin.Agent to prevent self-triggering
 * - Logs all activity to SQLite via Tauri commands
 *
 * @see docs/architecture/FLOATTY_HOOK_SYSTEM.md
 */

import { invoke } from '@tauri-apps/api/core';
import { createSignal } from 'solid-js';
import {
  blockProjectionScheduler,
  Origin,
  EventFilters,
  type EventEnvelope,
} from '../events';
import { blockStore } from '../../hooks/useBlockStore';
import { computeEffectiveMetadata, findNewMarkers } from '../metadataInheritance';
import type { Marker } from '../../generated/Marker';
import type { AgentStatus, EnrichmentResult } from './agentTypes';
import {
  AGENT_BATCH_SIZE,
  AGENT_MAX_QUEUE_SIZE,
  ENRICHMENT_SYSTEM_PROMPT,
} from './agentTypes';

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

/** Internal queue of block IDs pending enrichment (persists across flush cycles) */
const blockIdQueue: string[] = [];

/** Agent status signal for UI indicator */
const [agentStatus, setAgentStatus] = createSignal<AgentStatus>('idle');

/** Projection ID for cleanup */
let _projectionId: string | null = null;

// ═══════════════════════════════════════════════════════════════
// PURE FUNCTIONS (testable)
// ═══════════════════════════════════════════════════════════════

/**
 * Build the user message for enrichment LLM call.
 *
 * Includes block content and inherited marker context so the LLM
 * understands the block's position in the hierarchy.
 */
export function buildEnrichmentPrompt(
  content: string,
  inheritedMarkers: Marker[]
): string {
  let prompt = `Block content: "${content}"`;

  if (inheritedMarkers.length > 0) {
    const markerStr = inheritedMarkers
      .map(m => `${m.markerType}${m.value ? `::${m.value}` : ''}`)
      .join(', ');
    prompt += `\n\nInherited context markers: ${markerStr}`;
  }

  return prompt;
}

/**
 * Parse LLM response into structured enrichment result.
 *
 * Handles malformed JSON gracefully — returns empty markers on failure.
 */
export function parseAgentResponse(response: string): EnrichmentResult {
  try {
    // Strip markdown fencing if present (LLMs sometimes add it despite instructions)
    let cleaned = response.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const parsed = JSON.parse(cleaned);

    if (!parsed || !Array.isArray(parsed.markers)) {
      return { markers: [] };
    }

    // Validate each marker has required fields
    const validMarkers: Marker[] = parsed.markers
      .filter((m: unknown) => {
        if (typeof m !== 'object' || m === null) return false;
        const obj = m as Record<string, unknown>;
        return typeof obj.markerType === 'string' && obj.markerType.length > 0;
      })
      .map((m: Record<string, unknown>) => ({
        markerType: m.markerType as string,
        value: typeof m.value === 'string' ? m.value : null,
      }));

    return { markers: validMarkers };
  } catch {
    return { markers: [] };
  }
}

// ═══════════════════════════════════════════════════════════════
// ENRICHMENT LOGIC
// ═══════════════════════════════════════════════════════════════

/**
 * Enrich a single block: compute context, call LLM, write metadata.
 * Returns the markers that were added (empty if skipped).
 */
async function enrichBlock(blockId: string): Promise<{ action: 'enrich' | 'skip' | 'error'; markers: Marker[]; reason?: string }> {
  const block = blockStore.getBlock(blockId);
  if (!block) {
    return { action: 'skip', markers: [], reason: 'block deleted' };
  }

  // Skip blocks with very short content (not worth LLM call)
  if (block.content.trim().length < 5) {
    return { action: 'skip', markers: [], reason: 'content too short' };
  }

  // Compute effective metadata (own + ancestors' markers)
  const effective = computeEffectiveMetadata(blockId, (id) => blockStore.getBlock(id));

  // Build prompt with context
  const userMessage = buildEnrichmentPrompt(block.content, effective.markers);

  try {
    // Call Ollama via existing Tauri command
    const response = await invoke<string>('execute_ai_conversation', {
      messages: [{ role: 'user', content: userMessage }],
      system: ENRICHMENT_SYSTEM_PROMPT,
    });

    // Parse LLM response
    const result = parseAgentResponse(response);

    if (result.markers.length === 0) {
      return { action: 'skip', markers: [], reason: 'no enrichment needed' };
    }

    // Deduplicate against existing markers
    const existingMarkers = block.metadata?.markers ?? [];
    const newMarkers = findNewMarkers(existingMarkers, result.markers);

    if (newMarkers.length === 0) {
      return { action: 'skip', markers: [], reason: 'markers already exist' };
    }

    // Write enriched markers (merge with existing)
    const mergedMarkers = [...existingMarkers, ...newMarkers];
    blockStore.updateBlockMetadata(blockId, {
      markers: mergedMarkers,
      extractedAt: Date.now(),
    }, 'agent'); // CRITICAL: Origin.Agent prevents self-triggering

    return { action: 'enrich', markers: newMarkers };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { action: 'error', markers: [], reason };
  }
}

/**
 * Log an activity entry to SQLite via Tauri command.
 * Fire-and-forget — errors are caught and logged to console.
 */
async function logActivity(
  blockId: string,
  action: 'enrich' | 'skip' | 'error',
  markers: Marker[],
  reason?: string
): Promise<void> {
  try {
    await invoke('log_agent_activity', {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      blockId,
      action,
      addedMarkers: markers.length > 0 ? JSON.stringify(markers) : null,
      reason: reason ?? null,
    });
  } catch (error) {
    console.error('[agent] Failed to log activity:', error);
  }
}

// ═══════════════════════════════════════════════════════════════
// PROJECTION HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * ProjectionScheduler handler — called every 2s with batched events.
 *
 * 1. Adds new block IDs from events to internal queue (deduped)
 * 2. Splices up to AGENT_BATCH_SIZE blocks from front
 * 3. Enriches each block sequentially (avoids Ollama overload)
 * 4. Logs activity for each block
 */
async function handleAgentEnrichment(envelope: EventEnvelope): Promise<void> {
  // 1. Queue new block IDs (dedup against existing queue)
  const queueSet = new Set(blockIdQueue);
  for (const event of envelope.events) {
    if (event.blockId && !queueSet.has(event.blockId)) {
      blockIdQueue.push(event.blockId);
      queueSet.add(event.blockId);
    }
  }

  // Enforce max queue size (FIFO eviction)
  while (blockIdQueue.length > AGENT_MAX_QUEUE_SIZE) {
    blockIdQueue.shift();
  }

  // 2. Splice batch from front of queue
  const batch = blockIdQueue.splice(0, AGENT_BATCH_SIZE);
  if (batch.length === 0) {
    setAgentStatus('idle');
    return;
  }

  // 3. Process each block sequentially
  setAgentStatus('active');
  let hasError = false;

  for (const blockId of batch) {
    try {
      const result = await enrichBlock(blockId);
      await logActivity(blockId, result.action, result.markers, result.reason);

      if (result.action === 'error') {
        hasError = true;
      }
    } catch (error) {
      hasError = true;
      console.error(`[agent] Enrichment failed for ${blockId}:`, error);
      await logActivity(blockId, 'error', [], error instanceof Error ? error.message : String(error));
    }
  }

  // 4. Update status
  if (hasError) {
    setAgentStatus('offline');
  } else if (blockIdQueue.length > 0) {
    setAgentStatus('active');
  } else {
    setAgentStatus('idle');
  }
}

// ═══════════════════════════════════════════════════════════════
// REGISTRATION
// ═══════════════════════════════════════════════════════════════

/**
 * Register the agent enrichment projection with the ProjectionScheduler.
 * Safe to call multiple times — will skip if already registered.
 */
export function registerAgentEnrichment(): void {
  if (_projectionId) {
    console.log('[agent] Already registered');
    return;
  }

  _projectionId = blockProjectionScheduler.register(
    'agent-enrichment',
    handleAgentEnrichment,
    {
      filter: EventFilters.all(
        EventFilters.any(
          EventFilters.creates(),
          EventFilters.updates()
        ),
        EventFilters.notFromOrigin(Origin.Hook),
        EventFilters.notFromOrigin(Origin.Agent),
      ),
    }
  );

  console.log('[agent] Registered enrichment projection with ProjectionScheduler');
}

/**
 * Unregister the agent enrichment projection (for testing/cleanup).
 */
export function unregisterAgentEnrichment(): void {
  if (_projectionId) {
    blockProjectionScheduler.unregister(_projectionId);
    _projectionId = null;
    blockIdQueue.length = 0;
    console.log('[agent] Unregistered enrichment projection');
  }
}

/**
 * Get current agent status (for UI indicator).
 */
export { agentStatus };

/**
 * Get current queue size (for monitoring/debugging).
 */
export function getQueueSize(): number {
  return blockIdQueue.length;
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unregisterAgentEnrichment();
  });
}
