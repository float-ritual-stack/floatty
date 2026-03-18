import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSyncDiagnostics,
  getSyncDiagnosticsSummary,
  resetSyncDiagnostics,
  recordOrphansDetected,
  recordFullResync,
  recordDedupRepairs,
  recordGapFill,
  recordEchoGapFill,
  recordPhantomChildrenRemoved,
  recordCrossParentFixes,
  recordParentValidationFailure,
  logDiagnosticsSummary,
} from './syncDiagnostics';

describe('syncDiagnostics', () => {
  beforeEach(() => {
    resetSyncDiagnostics();
  });

  it('starts with zero counters', () => {
    const d = getSyncDiagnostics();
    expect(d.orphansDetected).toBe(0);
    expect(d.fullResyncs).toBe(0);
    expect(d.dedupRepairs).toBe(0);
    expect(d.gapFills).toBe(0);
    expect(d.echoGapFills).toBe(0);
    expect(d.phantomChildrenRemoved).toBe(0);
    expect(d.crossParentFixes).toBe(0);
    expect(d.parentValidationFailures).toBe(0);
    expect(d.lastEventAt).toBeNull();
    expect(d.sessionStartedAt).toBeGreaterThan(0);
  });

  it('records orphan detection', () => {
    recordOrphansDetected(3);
    const d = getSyncDiagnostics();
    expect(d.orphansDetected).toBe(3);
    expect(d.lastEventAt).not.toBeNull();
  });

  it('records full resync', () => {
    recordFullResync();
    recordFullResync();
    expect(getSyncDiagnostics().fullResyncs).toBe(2);
  });

  it('records dedup repairs', () => {
    recordDedupRepairs(5);
    recordDedupRepairs(0); // zero should be no-op
    recordDedupRepairs(2);
    expect(getSyncDiagnostics().dedupRepairs).toBe(7);
  });

  it('records gap fills', () => {
    recordGapFill();
    recordGapFill();
    recordGapFill();
    expect(getSyncDiagnostics().gapFills).toBe(3);
  });

  it('records phantom children removal', () => {
    recordPhantomChildrenRemoved(1);
    expect(getSyncDiagnostics().phantomChildrenRemoved).toBe(1);
  });

  it('records cross-parent fixes', () => {
    recordCrossParentFixes(2);
    expect(getSyncDiagnostics().crossParentFixes).toBe(2);
  });

  it('records parent validation failures', () => {
    recordParentValidationFailure();
    expect(getSyncDiagnostics().parentValidationFailures).toBe(1);
  });

  it('returns a snapshot (not a reference)', () => {
    const d1 = getSyncDiagnostics();
    recordFullResync();
    const d2 = getSyncDiagnostics();
    expect(d1.fullResyncs).toBe(0);
    expect(d2.fullResyncs).toBe(1);
  });

  it('records echo gap fills', () => {
    recordEchoGapFill();
    recordEchoGapFill();
    expect(getSyncDiagnostics().echoGapFills).toBe(2);
  });

  it('getSyncDiagnosticsSummary returns compact string', () => {
    recordFullResync();
    recordGapFill();
    const summary = getSyncDiagnosticsSummary();
    expect(summary).toContain('resyncs=1');
    expect(summary).toContain('gaps=1');
    expect(summary).toContain('session=');
  });

  it('resets all counters', () => {
    recordOrphansDetected(1);
    recordFullResync();
    recordDedupRepairs(1);
    recordGapFill();
    recordEchoGapFill();
    recordParentValidationFailure();
    resetSyncDiagnostics();
    const d = getSyncDiagnostics();
    expect(d.orphansDetected).toBe(0);
    expect(d.fullResyncs).toBe(0);
    expect(d.dedupRepairs).toBe(0);
    expect(d.gapFills).toBe(0);
    expect(d.echoGapFills).toBe(0);
    expect(d.parentValidationFailures).toBe(0);
    expect(d.lastEventAt).toBeNull();
  });

  it('logDiagnosticsSummary does not throw', () => {
    recordOrphansDetected(2);
    recordFullResync();
    expect(() => logDiagnosticsSummary()).not.toThrow();
  });
});
