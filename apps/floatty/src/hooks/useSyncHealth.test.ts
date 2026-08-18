/**
 * FLO-895 resync-ratchet tests.
 *
 * `consecutiveMismatches` used to be deliberately left parked at
 * MISMATCH_THRESHOLD whenever a resync failed to resolve the drift. Because a
 * resync only fires at `>= threshold`, that turned two-strikes into a hair
 * trigger: every subsequent single mismatched poll fired another full ~36MB
 * resync. Evan's release client did roughly ten of them between 20:00 and
 * 03:22 on 2026-08-17.
 *
 * These tests pin the two-strikes rule, the suppression window that replaced
 * the ratchet, and the doubling — the last of which is the difference between
 * "backs off" and "backs off enough to matter at 120s polls".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const server = { blockCount: 100 };
const local = { size: 100 };
const triggerFullResync = vi.fn(async () => ({ pushedBytes: 0 }));
const setSyncStatusExternal = vi.fn();
const hasPendingUpdates = vi.fn(() => false);
const driftStatus = { value: false };
const warn = vi.fn();
const info = vi.fn();

vi.mock('../lib/httpClient', () => ({
  isClientInitialized: () => true,
  getHttpClient: () => ({ getStateHash: async () => ({ ...server }) }),
}));
vi.mock('./useSyncedYDoc', () => ({
  getSharedDoc: () => ({ getMap: () => local }),
  triggerFullResync: () => triggerFullResync(),
  setSyncStatusExternal: (...args: unknown[]) => setSyncStatusExternal(...args),
  hasPendingUpdates: () => hasPendingUpdates(),
  deduplicateChildIds: () => 0,
  isInitialLoadComplete: () => true,
  isDriftStatus: () => driftStatus.value,
}));
vi.mock('./useBlockStore', () => ({ blockStore: { blocks: {}, rootIds: [] } }));
vi.mock('../lib/syncDiagnostics', () => ({
  logDiagnosticsSummary: vi.fn(),
  getSyncDiagnosticsSummary: () => '',
}));
vi.mock('../lib/logger', () => ({
  // Arrow indirection defers the const reads past hoisted import resolution.
  createLogger: () => ({
    warn: (...args: unknown[]) => warn(...args),
    info: (...args: unknown[]) => info(...args),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { logDiagnosticsSummary } from '../lib/syncDiagnostics';
import { performHealthCheck, resetSyncHealthState, getConsecutiveMismatches, getLastCheckTime } from './useSyncHealth';

/** Drive N polls with the server and local counts disagreeing. */
async function mismatchedPolls(n: number) {
  server.blockCount = 100;
  local.size = 90;
  for (let i = 0; i < n; i++) await performHealthCheck();
}

