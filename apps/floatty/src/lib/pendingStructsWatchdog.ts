/**
 * Pending-structs watchdog — the self-heal for silent yjs stalls ([[FLO-895]]).
 *
 * ## The failure this exists for
 *
 * yjs integrates remote ops only when their causal dependencies are present.
 * When one server frame goes missing, `Y.applyUpdate` does NOT error — it
 * stashes the update in `doc.store.pendingStructs` and returns normally. Every
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
 * frames are exactly what the stash is for, and the next frame drains it. Only
 * a stash that PERSISTS is a stall. Hence: sample often (cheap field read),
 * act only after {@link PENDING_STALL_THRESHOLD_MS}.
 *
 * ## The heal
 *
 * A state-vector diff pull (`POST /api/v1/state-diff`). The stashed ops are not
 * integrated, so they are absent from the local state vector — the server's
 * diff therefore includes the missing frame that opened the hole. Applying it
 * lets yjs drain the stash. This heals ANY hole regardless of cause, and
 * survives compaction (it diffs doc state, not the seq log).
 *
 * This module is the decision core only: pure, clock-injected, no yjs and no
 * network. The caller supplies "is there a stash right now" and performs the
 * returned action. See `useSyncedYDoc.ts` for the wiring.
 */

/** How long a stash must persist before it counts as a stall, not reordering. */
export const PENDING_STALL_THRESHOLD_MS = 10_000;

/**
 * Minimum spacing between heal attempts within one stall episode.
 *
 * A diff pull that fails to drain the stash means something worse than a
 * missing frame; retrying every sample would hammer the server for nothing.
 */
export const PENDING_HEAL_COOLDOWN_MS = 60_000;

/**
 * Diff pulls to attempt before escalating to a full bidirectional resync.
 *
 * The diff is the cheap, precise heal and should always be enough. If three of
 * them (≈3 minutes) leave the stash in place, the doc is broken in a way the
 * diff cannot express, and the expensive hammer is justified — once per
 * episode, never in a loop.
 */
export const PENDING_MAX_DIFF_HEALS = 3;

/** How often the caller should sample the stash. A field read; effectively free. */
export const PENDING_SAMPLE_INTERVAL_MS = 2_000;

/** What the caller should do with this sample. */
export type WatchdogAction =
  /** No stash. Nothing to do. */
  | { kind: 'idle' }
  /** Stash present but inside the grace period — probably reordering. */
  | { kind: 'watch'; stalledMs: number }
  /** Stall confirmed: pull a state diff. */
  | { kind: 'heal'; stalledMs: number; attempt: number }
  /** Diff pulls did not drain the stash: escalate to full resync (once). */
  | { kind: 'escalate'; stalledMs: number }
  /** Stall confirmed but a heal fired recently — hold. */
  | { kind: 'cooldown'; stalledMs: number }
  /** The stash drained. Carries how long the episode lasted, for logging. */
  | { kind: 'cleared'; stalledMs: number; healAttempts: number };

export interface PendingStructsWatchdog {
  /**
   * Feed one sample. `hasPending` is `doc.store.pendingStructs !== null`
   * (or pendingDs — a stashed delete set stalls the same way).
   */
  sample(hasPending: boolean, now: number): WatchdogAction;
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
  /** Diff pulls attempted in this episode. */
  let healAttempts = 0;
  /** Whether this episode already escalated. Escalation happens at most once. */
  let escalated = false;

  const reset = (): void => {
    pendingSince = null;
    lastHealAt = null;
    healAttempts = 0;
    escalated = false;
  };

  return {
    reset,

    sample(hasPending: boolean, now: number): WatchdogAction {
      if (!hasPending) {
        if (pendingSince === null) return { kind: 'idle' };
        const cleared: WatchdogAction = {
          kind: 'cleared',
          stalledMs: now - pendingSince,
          healAttempts,
        };
        reset();
        return cleared;
      }

      // First sample of a new episode: start the clock, decide next time.
      // Deliberately not `now - now === 0 < threshold` special-cased; the
      // uniform path below handles it.
      if (pendingSince === null) pendingSince = now;

      const stalledMs = now - pendingSince;
      if (stalledMs < PENDING_STALL_THRESHOLD_MS) {
        return { kind: 'watch', stalledMs };
      }

      if (lastHealAt !== null && now - lastHealAt < PENDING_HEAL_COOLDOWN_MS) {
        return { kind: 'cooldown', stalledMs };
      }

      lastHealAt = now;

      if (healAttempts >= PENDING_MAX_DIFF_HEALS) {
        if (escalated) {
          // Already spent the expensive hammer on this episode. Keep pulling
          // diffs rather than resyncing in a loop — the diff is idempotent and
          // cheap, and the loud logging continues either way.
          healAttempts += 1;
          return { kind: 'heal', stalledMs, attempt: healAttempts };
        }
        escalated = true;
        return { kind: 'escalate', stalledMs };
      }

      healAttempts += 1;
      return { kind: 'heal', stalledMs, attempt: healAttempts };
    },
  };
}
