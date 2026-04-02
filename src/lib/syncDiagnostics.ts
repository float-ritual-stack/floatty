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
  ].join(', ');
}

/** Log diagnostics summary (for dev console) */
export function logDiagnosticsSummary(): void {
  const d = counters;
  const uptime = Math.round((Date.now() - d.sessionStartedAt) / 1000);
  const totalIssues = d.orphansDetected + d.dedupRepairs + d.phantomChildrenRemoved + d.crossParentFixes + d.parentValidationFailures + d.childIdsTypeMismatches;

  logger.info(
    `Session ${uptime}s | ` +
    `resyncs:${d.fullResyncs} gapFills:${d.gapFills} echoGaps:${d.echoGapFills} ` +
    `orphans:${d.orphansDetected} dedups:${d.dedupRepairs} ` +
    `phantoms:${d.phantomChildrenRemoved} crossParent:${d.crossParentFixes} ` +
    `parentValidation:${d.parentValidationFailures} typeMismatch:${d.childIdsTypeMismatches} | ` +
    `total issues: ${totalIssues}`
  );
}

// HMR cleanup
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetSyncDiagnostics();
  });
}
