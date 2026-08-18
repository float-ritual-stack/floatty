/**
 * useSyncHealth - Periodic sync health check via REST polling
 *
 * Detects WebSocket sync drift by comparing local block count against server.
 * If mismatches persist for 2+ consecutive checks, triggers full resync.
 *
 * NOTE (FLO-197/P4): Originally used SHA256 hash comparison, but this was
 * fundamentally broken - Y.Doc encoding includes client IDs, timestamps, and
 * tombstones, so two docs with identical content have different hashes.
 * Block count comparison catches actual drift (create/delete mismatch) without
 * false positives from encoding differences.
 *
 * With sequence number tracking (seq field in WS broadcasts), most sync issues
 * are now detected immediately via gap detection. This poll runs at a reduced
 * frequency (120s vs 30s) as a safety net for edge cases like silent WebSocket
 * drops or compaction-related drift.
 *
 * This is the "safety net" - even if WebSocket is zombied, we eventually catch up.
 */

import { createEffect, onCleanup, createSignal } from 'solid-js';
import { getHttpClient, isClientInitialized } from '../lib/httpClient';
import { getSharedDoc, triggerFullResync, setSyncStatusExternal, hasPendingUpdates, deduplicateChildIds, isInitialLoadComplete, isDriftStatus } from './useSyncedYDoc';
import { logDiagnosticsSummary, getSyncDiagnosticsSummary } from '../lib/syncDiagnostics';
import { createLogger } from '../lib/logger';

const logger = createLogger('SyncHealth');

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

/**
 * How often to check sync health (ms).
 *
 * With sequence number tracking, gaps are now detected immediately via WebSocket.
 * This poll is just a safety net for edge cases (e.g., missed compaction, silent
 * WebSocket issues). Increased from 30s to 120s since seq provides faster detection.
 */
const POLL_INTERVAL = 120_000; // 120 seconds (2 minutes)

/** How many consecutive mismatches before triggering resync */
const MISMATCH_THRESHOLD = 2;

// ═══════════════════════════════════════════════════════════════
// STATE (exposed for debugging/UI if needed)
// ═══════════════════════════════════════════════════════════════

const [consecutiveMismatches, setConsecutiveMismatches] = createSignal(0);
const [lastCheckTime, setLastCheckTime] = createSignal<number | null>(null);
const [isResyncing, setIsResyncing] = createSignal(false);

// Module-level timer refs for HMR cleanup
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let initialDelayTimeout: ReturnType<typeof setTimeout> | null = null;

/** Get consecutive mismatch count (reactive) */
export const getConsecutiveMismatches = consecutiveMismatches;

/** Get last health check timestamp (reactive) */
export const getLastCheckTime = lastCheckTime;

/** Check if resync is in progress (reactive) */
export const getIsResyncing = isResyncing;

/** Get full sync health status including diagnostics (for dev tools / programmatic access) */
export function getSyncHealthStatus() {
  return {
    consecutiveMismatches: consecutiveMismatches(),
    lastCheckTime: lastCheckTime(),
    isResyncing: isResyncing(),
    diagnostics: getSyncDiagnosticsSummary(),
  };
}

// ═══════════════════════════════════════════════════════════════
// BLOCK COUNT (replaces broken hash comparison - FLO-197/P4)
// ═══════════════════════════════════════════════════════════════

/**
 * Count blocks in local Y.Doc.
 * Used for sync health comparison against server.
 */
function getLocalBlockCount(): number {
  const doc = getSharedDoc();
  if (!doc) return 0;

  // Read-only access - no transaction needed
  const blocksMap = doc.getMap('blocks');
  return blocksMap.size;
}

