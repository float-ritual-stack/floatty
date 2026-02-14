/**
 * Agent module — Background metadata enrichment system
 *
 * Registers a ProjectionScheduler projection that:
 * 1. Watches for block creates/updates
 * 2. Sends content to Ollama for analysis
 * 3. Writes enriched markers (issue numbers, ambiguous references)
 * 4. Logs all activity to SQLite for transparency
 */

export {
  registerAgentEnrichment,
  unregisterAgentEnrichment,
  agentStatus,
  getQueueSize,
} from './agentEnrichmentProjection';

export type {
  AgentStatus,
  AgentActivityEntry,
  EnrichmentResult,
} from './agentTypes';
