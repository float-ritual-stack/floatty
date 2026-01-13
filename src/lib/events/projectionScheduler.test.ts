/**
 * ProjectionScheduler unit tests
 *
 * Tests async batched event processing for expensive operations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProjectionScheduler } from './projectionScheduler';
import { Origin, EventFilters } from './types';
import type { EventEnvelope, BlockEvent } from './types';

// Test helpers
function createTestEnvelope(
  events: Partial<BlockEvent>[] = [],
  overrides: Partial<EventEnvelope> = {}
): EventEnvelope {
  return {
    batchId: `batch-${Date.now()}`,
    timestamp: Date.now(),
    origin: Origin.User,
    events: events.map((e) => ({
      type: 'block:create',
      blockId: 'test-block',
      ...e,
    })) as BlockEvent[],
    ...overrides,
  };
}

describe('ProjectionScheduler', () => {
  let scheduler: ProjectionScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    // Create scheduler without auto-start for controlled testing
    scheduler = new ProjectionScheduler({ autoStart: false });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  describe('register', () => {
    it('returns unique projection ID', () => {
      const id1 = scheduler.register('proj1', async () => {});
      const id2 = scheduler.register('proj2', async () => {});

      expect(id1).toMatch(/^proj_\d+$/);
      expect(id2).toMatch(/^proj_\d+$/);
      expect(id1).not.toBe(id2);
    });

    it('increments projection count', () => {
      expect(scheduler.projectionCount).toBe(0);

      scheduler.register('proj1', async () => {});
      expect(scheduler.projectionCount).toBe(1);

      scheduler.register('proj2', async () => {});
      expect(scheduler.projectionCount).toBe(2);
    });
  });

  describe('unregister', () => {
    it('removes projection and returns true', () => {
      const id = scheduler.register('proj', async () => {});
      expect(scheduler.projectionCount).toBe(1);

      const result = scheduler.unregister(id);
      expect(result).toBe(true);
      expect(scheduler.projectionCount).toBe(0);
    });

    it('returns false for unknown ID', () => {
      const result = scheduler.unregister('unknown');
      expect(result).toBe(false);
    });
  });

  describe('enqueue', () => {
    it('adds events to queue', () => {
      expect(scheduler.queueSize).toBe(0);

      scheduler.enqueue(createTestEnvelope());
      expect(scheduler.queueSize).toBe(1);

      scheduler.enqueue(createTestEnvelope());
      expect(scheduler.queueSize).toBe(2);
    });
  });

  describe('flush', () => {
    it('calls projections with queued events', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      scheduler.register('test', handler);

      scheduler.enqueue(createTestEnvelope([{ blockId: 'b1' }]));
      scheduler.enqueue(createTestEnvelope([{ blockId: 'b2' }]));

      await scheduler.flush();

      expect(handler).toHaveBeenCalledTimes(1);
      // Handler receives merged envelope with all events
      const envelope = handler.mock.calls[0][0] as EventEnvelope;
      expect(envelope.events).toHaveLength(2);
    });

    it('clears queue after flush', async () => {
      scheduler.register('test', async () => {});
      scheduler.enqueue(createTestEnvelope());

      expect(scheduler.queueSize).toBe(1);

      await scheduler.flush();

      expect(scheduler.queueSize).toBe(0);
    });

    it('does nothing when queue is empty', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      scheduler.register('test', handler);

      await scheduler.flush();

      expect(handler).not.toHaveBeenCalled();
    });

    it('prevents concurrent flushes', async () => {
      let flushCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        flushCount++;
        await new Promise((r) => setTimeout(r, 100));
      });

      scheduler.register('test', handler);
      scheduler.enqueue(createTestEnvelope());

      // Start two flushes concurrently
      const p1 = scheduler.flush();
      const p2 = scheduler.flush();

      // Advance timers to let the handler complete
      await vi.advanceTimersByTimeAsync(200);

      await Promise.all([p1, p2]);

      // Only one should have run
      expect(flushCount).toBe(1);
    });
  });

  describe('filtering', () => {
    it('only passes matching events to projection', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);

      scheduler.register('test', handler, {
        filter: EventFilters.creates(),
      });

      scheduler.enqueue(
        createTestEnvelope([
          { type: 'block:create', blockId: 'b1' },
          { type: 'block:update', blockId: 'b2' },
          { type: 'block:create', blockId: 'b3' },
        ])
      );

      await scheduler.flush();

      expect(handler).toHaveBeenCalledTimes(1);
      const envelope = handler.mock.calls[0][0] as EventEnvelope;
      expect(envelope.events).toHaveLength(2);
      expect(envelope.events.map((e) => e.blockId)).toEqual(['b1', 'b3']);
    });

    it('skips projection when no events match', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);

      scheduler.register('test', handler, {
        filter: EventFilters.creates(),
      });

      scheduler.enqueue(createTestEnvelope([{ type: 'block:delete' }]));

      await scheduler.flush();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('error isolation', () => {
    it('continues with other projections after one fails', async () => {
      const handler1 = vi.fn().mockRejectedValue(new Error('Failed'));
      const handler2 = vi.fn().mockResolvedValue(undefined);

      scheduler.register('failing', handler1);
      scheduler.register('working', handler2);

      scheduler.enqueue(createTestEnvelope());

      // Should not throw
      await expect(scheduler.flush()).resolves.toBeUndefined();

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it('logs error when projection fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      scheduler.register('failing', async () => {
        throw new Error('Test error');
      });

      scheduler.enqueue(createTestEnvelope());
      await scheduler.flush();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ProjectionScheduler]'),
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('automatic flushing', () => {
    it('flushes on interval when started', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const autoScheduler = new ProjectionScheduler({
        flushIntervalMs: 1000,
        autoStart: true,
      });

      autoScheduler.register('test', handler);
      autoScheduler.enqueue(createTestEnvelope());

      expect(handler).not.toHaveBeenCalled();

      // Advance timer
      await vi.advanceTimersByTimeAsync(1000);

      expect(handler).toHaveBeenCalledTimes(1);

      autoScheduler.stop();
    });

    it('can be started and stopped', () => {
      expect(scheduler.isRunning).toBe(false);

      scheduler.start();
      expect(scheduler.isRunning).toBe(true);

      scheduler.stop();
      expect(scheduler.isRunning).toBe(false);
    });
  });

  describe('max queue size', () => {
    it('triggers flush when queue exceeds max size', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const smallQueue = new ProjectionScheduler({
        maxQueueSize: 2,
        autoStart: false,
      });

      smallQueue.register('test', handler);

      smallQueue.enqueue(createTestEnvelope());
      expect(handler).not.toHaveBeenCalled();

      smallQueue.enqueue(createTestEnvelope());
      // Should trigger flush
      await vi.runAllTimersAsync();

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('getProjectionInfo', () => {
    it('returns projection metadata', () => {
      scheduler.register('proj-a', async () => {});
      scheduler.register('proj-b', async () => {});

      const info = scheduler.getProjectionInfo();

      expect(info).toHaveLength(2);
      expect(info.map((p) => p.name)).toEqual(['proj-a', 'proj-b']);
    });
  });

  describe('clearQueue / clearProjections', () => {
    it('clearQueue removes queued events', () => {
      scheduler.enqueue(createTestEnvelope());
      scheduler.enqueue(createTestEnvelope());

      expect(scheduler.queueSize).toBe(2);

      scheduler.clearQueue();

      expect(scheduler.queueSize).toBe(0);
    });

    it('clearProjections removes all projections', () => {
      scheduler.register('a', async () => {});
      scheduler.register('b', async () => {});

      expect(scheduler.projectionCount).toBe(2);

      scheduler.clearProjections();

      expect(scheduler.projectionCount).toBe(0);
    });
  });
});
