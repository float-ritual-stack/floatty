/**
 * Agent Types — Shared type definitions for the metadata enrichment agent
 */

import type { Marker } from '../../generated/Marker';

/**
 * Agent status for UI indicator.
 * - 'active': Last enrichment succeeded, agent processing normally
 * - 'idle': No pending blocks in queue
 * - 'offline': Ollama unreachable or last call failed
 */
export type AgentStatus = 'active' | 'idle' | 'offline';

/**
 * Activity log entry shape (mirrors Rust AgentActivityEntry).
 * Returned from `get_agent_log` Tauri command.
 */
export interface AgentActivityEntry {
  id: string;
  timestamp: number;
  blockId: string;
  action: 'enrich' | 'skip' | 'error';
  addedMarkers?: string; // JSON string of Marker[]
  reason?: string;
}

/**
 * Result of parsing an LLM enrichment response.
 */
export interface EnrichmentResult {
  markers: Marker[];
}

/**
 * Maximum blocks processed per ProjectionScheduler flush cycle.
 * Prevents Ollama overload during high-activity periods.
 */
export const AGENT_BATCH_SIZE = 5;

/**
 * Maximum block IDs in the internal queue.
 * FIFO eviction when exceeded.
 */
export const AGENT_MAX_QUEUE_SIZE = 100;

/**
 * System prompt for the enrichment LLM.
 */
export const ENRICHMENT_SYSTEM_PROMPT = `You are a metadata enrichment agent for an outliner application.
Analyze the block content and its inherited context markers. Return a JSON object with markers to add.

Available marker types:
- "issue": value is the issue number (e.g., "123" for #123, "PROJ-456" for PROJ-456)
- "ambiguous-ref": value is the ambiguous phrase that could refer to multiple things (e.g., "the server", "that bug", "the API")

Rules:
- Only add markers for patterns you're confident about
- For issue numbers: match #NNN, PROJ-NNN, GH-NNN patterns
- For ambiguous refs: flag pronouns or vague references that would benefit from clarification
- Return empty markers array if nothing to add
- Respond with ONLY valid JSON, no markdown fencing or explanation

Response format:
{"markers": [{"markerType": "issue", "value": "123"}, {"markerType": "ambiguous-ref", "value": "the server"}]}`;