// ═══════════════════════════════════════════════════════════════
// RESYNC BACKOFF ([[FLO-895]])
// ═══════════════════════════════════════════════════════════════
//
// ## The ratchet this replaces
//
// `consecutiveMismatches` used to be left alone when a resync failed to fix the
// drift ("don't reset counter — will retry next check"). Since a resync only
// fires at `>= MISMATCH_THRESHOLD`, leaving the counter parked AT the threshold
// converted the two-strikes rule into a hair trigger: from then on a SINGLE
// mismatched poll fired another full resync.
//
// On an active client that is a storm. Counts disagree briefly all the time —
// local ahead means edits not yet pushed, server ahead means ops not yet
// arrived. Both are normal in-flight states, which is also why the observed
// deltas swing in both directions. Worse, the post-resync verification re-counts
// immediately after a ~36MB pull that takes seconds, during which more writes
// land — so on a busy outline the verification "fails" almost by construction
// and re-arms the ratchet every time. Observed on the release client
// 2026-08-17: roughly ten full resyncs between 20:00 and 03:22.
//
// The fix is a suppression window. A resync that failed once against unchanged
// state fails identically the second time, and this is the most expensive
// recovery path there is.
//
// The window gates ONLY the resync trigger, not the health poll. The count
// comparison is cheap, so it keeps running: diagnostics stay visible and drift
// that resolves on its own still clears the badge instead of leaving the
// indicator red for the length of the window (~30 min at the far end).

/** ~30 min at the 120s poll cadence. */
const MAX_RESYNC_BACKOFF_POLLS = 15;
/**
 * First suppression window, in polls (~10 min).
 *
 * Deliberately not 1: this layer moves ~36MB, so even a gentle 1-2-4 ramp costs
 * several full pulls before it bites.
 */
const INITIAL_RESYNC_BACKOFF_POLLS = 5;
let resyncBackoffPolls = 0;
let resyncPollsToSkip = 0;

/**
 * Drop all suppression state. For the HMR dispose block and tests — these are
 * module singletons, so a test that skipped this would inherit the previous
 * test's backoff window.
 */
export function resetSyncHealthState(): void {
  setConsecutiveMismatches(0);
  setLastCheckTime(null);
  setIsResyncing(false);
  resyncBackoffPolls = 0;
  resyncPollsToSkip = 0;
}

/** Reset the trigger counter and widen the gap before the next attempt. */
function backOffResync(reason: string): void {
  setConsecutiveMismatches(0);
  resyncBackoffPolls = Math.min(
    resyncBackoffPolls === 0 ? INITIAL_RESYNC_BACKOFF_POLLS : resyncBackoffPolls * 2,
    MAX_RESYNC_BACKOFF_POLLS
  );
  resyncPollsToSkip = resyncBackoffPolls;
  logger.warn(`Resync did not resolve drift (${reason}); backing off ${resyncPollsToSkip} poll(s)`);
}

/** Clear the window after a resync that actually worked. */
function clearResyncBackoff(): void {
  resyncBackoffPolls = 0;
  resyncPollsToSkip = 0;
}

// ═══════════════════════════════════════════════════════════════
// SYNC HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

/**
 * Perform a single sync health check.
 * Compares local block count against server; triggers resync if persistent mismatch.
 *
 * FLO-197/P4: Uses block count instead of hash. Hash comparison was broken because
 * Y.Doc encoding includes client IDs, timestamps, tombstones - two docs with
 * identical content have different encodings and thus different hashes.
 */
