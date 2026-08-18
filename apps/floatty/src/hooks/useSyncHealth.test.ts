/**
 * Sync-health trigger tests ([[FLO-895]]).
 *
 * The layer under test is the expensive one: a full bidirectional resync moves
 * ~36MB on Evan's outline and takes seconds. What guards it is a two-strikes
 * rule — counts must disagree on two consecutive polls.
 *
 * That guard used to disarm itself. When a resync failed to resolve the drift
 * the mismatch counter was deliberately left alone, parked exactly AT the
 * threshold, so from then on a SINGLE mismatched poll fired another resync.
 * On an active client counts disagree briefly all the time (edits not yet
 * pushed, ops not yet arrived), and the post-resync verification re-counts
 * right after a multi-second pull — so it "fails" almost by construction and
 * re-arms the ratchet. Result: ~10 full resyncs in seven hours on the release
 * client, 2026-08-17.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

const doc = new Y.Doc();
let serverBlockCount = 10;
/** Set by triggerFullResync when the test wants the resync to actually work. */
let resyncFixesDrift = false;

function setLocalBlocks(n: number) {
  const blocks = doc.getMap('blocks');
  doc.transact(() => {
    for (const k of [...blocks.keys()]) blocks.delete(k);
    for (let i = 0; i < n; i++) blocks.set(`b${i}`, i);
  });
}

const triggerFullResync = vi.fn(async () => {
  if (resyncFixesDrift) serverBlockCount = doc.getMap('blocks').size;
  return { pushedBytes: 0 };
});
const setSyncStatusExternal = vi.fn();
const pullServerDiffNow = vi.fn(async () => false);
const getStateHash = vi.fn(async () => ({
  hash: 'x',
  blockCount: serverBlockCount,
  timestamp: 0,
  epoch: 0,
}));
let driftStatus = false;

vi.mock('../lib/httpClient', () => ({
  getHttpClient: () => ({ getStateHash: () => getStateHash() }),
  isClientInitialized: () => true,
}));
vi.mock('./useSyncedYDoc', () => ({
  getSharedDoc: () => doc,
  triggerFullResync: () => triggerFullResync(),
  setSyncStatusExternal: (...a: unknown[]) => setSyncStatusExternal(...a),
  hasPendingUpdates: () => false,
  deduplicateChildIds: () => 0,
  isInitialLoadComplete: () => true,
  pullServerDiffNow: () => pullServerDiffNow(),
  isDriftStatus: () => driftStatus,
}));
vi.mock('./useBlockStore', () => ({
  blockStore: { reconcileStoreFromYDoc: () => null },
}));
vi.mock('../lib/syncDiagnostics', () => ({
  logDiagnosticsSummary: vi.fn(),
  getSyncDiagnosticsSummary: () => '',
  recordStoreReconcileRepairs: vi.fn(),
}));
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { performHealthCheck, resetSyncHealthState, getConsecutiveMismatches } from './useSyncHealth';

/** One poll with the counts disagreeing. */
async function pollWithDrift() {
  setLocalBlocks(serverBlockCount + 1);
  await performHealthCheck();
}

/** One poll with the counts agreeing. */
async function pollHealthy() {
  setLocalBlocks(serverBlockCount);
  await performHealthCheck();
}

beforeEach(() => {
  resetSyncHealthState();
  triggerFullResync.mockClear();
  setSyncStatusExternal.mockClear();
  pullServerDiffNow.mockClear();
  serverBlockCount = 10;
  resyncFixesDrift = false;
  driftStatus = false;
});

describe('resync trigger — two strikes', () => {
  it('does not resync on a single mismatch', async () => {
    await pollWithDrift();

    expect(triggerFullResync).not.toHaveBeenCalled();
    expect(getConsecutiveMismatches()).toBe(1);
  });

  it('resyncs on two consecutive mismatches', async () => {
    await pollWithDrift();
    await pollWithDrift();

    expect(triggerFullResync).toHaveBeenCalledTimes(1);
  });

  it('a healthy poll clears the counter', async () => {
    await pollWithDrift();
    await pollHealthy();
    await pollWithDrift();

    expect(triggerFullResync).not.toHaveBeenCalled();
  });
});

