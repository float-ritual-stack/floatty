import { createSignal } from 'solid-js';

interface SyncDiagnostics {
  orphansDetected: number;
  fullResyncsTriggered: number;
  dedupRepairsMade: number;
  gapFillsPerformed: number;
  echoGapFillsPerformed: number;
  sessionStartTime: number;
}

const [diagnostics, setDiagnostics] = createSignal<SyncDiagnostics>({
  orphansDetected: 0,
  fullResyncsTriggered: 0,
  dedupRepairsMade: 0,
  gapFillsPerformed: 0,
  echoGapFillsPerformed: 0,
  sessionStartTime: Date.now(),
});

function increment(field: keyof Omit<SyncDiagnostics, 'sessionStartTime'>, amount: number = 1): void {
  setDiagnostics(prev => ({ ...prev, [field]: prev[field] + amount }));
}

export function recordOrphansDetected(count: number): void {
  increment('orphansDetected', count);
}

export function recordFullResync(): void {
  increment('fullResyncsTriggered');
}

export function recordDedupRepairs(count: number): void {
  if (count > 0) increment('dedupRepairsMade', count);
}

export function recordGapFill(): void {
  increment('gapFillsPerformed');
}

export function recordEchoGapFill(): void {
  increment('echoGapFillsPerformed');
}

export function getSyncDiagnostics(): SyncDiagnostics {
  return diagnostics();
}

export function getSyncDiagnosticsSummary(): string {
  const d = diagnostics();
  const uptimeMs = Date.now() - d.sessionStartTime;
  const uptimeMin = Math.round(uptimeMs / 60000);
  return [
    `session=${uptimeMin}min`,
    `orphans=${d.orphansDetected}`,
    `resyncs=${d.fullResyncsTriggered}`,
    `dedups=${d.dedupRepairsMade}`,
    `gaps=${d.gapFillsPerformed}`,
    `echoGaps=${d.echoGapFillsPerformed}`,
  ].join(', ');
}

export function resetSyncDiagnostics(): void {
  setDiagnostics({
    orphansDetected: 0,
    fullResyncsTriggered: 0,
    dedupRepairsMade: 0,
    gapFillsPerformed: 0,
    echoGapFillsPerformed: 0,
    sessionStartTime: Date.now(),
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetSyncDiagnostics();
  });
}
