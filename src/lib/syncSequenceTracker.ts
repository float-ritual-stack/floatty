/**
 * SyncSequenceTracker - Pure state machine for CRDT sync sequence tracking
 *
 * Extracted from useSyncedYDoc.ts to enable isolated testing.
 * No Y.Doc, no HTTP, no WebSocket - just sequence arithmetic.
 *
 * Responsibilities:
 * - Track highest seen sequence number (lastSeenSeq)
 * - Track highest contiguous sequence (lastContiguousSeq)
 * - Detect gaps and queue them for fetching
 * - Consolidate overlapping gaps
 * - Reset state on restore broadcasts
 */

/** Gap that needs to be fetched */
export interface PendingGap {
  fromSeq: number;
  toSeq: number;
}

/** Result of observing a sequence number */
export interface GapDetected {
  fromSeq: number;
  toSeq: number;
}

/**
 * Threshold for gap size before falling back to full resync.
 * If gap > 100, fetching individual updates may be slower than full state.
 */
const GAP_THRESHOLD_FOR_FULL_RESYNC = 100;

export class SyncSequenceTracker {
  /**
   * Highest sequence number we've seen.
   * Can jump on out-of-order messages.
   * Used for gap detection: seq 417 → seq 419 means we missed 418.
   */
  private _lastSeenSeq: number | null = null;

  /**
   * Highest seq where ALL prior seqs have been received.
   * Only advances when updates are applied in contiguous order.
   * Used for gap queue processing - determines when queued gaps are covered.
   */
  private _lastContiguousSeq: number | null = null;

  /** Queue of pending gap fetches */
  private _pendingGapQueue: PendingGap[] = [];

  /** Whether we're currently fetching missing updates */
  private _isFetching = false;

  // ═══════════════════════════════════════════════════════════════
  // GETTERS (read-only access to state)
  // ═══════════════════════════════════════════════════════════════

  get lastSeenSeq(): number | null {
    return this._lastSeenSeq;
  }

  get lastContiguousSeq(): number | null {
    return this._lastContiguousSeq;
  }

  get pendingGapQueue(): readonly PendingGap[] {
    return this._pendingGapQueue;
  }