describe('resync trigger — the ratchet must not come back', () => {
  it('does not fire again on the very next mismatched poll', async () => {
    // THE bug: the counter used to be left parked at the threshold after a
    // failed resync, so this third poll — a single mismatch — fired another
    // full resync. Suppression is what prevents it now.
    await pollWithDrift();
    await pollWithDrift();
    expect(triggerFullResync).toHaveBeenCalledTimes(1);

    await pollWithDrift();

    expect(triggerFullResync).toHaveBeenCalledTimes(1);
  });

  it('backs off instead of resyncing on every poll pair', async () => {
    await pollWithDrift();
    await pollWithDrift();
    expect(triggerFullResync).toHaveBeenCalledTimes(1);

    // Ten more drifting polls. With the ratchet this was ~10 more full pulls;
    // with two-strikes-only it would be ~5.
    for (let i = 0; i < 10; i++) await pollWithDrift();

    expect(triggerFullResync.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('retries once the backoff window passes', async () => {
    await pollWithDrift();
    await pollWithDrift(); // resync #1, fails → suppression window opens
    expect(triggerFullResync).toHaveBeenCalledTimes(1);

    // Drive past the window, then two strikes.
    for (let i = 0; i < 5; i++) await pollWithDrift();
    await pollWithDrift();
    await pollWithDrift();

    expect(triggerFullResync).toHaveBeenCalledTimes(2);
  });

  it('widens the window on each failure rather than settling into a rhythm', async () => {
    const skipsBefore: number[] = [];
    let polls = 0;
    let resyncs = 0;

    // Drive 40 drifting polls and record how many resyncs happen. With the
    // ratchet this is ~39; with two-strikes-only it is ~20; with backoff it
    // must be far fewer, and the gaps must grow.
    while (polls < 40) {
      const before = triggerFullResync.mock.calls.length;
      await pollWithDrift();
      polls++;
      if (triggerFullResync.mock.calls.length > before) {
        skipsBefore.push(polls);
        resyncs++;
      }
    }

    // Two-strikes alone would give ~20 over 40 polls; the ratchet ~39.
    expect(resyncs).toBeLessThanOrEqual(4);
    // And the spacing widens rather than settling into a fixed rhythm.
    const gaps = skipsBefore.slice(1).map((p, i) => p - skipsBefore[i]);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    }
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);
  });

  it('clears the backoff when a resync actually resolves the drift', async () => {
    await pollWithDrift();
    await pollWithDrift(); // resync #1 fails → backoff armed
    expect(triggerFullResync).toHaveBeenCalledTimes(1);

    resyncFixesDrift = true;
    for (let i = 0; i < 5; i++) await pollWithDrift(); // suppression window
    await pollWithDrift();
    await pollWithDrift(); // resync #2 — this one works
    expect(triggerFullResync).toHaveBeenCalledTimes(2);

    // Backoff cleared, so the next genuine drift pair resyncs immediately.
    resyncFixesDrift = false;
    await pollWithDrift();
    await pollWithDrift();
    expect(triggerFullResync).toHaveBeenCalledTimes(3);
  });

  it('clears the backoff when the counts agree on their own', async () => {
    await pollWithDrift();
    await pollWithDrift(); // resync #1 fails → backoff armed
    await pollHealthy(); // recovery WITHOUT a resync

    await pollWithDrift();
    await pollWithDrift();

    expect(triggerFullResync).toHaveBeenCalledTimes(2);
  });
});

describe('drift indicator', () => {
  it('clears a stale drift badge when the counts agree again', async () => {
    // Previously only a successful resync cleared drift, so the badge stayed
    // red after the drift resolved on its own.
    driftStatus = true;

    await pollHealthy();

    expect(setSyncStatusExternal).toHaveBeenCalledWith('synced', null);
  });

  it('does not touch status on a healthy poll when there was no drift', async () => {
    driftStatus = false;

    await pollHealthy();

    expect(setSyncStatusExternal).not.toHaveBeenCalled();
  });
});