export async function performHealthCheck(): Promise<void> {
  if (!isClientInitialized()) {
    // Client not ready yet, skip this check
    return;
  }

  if (!isInitialLoadComplete()) {
    // Boot still in flight: the local store is legitimately empty, so a
    // count comparison would report a phantom mismatch and could trigger a
    // full resync ON TOP of the in-flight boot (boot-sequence audit §3.5).
    return;
  }

  if (isResyncing()) {
    // Already resyncing, skip
    return;
  }

  try {
    const httpClient = getHttpClient();
    const serverHealth = await httpClient.getStateHash();
    const localBlockCount = getLocalBlockCount();

    setLastCheckTime(Date.now());

    // Log diagnostics summary with each health check (dev visibility)
    logDiagnosticsSummary();

    if (serverHealth.blockCount !== localBlockCount) {
      const newCount = consecutiveMismatches() + 1;
      setConsecutiveMismatches(newCount);
      logger.warn(
        `Block count mismatch detected (${newCount}/${MISMATCH_THRESHOLD}) | Server: ${serverHealth.blockCount} blocks | Local: ${localBlockCount} blocks`
      );

      if (newCount >= MISMATCH_THRESHOLD) {
        if (resyncPollsToSkip > 0) {
          // Inside a suppression window: the last resync didn't resolve the
          // drift, so re-running it against effectively unchanged state just
          // repeats the cost. Only the resync is suppressed — the cheap count
          // poll above still runs, so diagnostics keep logging and drift that
          // resolves on its own still clears the badge via the match branch.
          resyncPollsToSkip--;
          logger.warn(`Resync suppressed, ${resyncPollsToSkip} poll(s) remaining in backoff window`);
          return;
        }
        logger.warn('Persistent drift detected, triggering bidirectional resync');
        setIsResyncing(true);

        try {
          const { pushedBytes } = await triggerFullResync();
          if (pushedBytes > 0) {
            logger.info(`Pushed ${pushedBytes} bytes of local-only data to server`);
          }

          // Post-resync dedup: clean up any duplicate childIds from CRDT merge
          const deduped = deduplicateChildIds();
          if (deduped > 0) {
            logger.warn(`Post-resync dedup removed ${deduped} duplicates`);
          }

          // Post-resync verification: re-check block counts
          const postServerHealth = await httpClient.getStateHash();
          const postLocalCount = getLocalBlockCount();

          if (postServerHealth.blockCount === postLocalCount) {
            setConsecutiveMismatches(0);
            clearResyncBackoff();
            if (!hasPendingUpdates()) {
              setSyncStatusExternal('synced', null);
            }
            logger.info('Resync complete, drift resolved');
          } else {
            // Still mismatched after resync — show drift state, don't fake green
            const delta = postLocalCount - postServerHealth.blockCount;
            const absDelta = Math.abs(delta);
            const direction = delta > 0
              ? `local has ${absDelta} extra block${absDelta !== 1 ? 's' : ''}`
              : `server has ${absDelta} extra block${absDelta !== 1 ? 's' : ''}`;
            logger.warn(
              `Drift persists after resync! Server: ${postServerHealth.blockCount} blocks | Local: ${postLocalCount} blocks | Delta: ${delta}`
            );
            setSyncStatusExternal(
              'drift',
              `Sync drift: ${direction}`
            );
            backOffResync(`delta ${delta}`);
          }
        } catch (err) {
          logger.error('Resync failed', { err });
          backOffResync('resync threw');
        } finally {
          setIsResyncing(false);
        }
      }
    } else {
      // Block counts match - reset counter
      if (consecutiveMismatches() > 0) {
        logger.info('Block counts match, clearing mismatch counter');
      }
      setConsecutiveMismatches(0);
      clearResyncBackoff();
      // Counts agreeing IS a recovery signal. Previously only a successful
      // resync cleared the badge, so drift that resolved on its own left the
      // indicator stuck red.
      if (isDriftStatus() && !hasPendingUpdates()) {
        setSyncStatusExternal('synced', null);
      }
      logger.info(`OK ${localBlockCount} blocks in sync | ${getSyncDiagnosticsSummary()}`);
    }
  } catch (err) {
    logger.error('Health check failed', { err });
    // Network error - don't count as mismatch, just skip
  }
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

/**
 * Start periodic sync health checking.
 * Call once in App.tsx - polling runs for app lifetime.
 */
export function useSyncHealth(): void {
  createEffect(() => {
    // Initial check after a short delay (let WS connect first)
    initialDelayTimeout = setTimeout(() => {
      performHealthCheck();
    }, 5000);

    // Periodic checks
    healthCheckInterval = setInterval(() => {
      performHealthCheck();
    }, POLL_INTERVAL);

    onCleanup(() => {
      if (initialDelayTimeout) clearTimeout(initialDelayTimeout);
      if (healthCheckInterval) clearInterval(healthCheckInterval);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    logger.debug('HMR cleanup');
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    if (initialDelayTimeout) {
      clearTimeout(initialDelayTimeout);
      initialDelayTimeout = null;
    }
    // Reset signals AND the module-level backoff window to clean state.
    resetSyncHealthState();
  });
}