  get isFetching(): boolean {
    return this._isFetching;
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE MUTATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Observe a sequence number from a regular (non-echo) message.
   * Updates lastSeenSeq monotonically and detects gaps.
   *
   * @returns Gap info if a gap was detected, null otherwise
   */
  observeSeq(seq: number): GapDetected | null {
    let gap: GapDetected | null = null;

    // Gap detection: check if we missed any updates
    if (this._lastSeenSeq !== null && seq > this._lastSeenSeq + 1) {
      gap = { fromSeq: this._lastSeenSeq, toSeq: seq };
    }

    // Update lastSeenSeq monotonically
    this.updateLastSeen(seq);

    // Also advance contiguous tracking if this is the next expected seq
    if (this._lastContiguousSeq === null || seq === this._lastContiguousSeq + 1) {
      this._lastContiguousSeq = seq;
    }

    return gap;
  }

  /**
   * Observe a sequence number from an echoed message (our own update returning).
   * Still runs gap detection but handles contiguous tracking differently.
   *
   * @returns Gap info if a gap was detected, null otherwise
   */
  observeEcho(seq: number): GapDetected | null {
    let gap: GapDetected | null = null;

    // Gap detection for echoed messages - our message's seq may reveal
    // we missed updates from other clients
    if (this._lastSeenSeq !== null && seq > this._lastSeenSeq + 1) {
      gap = { fromSeq: this._lastSeenSeq, toSeq: seq };
    }

    // Track seq even for our own updates (monotonic + contiguous)
    this.updateLastSeen(seq);

    // Our own update was applied locally, so it's contiguous
    if (this._lastContiguousSeq === null || seq === this._lastContiguousSeq + 1) {
      this._lastContiguousSeq = seq;
    }

    return gap;
  }

  /**
   * Update lastSeenSeq monotonically.
   * Only updates if newSeq > current lastSeenSeq (or if lastSeenSeq is null).
   */
  private updateLastSeen(newSeq: number): void {
    if (this._lastSeenSeq === null || newSeq > this._lastSeenSeq) {
      this._lastSeenSeq = newSeq;
    }
  }

  /**
   * Advance lastContiguousSeq when applying the next expected seq.
   * Called when applying contiguous updates (gap-fill, reconnect sync).
   */
  advanceContiguous(seq: number): void {
    if (this._lastContiguousSeq === null || seq === this._lastContiguousSeq + 1) {
      this._lastContiguousSeq = seq;
    }
  }

  /**
   * Seed both seq trackers from a full sync (initial load, reconnect full state).
   * Full state means all seqs up to this value are covered.
   */
  seedFromFullSync(seq: number): void {
    this._lastSeenSeq = seq;
    this._lastContiguousSeq = seq;
  }

  /**
   * Reset all state on restore broadcast (full Y.Doc replacement).
   * Pre-restore seq values are stale and would cause false gap detection.
   */
  resetForRestore(): void {
    this._lastSeenSeq = null;
    this._lastContiguousSeq = null;
    this._pendingGapQueue = [];
  }

  // ═══════════════════════════════════════════════════════════════
  // GAP QUEUE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Queue a gap for fetching.
   * @returns true if gap was queued, false if it exceeds threshold (needs full resync)
   */
  queueGap(fromSeq: number, toSeq: number): boolean {
    const gapSize = toSeq - fromSeq;
    if (gapSize > GAP_THRESHOLD_FOR_FULL_RESYNC) {
      return false; // Caller should trigger full resync
    }

    this._pendingGapQueue.push({ fromSeq, toSeq });
    return true;
  }

  /**
   * Check if there are gaps to process.
   */
  hasQueuedGaps(): boolean {
    return this._pendingGapQueue.length > 0;
  }

  /**
   * Consolidate pending gaps into a single range for fetching.
   * Returns null if gaps are already covered by lastContiguousSeq.
   */
  consolidateGaps(): { fromSeq: number; toSeq: number } | null {
    if (this._pendingGapQueue.length === 0) {
      return null;
    }

    // Consolidate overlapping/adjacent gaps
    const minFrom = Math.min(...this._pendingGapQueue.map(g => g.fromSeq));
    const maxTo = Math.max(...this._pendingGapQueue.map(g => g.toSeq));

    // Clear the queue
    this._pendingGapQueue = [];

    // Check if gaps are already covered by contiguous tracking
    if (this._lastContiguousSeq !== null && maxTo <= this._lastContiguousSeq) {
      return null; // Already covered
    }

    // Compute effective range using lastContiguousSeq
    const effectiveFrom = this._lastContiguousSeq !== null
      ? Math.max(minFrom, this._lastContiguousSeq)
      : minFrom;

    return { fromSeq: effectiveFrom, toSeq: maxTo };
  }

  /**
   * Mark that a fetch is starting. Prevents concurrent fetches.
   * @returns true if fetch can proceed, false if already fetching
   */
  markFetchStarted(): boolean {
    if (this._isFetching) {
      return false;
    }
    this._isFetching = true;
    return true;
  }

  /**
   * Mark that a fetch completed.
   */
  markFetchDone(): void {
    this._isFetching = false;
  }
}

/** Singleton instance for use in useSyncedYDoc.ts */
let sharedTracker: SyncSequenceTracker | null = null;

/**
 * Get or create the shared tracker instance.
 * Used by useSyncedYDoc.ts during migration - will be removed
 * when full orchestrator refactor is complete.
 */
export function getSharedTracker(): SyncSequenceTracker {
  if (!sharedTracker) {
    sharedTracker = new SyncSequenceTracker();
  }
  return sharedTracker;
}

/**
 * Reset the shared tracker (for HMR/testing).
 */
export function resetSharedTracker(): void {
  sharedTracker = null;
}
