/**
 * Sync Integrity Diagnostics
 *
 * Lightweight counters tracking sync pipeline health indicators.
 * These counters accumulate per session and can be queried for
 * debugging or surfaced in dev-mode UI.
 *
 * The design goal: the safety nets (orphan detector, deduplicateChildIds,
 * full resync, gap fills) should rarely trigger. When they do, these
 * counters make the root cause identifiable.
 */

import { createLogger } from './logger';

const logger = createLogger('SyncDiagnostics');

export interface SyncDiagnostics {
  /** Number of orphaned blocks detected and quarantined */
  orphansDetected: number;
  /** Number of full resyncs triggered (health check or overflow recovery) */
  fullResyncs: number;
  /** Number of duplicate childIds entries repaired by deduplicateChildIds */
  dedupRepairs: number;
  /** Number of gap-fill fetches performed (incremental catch-up) */
  gapFills: number;
  /** Number of echo gap-fill fetches (debounced gap fills from own updates) */
  echoGapFills: number;
  /** Number of phantom children removed (childIds referencing non-existent blocks) */
  phantomChildrenRemoved: number;
  /** Number of cross-parent conflicts resolved */
  crossParentFixes: number;
  /** Number of parent existence validation failures (createBlock with missing parent) */
  parentValidationFailures: number;
  /** Number of childIds type mismatches encountered during descendant walks */
  childIdsTypeMismatches: number;
  /**
   * Observer store-writes skipped because `toBlock()` returned null (FLO-895).
   *
   * The block was named by a Y.Doc event but `blocksMap.get(id)` resolved to
   * nothing (or to a Y.Map with no id) at read time. The store write is
   * skipped and never retried, so the store silently diverges from the Y.Doc.
   * This was the unlogged suspect behind stale renders on long-lived sessions.
   */
  storeWriteSkips: number;
  /** Blocks re-materialized into the store by `reconcileStoreFromYDoc` (FLO-895). */
  storeReconcileRepairs: number;
  /** Pending-structs stalls that outlived the watchdog grace period (FLO-895). */
  pendingStructsStalls: number;
  /** Timestamp of last diagnostic event */
  lastEventAt: number | null;
  /** Session start time */
  sessionStartedAt: number;
}

// Module-level singleton counters
const counters: SyncDiagnostics = {
  orphansDetected: 0,
  fullResyncs: 0,
  dedupRepairs: 0,
  gapFills: 0,
  echoGapFills: 0,
  phantomChildrenRemoved: 0,
  crossParentFixes: 0,
  parentValidationFailures: 0,
  childIdsTypeMismatches: 0,
  storeWriteSkips: 0,
  storeReconcileRepairs: 0,
  pendingStructsStalls: 0,
  lastEventAt: null,
  sessionStartedAt: Date.now(),
};

function touch(): void {
  counters.lastEventAt = Date.now();
}

/** Record orphan detection event */
export function recordOrphansDetected(count: number): void {
  counters.orphansDetected += count;
  touch();
}

/** Record a full resync trigger */
export function recordFullResync(): void {
  counters.fullResyncs++;
  touch();
}

/** Record dedup repairs from deduplicateChildIds */
export function recordDedupRepairs(count: number): void {
  if (count > 0) {
    counters.dedupRepairs += count;
    touch();
  }
}

/** Record a gap-fill fetch */
export function recordGapFill(): void {
  counters.gapFills++;
  touch();
}

/** Record an echo gap-fill (debounced gap from own updates triggering hook broadcasts) */
export function recordEchoGapFill(): void {
  counters.echoGapFills++;
  touch();
}

/** Record phantom children removal */
export function recordPhantomChildrenRemoved(count: number): void {
  if (count > 0) {
    counters.phantomChildrenRemoved += count;
    touch();
  }
}

/** Record cross-parent conflict resolution */
export function recordCrossParentFixes(count: number): void {
  if (count > 0) {
    counters.crossParentFixes += count;
    touch();
  }
}

/** Record parent validation failure */
export function recordParentValidationFailure(): void {
  counters.parentValidationFailures++;
  touch();
}

