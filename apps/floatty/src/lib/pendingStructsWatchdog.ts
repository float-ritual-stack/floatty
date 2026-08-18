/**
 * Pending-structs watchdog — the self-heal for silent yjs stalls ([[FLO-895]]).
 *
 * ## The failure this exists for
 *
 * yjs integrates remote ops only when their causal dependencies are present.
 * When a dependency is missing, `Y.applyUpdate` does NOT error — it stashes
 * the update in `doc.store.pendingStructs` and returns normally. Every
 * subsequent op from that writer stashes too (clock contiguity per client-id),
 * so the client goes quietly stale: writes land on the server, broadcasts
 * arrive, and nothing renders. Sync status stays green because no layer ever
 * saw a failure.
 *
 * Gap detection (seq tracking) covers the case where we NOTICE the missing
 * frame. This watchdog covers the case where we don't: it reads the stash
 * itself, which is the ground truth for "yjs is holding ops it cannot apply".
 *
 * ## Why a grace period
 *
 * A non-null stash is NORMAL for a few hundred milliseconds — out-of-order WS
 * frames are exactly what it is for, and the next frame drains it. Only a
 * stash that PERSISTS is a stall. Sample often (a field read), act only after
 * {@link PENDING_STALL_THRESHOLD_MS}.
 *
 * ## Why the ladder stops instead of escalating
 *
 * The heal is a state-vector diff pull: the stashed ops are not integrated, so
 * they are absent from the local state vector, and the server's diff therefore
 * includes the frame that opened the hole.
 *
 * That works only when the server HAS the missing ops. Probing the dev client
 * on 2026-08-17 found a stash the server could not fill: seeding a scratch doc
 * from `GET /api/v1/state` reproduced the identical stash, and 7 of 8 missing
 * client-ids were either absent from the server entirely or short by several
 * clocks. The server's own persisted doc referenced predecessors it did not
 * have.
 *
 * Two consequences, both load-bearing here:
 *
 * 1. Retrying is pointless for that class of hole, and an unbounded retry is a
 *    permanent low-grade pull loop against the live server.
 * 2. Escalating to a full resync is WORSE than pointless — the full state
 *    comes from the same doc the diff came from, so it reproduces the same
 *    stash while costing a multi-second freeze on a large outline.
 *
 * So the watchdog heals ONCE, checks whether the stash actually changed, and
 * goes dormant when it did not. A dormant episode still samples (so a later
 * drain is noticed and reported) but never pulls again until the stash itself
 * changes — which would mean new ops arrived and the hole may now be fillable.
 *
 * This module is the decision core only: pure, clock-injected, no yjs and no
 * network. The caller supplies a signature of the current stash and performs
 * the returned action. See `useSyncedYDoc.ts` for the wiring.
 */

/** How long a stash must persist before it counts as a stall, not reordering. */
export const PENDING_STALL_THRESHOLD_MS = 10_000;

/**
 * How long to wait after a heal before judging whether it worked.
 *
 * Must comfortably exceed a diff pull on a large doc — judging too early would
 * read "the pull hasn't finished yet" as "the pull didn't help".
 */
export const PENDING_HEAL_SETTLE_MS = 60_000;

/** How often the caller should sample the stash. A field read; effectively free. */
export const PENDING_SAMPLE_INTERVAL_MS = 2_000;

/**
 * Identity of the current stash, or null when there is none.
 *
 * Any stable encoding works as long as it changes when the stash changes —
 * the watchdog only ever compares it for equality, to tell "the heal made
 * progress" from "the heal changed nothing".
 */
export type StashSignature = string | null;

/** What the caller should do with this sample. */
export type WatchdogAction =
  /** No stash. Nothing to do. */
  | { kind: 'idle' }
  /** Stash present but inside the grace period — probably reordering. */
  | { kind: 'watch'; stalledMs: number }
  /** Stall confirmed: pull a state diff. */
  | { kind: 'heal'; stalledMs: number; attempt: number }
  /** Waiting to see whether the last heal worked. */
  | { kind: 'settling'; stalledMs: number }
  /**
   * The heal changed nothing — the server cannot supply the missing ops.
   * Emitted ONCE per episode; further samples return `dormant`.
   */
  | { kind: 'unfillable'; stalledMs: number; attempts: number }
  /** Known-unfillable stash, unchanged. Stay quiet. */
  | { kind: 'dormant'; stalledMs: number }
  /** The stash drained. Carries how long the episode lasted, for logging. */
  | { kind: 'cleared'; stalledMs: number; healAttempts: number };

export interface PendingStructsWatchdog {
  /** Feed one sample. `signature` is null when the doc holds no stash. */
  sample(signature: StashSignature, now: number): WatchdogAction;
  /** Drop episode state (reconnect, restore, HMR). */
  reset(): void;
}

/**
 * Build a watchdog.
 *
 * Stateful across samples but pure with respect to time: every decision comes
 * from the `now` the caller passes, so tests drive it with a fake clock instead
 * of waiting out real thresholds.
 */
export function createPendingStructsWatchdog(): PendingStructsWatchdog {
  /** When the current stall episode began. Null when no stash is held. */
  let pendingSince: number | null = null;
  /** When the last heal fired in this episode. */
  let lastHealAt: number | null = null;
  /** The stash as it looked when the last heal fired. */
  let signatureAtLastHeal: StashSignature = null;
  /** Diff pulls attempted in this episode. */
  let healAttempts = 0;
  /** The stash we gave up on. Non-null means dormant. */
  let dormantSignature: StashSignature = null;

  const reset = (): void => {
    pendingSince = null;
    lastHealAt = null;
    signatureAtLastHeal = null;
    healAttempts = 0;
    dormantSignature = null;
  };

  return {
    reset,

    sample(signature: StashSignature, now: number): WatchdogAction {
      if (signature === null) {
        if (pendingSince === null) return { kind: 'idle' };
        const cleared: WatchdogAction = {
          kind: 'cleared',
          stalledMs: now - pendingSince,
          healAttempts,
        };
        reset();
        return cleared;
      }

      if (pendingSince === null) pendingSince = now;
      const stalledMs = now - pendingSince;

      // Given up on this exact stash. A CHANGED stash means new ops arrived
      // and the hole may now be fillable, so re-arm rather than stay quiet.
      if (dormantSignature !== null) {
        if (signature === dormantSignature) return { kind: 'dormant', stalledMs };
        dormantSignature = null;
      }

      if (stalledMs < PENDING_STALL_THRESHOLD_MS) {
        return { kind: 'watch', stalledMs };
      }

      if (lastHealAt !== null) {
        // Don't judge a heal that may still be in flight.
        if (now - lastHealAt < PENDING_HEAL_SETTLE_MS) {
          return { kind: 'settling', stalledMs };
        }
        if (signature === signatureAtLastHeal) {
          dormantSignature = signature;
          return { kind: 'unfillable', stalledMs, attempts: healAttempts };
        }
      }

      lastHealAt = now;
      signatureAtLastHeal = signature;
      healAttempts += 1;
      return { kind: 'heal', stalledMs, attempt: healAttempts };
    },
  };
}
