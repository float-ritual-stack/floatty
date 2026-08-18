import { describe, it, expect } from 'vitest';
import {
  createPendingStructsWatchdog,
  PENDING_STALL_THRESHOLD_MS,
  PENDING_HEAL_SETTLE_MS,
} from './pendingStructsWatchdog';

const T0 = 1_000_000;
const STASH = 'client:430710203@2549|bytes:14401';
const OTHER_STASH = 'client:430710203@2600|bytes:9000';

describe('pendingStructsWatchdog', () => {
  it('stays idle while nothing is stashed', () => {
    const wd = createPendingStructsWatchdog();

    expect(wd.sample(null, T0)).toEqual({ kind: 'idle' });
    expect(wd.sample(null, T0 + 60_000)).toEqual({ kind: 'idle' });
  });

  it('watches without acting inside the grace period', () => {
    // A stash that drains in milliseconds is out-of-order delivery working as
    // designed — acting on it would pull a diff on every reordered frame.
    const wd = createPendingStructsWatchdog();

    expect(wd.sample(STASH, T0)).toEqual({ kind: 'watch', stalledMs: 0 });
    expect(wd.sample(STASH, T0 + PENDING_STALL_THRESHOLD_MS - 1)).toEqual({
      kind: 'watch',
      stalledMs: PENDING_STALL_THRESHOLD_MS - 1,
    });
  });

  it('reports cleared with the episode duration when the stash drains', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);

    expect(wd.sample(null, T0 + 3_000)).toEqual({
      kind: 'cleared',
      stalledMs: 3_000,
      healAttempts: 0,
    });
    expect(wd.sample(null, T0 + 4_000)).toEqual({ kind: 'idle' });
  });

  it('heals once the stash outlives the grace period', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);

    expect(wd.sample(STASH, T0 + PENDING_STALL_THRESHOLD_MS)).toEqual({
      kind: 'heal',
      stalledMs: PENDING_STALL_THRESHOLD_MS,
      attempt: 1,
    });
  });

  it('settles rather than re-judging while the pull may still be in flight', () => {
    // Sampling every 2s must not read "the pull hasn't finished" as
    // "the pull didn't help".
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);
    const healAt = T0 + PENDING_STALL_THRESHOLD_MS;
    expect(wd.sample(STASH, healAt).kind).toBe('heal');

    expect(wd.sample(STASH, healAt + 2_000).kind).toBe('settling');
    expect(wd.sample(STASH, healAt + PENDING_HEAL_SETTLE_MS - 1).kind).toBe('settling');
  });

  it('reports a fillable hole as cleared after the heal lands', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);
    const healAt = T0 + PENDING_STALL_THRESHOLD_MS;
    wd.sample(STASH, healAt);

    expect(wd.sample(null, healAt + 500)).toEqual({
      kind: 'cleared',
      stalledMs: PENDING_STALL_THRESHOLD_MS + 500,
      healAttempts: 1,
    });
  });
});

describe('pendingStructsWatchdog — unfillable stashes', () => {
  it('gives up when the heal changed nothing', () => {
    // Probed live 2026-08-17: a stash the server itself cannot fill (seeding a
    // scratch doc from GET /state reproduced it exactly). Retrying that is a
    // permanent pull loop against the live server.
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);
    const healAt = T0 + PENDING_STALL_THRESHOLD_MS;
    wd.sample(STASH, healAt);

    expect(wd.sample(STASH, healAt + PENDING_HEAL_SETTLE_MS)).toEqual({
      kind: 'unfillable',
      stalledMs: PENDING_STALL_THRESHOLD_MS + PENDING_HEAL_SETTLE_MS,
      attempts: 1,
    });
  });

  it('pulls exactly once for an unfillable stash, then stays dormant', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);

    let heals = 0;
    let now = T0 + PENDING_STALL_THRESHOLD_MS;
    for (let i = 0; i < 40; i++) {
      if (wd.sample(STASH, now).kind === 'heal') heals++;
      now += PENDING_HEAL_SETTLE_MS; // jump a full settle window each sample
    }

    // Over ~40 minutes of a stuck stash: one pull, no escalation, no loop.
    expect(heals).toBe(1);
  });

  it('emits unfillable once, not on every sample', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);
    const healAt = T0 + PENDING_STALL_THRESHOLD_MS;
    wd.sample(STASH, healAt);

    const settled = healAt + PENDING_HEAL_SETTLE_MS;
    expect(wd.sample(STASH, settled).kind).toBe('unfillable');
    expect(wd.sample(STASH, settled + 2_000).kind).toBe('dormant');
    expect(wd.sample(STASH, settled + 4_000).kind).toBe('dormant');
  });

  it('re-arms when the stash changes — new ops may have made it fillable', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);
    const healAt = T0 + PENDING_STALL_THRESHOLD_MS;
    wd.sample(STASH, healAt);

    const settled = healAt + PENDING_HEAL_SETTLE_MS;
    expect(wd.sample(STASH, settled).kind).toBe('unfillable');
    expect(wd.sample(STASH, settled + 2_000).kind).toBe('dormant');

    // A different stash means the doc moved; it is worth one more attempt.
    const next = wd.sample(OTHER_STASH, settled + 4_000);
    expect(next).toMatchObject({ kind: 'heal', attempt: 2 });
  });

  it('keeps healing while each attempt makes progress', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);

    let now = T0 + PENDING_STALL_THRESHOLD_MS;
    expect(wd.sample(STASH, now)).toMatchObject({ kind: 'heal', attempt: 1 });

    now += PENDING_HEAL_SETTLE_MS;
    expect(wd.sample(OTHER_STASH, now)).toMatchObject({ kind: 'heal', attempt: 2 });

    now += PENDING_HEAL_SETTLE_MS;
    expect(wd.sample('third-shape', now)).toMatchObject({ kind: 'heal', attempt: 3 });
  });

  it('notices a dormant stash finally draining', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);
    const healAt = T0 + PENDING_STALL_THRESHOLD_MS;
    wd.sample(STASH, healAt);
    const settled = healAt + PENDING_HEAL_SETTLE_MS;
    wd.sample(STASH, settled);
    expect(wd.sample(STASH, settled + 2_000).kind).toBe('dormant');

    expect(wd.sample(null, settled + 10_000)).toMatchObject({ kind: 'cleared', healAttempts: 1 });
    // And a brand-new episode starts clean.
    expect(wd.sample(STASH, settled + 12_000)).toEqual({ kind: 'watch', stalledMs: 0 });
  });

  it('reset() abandons the episode', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(STASH, T0);
    wd.reset();

    expect(wd.sample(STASH, T0 + PENDING_STALL_THRESHOLD_MS)).toEqual({
      kind: 'watch',
      stalledMs: 0,
    });
  });
});
