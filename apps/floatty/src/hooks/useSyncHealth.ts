/**
 * useSyncHealth — the periodic safety net. Three layers, three failure shapes.
 *
 * With sequence tracking, most sync issues are caught immediately via gap
 * detection on the WebSocket. This poll exists for what gap detection misses,
 * and runs at a reduced cadence (120s) because it is a backstop, not a path.
 *
 * ## Layer 1 — store vs Y.Doc (local, no network) [[FLO-895]]
 *
 * Runs FIRST because it is the only layer that can fix a store that disagrees
 * with its own Y.Doc. Every network-level repair — gap fetch, state diff, full
 * resync — assumes "if the Y.Doc has it, the app shows it". When that
 * assumption breaks (the observer's `toBlock()` guard silently skipping a
 * write), no amount of resyncing helps: the server sends nothing new because
 * the client is already up to date, so the observer never re-fires and the
 * stale render survives until restart. That is the shape observed on the live
 * client — block counts in parity with the server while the block never
 * rendered. See `reconcileStoreFromYDoc` in `useBlockStore.ts`.
 *
 * ## Layer 2 — content drift (state-vector diff pull)
 *
 * Block counts match whenever a PATCH is missed rather than a create — which
 * is precisely the reported symptom (client renders one edit behind). Counting
 * blocks cannot see it.
 *
 * NOTE (FLO-197/P4, still true): comparing SHA256 of the encoded doc does NOT
 * work as a content check. Y.Doc encoding carries client ids, clocks and
 * tombstones, so two docs with identical logical content hash differently.
 * Wiring `/api/v1/state/hash`'s hash into a comparison would mismatch forever
 * and resync every 2 minutes.
 *
 * The comparable form of "am I missing content" is the state VECTOR, and
 * `POST /api/v1/state-diff` already answers it authoritatively: send the local
 * vector, get back exactly the ops we lack. An up-to-date client gets an empty
 * 2-byte response; a client missing a PATCH gets that PATCH. Detection and
 * repair are the same call, so this layer heals instead of merely alarming —
 * and it survives compaction, unlike a seq-based catch-up.
 *
 * ## Layer 3 — block count (create/delete drift)
 *
 * The original check, unchanged: persistent count mismatch across
 * MISMATCH_THRESHOLD polls triggers a bidirectional resync. This is the only
 * layer that pushes local-only data, so it stays the escalation path.
 */

import { createEffect, onCleanup, createSignal } from 'solid-js';
import { getHttpClient, isClientInitialized } from '../lib/httpClient';
import { getSharedDoc, triggerFullResync, setSyncStatusExternal, hasPendingUpdates, deduplicateChildIds, isInitialLoadComplete, pullServerDiffNow } from './useSyncedYDoc';
import { blockStore } from './useBlockStore';
import { logDiagnosticsSummary, getSyncDiagnosticsSummary, recordStoreReconcileRepairs } from '../lib/syncDiagnostics';
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
// SYNC HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

/**
 * Layer 1: repair the SolidJS store from the Y.Doc (FLO-895).
 *
 * Local and cheap, so it runs on every poll before any network work — and
 * before the count comparison, which reads the store's view of the world.
 */
function reconcileStoreLayer(): void {
  const report = blockStore.reconcileStoreFromYDoc();
  if (!report) return; // pre-init; nothing to compare against yet

  const repaired = report.missing + report.extra + report.stale;
  if (repaired === 0 && !report.rootIdsRepaired && report.unreadable === 0) return;

  recordStoreReconcileRepairs(repaired);
  logger.warn(
    `Store/Y.Doc divergence: ${report.missing} missing, ${report.extra} extra, ` +
      `${report.stale} stale repaired (scanned ${report.scanned} of ${report.docBlocks})` +
      `${report.rootIdsRepaired ? ', rootIds replaced' : ''}` +
      // Not repairable from here — the Y.Doc entry itself is malformed.
      `${report.unreadable > 0 ? `, ${report.unreadable} unreadable in Y.Doc` : ''}` +
      `${report.sampleIds.length > 0 ? ` | ids: ${report.sampleIds.join(', ')}` : ''}`
  );
}

/**
 * Layer 2: pull whatever ops this doc is missing (FLO-895).
 *
 * Detection and repair in one call — see the module header for why a hash
 * comparison cannot do this job. Returns true when real ops landed, which
 * means the client HAD silently drifted at the Y.Doc level.
 */
async function pullContentDriftLayer(): Promise<boolean> {
  try {
    const applied = await pullServerDiffNow();
    if (applied) {
      logger.warn(
        'Content drift healed: the server held ops this client never received ' +
          '(counts alone would not have caught this)'
      );
    }
    return applied;
  } catch (err) {
    logger.error('Content drift pull failed', { err });
    return false;
  }
}

/**
 * Perform a single sync health check — all three layers, cheapest first.
 */
async function performHealthCheck(): Promise<void> {
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
    // Layer 1 — local store repair. Runs before the count read below so the
    // count reflects a store already reconciled with its Y.Doc.
    reconcileStoreLayer();

    // Layer 2 — pull any ops we're missing. Awaited before the count check so
    // a heal here doesn't leave a phantom mismatch for layer 3 to escalate on.
    await pullContentDriftLayer();

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
            // Don't reset counter — will retry next check
          }
        } catch (err) {
          logger.error('Resync failed', { err });
          // Don't reset counter - will retry on next check
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
    // Reset signals to clean state
    setConsecutiveMismatches(0);
    setLastCheckTime(null);
    setIsResyncing(false);
  });
}