describe('resync ratchet (FLO-895)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSyncHealthState();
    server.blockCount = 100;
    local.size = 100;
    driftStatus.value = false;
    hasPendingUpdates.mockReturnValue(false);
    // Default: the resync does not resolve the drift, which is the case that
    // used to arm the ratchet.
    triggerFullResync.mockResolvedValue({ pushedBytes: 0 });
  });

  it('still takes two strikes to fire the first resync', async () => {
    await mismatchedPolls(1);
    expect(triggerFullResync).not.toHaveBeenCalled();

    await mismatchedPolls(1);
    expect(triggerFullResync).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire again on the very next mismatch after an unresolved resync', async () => {
    await mismatchedPolls(2);
    expect(triggerFullResync).toHaveBeenCalledTimes(1);

    // This is the ratchet: pre-fix, the counter sat at the threshold, so this
    // single poll fired a second full resync.
    await mismatchedPolls(1);
    expect(triggerFullResync).toHaveBeenCalledTimes(1);
  });

  it('resets the mismatch counter when a resync does not resolve the drift', async () => {
    await mismatchedPolls(2);
    expect(getConsecutiveMismatches()).toBe(0);
  });

  it('suppresses the configured number of polls, then allows a retry', async () => {
    await mismatchedPolls(2); // resync #1
    expect(triggerFullResync).toHaveBeenCalledTimes(1);

    // 5 suppressed polls, then two more to re-earn the threshold.
    await mismatchedPolls(5);
    expect(triggerFullResync).toHaveBeenCalledTimes(1);

    await mismatchedPolls(2);
    expect(triggerFullResync).toHaveBeenCalledTimes(2);
  });

  it('doubles the window after each unresolved resync', async () => {
    await mismatchedPolls(2); // resync #1 → window 5
    await mismatchedPolls(5 + 2); // resync #2 → window 10

    expect(triggerFullResync).toHaveBeenCalledTimes(2);

    // Only 5 skips + 2 would fire a third if the window had NOT doubled.
    await mismatchedPolls(5 + 2);
    expect(triggerFullResync).toHaveBeenCalledTimes(2);

    // The remaining 5 of the doubled window, then two to re-earn it.
    await mismatchedPolls(5 + 2);
    expect(triggerFullResync).toHaveBeenCalledTimes(3);
  });

  it('backs off when the resync throws, not just when it under-delivers', async () => {
    triggerFullResync.mockRejectedValue(new Error('network down'));

    await mismatchedPolls(2);
    expect(triggerFullResync).toHaveBeenCalledTimes(1);

    await mismatchedPolls(1);
    expect(triggerFullResync).toHaveBeenCalledTimes(1);
  });

  it('clears the window when a resync actually resolves the drift', async () => {
    // Resync succeeds: local catches up to the server mid-call.
    triggerFullResync.mockImplementation(async () => {
      local.size = 100;
      return { pushedBytes: 0 };
    });

    await mismatchedPolls(2);
    expect(triggerFullResync).toHaveBeenCalledTimes(1);
    expect(setSyncStatusExternal).toHaveBeenCalledWith('synced', null);

    // No suppression window was opened, so a fresh drift gets its two strikes
    // immediately rather than waiting one out.
    triggerFullResync.mockResolvedValue({ pushedBytes: 0 });
    await mismatchedPolls(2);
    expect(triggerFullResync).toHaveBeenCalledTimes(2);
  });

  describe('drift badge', () => {
    it('clears a stale drift badge when counts agree on their own', async () => {
      driftStatus.value = true;
      server.blockCount = 100;
      local.size = 100;

      await performHealthCheck();

      // Pre-fix only a SUCCESSFUL resync cleared this, so drift that resolved
      // itself left the indicator stuck red.
      expect(setSyncStatusExternal).toHaveBeenCalledWith('synced', null);
    });

    it('leaves the badge alone when local writes are still pending', async () => {
      driftStatus.value = true;
      hasPendingUpdates.mockReturnValue(true);

      await performHealthCheck();

      expect(setSyncStatusExternal).not.toHaveBeenCalled();
    });

    it('clears a stale badge from INSIDE an open suppression window', async () => {
      await mismatchedPolls(2); // resync #1 fails → window open
      expect(triggerFullResync).toHaveBeenCalledTimes(1);
      driftStatus.value = true;
      setSyncStatusExternal.mockClear();

      // The window suppresses the resync, not the poll. Pre-fix this returned
      // before the count comparison, so the badge stayed red for the whole
      // window (up to ~30 min at the 120s cadence) even once drift resolved.
      server.blockCount = 100;
      local.size = 100;
      await performHealthCheck();

      expect(setSyncStatusExternal).toHaveBeenCalledWith('synced', null);
    });
  });

  it('keeps polling and logging diagnostics during a suppression window', async () => {
    await mismatchedPolls(2); // resync #1 fails → window open
    vi.mocked(logDiagnosticsSummary).mockClear();

    await mismatchedPolls(1);

    expect(triggerFullResync).toHaveBeenCalledTimes(1);
    expect(logDiagnosticsSummary).toHaveBeenCalled();
    expect(getLastCheckTime()).not.toBeNull();
  });
});
