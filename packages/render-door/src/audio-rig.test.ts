/**
 * Audio rig — Bjorklund + RigBus regression tests.
 *
 * Bjorklund's algorithm distributes `hits` pulses as evenly as possible
 * across `steps`. Canonical patterns (tresillo, cinquillo, four-on-floor,
 * Aksak) have well-known shapes — locking those is how we know we
 * haven't drifted in some clever-but-wrong refactor.
 *
 * RigBus tests verify the per-rigId scoped pub/sub: subscribing on rig 'A'
 * never receives events emitted on rig 'B', unsubscribe actually
 * detaches, and multiple listeners on the same rig all fire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  bjorklund,
  rotateArray,
  subscribeRigStep,
  subscribeRigTransport,
  emitRigStep,
  emitRigTransport,
  rigStateGet,
  type RigStepDetail,
  type RigTransportDetail,
} from './components';

// ─── Bjorklund canonical patterns ─────────────────────────────────

describe('bjorklund', () => {
  it('produces tresillo (3, 8) — canonical Cuban rhythm', () => {
    // Tresillo = ◆ · · ◆ · · ◆ ·  (positions 0, 3, 6)
    expect(bjorklund(3, 8)).toEqual([
      true,  false, false,
      true,  false, false,
      true,  false,
    ]);
  });

  it('produces cinquillo-class (5, 8) — five evenly-distributed hits', () => {
    // Bjorklund produces [T F T T F T T F] (hits at 0, 2, 3, 5, 6).
    // That's a valid Euclidean (5,8) — equivalent to son-clave by rotation.
    const pat = bjorklund(5, 8);
    expect(pat.filter(Boolean).length).toBe(5);
    expect(pat.length).toBe(8);
    expect(pat).toEqual([
      true,  false,
      true,  true,
      false, true,
      true,  false,
    ]);
  });

  it('produces four-on-floor (4, 16) — pulse on every beat', () => {
    expect(bjorklund(4, 16)).toEqual([
      true,  false, false, false,
      true,  false, false, false,
      true,  false, false, false,
      true,  false, false, false,
    ]);
  });

  it('produces Aksak-class (7, 16) — variable density', () => {
    const pat = bjorklund(7, 16);
    expect(pat.length).toBe(16);
    expect(pat.filter(Boolean).length).toBe(7);
  });

  it('produces hat-storm (13, 16) — almost-everywhere fill', () => {
    const pat = bjorklund(13, 16);
    expect(pat.length).toBe(16);
    expect(pat.filter(Boolean).length).toBe(13);
  });

  it('handles 0 hits as all-rest', () => {
    expect(bjorklund(0, 8)).toEqual(Array(8).fill(false));
  });

  it('handles hits >= steps as all-fill', () => {
    expect(bjorklund(8, 8)).toEqual(Array(8).fill(true));
    expect(bjorklund(20, 8)).toEqual(Array(8).fill(true));
  });

  it('handles negative or zero steps as empty', () => {
    expect(bjorklund(0, 0)).toEqual([]);
    expect(bjorklund(3, 0)).toEqual([]);
    expect(bjorklund(3, -2)).toEqual([]);
  });

  it('hits=1 places a single pulse at position 0', () => {
    expect(bjorklund(1, 8)).toEqual([
      true,  false, false, false, false, false, false, false,
    ]);
  });

  it('always returns exactly steps elements', () => {
    for (const [h, s] of [[3, 8], [5, 8], [7, 12], [11, 16], [13, 32]]) {
      const pat = bjorklund(h, s);
      expect(pat.length).toBe(s);
      expect(pat.filter(Boolean).length).toBe(h);
    }
  });
});

// ─── rotateArray ──────────────────────────────────────────────────

describe('rotateArray', () => {
  it('rotates by positive amount (left)', () => {
    expect(rotateArray([1, 2, 3, 4, 5], 2)).toEqual([3, 4, 5, 1, 2]);
  });

  it('rotates by 0 as identity', () => {
    expect(rotateArray([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });

  it('rotates by length as identity', () => {
    expect(rotateArray([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it('rotates by amount > length wrapping correctly', () => {
    expect(rotateArray([1, 2, 3], 5)).toEqual([3, 1, 2]);
  });

  it('rotates by negative amount (right)', () => {
    expect(rotateArray([1, 2, 3, 4, 5], -1)).toEqual([5, 1, 2, 3, 4]);
  });

  it('handles empty array', () => {
    expect(rotateArray([], 3)).toEqual([]);
  });

  it('shifts a Bjorklund pattern (rotation prop on EuclidTrack)', () => {
    const tresillo = bjorklund(3, 8); // [T F F T F F T F]
    const rotated = rotateArray(tresillo, 1); // left-shift by 1 → [F F T F F T F T]
    expect(rotated).toEqual([
      false, false, true,
      false, false, true,
      false, true,
    ]);
    // Same hit count, different starting alignment:
    expect(rotated.filter(Boolean).length).toBe(3);
  });
});

// ─── RigBus pub/sub ───────────────────────────────────────────────

const TEST_RIG_A = '__test_rig_a__';
const TEST_RIG_B = '__test_rig_b__';
const TEST_RIG_C = '__test_rig_c__';

function makeStepDetail(rigId: string, step: number): RigStepDetail {
  return { rigId, step, bpm: 124, swing: 0, masterSteps: 16, audioTime: 0 };
}

describe('RigBus.subscribeRigStep', () => {
  // Reset listener registries between tests by unsubscribing all
  // subscribers we register in each test (RigBus is window-singleton).
  let cleanups: Array<() => void> = [];
  beforeEach(() => {
    cleanups.forEach(fn => fn());
    cleanups = [];
  });

  it('delivers events to a subscriber on the same rigId', () => {
    const received: number[] = [];
    cleanups.push(subscribeRigStep(TEST_RIG_A, (d) => received.push(d.step)));
    emitRigStep(makeStepDetail(TEST_RIG_A, 0));
    emitRigStep(makeStepDetail(TEST_RIG_A, 4));
    emitRigStep(makeStepDetail(TEST_RIG_A, 8));
    expect(received).toEqual([0, 4, 8]);
  });

  it('does NOT deliver events across rigId boundaries', () => {
    const onA: number[] = [];
    const onB: number[] = [];
    cleanups.push(subscribeRigStep(TEST_RIG_A, (d) => onA.push(d.step)));
    cleanups.push(subscribeRigStep(TEST_RIG_B, (d) => onB.push(d.step)));
    emitRigStep(makeStepDetail(TEST_RIG_A, 1));
    emitRigStep(makeStepDetail(TEST_RIG_B, 99));
    expect(onA).toEqual([1]);
    expect(onB).toEqual([99]);
  });

  it('fans out to multiple subscribers on the same rigId', () => {
    const onA1: number[] = [];
    const onA2: number[] = [];
    const onA3: number[] = [];
    cleanups.push(subscribeRigStep(TEST_RIG_A, (d) => onA1.push(d.step)));
    cleanups.push(subscribeRigStep(TEST_RIG_A, (d) => onA2.push(d.step)));
    cleanups.push(subscribeRigStep(TEST_RIG_A, (d) => onA3.push(d.step)));
    emitRigStep(makeStepDetail(TEST_RIG_A, 7));
    expect(onA1).toEqual([7]);
    expect(onA2).toEqual([7]);
    expect(onA3).toEqual([7]);
  });

  it('unsubscribe detaches the listener', () => {
    const received: number[] = [];
    const unsub = subscribeRigStep(TEST_RIG_A, (d) => received.push(d.step));
    emitRigStep(makeStepDetail(TEST_RIG_A, 0));
    unsub();
    emitRigStep(makeStepDetail(TEST_RIG_A, 1));
    emitRigStep(makeStepDetail(TEST_RIG_A, 2));
    expect(received).toEqual([0]);
  });

  it('throwing listener does not break the chain', () => {
    const onA1: number[] = [];
    const onA3: number[] = [];
    cleanups.push(subscribeRigStep(TEST_RIG_A, (d) => onA1.push(d.step)));
    cleanups.push(subscribeRigStep(TEST_RIG_A, () => { throw new Error('boom'); }));
    cleanups.push(subscribeRigStep(TEST_RIG_A, (d) => onA3.push(d.step)));
    emitRigStep(makeStepDetail(TEST_RIG_A, 5));
    // Listeners 1 and 3 still receive even though listener 2 threw.
    expect(onA1).toEqual([5]);
    expect(onA3).toEqual([5]);
  });

  it('emit with no subscribers is a silent no-op (no throw)', () => {
    expect(() => emitRigStep(makeStepDetail('__nobody_listening__', 0))).not.toThrow();
  });
});

describe('RigBus.subscribeRigTransport', () => {
  let cleanups: Array<() => void> = [];
  beforeEach(() => {
    cleanups.forEach(fn => fn());
    cleanups = [];
  });

  it('delivers play/stop transitions on the same rigId', () => {
    const received: Array<RigTransportDetail['state']> = [];
    cleanups.push(subscribeRigTransport(TEST_RIG_C, (d) => received.push(d.state)));
    emitRigTransport({ rigId: TEST_RIG_C, state: 'play' });
    emitRigTransport({ rigId: TEST_RIG_C, state: 'stop' });
    emitRigTransport({ rigId: TEST_RIG_C, state: 'play' });
    expect(received).toEqual(['play', 'stop', 'play']);
  });

  it('rigState reflects the most recent transport call (set by MasterClock)', () => {
    const state = rigStateGet(TEST_RIG_C);
    state.playing = false;
    state.bpm = 100;
    expect(rigStateGet(TEST_RIG_C)).toEqual({ playing: false, bpm: 100 });
    state.playing = true;
    state.bpm = 140;
    expect(rigStateGet(TEST_RIG_C)).toEqual({ playing: true, bpm: 140 });
  });
});
