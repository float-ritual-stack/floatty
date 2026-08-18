import { describe, it, expect } from 'vitest';
import {
  createPendingStructsWatchdog,
  PENDING_STALL_THRESHOLD_MS,
  PENDING_HEAL_COOLDOWN_MS,
  PENDING_MAX_DIFF_HEALS,
} from './pendingStructsWatchdog';

const T0 = 1_000_000;

describe('pendingStructsWatchdog', () => {
  it('stays idle while nothing is stashed', () => {
    const wd = createPendingStructsWatchdog();

    expect(wd.sample(false, T0)).toEqual({ kind: 'idle' });
    expect(wd.sample(false, T0 + 60_000)).toEqual({ kind: 'idle' });
  });

  it('watches without acting inside the grace period', () => {
    // A stash that drains in milliseconds is out-of-order delivery working as
    // designed — acting on it would pull a diff on every reordered frame.
    const wd = createPendingStructsWatchdog();

    expect(wd.sample(true, T0)).toEqual({ kind: 'watch', stalledMs: 0 });
    expect(wd.sample(true, T0 + PENDING_STALL_THRESHOLD_MS - 1)).toEqual({
      kind: 'watch',
      stalledMs: PENDING_STALL_THRESHOLD_MS - 1,
    });
  });

  it('reports cleared with the episode duration when the stash drains', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(true, T0);

    expect(wd.sample(false, T0 + 3_000)).toEqual({
      kind: 'cleared',
      stalledMs: 3_000,
      healAttempts: 0,
    });
    // Episode state is gone — the next sample starts fresh.
    expect(wd.sample(false, T0 + 4_000)).toEqual({ kind: 'idle' });
  });

  it('heals once the stash outlives the grace period', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(true, T0);

    expect(wd.sample(true, T0 + PENDING_STALL_THRESHOLD_MS)).toEqual({
      kind: 'heal',
      stalledMs: PENDING_STALL_THRESHOLD_MS,
      attempt: 1,
    });
  });

  it('holds in cooldown between heal attempts', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(true, T0);
    const healAt = T0 + PENDING_STALL_THRESHOLD_MS;
    expect(wd.sample(true, healAt).kind).toBe('heal');

    // Sampling every 2s must not fire a diff pull every 2s.
    expect(wd.sample(true, healAt + 2_000).kind).toBe('cooldown');
    expect(wd.sample(true, healAt + PENDING_HEAL_COOLDOWN_MS - 1).kind).toBe('cooldown');
    expect(wd.sample(true, healAt + PENDING_HEAL_COOLDOWN_MS).kind).toBe('heal');
  });

  it('keeps the stall clock running across heal attempts', () => {
    // The logged duration is the whole episode, not the time since last heal —
    // "stalled 70s" is the number that tells you how bad it got.
    const wd = createPendingStructsWatchdog();
    wd.sample(true, T0);
    const firstHeal = T0 + PENDING_STALL_THRESHOLD_MS;
    wd.sample(true, firstHeal);

    const second = wd.sample(true, firstHeal + PENDING_HEAL_COOLDOWN_MS);
    expect(second).toEqual({
      kind: 'heal',
      stalledMs: PENDING_STALL_THRESHOLD_MS + PENDING_HEAL_COOLDOWN_MS,
      attempt: 2,
    });
  });

  it('escalates to full resync once, after the diff pulls fail', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(true, T0);

    let now = T0 + PENDING_STALL_THRESHOLD_MS;
    for (let attempt = 1; attempt <= PENDING_MAX_DIFF_HEALS; attempt++) {
      expect(wd.sample(true, now)).toMatchObject({ kind: 'heal', attempt });
      now += PENDING_HEAL_COOLDOWN_MS;
    }

    expect(wd.sample(true, now)).toMatchObject({ kind: 'escalate' });

    // Escalation is once per episode — a stuck stash must not trigger a
    // 36MB bidirectional resync every cooldown window.
    now += PENDING_HEAL_COOLDOWN_MS;
    expect(wd.sample(true, now).kind).toBe('heal');
    now += PENDING_HEAL_COOLDOWN_MS;
    expect(wd.sample(true, now).kind).toBe('heal');
  });

  it('re-arms escalation for a genuinely new episode', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(true, T0);

    let now = T0 + PENDING_STALL_THRESHOLD_MS;
    for (let i = 0; i < PENDING_MAX_DIFF_HEALS; i++) {
      wd.sample(true, now);
      now += PENDING_HEAL_COOLDOWN_MS;
    }
    expect(wd.sample(true, now).kind).toBe('escalate');

    // Stash drains — episode over.
    expect(wd.sample(false, now + 1_000).kind).toBe('cleared');

    // A later, unrelated stall gets the full ladder again.
    const t1 = now + 500_000;
    wd.sample(true, t1);
    let n = t1 + PENDING_STALL_THRESHOLD_MS;
    for (let i = 0; i < PENDING_MAX_DIFF_HEALS; i++) {
      expect(wd.sample(true, n).kind).toBe('heal');
      n += PENDING_HEAL_COOLDOWN_MS;
    }
    expect(wd.sample(true, n).kind).toBe('escalate');
  });

  it('counts heal attempts in the cleared report', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(true, T0);
    const healAt = T0 + PENDING_STALL_THRESHOLD_MS;
    wd.sample(true, healAt);

    expect(wd.sample(false, healAt + 5_000)).toEqual({
      kind: 'cleared',
      stalledMs: PENDING_STALL_THRESHOLD_MS + 5_000,
      healAttempts: 1,
    });
  });

  it('reset() abandons the episode', () => {
    const wd = createPendingStructsWatchdog();
    wd.sample(true, T0);
    wd.reset();

    // Clock restarts: the old episode's age must not carry into a fresh one.
    expect(wd.sample(true, T0 + PENDING_STALL_THRESHOLD_MS)).toEqual({
      kind: 'watch',
      stalledMs: 0,
    });
  });
});
