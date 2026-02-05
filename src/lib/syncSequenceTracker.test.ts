/**
 * SyncSequenceTracker tests
 *
 * Pure state machine tests - no mocking needed.
 * Tests the sequence tracking logic extracted from useSyncedYDoc.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SyncSequenceTracker } from './syncSequenceTracker';

describe('SyncSequenceTracker', () => {
  let tracker: SyncSequenceTracker;

  beforeEach(() => {
    tracker = new SyncSequenceTracker();
  });

  // ═══════════════════════════════════════════════════════════════
  // GAP DETECTION
  // ═══════════════════════════════════════════════════════════════

  describe('gap detection', () => {
    it('detects no gap on first sequence', () => {
      const gap = tracker.observeSeq(100);
      expect(gap).toBeNull();
      expect(tracker.lastSeenSeq).toBe(100);
      expect(tracker.lastContiguousSeq).toBe(100);
    });

    it('detects no gap on contiguous sequence', () => {
      tracker.observeSeq(100);
      const gap = tracker.observeSeq(101);
      expect(gap).toBeNull();
      expect(tracker.lastSeenSeq).toBe(101);
      expect(tracker.lastContiguousSeq).toBe(101);
    });

    it('detects gap in sequence', () => {
      tracker.observeSeq(100);
      tracker.observeSeq(101);

      const gap = tracker.observeSeq(105);
      expect(gap).toEqual({ fromSeq: 101, toSeq: 105 });
      expect(tracker.lastSeenSeq).toBe(105);
      // Contiguous doesn't advance (gap exists)
      expect(tracker.lastContiguousSeq).toBe(101);
    });

    it('detects multiple consecutive gaps', () => {
      tracker.observeSeq(100);

      const gap1 = tracker.observeSeq(105);
      expect(gap1).toEqual({ fromSeq: 100, toSeq: 105 });

      const gap2 = tracker.observeSeq(110);
      expect(gap2).toEqual({ fromSeq: 105, toSeq: 110 });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ECHO HANDLING
  // ═══════════════════════════════════════════════════════════════

  describe('echo handling', () => {
    it('handles echo messages without regressing seq', () => {
      tracker.observeSeq(100);
      tracker.observeSeq(105); // Gap detected

      // Simulate echo of an earlier message (shouldn't happen normally,
      // but tests monotonic guard)
      tracker.observeEcho(100);
      expect(tracker.lastSeenSeq).toBe(105); // Should NOT regress
    });

    it('detects gap in echo messages', () => {
      tracker.observeSeq(100);

      // Our own message comes back with seq 105, revealing we missed 101-104
      const gap = tracker.observeEcho(105);
      expect(gap).toEqual({ fromSeq: 100, toSeq: 105 });
    });

    it('advances contiguous on echo if next expected', () => {
      tracker.observeSeq(100);
      tracker.observeEcho(101);
      expect(tracker.lastContiguousSeq).toBe(101);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // GAP QUEUE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  describe('gap queue', () => {
    it('queues gaps for fetching', () => {
      const queued = tracker.queueGap(100, 105);
      expect(queued).toBe(true);
      expect(tracker.hasQueuedGaps()).toBe(true);
      expect(tracker.pendingGapQueue).toHaveLength(1);
    });

    it('rejects gaps exceeding threshold', () => {
      // GAP_THRESHOLD_FOR_FULL_RESYNC is 100
      const queued = tracker.queueGap(100, 250); // gap of 150
      expect(queued).toBe(false);
      expect(tracker.hasQueuedGaps()).toBe(false);
    });

    it('consolidates multiple queued gaps', () => {
      tracker.seedFromFullSync(100);

      // Queue overlapping gaps
      tracker.queueGap(100, 105);
      tracker.queueGap(105, 110);
      tracker.queueGap(108, 115);

      const consolidated = tracker.consolidateGaps();
      expect(consolidated).toEqual({ fromSeq: 100, toSeq: 115 });
      expect(tracker.pendingGapQueue).toHaveLength(0); // Cleared
    });

    it('skips consolidation when contiguous covers gaps', () => {
      tracker.seedFromFullSync(120);

      // Queue a gap that's already covered
      tracker.queueGap(100, 115);

      const consolidated = tracker.consolidateGaps();
      expect(consolidated).toBeNull(); // Already covered
    });

    it('adjusts fromSeq based on lastContiguousSeq', () => {
      tracker.seedFromFullSync(105);

      // Queue a gap starting before contiguous
      tracker.queueGap(100, 115);

      const consolidated = tracker.consolidateGaps();
      // Should start from 105 (lastContiguousSeq), not 100
      expect(consolidated).toEqual({ fromSeq: 105, toSeq: 115 });
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // FETCH COORDINATION
  // ═══════════════════════════════════════════════════════════════

  describe('fetch coordination', () => {
    it('prevents concurrent fetches', () => {
      expect(tracker.markFetchStarted()).toBe(true);
      expect(tracker.isFetching).toBe(true);

      // Second attempt should fail
      expect(tracker.markFetchStarted()).toBe(false);

      // After done, can start again
      tracker.markFetchDone();
      expect(tracker.isFetching).toBe(false);
      expect(tracker.markFetchStarted()).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // FULL SYNC SEEDING
  // ═══════════════════════════════════════════════════════════════

  describe('full sync seeding', () => {
    it('seeds both seq values from full sync', () => {
      tracker.seedFromFullSync(500);
      expect(tracker.lastSeenSeq).toBe(500);
      expect(tracker.lastContiguousSeq).toBe(500);
    });

    it('full sync supersedes previous state', () => {
      tracker.observeSeq(100);
      tracker.observeSeq(105); // Gap

      tracker.seedFromFullSync(500);
      expect(tracker.lastSeenSeq).toBe(500);
      expect(tracker.lastContiguousSeq).toBe(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // RESTORE HANDLING
  // ═══════════════════════════════════════════════════════════════

  describe('restore handling', () => {
    it('resets all state on restore', () => {
      // Build up state
      tracker.observeSeq(100);
      tracker.observeSeq(105);
      tracker.queueGap(100, 105);

      // Restore should clear everything
      tracker.resetForRestore();

      expect(tracker.lastSeenSeq).toBeNull();
      expect(tracker.lastContiguousSeq).toBeNull();
      expect(tracker.pendingGapQueue).toEqual([]);
    });

    it('allows fresh tracking after restore', () => {
      tracker.observeSeq(100);
      tracker.resetForRestore();

      // New sequence should work normally
      const gap = tracker.observeSeq(1);
      expect(gap).toBeNull(); // No gap on first seq after reset
      expect(tracker.lastSeenSeq).toBe(1);
    });

    it('resetAll clears everything including fetch state', () => {
      // Build up state including fetch
      tracker.observeSeq(100);
      tracker.observeSeq(105);
      tracker.queueGap(100, 105);
      tracker.markFetchStarted();

      expect(tracker.isFetching).toBe(true);

      // Full reset
      tracker.resetAll();

      expect(tracker.lastSeenSeq).toBeNull();
      expect(tracker.lastContiguousSeq).toBeNull();
      expect(tracker.pendingGapQueue).toEqual([]);
      expect(tracker.isFetching).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // CONTIGUOUS ADVANCEMENT
  // ═══════════════════════════════════════════════════════════════

  describe('contiguous advancement', () => {
    it('advances contiguous on gap-fill', () => {
      tracker.seedFromFullSync(100);
      tracker.observeSeq(105); // Creates gap

      // Gap-fill arrives
      tracker.advanceContiguous(101);
      expect(tracker.lastContiguousSeq).toBe(101);

      tracker.advanceContiguous(102);
      expect(tracker.lastContiguousSeq).toBe(102);
    });

    it('does not advance contiguous on out-of-order fill', () => {
      tracker.seedFromFullSync(100);

      // Skip 101, try to advance to 102
      tracker.advanceContiguous(102);
      expect(tracker.lastContiguousSeq).toBe(100); // Unchanged
    });
  });
});
