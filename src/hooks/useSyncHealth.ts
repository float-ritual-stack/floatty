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
import { getSharedDoc, triggerFullResync, setSyncStatusExternal, hasPendingUpdates, deduplicateChildIds } from './useSyncedYDoc';

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
 * Perform a single sync health check.
 * Compares local block count against server; triggers resync if persistent mismatch.
 *
 * FLO-197/P4: Uses block count instead of hash. Hash comparison was broken because
 * Y.Doc encoding includes client IDs, timestamps, tombstones - two docs with
 * identical content have different encodings and thus different hashes.
 */
async function performHealthCheck(): Promise<void> {
  if (!isClientInitialized()) {
    // Client not ready yet, skip this check
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

    if (serverHealth.blockCount !== localBlockCount) {
      const newCount = consecutiveMismatches() + 1;
      setConsecutiveMismatches(newCount);
      console.warn(
        `[SyncHealth] Block count mismatch detected (${newCount}/${MISMATCH_THRESHOLD})`,
        `\n  Server: ${serverHealth.blockCount} blocks`,
        `\n  Local:  ${localBlockCount} blocks`
      );

      if (newCount >= MISMATCH_THRESHOLD) {
        console.warn('[SyncHealth] Persistent drift detected, triggering bidirectional resync');
        setIsResyncing(true);

        try {
          const { pushedBytes } = await triggerFullResync();
          if (pushedBytes > 0) {
            console.log(`[SyncHealth] Pushed ${pushedBytes} bytes of local-only data to server`);
          }

          // Post-resync dedup: clean up any duplicate childIds from CRDT merge
          const deduped = deduplicateChildIds();
          if (deduped > 0) {
            console.warn(`[SyncHealth] Post-resync dedup removed ${deduped} duplicates`);
          }

          // Post-resync verification: re-check block counts
          const postServerHealth = await httpClient.getStateHash();
          const postLocalCount = getLocalBlockCount();

          if (postServerHealth.blockCount === postLocalCount) {
            setConsecutiveMismatches(0);
            if (!hasPendingUpdates()) {
              setSyncStatusExternal('synced', null);
            }
            console.log('[SyncHealth] Resync complete, drift resolved');
          } else {
            // Still mismatched after resync — show drift state, don't fake green
            const delta = postLocalCount - postServerHealth.blockCount;
            const absDelta = Math.abs(delta);
            const direction = delta > 0
              ? `local has ${absDelta} extra block${absDelta !== 1 ? 's' : ''}`
              : `server has ${absDelta} extra block${absDelta !== 1 ? 's' : ''}`;
            console.warn(
              `[SyncHealth] Drift persists after resync!`,
              `\n  Server: ${postServerHealth.blockCount} blocks`,
              `\n  Local:  ${postLocalCount} blocks`,
              `\n  Delta:  ${delta}`
            );
            setSyncStatusExternal(
              'drift',
              `Sync drift: ${direction}`
            );
            // Don't reset counter — will retry next check
          }
        } catch (err) {
          console.error('[SyncHealth] Resync failed:', err);
          // Don't reset counter - will retry on next check
        } finally {
          setIsResyncing(false);
        }
      }
    } else {
      // Block counts match - reset counter
      if (consecutiveMismatches() > 0) {
        console.log('[SyncHealth] Block counts match, clearing mismatch counter');
      }
      setConsecutiveMismatches(0);
    }
  } catch (err) {
    console.error('[SyncHealth] Health check failed:', err);
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
    console.log('[useSyncHealth] HMR cleanup');
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
