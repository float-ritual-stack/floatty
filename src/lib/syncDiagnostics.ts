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

export interface SyncDiagnostics {
  /** Number of orphaned blocks detected and quarantined */
  orphansDetected: number;
  /** Number of full resyncs triggered (health check or overflow recovery) */
  fullResyncs: number;
  /** Number of duplicate childIds entries repaired by deduplicateChildIds */
  dedupRepairs: number;
  /** Number of gap-fill fetches performed (incremental catch-up) */
  gapFills: number;
  /** Number of phantom children removed (childIds referencing non-existent blocks) */
  phantomChildrenRemoved: number;
  /** Number of cross-parent conflicts resolved */
  crossParentFixes: number;
  /** Number of parent existence validation failures (createBlock with missing parent) */
  parentValidationFailures: number;
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
  phantomChildrenRemoved: 0,
  crossParentFixes: 0,
  parentValidationFailures: 0,
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
  counters.phantomChildrenRemoved = 0;
  counters.crossParentFixes = 0;
  counters.parentValidationFailures = 0;
  counters.lastEventAt = null;
  counters.sessionStartedAt = Date.now();
}

/** Log diagnostics summary (for dev console) */
export function logDiagnosticsSummary(): void {
  const d = counters;
  const uptime = Math.round((Date.now() - d.sessionStartedAt) / 1000);
  const totalIssues = d.orphansDetected + d.dedupRepairs + d.phantomChildrenRemoved + d.crossParentFixes + d.parentValidationFailures;

  console.log(
    `[SyncDiagnostics] Session ${uptime}s | ` +
    `resyncs:${d.fullResyncs} gapFills:${d.gapFills} ` +
    `orphans:${d.orphansDetected} dedups:${d.dedupRepairs} ` +
    `phantoms:${d.phantomChildrenRemoved} crossParent:${d.crossParentFixes} ` +
    `parentValidation:${d.parentValidationFailures} | ` +
    `total issues: ${totalIssues}`
  );
}

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetSyncDiagnostics();
  });
}
