/**
 * EventBus - Synchronous pub/sub for immediate event reactions
 *
 * Part of the two-lane event system:
 * - EventBus (this): sync handlers for UI updates, validation
 * - ProjectionScheduler: async handlers for batched index writes
 *
 * Priority conventions (from FLOATTY_HOOK_SYSTEM.md):
 * | Range      | Use                              |
 * |------------|----------------------------------|
 * | -100 to -1 | Security/validation (run first)  |
 * | 0 to 49    | Context assembly, transformation |
 * | 50 to 99   | Standard processing              |
 * | 100+       | Logging, cleanup (run last)      |
 *
 * @example
 * const bus = new EventBus();
 *
 * // Subscribe with filter and priority
 * const id = bus.subscribe(
 *   (envelope) => console.log('Block created:', envelope),
 *   {
 *     filter: EventFilters.creates(),
 *     priority: 50,
 *   }
 * );
 *
 * // Emit events
 * bus.emit({
 *   batchId: crypto.randomUUID(),
 *   timestamp: Date.now(),
 *   origin: Origin.User,
 *   events: [{ type: 'block:create', blockId: '123', block: {...} }],
 * });
 *
 * // Unsubscribe
 * bus.unsubscribe(id);
 */

import type {
  EventEnvelope,
  SyncEventHandler,
  EventFilter,
} from './types';

// ═══════════════════════════════════════════════════════════════
// SUBSCRIPTION TYPES
// ═══════════════════════════════════════════════════════════════

export interface SubscriptionOptions {
  /** Filter to apply before calling handler. If returns false, handler is skipped. */
  filter?: EventFilter;

  /**
   * Priority for handler execution order. Lower = earlier.
   * Default: 50 (standard processing)
   *
   * Conventions:
   * - -100 to -1: Security/validation
   * - 0 to 49: Context assembly
   * - 50 to 99: Standard processing
   * - 100+: Logging, cleanup
   */
  priority?: number;

  /** Optional name for debugging */
  name?: string;
}

interface Subscription {
  id: string;
  handler: SyncEventHandler;
  filter?: EventFilter;
  priority: number;
  name?: string;
}

// ═══════════════════════════════════════════════════════════════
// EVENT BUS
// ═══════════════════════════════════════════════════════════════

const DEFAULT_PRIORITY = 50;

export class EventBus {
  private subscriptions: Subscription[] = [];
  private nextId = 0;

  /**
   * Subscribe a handler to receive events.
   *
   * @param handler - Function called for each matching event
   * @param options - Filter, priority, and debug name
   * @returns Subscription ID for unsubscribing
   */
  subscribe(handler: SyncEventHandler, options: SubscriptionOptions = {}): string {
    const id = `sub_${this.nextId++}`;
    const subscription: Subscription = {
      id,
      handler,
      filter: options.filter,
      priority: options.priority ?? DEFAULT_PRIORITY,
      name: options.name,
    };

    // Insert in priority order (lower priority = earlier in array)
    const insertIndex = this.subscriptions.findIndex(
      (s) => s.priority > subscription.priority
    );

    if (insertIndex === -1) {
      this.subscriptions.push(subscription);
    } else {
      this.subscriptions.splice(insertIndex, 0, subscription);
    }

    return id;
  }

  /**
   * Remove a subscription by ID.
   *
   * @param id - Subscription ID from subscribe()
   * @returns true if subscription was found and removed
   */
  unsubscribe(id: string): boolean {
    const index = this.subscriptions.findIndex((s) => s.id === id);
    if (index === -1) return false;

    this.subscriptions.splice(index, 1);
    return true;
  }

  /**
   * Emit an event envelope to all subscribed handlers.
   *
   * Handlers are called synchronously in priority order.
   * If a handler throws, the error is logged but other handlers still run.
   *
   * @param envelope - Event envelope containing block events
   */
  emit(envelope: EventEnvelope): void {
    // Snapshot subscriptions to prevent mutation during iteration
    const subscriptions = [...this.subscriptions];

    for (const subscription of subscriptions) {
      try {
        // Check filter for each event in the envelope
        const matchingEvents = subscription.filter
          ? envelope.events.filter((event) =>
              subscription.filter!(event, envelope)
            )
          : envelope.events;

        // Skip if no events match the filter
        if (matchingEvents.length === 0) continue;

        // Create filtered envelope for handler
        const filteredEnvelope: EventEnvelope =
          matchingEvents.length === envelope.events.length
            ? envelope
            : { ...envelope, events: matchingEvents };

        subscription.handler(filteredEnvelope);
      } catch (error) {
        // Log but don't propagate - one handler failing shouldn't break others
        console.error(
          `[EventBus] Handler ${subscription.name || subscription.id} threw:`,
          error
        );
      }
    }
  }

  /**
   * Get count of active subscriptions.
   * Useful for testing and debugging.
   */
  get subscriptionCount(): number {
    return this.subscriptions.length;
  }

  /**
   * Get subscription info for debugging.
   * Returns array of { id, name, priority } for each subscription.
   */
  getSubscriptionInfo(): Array<{ id: string; name?: string; priority: number }> {
    return this.subscriptions.map((s) => ({
      id: s.id,
      name: s.name,
      priority: s.priority,
    }));
  }

  /**
   * Remove all subscriptions.
   * Useful for cleanup in tests.
   */
  clear(): void {
    this.subscriptions = [];
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════

/**
 * Global EventBus instance for block events.
 *
 * Use this for most cases. Create separate instances only for
 * testing or isolated subsystems.
 */
export const blockEventBus = new EventBus();
