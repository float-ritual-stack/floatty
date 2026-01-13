/**
 * useSyncHealth - Periodic sync health check via REST polling
 *
 * Detects WebSocket sync drift by comparing local Y.Doc hash against server.
 * If mismatches persist for 2+ consecutive checks, triggers full resync.
 *
 * This is the "safety net" - even if WebSocket is zombied, we eventually catch up.
 */

import { createEffect, onCleanup, createSignal } from 'solid-js';
import { getHttpClient, isClientInitialized } from '../lib/httpClient';
import { getSharedDoc, triggerFullResync } from './useSyncedYDoc';
import * as Y from 'yjs';

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

/** How often to check sync health (ms) */
const POLL_INTERVAL = 30_000; // 30 seconds

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
// HASH COMPUTATION
// ═══════════════════════════════════════════════════════════════

/**
 * Compute SHA-256 hash of local Y.Doc state.
 * Must match server's computation in api.rs.
 */
async function computeLocalHash(): Promise<string> {
  const doc = getSharedDoc();
  if (!doc) return '';

  // Get full state (same as server's get_full_state)
  const state = Y.encodeStateAsUpdate(doc);

  // Use SubtleCrypto for SHA-256 (browser API)
  // Uint8Array is a valid BufferSource - pass directly (state.buffer could have wrong offset)
  const hashBuffer = await crypto.subtle.digest('SHA-256', state);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return hashHex;
}

// ═══════════════════════════════════════════════════════════════
// SYNC HEALTH CHECK
// ═══════════════════════════════════════════════════════════════

/**
 * Perform a single sync health check.
 * Compares local hash against server; triggers resync if persistent mismatch.
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
    const serverHash = await httpClient.getStateHash();
    const localHash = await computeLocalHash();

    setLastCheckTime(Date.now());

    if (serverHash.hash !== localHash) {
      const newCount = consecutiveMismatches() + 1;
      setConsecutiveMismatches(newCount);
      console.warn(
        `[SyncHealth] Hash mismatch detected (${newCount}/${MISMATCH_THRESHOLD})`,
        `\n  Server: ${serverHash.hash.slice(0, 16)}... (${serverHash.blockCount} blocks)`,
        `\n  Local:  ${localHash.slice(0, 16)}...`
      );

      if (newCount >= MISMATCH_THRESHOLD) {
        console.warn('[SyncHealth] Persistent drift detected, triggering full resync');
        setIsResyncing(true);

        try {
          await triggerFullResync();
          setConsecutiveMismatches(0);
          console.log('[SyncHealth] Resync complete, drift resolved');
        } catch (err) {
          console.error('[SyncHealth] Resync failed:', err);
          // Don't reset counter - will retry on next check
        } finally {
          setIsResyncing(false);
        }
      }
    } else {
      // Hashes match - reset counter
      if (consecutiveMismatches() > 0) {
        console.log('[SyncHealth] Hashes match, clearing mismatch counter');
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