/** Record childIds type mismatch (block exists but childIds is not Y.Array) */
export function recordChildIdsTypeMismatch(): void {
  counters.childIdsTypeMismatches++;
  touch();
}

/**
 * Record an observer store-write that was skipped because the block could not
 * be read back from the Y.Doc (FLO-895).
 *
 * A non-zero count here means the store is diverging from the Y.Doc in exactly
 * the way that produces "the server has it, the app doesn't render it" — and
 * that no transport-level repair can fix, because the Y.Doc is already correct.
 */
export function recordStoreWriteSkip(): void {
  counters.storeWriteSkips++;
  touch();
}

/** Record blocks repaired by a store↔Y.Doc reconcile pass (FLO-895). */
export function recordStoreReconcileRepairs(count: number): void {
  if (count > 0) {
    counters.storeReconcileRepairs += count;
    touch();
  }
}

/** Record a pending-structs stall that outlived the watchdog grace period (FLO-895). */
export function recordPendingStructsStall(): void {
  counters.pendingStructsStalls++;
  touch();
}

/** Get snapshot of current diagnostics */
export function getSyncDiagnostics(): Readonly<SyncDiagnostics> {
  return { ...counters };
}

/** Reset all counters (for testing) */
export function resetSyncDiagnostics(): void {
  counters.orphansDetected = 0;
  counters.fullResyncs = 0;
  counters.dedupRepairs = 0;
  counters.gapFills = 0;
  counters.echoGapFills = 0;
  counters.phantomChildrenRemoved = 0;
  counters.crossParentFixes = 0;
  counters.parentValidationFailures = 0;
  counters.childIdsTypeMismatches = 0;
  counters.storeWriteSkips = 0;
  counters.storeReconcileRepairs = 0;
  counters.pendingStructsStalls = 0;
  counters.lastEventAt = null;
  counters.sessionStartedAt = Date.now();
}

/** Get a compact human-readable summary string */
export function getSyncDiagnosticsSummary(): string {
  const d = counters;
  const uptimeMin = Math.round((Date.now() - d.sessionStartedAt) / 60000);
  return [
    `session=${uptimeMin}min`,
    `orphans=${d.orphansDetected}`,
    `resyncs=${d.fullResyncs}`,
    `dedups=${d.dedupRepairs}`,
    `gaps=${d.gapFills}`,
    `echoGaps=${d.echoGapFills}`,
    `parentValidation=${d.parentValidationFailures}`,
    `typeMismatch=${d.childIdsTypeMismatches}`,
    `storeSkips=${d.storeWriteSkips}`,
    `storeRepairs=${d.storeReconcileRepairs}`,
    `pendingStalls=${d.pendingStructsStalls}`,
  ].join(', ');
}

/** Log diagnostics summary (for dev console) */
export function logDiagnosticsSummary(): void {
  const d = counters;
  const uptime = Math.round((Date.now() - d.sessionStartedAt) / 1000);
  const totalIssues = d.orphansDetected + d.dedupRepairs + d.phantomChildrenRemoved + d.crossParentFixes + d.parentValidationFailures + d.childIdsTypeMismatches + d.storeWriteSkips + d.storeReconcileRepairs + d.pendingStructsStalls;

  logger.info(
    `Session ${uptime}s | ` +
    `resyncs:${d.fullResyncs} gapFills:${d.gapFills} echoGaps:${d.echoGapFills} ` +
    `orphans:${d.orphansDetected} dedups:${d.dedupRepairs} ` +
    `phantoms:${d.phantomChildrenRemoved} crossParent:${d.crossParentFixes} ` +
    `parentValidation:${d.parentValidationFailures} typeMismatch:${d.childIdsTypeMismatches} ` +
    `storeSkips:${d.storeWriteSkips} storeRepairs:${d.storeReconcileRepairs} pendingStalls:${d.pendingStructsStalls} | ` +
    `total issues: ${totalIssues}`
  );
}

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetSyncDiagnostics();
  });
}
