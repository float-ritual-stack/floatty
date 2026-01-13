/**
 * EventBus unit tests
 *
 * Tests synchronous pub/sub for immediate event reactions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from './eventBus';
import { Origin, EventFilters } from './types';
import type { EventEnvelope, BlockEvent } from './types';

// Test helpers
function createTestEnvelope(events?: Partial<BlockEvent>[]): EventEnvelope {
  // Default to one event if none provided (empty events array skips handlers)
  const eventList = events ?? [{}];
  return {
    batchId: 'test-batch',
    timestamp: Date.now(),
    origin: Origin.User,
    events: eventList.map((e) => ({
      type: 'block:create',
      blockId: 'test-block',
      ...e,
    })) as BlockEvent[],
  };
}

function createTestBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-block',
    parentId: null,
    childIds: [],
    content: 'test content',
    type: 'text' as const,
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe('subscribe', () => {
    it('returns unique subscription ID', () => {
      const id1 = bus.subscribe(() => {});
      const id2 = bus.subscribe(() => {});

      expect(id1).toMatch(/^sub_\d+$/);
      expect(id2).toMatch(/^sub_\d+$/);
      expect(id1).not.toBe(id2);
    });

    it('increments subscription count', () => {
      expect(bus.subscriptionCount).toBe(0);

      bus.subscribe(() => {});
      expect(bus.subscriptionCount).toBe(1);

      bus.subscribe(() => {});
      expect(bus.subscriptionCount).toBe(2);
    });
  });

  describe('unsubscribe', () => {
    it('removes subscription and returns true', () => {
      const id = bus.subscribe(() => {});
      expect(bus.subscriptionCount).toBe(1);

      const result = bus.unsubscribe(id);
      expect(result).toBe(true);
      expect(bus.subscriptionCount).toBe(0);
    });

    it('returns false for unknown ID', () => {
      const result = bus.unsubscribe('unknown');
      expect(result).toBe(false);
    });
  });

  describe('emit', () => {
    it('calls subscribed handlers', () => {
      const handler = vi.fn();
      bus.subscribe(handler);

      const envelope = createTestEnvelope([{ blockId: 'b1' }]);
      bus.emit(envelope);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(envelope);
    });

    it('calls multiple handlers', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.subscribe(handler1);
      bus.subscribe(handler2);

      const envelope = createTestEnvelope();
      bus.emit(envelope);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('does not call unsubscribed handlers', () => {
      const handler = vi.fn();
      const id = bus.subscribe(handler);

      bus.unsubscribe(id);
      bus.emit(createTestEnvelope());

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('priority ordering', () => {
    it('calls handlers in priority order (lower first)', () => {
      const order: number[] = [];

      bus.subscribe(() => order.push(3), { priority: 100 });
      bus.subscribe(() => order.push(1), { priority: -10 });
      bus.subscribe(() => order.push(2), { priority: 50 });

      bus.emit(createTestEnvelope());

      expect(order).toEqual([1, 2, 3]);
    });

    it('uses default priority 50', () => {
      const order: number[] = [];

      bus.subscribe(() => order.push(2)); // default 50
      bus.subscribe(() => order.push(1), { priority: 0 });
      bus.subscribe(() => order.push(3), { priority: 100 });

      bus.emit(createTestEnvelope());

      expect(order).toEqual([1, 2, 3]);
    });
  });

  describe('filtering', () => {
    it('only calls handler when filter matches', () => {
      const handler = vi.fn();

      bus.subscribe(handler, {
        filter: EventFilters.creates(),
      });

      // Should match
      bus.emit(createTestEnvelope([{ type: 'block:create' }]));
      expect(handler).toHaveBeenCalledTimes(1);

      // Should not match
      bus.emit(createTestEnvelope([{ type: 'block:update' }]));
      expect(handler).toHaveBeenCalledTimes(1); // Still 1
    });

    it('filters events within envelope', () => {
      const handler = vi.fn();

      bus.subscribe(handler, {
        filter: EventFilters.creates(),
      });

      // Mixed events - only creates should be in filtered envelope
      bus.emit(
        createTestEnvelope([
          { type: 'block:create', blockId: 'b1' },
          { type: 'block:update', blockId: 'b2' },
          { type: 'block:create', blockId: 'b3' },
        ])
      );

      expect(handler).toHaveBeenCalledTimes(1);
      const receivedEnvelope = handler.mock.calls[0][0] as EventEnvelope;
      expect(receivedEnvelope.events).toHaveLength(2);
      expect(receivedEnvelope.events.map((e) => e.blockId)).toEqual(['b1', 'b3']);
    });

    it('skips handler when no events match filter', () => {
      const handler = vi.fn();

      bus.subscribe(handler, {
        filter: EventFilters.creates(),
      });

      bus.emit(createTestEnvelope([{ type: 'block:delete' }]));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('error isolation', () => {
    it('continues calling handlers after one throws', () => {
      const handler1 = vi.fn(() => {
        throw new Error('Handler 1 failed');
      });
      const handler2 = vi.fn();

      bus.subscribe(handler1, { priority: 0 });
      bus.subscribe(handler2, { priority: 100 });

      // Should not throw
      expect(() => bus.emit(createTestEnvelope())).not.toThrow();

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('logs error when handler throws', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.subscribe(
        () => {
          throw new Error('Test error');
        },
        { name: 'test-handler' }
      );

      bus.emit(createTestEnvelope());

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[EventBus]'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('getSubscriptionInfo', () => {
    it('returns subscription metadata', () => {
      bus.subscribe(() => {}, { name: 'handler-a', priority: 10 });
      bus.subscribe(() => {}, { name: 'handler-b', priority: 20 });

      const info = bus.getSubscriptionInfo();

      expect(info).toHaveLength(2);
      expect(info[0]).toMatchObject({ name: 'handler-a', priority: 10 });
      expect(info[1]).toMatchObject({ name: 'handler-b', priority: 20 });
    });
  });

  describe('clear', () => {
    it('removes all subscriptions', () => {
      bus.subscribe(() => {});
      bus.subscribe(() => {});

      expect(bus.subscriptionCount).toBe(2);

      bus.clear();

      expect(bus.subscriptionCount).toBe(0);
    });
  });
});
