/**
 * ProjectionScheduler - Batched async event processing for expensive operations
 *
 * Part of the two-lane event system:
 * - EventBus: sync handlers for UI updates, validation (immediate)
 * - ProjectionScheduler (this): async handlers for index writes (batched)
 *
 * Timing guidelines (from ydoc-patterns.md):
 * | Layer              | Timing | Why                      |
 * |--------------------|--------|--------------------------|
 * | Index (Tantivy)    | 2-5s   | Batch expensive commits  |
 * | Hooks (metadata)   | 1-2s   | Batch extraction         |
 *
 * @example
 * const scheduler = new ProjectionScheduler({ flushIntervalMs: 2000 });
 *
 * // Register async projection
 * const id = scheduler.register(
 *   'search-index',
 *   async (envelope) => {
 *     await tantivy.indexBatch(envelope.events);
 *   },
 *   { filter: EventFilters.updates() }
 * );
 *
 * // Queue events (called from Y.Doc observer)
 * scheduler.enqueue(envelope);
 *
 * // Events are batched and flushed every 2s
 *
 * // Cleanup
 * scheduler.stop();
 */

import type {
  EventEnvelope,
  BlockEvent,
  AsyncEventHandler,
  EventFilter,
} from './types';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface ProjectionSchedulerOptions {
  /**
   * Interval between automatic flushes in milliseconds.
   * Default: 2000 (2 seconds, per ydoc-patterns.md)
   */
  flushIntervalMs?: number;

  /**
   * Maximum events to accumulate before forcing a flush.
   * Prevents unbounded memory growth during high activity.
   * Default: 1000
   */
  maxQueueSize?: number;

  /**
   * Whether to start the flush timer immediately.
   * Set to false for manual control (e.g., in tests).
   * Default: true
   */
  autoStart?: boolean;
}

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_MAX_QUEUE_SIZE = 1000;

// ═══════════════════════════════════════════════════════════════
// PROJECTION TYPES
// ═══════════════════════════════════════════════════════════════

export interface ProjectionOptions {
  /** Filter to apply - only matching events are passed to handler */
  filter?: EventFilter;

  /** Optional name for debugging and logging */
  name?: string;
}

interface Projection {
  id: string;
  name: string;
  handler: AsyncEventHandler;
  filter?: EventFilter;
}

// ═══════════════════════════════════════════════════════════════
// PROJECTION SCHEDULER
// ═══════════════════════════════════════════════════════════════

export class ProjectionScheduler {
  private projections: Map<string, Projection> = new Map();
  private queue: EventEnvelope[] = [];
  private flushIntervalMs: number;
  private maxQueueSize: number;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;
  private nextId = 0;

  constructor(options: ProjectionSchedulerOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;

    if (options.autoStart !== false) {
      this.start();
    }
  }

  /**
   * Register an async projection handler.
   *
   * @param name - Human-readable name for logging
   * @param handler - Async function called with batched events
   * @param options - Filter and other options
   * @returns Projection ID for unregistering
   */
  register(
    name: string,
    handler: AsyncEventHandler,
    options: ProjectionOptions = {}
  ): string {
    const id = `proj_${this.nextId++}`;
    this.projections.set(id, {
      id,
      name: options.name ?? name,
      handler,
      filter: options.filter,
    });
    return id;
  }

  /**
   * Unregister a projection by ID.
   *
   * @param id - Projection ID from register()
   * @returns true if projection was found and removed
   */
  unregister(id: string): boolean {
    return this.projections.delete(id);
  }

  /**
   * Add an event envelope to the queue.
   * Events will be flushed on the next interval or when queue is full.
   *
   * @param envelope - Event envelope to queue
   */
  enqueue(envelope: EventEnvelope): void {
    this.queue.push(envelope);

    // Force flush if queue is too large
    if (this.queue.length >= this.maxQueueSize) {
      void this.flush();
    }
  }

  /**
   * Start the automatic flush timer.
   * Called automatically unless autoStart is false.
   */
  start(): void {
    if (this.timerId !== null) return;

    this.timerId = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);
  }

  /**
   * Stop the automatic flush timer.
   * Does NOT flush remaining events - call flush() first if needed.
   */
  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * Flush all queued events to projections.
   * Returns when all projections have processed.
   *
   * Safe to call multiple times - concurrent flushes are serialized.
   */
  async flush(): Promise<void> {
    // Prevent concurrent flushes
    if (this.isFlushing) return;
    if (this.queue.length === 0) return;

    this.isFlushing = true;

    // Grab current queue and reset
    const batch = this.queue;
    this.queue = [];

    try {
      // Run all projections in parallel
      const promises = Array.from(this.projections.values()).map(
        async (projection) => {
          try {
            // Filter events for this projection
            const filteredBatch = this.filterBatch(batch, projection);
            if (filteredBatch.length === 0) return;

            // Merge filtered envelopes into single envelope for handler
            const merged = this.mergeBatch(filteredBatch);
            await projection.handler(merged);
          } catch (error) {
            // Log but don't propagate - one projection failing shouldn't break others
            console.error(
              `[ProjectionScheduler] Projection "${projection.name}" failed:`,
              error
            );
          }
        }
      );

      await Promise.all(promises);
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Filter a batch of envelopes for a specific projection.
   */
  private filterBatch(
    batch: EventEnvelope[],
    projection: Projection
  ): EventEnvelope[] {
    if (!projection.filter) return batch;

    return batch
      .map((envelope) => ({
        ...envelope,
        events: envelope.events.filter((event) =>
          projection.filter!(event, envelope)
        ),
      }))
      .filter((envelope) => envelope.events.length > 0);
  }

  /**
   * Merge multiple envelopes into a single envelope.
   * Used to provide handlers with a single batched envelope.
   */
  private mergeBatch(batch: EventEnvelope[]): EventEnvelope {
    if (batch.length === 1) return batch[0];

    // Use first envelope's metadata, combine all events
    const first = batch[0];
    const allEvents: BlockEvent[] = [];

    for (const envelope of batch) {
      allEvents.push(...envelope.events);
    }

    return {
      batchId: `merged_${first.batchId}`,
      timestamp: first.timestamp,
      origin: first.origin,
      sourcePane: first.sourcePane,
      events: allEvents,
    };
  }

  /**
   * Get count of queued events (for monitoring).
   */
  get queueSize(): number {
    return this.queue.length;
  }

  /**
   * Get count of registered projections.
   */
  get projectionCount(): number {
    return this.projections.size;
  }

  /**
   * Check if scheduler is running (timer active).
   */
  get isRunning(): boolean {
    return this.timerId !== null;
  }

  /**
   * Get projection info for debugging.
   */
  getProjectionInfo(): Array<{ id: string; name: string }> {
    return Array.from(this.projections.values()).map((p) => ({
      id: p.id,
      name: p.name,
    }));
  }

  /**
   * Clear all queued events without processing.
   * Useful for cleanup in tests.
   */
  clearQueue(): void {
    this.queue = [];
  }

  /**
   * Remove all projections.
   * Useful for cleanup in tests.
   */
  clearProjections(): void {
    this.projections.clear();
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

/**
 * Global ProjectionScheduler for block event projections.
 *
 * Use this for index writes, backlink updates, and other
 * expensive async operations that benefit from batching.
 */
export const blockProjectionScheduler = new ProjectionScheduler();

// HMR cleanup: stop previous scheduler to avoid duplicate timers
if (import.meta.hot) {
  import.meta.hot.dispose(() => blockProjectionScheduler.stop());
}
