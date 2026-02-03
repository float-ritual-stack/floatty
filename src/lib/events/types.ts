/**
 * Event Types for Floatty's two-lane event system
 *
 * Y.Doc Update
 *      │
 *      ├──► EventBus (sync) ──► immediate reactions (UI updates, validation)
 *      │
 *      └──► ProjectionScheduler (async) ──► batched index writes (search, backlinks)
 *
 * @see docs/architecture/FLOATTY_HOOK_SYSTEM.md
 */

import type { Block, BlockType } from '../blockTypes';

// ═══════════════════════════════════════════════════════════════
// ORIGIN - Source of the change
// ═══════════════════════════════════════════════════════════════

/**
 * Origin identifies the source of a Y.Doc transaction.
 * Used by hooks to filter events and prevent echo loops.
 *
 * @example
 * // In hook handler:
 * if (event.origin === Origin.Hook) return; // Don't re-process hook-generated changes
 */
export const Origin = {
  /** Local user typing, clicking, keyboard actions */
  User: 'user',
  /** Remote CRDT sync from another client */
  Remote: 'remote',
  /** Hook-generated changes (metadata extraction, etc.) */
  Hook: 'hook',
  /** Undo/Redo via Y.UndoManager */
  Undo: 'undo',
  /** Bulk import operations (paste, file import) */
  BulkImport: 'bulk_import',
  /** External API calls (floatty-server REST API) */
  Api: 'api',
  /** System-generated changes (auto-save, cleanup) */
  System: 'system',
  /** Handler/executor-generated changes (execution outputs, etc.) */
  Executor: 'executor',
  /** Authoritative server state on WebSocket reconnect - bypasses hasLocalChanges guard */
  ReconnectAuthority: 'reconnect-authority',
} as const;

export type OriginType = (typeof Origin)[keyof typeof Origin];

// ═══════════════════════════════════════════════════════════════
// BLOCK EVENT - Individual block change
// ═══════════════════════════════════════════════════════════════

/**
 * Types of block lifecycle events.
 * Maps to Y.Doc map operations + execution lifecycle.
 */
export type BlockEventType =
  | 'block:create'
  | 'block:update'
  | 'block:delete'
  | 'block:move';  // Parent changed (indent/outdent/reorder)

/**
 * What changed in an update event.
 * Allows hooks to filter by field of interest.
 */
export type BlockChangeField =
  | 'content'
  | 'type'
  | 'collapsed'
  | 'childIds'
  | 'parentId'
  | 'metadata'
  | 'output'
  | 'outputType'
  | 'outputStatus';

/**
 * A block change event from Y.Doc observer.
 *
 * For 'block:create': block is the new block
 * For 'block:update': block is current state, previousBlock is prior state
 * For 'block:delete': previousBlock is the deleted block, block is undefined
 * For 'block:move': block is current state with new parentId
 */
export interface BlockEvent {
  /** Event type */
  type: BlockEventType;

  /** Block ID */
  blockId: string;

  /** Current block state (undefined for delete) */
  block?: Block;

  /** Previous block state (for update/delete) */
  previousBlock?: Block;

  /** Which fields changed (for update events) */
  changedFields?: BlockChangeField[];
}

// ═══════════════════════════════════════════════════════════════
// EVENT ENVELOPE - Wrapper with metadata
// ═══════════════════════════════════════════════════════════════

/**
 * EventEnvelope wraps block events with transaction metadata.
 * Enables filtering, batching, and replay.
 */
export interface EventEnvelope {
  /** Unique ID for this event batch (for idempotency) */
  batchId: string;

  /** Timestamp when events were captured */
  timestamp: number;

  /** Source of the change */
  origin: OriginType;

  /** Optional source pane ID (for multi-pane echo prevention) */
  sourcePane?: string;

  /** Block events in this batch */
  events: BlockEvent[];
}

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLER TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Synchronous event handler for EventBus.
 * Must be fast - blocks the Y.Doc observer.
 */
export type SyncEventHandler = (envelope: EventEnvelope) => void;

/**
 * Async event handler for ProjectionScheduler.
 * Can be slow - runs in batched background queue.
 */
export type AsyncEventHandler = (envelope: EventEnvelope) => Promise<void>;

/**
 * Filter predicate for event handlers.
 * Return true to process the event, false to skip.
 */
export type EventFilter = (event: BlockEvent, envelope: EventEnvelope) => boolean;

// ═══════════════════════════════════════════════════════════════
// CONVENIENCE FILTERS
// ═══════════════════════════════════════════════════════════════

/**
 * Pre-built filters for common use cases.
 */
export const EventFilters = {
  /** Match events for a specific block type */
  byBlockType: (blockType: BlockType): EventFilter =>
    (event) => event.block?.type === blockType,

  /** Match only create events */
  creates: (): EventFilter =>
    (event) => event.type === 'block:create',

  /** Match only update events */
  updates: (): EventFilter =>
    (event) => event.type === 'block:update',

  /** Match only delete events */
  deletes: (): EventFilter =>
    (event) => event.type === 'block:delete',

  /** Match events where specific field changed */
  fieldChanged: (field: BlockChangeField): EventFilter =>
    (event) => event.changedFields?.includes(field) ?? false,

  /** Match events from specific origin */
  fromOrigin: (origin: OriginType): EventFilter =>
    (_event, envelope) => envelope.origin === origin,

  /** Exclude events from specific origin */
  notFromOrigin: (origin: OriginType): EventFilter =>
    (_event, envelope) => envelope.origin !== origin,

  /** Match blocks with specific content prefix (e.g., 'ai::', 'sh::') */
  contentPrefix: (prefix: string): EventFilter =>
    (event) => event.block?.content.trim().toLowerCase().startsWith(prefix.toLowerCase()) ?? false,

  /** Match blocks containing wikilinks */
  hasWikilinks: (): EventFilter =>
    (event) => event.block?.content.includes('[[') ?? false,

  /** Combine multiple filters with AND logic */
  all: (...filters: EventFilter[]): EventFilter =>
    (event, envelope) => filters.every(f => f(event, envelope)),

  /** Combine multiple filters with OR logic */
  any: (...filters: EventFilter[]): EventFilter =>
    (event, envelope) => filters.some(f => f(event, envelope)),
} as const;
