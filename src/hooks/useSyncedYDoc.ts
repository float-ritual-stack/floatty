/**
 * useSyncedYDoc - Bridge between Server (floatty-server) and Frontend (yjs)
 *
 * Phase 3: Uses HTTP client to sync with floatty-server instead of Tauri IPC.
 *
 * Handles:
 * - Loading initial state from server on mount
 * - Observing local Y.Doc changes and syncing to server
 * - Debounced batch updates with retry logic
 */

import { onMount, onCleanup, createSignal, type Accessor } from 'solid-js';
import { getHttpClient, isClientInitialized } from '../lib/httpClient';
import * as Y from 'yjs';
import {
  saveBackup as saveBackupIDB,
  getBackup as getBackupIDB,
  clearBackup as clearBackupIDB,
  hasBackup as hasBackupIDB,
  initBackupNamespace,
} from '../lib/idbBackup';
import { invoke } from '@tauri-apps/api/core';
import type { AggregatorConfig } from '../lib/tauriTypes';

// ═══════════════════════════════════════════════════════════════
// SYNC STATUS (singleton signals for UI visibility)
// ═══════════════════════════════════════════════════════════════

export type SyncStatus = 'synced' | 'pending' | 'error';

// Singleton signals - survive component remount like sharedDoc
const [syncStatus, setSyncStatus] = createSignal<SyncStatus>('synced');
const [pendingCount, setPendingCount] = createSignal(0);
const [lastSyncError, setLastSyncError] = createSignal<string | null>(null);

/** Get current sync status (reactive) */
export const getSyncStatus: Accessor<SyncStatus> = syncStatus;

/** Get pending update count (reactive) */
export const getPendingCount: Accessor<number> = pendingCount;

/** Get last sync error message (reactive) */
export const getLastSyncError: Accessor<string | null> = lastSyncError;

/** Check if there are pending updates (for close gate) */
export function hasPendingUpdates(): boolean {
  return sharedPendingUpdates.length > 0 || sharedIsFlushing;
}

/**
 * Force sync pending updates immediately (module-level for close gate).
 * This is a standalone function that can be called without the hook.
 */
export async function forceSyncNow(): Promise<void> {
  // Cancel any pending debounced flush
  if (sharedSyncTimer) {
    clearTimeout(sharedSyncTimer);
    sharedSyncTimer = null;
  }

  // If already flushing or nothing to flush, early return
  if (sharedIsFlushing || sharedPendingUpdates.length === 0) return;

  if (!isClientInitialized()) {
    console.warn('[useSyncedYDoc] HTTP client not initialized, cannot force sync');
    return;
  }

  sharedIsFlushing = true;
  const updates = sharedPendingUpdates;
  sharedPendingUpdates = [];

  let sentCount = 0;
  try {
    const httpClient = getHttpClient();
    for (const update of updates) {
      const txId = generateTxId();
      await httpClient.applyUpdate(update, txId);
      sentCount++;
    }
    sharedRetryCount = 0;
    setSyncStatus('synced');
    setLastSyncError(null);
    setPendingCount(0);
    clearBackup(); // All synced - clear crash backup
    console.log('[useSyncedYDoc] Force sync completed successfully');
  } catch (err) {
    console.error('[useSyncedYDoc] Force sync failed:', err);
    // Restore unsent updates
    sharedPendingUpdates = [...updates.slice(sentCount), ...sharedPendingUpdates];
    setPendingCount(sharedPendingUpdates.length);
    setSyncStatus('error');
    setLastSyncError(String(err));
    throw err; // Re-throw so caller knows it failed
  } finally {
    sharedIsFlushing = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// BASE64 UTILITIES (re-exported for tests and other consumers)
// ═══════════════════════════════════════════════════════════════

// Shared implementation in src/lib/encoding.ts
import { base64ToBytes, bytesToBase64 } from '../lib/encoding';
export { base64ToBytes, bytesToBase64 };

/**
 * Get the singleton Y.Doc instance.
 * Used for testing singleton behavior.
 */
export function getSharedDoc(): Y.Doc {
  return sharedDoc;
}

/**
 * Trigger a full resync from server.
 * Fetches full Y.Doc state and applies it (idempotent - only new updates have effect).
 * Used by sync health check when hash mismatch detected.
 */
export async function triggerFullResync(): Promise<void> {
  if (!isClientInitialized()) {
    console.warn('[useSyncedYDoc] HTTP client not initialized, cannot trigger resync');
    return;
  }

  console.log('[useSyncedYDoc] Triggering full resync from server');
  const httpClient = getHttpClient();

  try {
    const { state: serverState, latestSeq } = await httpClient.getState();
    if (serverState && serverState.length > 2) {
      try {
        isApplyingRemoteGlobal = true;
        Y.applyUpdate(sharedDoc, serverState, 'reconnect-authority');
      } finally {
        isApplyingRemoteGlobal = false;
      }
      // Re-seed both seq trackers from server's latestSeq
      // Full state means all seqs up to latestSeq are covered
      if (latestSeq !== null) {
        updateLastSeenSeq(latestSeq);
        lastContiguousSeq = latestSeq;
        console.log('[useSyncedYDoc] Full resync complete:', serverState.length, 'bytes applied, seq:', latestSeq);
      } else {
        console.log('[useSyncedYDoc] Full resync complete:', serverState.length, 'bytes applied (no seq)');
      }
      // Clear any pending gaps - full sync covers everything
      pendingGapQueue = [];
    } else {
      console.log('[useSyncedYDoc] Server state empty, nothing to apply');
    }
    setLastSyncError(null);
  } catch (err) {
    console.error('[useSyncedYDoc] Full resync failed:', err);
    setLastSyncError(`Resync failed: ${String(err)}`);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON Y.DOC
// ═══════════════════════════════════════════════════════════════

// Y.Doc is a singleton - survives component unmount/remount cycles.
// Only the update observer is cleaned up per-component.
// FLO-197/P4: Enable GC to prevent tombstone accumulation (safe with single-client)
const sharedDoc = new Y.Doc({ gc: true });
let sharedDocLoaded = false;
let sharedDocError: string | null = null;
let sharedDocLoadPromise: Promise<void> | null = null;

// UndoManager for the blocks map (singleton, tied to shared doc)
let sharedUndoManager: Y.UndoManager | null = null;

// Sync machinery is also singleton (tied to the shared doc)
let sharedPendingUpdates: Uint8Array[] = [];
let sharedSyncTimer: number | null = null;
let sharedIsFlushing = false;
let sharedRetryCount = 0;
const MAX_RETRIES = 5;
const DEFAULT_SYNC_DEBOUNCE = 50;

// ═══════════════════════════════════════════════════════════════
// REF-COUNTED HANDLER ATTACHMENT
// ═══════════════════════════════════════════════════════════════
// Multiple Outliner panes call useSyncedYDoc() - each would attach its own
// update handler to the singleton doc. This caused 3x queueUpdate calls
// with 3 panes open. Solution: attach handler once, ref-count consumers.

let handlerRefCount = 0;
let moduleUpdateHandler: ((update: Uint8Array, origin: unknown) => void) | null = null;
let isApplyingRemoteGlobal = false; // Module-level flag for handler

/**
 * Module-level schedule flush - uses DEFAULT_SYNC_DEBOUNCE.
 * Called by the singleton update handler.
 */
function scheduleFlushModule(delay?: number) {
  if (sharedSyncTimer) {
    clearTimeout(sharedSyncTimer);
  }
  sharedSyncTimer = window.setTimeout(flushUpdatesModule, delay ?? DEFAULT_SYNC_DEBOUNCE);
}

/**
 * Module-level flush updates - same logic as hook's flushUpdates but without
 * per-component error signal.
 */
async function flushUpdatesModule() {
  if (sharedIsFlushing || sharedPendingUpdates.length === 0) return;

  if (!isClientInitialized()) {
    console.warn('[useSyncedYDoc] HTTP client not initialized, skipping flush');
    return;
  }

  sharedIsFlushing = true;
  const updates = sharedPendingUpdates;
  sharedPendingUpdates = [];

  let sentCount = 0;
  try {
    const httpClient = getHttpClient();
    for (const update of updates) {
      const txId = generateTxId();
      await httpClient.applyUpdate(update, txId);
      sentCount++;
    }
    sharedRetryCount = 0;

    if (sharedPendingUpdates.length === 0) {
      setSyncStatus('synced');
      setLastSyncError(null);
      clearBackup();
    }
    setPendingCount(sharedPendingUpdates.length);
  } catch (err) {
    sharedRetryCount++;
    console.error(`Failed to sync to server (attempt ${sharedRetryCount}/${MAX_RETRIES}):`, err);
    sharedPendingUpdates = [...updates.slice(sentCount), ...sharedPendingUpdates];
    setPendingCount(sharedPendingUpdates.length);

    if (sharedRetryCount >= MAX_RETRIES) {
      setSyncStatus('error');
      setLastSyncError(`Sync failed after ${MAX_RETRIES} attempts. Changes may not be saved.`);
      sharedRetryCount = 0;
    } else if (sharedPendingUpdates.length > 0) {
      const backoffDelay = Math.min(DEFAULT_SYNC_DEBOUNCE * Math.pow(2, sharedRetryCount), 10000);
      scheduleFlushModule(backoffDelay);
    }
  } finally {
    sharedIsFlushing = false;
  }
}

/**
 * Module-level queue update - called by singleton handler.
 */
function queueUpdateModule(update: Uint8Array) {
  sharedPendingUpdates.push(update);
  setPendingCount(sharedPendingUpdates.length);
  setSyncStatus('pending');
  scheduleFlushModule();
  scheduleBackup();
}

/**
 * Attach the singleton update handler (ref-counted).
 * Call in onMount - only first caller actually attaches.
 */
function attachHandler() {
  handlerRefCount++;
  if (handlerRefCount === 1) {
    moduleUpdateHandler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote' || isApplyingRemoteGlobal) return;
      queueUpdateModule(update);
    };
    sharedDoc.on('update', moduleUpdateHandler);
    console.log('[useSyncedYDoc] Attached singleton update handler');
  }
}

/**
 * Detach the singleton update handler (ref-counted).
 * Call in onCleanup - only last caller actually detaches.
 */
function detachHandler() {
  handlerRefCount--;
  if (handlerRefCount === 0 && moduleUpdateHandler) {
    sharedDoc.off('update', moduleUpdateHandler);
    moduleUpdateHandler = null;
    console.log('[useSyncedYDoc] Detached singleton update handler');

    // Also clean up sync timer since no consumers remain
    if (sharedSyncTimer) {
      clearTimeout(sharedSyncTimer);
      sharedSyncTimer = null;
    }
  }
}

/**
 * Set the global isApplyingRemote flag.
 * Called during initial load and reconciliation.
 */
function setApplyingRemote(value: boolean) {
  isApplyingRemoteGlobal = value;
}

// WebSocket for real-time sync from server
let sharedWebSocket: WebSocket | null = null;
let wsReconnectTimer: number | null = null;
let wsRetryCount = 0;
let wsHasConnectedOnce = false; // FLO-269: Distinguish first connect from reconnect
const WS_RECONNECT_DELAY = 2000;
const WS_MAX_RECONNECT_DELAY = 30000;

// FLO-152: Message buffering to prevent race condition on reconnect
// Problem: onopen schedules microtask, but WS messages arrive before it runs,
// causing live updates to be overwritten by the subsequent full state fetch.
// Solution: Buffer incoming messages until reconnect sync completes, then replay.
let wsReadyForMessages = true; // Start true - only false during reconnect sync
let wsConnectionId = 0; // FLO-152: Guards against stale IIFE setting wsReadyForMessages
const WS_MESSAGE_BUFFER_MAX = 100; // Prevent unbounded growth if sync hangs

// ═══════════════════════════════════════════════════════════════
// SEQUENCE NUMBER TRACKING (gap detection & incremental reconnect)
// ═══════════════════════════════════════════════════════════════

/** WS message from server (now includes seq for gap detection) */
interface WsMessage {
  /** Sequence number from persistence layer (for gap detection). Missing on restore broadcasts. */
  seq?: number;
  /** Transaction ID for echo prevention */
  txId?: string;
  /** Base64-encoded Y.Doc update bytes */
  data: string;
}

/**
 * Last seen sequence number from WebSocket.
 * - null: haven't seen any seq-bearing messages yet
 * - number: highest seq we've successfully processed
 *
 * IMPORTANT: This must be monotonically increasing to prevent reopening gaps.
 * Only update via updateLastSeenSeq() which enforces monotonicity.
 *
 * Used for:
 * - Gap detection: seq 417 → seq 419 means we missed 418
 * - Incremental reconnect: fetch only updates since lastSeenSeq
 */
let lastSeenSeq: number | null = null;

/**
 * Track the highest seq for which ALL prior seqs have been received.
 * Unlike lastSeenSeq (which can jump on out-of-order messages), this only
 * advances when updates are applied in contiguous order.
 *
 * Used for gap queue processing - determines when queued gaps are truly covered.
 *
 * Example:
 * - Receive seq 100: lastContiguousSeq = 100, lastSeenSeq = 100
 * - Receive seq 105: lastContiguousSeq = 100, lastSeenSeq = 105 (gap queued for 101-104)
 * - Gap-fill applies 101-104: lastContiguousSeq = 105, lastSeenSeq = 105
 */
let lastContiguousSeq: number | null = null;

/** Track if we're currently fetching missing updates (prevent concurrent fetches) */
let isFetchingMissingUpdates = false;

/** Queue of pending gap fetches - processed after current fetch completes */
interface PendingGap {
  fromSeq: number;
  toSeq: number;
}
let pendingGapQueue: PendingGap[] = [];

/**
 * Threshold for gap size before falling back to full resync.
 * If gap > 100, fetching individual updates may be slower than full state.
 */
const GAP_THRESHOLD_FOR_FULL_RESYNC = 100;

/** Message buffer (seq-aware) */
let wsMessageBuffer: WsMessage[] = [];

/**
 * Update lastSeenSeq monotonically.
 * Only updates if newSeq > current lastSeenSeq (or if lastSeenSeq is null).
 * This prevents out-of-order or gap-fill updates from regressing the counter.
 */
function updateLastSeenSeq(newSeq: number): void {
  if (lastSeenSeq === null || newSeq > lastSeenSeq) {
    lastSeenSeq = newSeq;
  }
}

/**
 * Advance lastContiguousSeq when applying the next expected seq.
 * Only call this when applying updates that are known to be contiguous
 * (gap-fill results, reconnect sync pages, initial load).
 *
 * Callers must iterate in seq order — this only advances if seq is exactly
 * lastContiguousSeq + 1 (or if this is the first seq we track).
 */
function advanceContiguousSeq(seq: number): void {
  if (lastContiguousSeq === null || seq === lastContiguousSeq + 1) {
    lastContiguousSeq = seq;
  }
}

// Echo prevention: track txIds we sent to filter them from broadcasts
const recentTxIds = new Set<string>();
const MAX_RECENT_TX_IDS = 50; // Prevent unbounded growth
let txIdCounter = 0;

/** Generate a unique transaction ID */
function generateTxId(): string {
  const id = `${Date.now()}-${txIdCounter++}`;
  recentTxIds.add(id);
  // Trim old entries if set gets too large
  while (recentTxIds.size > MAX_RECENT_TX_IDS) {
    const iterator = recentTxIds.values();
    const oldest = iterator.next().value;
    if (oldest !== undefined) {
      recentTxIds.delete(oldest);
    }
  }
  return id;
}

/**
 * Apply a WebSocket message to the Y.Doc.
 * Extracted to support buffering during reconnect (FLO-152).
 *
 * Now includes sequence number tracking for gap detection.
 */
function applyWsMessage(msg: WsMessage) {
  // Echo prevention: skip APPLICATION if this is our own update
  // But still run gap detection - the seq may reveal missed updates from others
  if (msg.txId && recentTxIds.has(msg.txId)) {
    console.log('[WS] Skipping own update application (txId:', msg.txId, ')');
    recentTxIds.delete(msg.txId);

    // Gap detection for echoed messages - don't skip this!
    // Our message's seq may reveal we missed updates from other clients
    if (msg.seq !== undefined && lastSeenSeq !== null) {
      const expectedSeq = lastSeenSeq + 1;
      if (msg.seq > expectedSeq) {
        console.warn(`[WS] Gap detected (echo): ${lastSeenSeq} → ${msg.seq} (missing ${msg.seq - expectedSeq} updates)`);
        queueGapFetch(lastSeenSeq, msg.seq);
      }
    }

    // Track seq even for our own updates (monotonic + contiguous)
    if (msg.seq !== undefined) {
      updateLastSeenSeq(msg.seq);
      // Our own update was applied locally, so it's contiguous
      if (lastContiguousSeq === null || msg.seq === lastContiguousSeq + 1) {
        lastContiguousSeq = msg.seq;
      }
    }
    return;
  }

  // Gap detection: check if we missed any updates
  if (msg.seq !== undefined && lastSeenSeq !== null) {
    const expectedSeq = lastSeenSeq + 1;
    if (msg.seq > expectedSeq) {
      // Gap detected! We missed seq(s) between lastSeenSeq and msg.seq
      console.warn(`[WS] Gap detected: ${lastSeenSeq} → ${msg.seq} (missing ${msg.seq - expectedSeq} updates)`);

      // NOTE: We apply this message immediately even though earlier seq(s) are missing.
      // This is safe because Y.Doc CRDT merge is commutative — application order doesn't
      // affect the final document state. The gap-fill fetch runs async and applies the
      // missing updates when they arrive. The end state is identical regardless of order.
      queueGapFetch(lastSeenSeq, msg.seq);
    }
  }

  // Track sequence number monotonically (if provided - restore broadcasts don't have seq)
  if (msg.seq !== undefined) {
    updateLastSeenSeq(msg.seq);
    // Also advance contiguous tracking if this is the next expected seq
    // (or the first seq we see when lastContiguousSeq is null)
    if (lastContiguousSeq === null || msg.seq === lastContiguousSeq + 1) {
      lastContiguousSeq = msg.seq;
    }
  }

  // Decode base64 and apply
  const update = base64ToBytes(msg.data);
  Y.applyUpdate(sharedDoc, update, 'remote');
}

/**
 * Queue a gap fetch. If no fetch is in progress, starts immediately.
 * If a fetch is in progress, queues the gap to be processed after.
 */
function queueGapFetch(fromSeq: number, toSeq: number): void {
  if (isFetchingMissingUpdates) {
    // Queue the gap - will be processed after current fetch
    pendingGapQueue.push({ fromSeq, toSeq });
    console.log(`[WS] Queued gap fetch (${fromSeq} → ${toSeq}), queue size: ${pendingGapQueue.length}`);
    return;
  }

  // No fetch in progress - start immediately
  // Note: fetchMissingUpdates has internal try/catch, but add .catch() for any
  // unexpected throws (e.g., dynamic import failure) to prevent unhandled rejection
  fetchMissingUpdates(fromSeq, toSeq).catch((err) =>
    console.error('[WS] Unhandled error in gap fetch:', err)
  );
}

/**
 * Process the next gap in the queue, if any.
 * Called after a gap fetch completes.
 */
function processNextQueuedGap(): void {
  if (pendingGapQueue.length === 0) {
    return;
  }

  // Consolidate queued gaps: find the overall range needed
  // This handles cases where multiple gaps were queued during a long fetch
  const minFrom = Math.min(...pendingGapQueue.map((g) => g.fromSeq));
  const maxTo = Math.max(...pendingGapQueue.map((g) => g.toSeq));

  // Clear queue before processing
  pendingGapQueue = [];

  // Use lastContiguousSeq (not lastSeenSeq) to determine if gaps are truly covered.
  // lastSeenSeq can jump ahead on out-of-order messages, making it seem like
  // gaps are covered when they're not. lastContiguousSeq only advances when
  // all prior seqs have been received.
  if (lastContiguousSeq !== null && maxTo <= lastContiguousSeq) {
    console.log('[WS] Queued gaps already covered by lastContiguousSeq:', lastContiguousSeq);
    return;
  }

  // Compute effective range using lastContiguousSeq
  const effectiveFrom = lastContiguousSeq !== null ? Math.max(minFrom, lastContiguousSeq) : minFrom;
  console.log(`[WS] Processing consolidated queued gap: ${effectiveFrom} → ${maxTo} (contiguous: ${lastContiguousSeq})`);
  fetchMissingUpdates(effectiveFrom, maxTo);
}

/**
 * Fetch missing updates when a gap is detected.
 * Runs async - doesn't block current message processing.
 * Falls back to full resync if gap is too large or updates are compacted.
 */
async function fetchMissingUpdates(fromSeq: number, toSeq: number): Promise<void> {
  // Guard against concurrent fetches (shouldn't happen with queue, but be safe)
  if (isFetchingMissingUpdates) {
    console.warn('[WS] Unexpected concurrent fetch attempt, queueing');
    pendingGapQueue.push({ fromSeq, toSeq });
    return;
  }

  const gapSize = toSeq - fromSeq - 1;

  // Large gap - full resync is faster
  if (gapSize > GAP_THRESHOLD_FOR_FULL_RESYNC) {
    console.log(`[WS] Gap too large (${gapSize} updates), triggering full resync`);
    pendingGapQueue = []; // Clear queue - full resync covers everything
    await triggerFullResync();
    return;
  }

  isFetchingMissingUpdates = true;
  try {
    const { getHttpClient, isClientInitialized } = await import('../lib/httpClient');
    if (!isClientInitialized()) {
      console.warn('[WS] HTTP client not initialized, cannot fetch missing updates');
      return;
    }

    const httpClient = getHttpClient();
    const result = await httpClient.getUpdatesSince(fromSeq, gapSize + 1);

    if (!result.ok) {
      // 410 Gone - updates were compacted, need full resync
      console.warn('[WS] Updates compacted (through seq', result.compactedThrough, '), triggering full resync');
      pendingGapQueue = []; // Clear queue - full resync covers everything
      await triggerFullResync();
      return;
    }

    // Apply the missing updates
    const { updates, latestSeq } = result.response;
    console.log(`[WS] Fetched ${updates.length} missing updates (seq ${fromSeq} → ${latestSeq ?? 'unknown'})`);

    try {
      isApplyingRemoteGlobal = true;
      for (const entry of updates) {
        const update = base64ToBytes(entry.data);
        Y.applyUpdate(sharedDoc, update, 'gap-fill');
        // Update both seq trackers - gap-fill updates are contiguous
        updateLastSeenSeq(entry.seq);
        advanceContiguousSeq(entry.seq);
      }
    } finally {
      isApplyingRemoteGlobal = false;
    }
  } catch (err) {
    console.error('[WS] Failed to fetch missing updates:', err);
    // Fall back to full resync on any error
    pendingGapQueue = []; // Clear queue - full resync covers everything
    await triggerFullResync();
  } finally {
    isFetchingMissingUpdates = false;
    // Process any gaps that were queued during this fetch
    processNextQueuedGap();
  }
}

// ═══════════════════════════════════════════════════════════════
// INDEXEDDB BACKUP (crash resilience)
// ═══════════════════════════════════════════════════════════════
// Migrated from localStorage (2026-01-23) due to 5MB limit.
// IndexedDB supports binary storage directly (no base64 overhead)
// and has much higher quotas (typically 50MB+ or % of disk).

const YDOC_BACKUP_KEY = 'floatty_ydoc_backup'; // For migration only
const BACKUP_DEBOUNCE_MS = 1000;
let backupTimer: number | null = null;

/**
 * Schedule a backup of current Y.Doc state to IndexedDB.
 * Called when local changes are queued, providing crash resilience.
 */
function scheduleBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = window.setTimeout(async () => {
    try {
      const state = Y.encodeStateAsUpdate(sharedDoc);
      await saveBackupIDB(state);
      console.log('[useSyncedYDoc] Backed up Y.Doc to IndexedDB:', state.length, 'bytes');
    } catch (err) {
      console.error('[useSyncedYDoc] Failed to backup Y.Doc:', err);
    }
  }, BACKUP_DEBOUNCE_MS);
}

/**
 * Clear the IndexedDB backup (called when sync completes).
 */
function clearBackup() {
  clearBackupIDB()
    .then(() => {
      console.log('[useSyncedYDoc] Cleared IndexedDB backup (synced)');
    })
    .catch(err => {
      console.warn('[useSyncedYDoc] Failed to clear backup:', err);
    });
}

/**
 * Check if a legacy localStorage backup exists (sync check).
 * @deprecated Use getBackup() from idbBackup.ts for new code.
 * This only checks localStorage, not IndexedDB.
 */
export function hasLocalBackup(): boolean {
  try {
    return localStorage.getItem(YDOC_BACKUP_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Get the backup if it exists (checks both IndexedDB and legacy localStorage).
 */
export async function getLocalBackup(): Promise<Uint8Array | null> {
  try {
    // Try IndexedDB first (new location)
    const idbBackup = await getBackupIDB();
    if (idbBackup) return idbBackup;

    // Fallback to localStorage (legacy migration)
    const lsBackup = localStorage.getItem(YDOC_BACKUP_KEY);
    if (lsBackup) {
      console.log('[useSyncedYDoc] Found legacy localStorage backup, migrating to IndexedDB');
      const bytes = base64ToBytes(lsBackup);
      await saveBackupIDB(bytes);
      localStorage.removeItem(YDOC_BACKUP_KEY);
      console.log('[useSyncedYDoc] Migration complete');
      return bytes;
    }

    return null;
  } catch (err) {
    console.warn('[useSyncedYDoc] Failed to read backup:', err);
    return null;
  }
}

/**
 * FLO-247: Startup sanity check - detect suspicious Y.Doc state.
 *
 * Logs warnings for states that might indicate data corruption or
 * accidental wipe. Future: Could show modal for confirmation.
 *
 * NOTE: Returns void - this is logging-only, doesn't gate startup.
 */
async function validateSyncedState(doc: Y.Doc): Promise<void> {
  try {
    const blocksMap = doc.getMap('blocks');
    const rootIdsArray = doc.getArray<string>('rootIds');

    const blockCount = blocksMap.size;
    const rootCount = rootIdsArray.length;

    // Suspicious: 0 blocks but backup existed (possible server wipe)
    if (blockCount === 0) {
      const hadBackup = await hasBackupIDB();
      if (hadBackup) {
        console.warn('[FLO-247] ⚠️ Server returned empty but IndexedDB backup exists!');
        console.warn('[FLO-247] This could indicate server wipe. Check ctx_markers.db in your FLOATTY_DATA_DIR');
        return;
      }
    }

    // Suspicious: Very few blocks (might be test data)
    if (blockCount > 0 && blockCount < 10) {
      console.warn(`[FLO-247] ⚠️ Very few blocks (${blockCount}) - might be test data`);
    }

    // Suspicious: No roots but blocks exist (orphaned blocks)
    if (rootCount === 0 && blockCount > 0) {
      console.warn(`[FLO-247] ⚠️ ${blockCount} blocks exist but no root IDs!`);
      return;
    }

    // Suspicious: More roots than expected (usually 2-3)
    if (rootCount > 20) {
      console.warn(`[FLO-247] ⚠️ Unusually many root blocks (${rootCount})`);
    }

    console.log(`[FLO-247] ✓ State looks healthy: ${blockCount} blocks, ${rootCount} roots`);
  } catch (err) {
    console.warn('[FLO-247] Sanity check failed:', err);
  }
}

// Export for testing
export { validateSyncedState };

/**
 * Force flush pending updates immediately.
 * Used on WebSocket reconnect to sync state before receiving broadcasts.
 */
async function forceFlushOnReconnect() {
  if (sharedIsFlushing || sharedPendingUpdates.length === 0) return;

  if (!isClientInitialized()) {
    console.warn('[useSyncedYDoc] HTTP client not initialized, cannot flush');
    return;
  }

  sharedIsFlushing = true;
  const updates = sharedPendingUpdates;
  sharedPendingUpdates = [];

  try {
    const { getHttpClient } = await import('../lib/httpClient');
    const httpClient = getHttpClient();
    for (const update of updates) {
      const txId = generateTxId();
      await httpClient.applyUpdate(update, txId);
    }
    sharedRetryCount = 0;
    console.log('[WS] Successfully flushed pending updates on reconnect');
  } catch (err) {
    console.error('[WS] Failed to flush pending updates on reconnect:', err);
    // Restore updates for retry
    sharedPendingUpdates = [...updates, ...sharedPendingUpdates];
  } finally {
    sharedIsFlushing = false;
  }
}

/**
 * Connect to WebSocket for real-time updates from server.
 * Called once after initial state load.
 */
function connectWebSocket() {
  // Already connected, connecting, or closing - avoid duplicate connections
  if (sharedWebSocket?.readyState === WebSocket.OPEN ||
      sharedWebSocket?.readyState === WebSocket.CONNECTING ||
      sharedWebSocket?.readyState === WebSocket.CLOSING) {
    return;
  }

  // Get server URL from httpClient config
  const serverUrl = window.__FLOATTY_SERVER_URL__;
  if (!serverUrl) {
    console.warn('[WS] Server URL not set, skipping WebSocket');
    return;
  }

  // Convert http://localhost:8765 to ws://localhost:8765/ws
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  console.log('[WS] Connecting to', wsUrl);

  try {
    sharedWebSocket = new WebSocket(wsUrl);

    sharedWebSocket.onopen = () => {
      console.log('[WS] Connected');
      // Reset retry count on successful connection
      wsRetryCount = 0;

      const isReconnect = wsHasConnectedOnce;
      wsHasConnectedOnce = true;

      // FLO-152: Increment connection ID to invalidate any stale IIFEs
      const thisConnectionId = ++wsConnectionId;

      // Clear any previous connection error now that we're connected
      if (sharedPendingUpdates.length === 0) {
        setSyncStatus('synced');
        setLastSyncError(null);
      }

      if (isReconnect) {
        // RECONNECT: sync with buffering (FLO-152)
        // Now supports incremental sync via lastSeenSeq when available
        // FLO-152: Mark NOT ready for messages - buffer incoming until sync completes
        wsReadyForMessages = false;
        wsMessageBuffer = [];

        // Reconnection sync: flush local pending, then fetch any missed server updates.
        // This prevents stale state if server received updates while we were disconnected.
        // FLO-152: Use IIFE instead of queueMicrotask to control message buffering
        (async () => {
          try {
            // 1. Flush local pending updates first
            if (sharedPendingUpdates.length > 0) {
              console.log('[WS] Flushing', sharedPendingUpdates.length, 'pending updates on reconnect');
              if (sharedSyncTimer) {
                clearTimeout(sharedSyncTimer);
                sharedSyncTimer = null;
              }
              await forceFlushOnReconnect();
            }

            // 2. Fetch any updates we missed during disconnection
            const { getHttpClient } = await import('../lib/httpClient');
            const httpClient = getHttpClient();

            // Try incremental sync if we have a lastSeenSeq
            // Loop through pages since server may paginate results (default limit 100)
            // Cap at 50 pages (5000 updates) to prevent infinite loop if server is receiving
            // updates faster than we can fetch them
            const MAX_RECONNECT_PAGES = 50;
            let syncedIncrementally = false;
            if (lastSeenSeq !== null) {
              console.log('[WS] Attempting incremental reconnect sync (since seq:', lastSeenSeq, ')');
              let currentSeq = lastSeenSeq;
              let totalApplied = 0;
              let pageCount = 0;

              // Loop until we've fetched all pages (or hit ceiling)
              while (pageCount < MAX_RECONNECT_PAGES) {
                pageCount++;
                const result = await httpClient.getUpdatesSince(currentSeq);

                if (!result.ok) {
                  // 410 Gone - updates were compacted, need full resync
                  console.warn('[WS] Incremental sync unavailable (compacted through', result.compactedThrough, '), falling back to full sync');
                  break;
                }

                const { updates, latestSeq } = result.response;

                if (updates.length === 0) {
                  // No more updates to fetch
                  if (totalApplied > 0) {
                    console.log(`[WS] Incremental sync complete: applied ${totalApplied} updates total`);
                  } else {
                    console.log('[WS] Incremental sync: no new updates (already up to date)');
                  }
                  syncedIncrementally = true;
                  break;
                }

                // Apply this page of updates
                console.log(`[WS] Incremental sync: applying ${updates.length} updates (seq ${currentSeq} → ${updates[updates.length - 1].seq})`);
                try {
                  isApplyingRemoteGlobal = true;
                  for (const entry of updates) {
                    const update = base64ToBytes(entry.data);
                    Y.applyUpdate(sharedDoc, update, 'reconnect-authority');
                    // Update both seq trackers - reconnect sync updates are contiguous
                    updateLastSeenSeq(entry.seq);
                    advanceContiguousSeq(entry.seq);
                    currentSeq = entry.seq;
                  }
                } finally {
                  isApplyingRemoteGlobal = false;
                }
                totalApplied += updates.length;

                // Check if we've caught up (latestSeq matches what we just applied)
                if (latestSeq !== null && currentSeq >= latestSeq) {
                  console.log(`[WS] Incremental sync complete: applied ${totalApplied} updates, caught up to seq ${latestSeq}`);
                  syncedIncrementally = true;
                  break;
                }

                // Continue fetching more pages
              }

              // Hit page ceiling without catching up - fall back to full sync
              if (pageCount >= MAX_RECONNECT_PAGES && !syncedIncrementally) {
                console.warn(`[WS] Incremental sync exceeded ${MAX_RECONNECT_PAGES} pages (${totalApplied} updates), falling back to full sync`);
              }
            }

            // Fall back to full state sync if incremental sync not possible/failed
            if (!syncedIncrementally) {
              const { state: serverState, latestSeq } = await httpClient.getState();
              if (serverState && serverState.length > 2) {
                console.log('[WS] Full state sync after reconnect:', serverState.length, 'bytes');
                // FLO-256: Wrap in isApplyingRemoteGlobal to prevent update observer from echoing
                try {
                  isApplyingRemoteGlobal = true;
                  Y.applyUpdate(sharedDoc, serverState, 'reconnect-authority');
                } finally {
                  isApplyingRemoteGlobal = false;
                }
              }
              // Re-seed both seq trackers from server's latestSeq
              // Full state means all seqs up to latestSeq are covered
              if (latestSeq !== null) {
                updateLastSeenSeq(latestSeq);
                lastContiguousSeq = latestSeq;
                console.log('[WS] Seq tracking re-seeded to:', latestSeq);
              }
              // Clear any pending gaps - full sync covers everything
              pendingGapQueue = [];
            }

            // FLO-152: Guard against stale IIFE from previous connection
            if (thisConnectionId !== wsConnectionId) {
              console.log('[WS] Stale connection IIFE, ignoring');
              return;
            }

            // FLO-152: NOW safe to process messages - replay buffered ones
            console.log('[WS] Reconnect sync complete, replaying', wsMessageBuffer.length, 'buffered messages');
            wsReadyForMessages = true;
            for (const msg of wsMessageBuffer) {
              applyWsMessage(msg);
            }
            wsMessageBuffer = [];
          } catch (err) {
            console.error('[WS] Reconnect sync failed:', err);
            // FLO-152: Guard against stale IIFE from previous connection
            if (thisConnectionId !== wsConnectionId) {
              console.log('[WS] Stale connection IIFE error path, ignoring');
              return;
            }
            // Even on failure, start accepting messages (better than blocking forever)
            wsReadyForMessages = true;
            wsMessageBuffer = [];
          }
        })();
      } else {
        // FLO-269: FIRST CONNECTION - state just loaded in loadInitialState()
        // No buffering needed — just start accepting WS messages immediately.
        // This eliminates the race where:
        //   1. loadInitialState() fetches full state
        //   2. WS connects, IIFE re-fetches same state (redundant)
        //   3. PATCH arrives between load and re-fetch → absorbed into HTTP response
        //   4. WS delta becomes CRDT no-op → observeDeep never fires → block never renders
        wsReadyForMessages = true;
        wsMessageBuffer = [];
        console.log('[WS] First connection — accepting messages immediately (no redundant fetch)');
      }
    };

    sharedWebSocket.onmessage = (event) => {
      // Server sends JSON text messages: { seq?: number, txId?: string, data: string (base64) }
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as WsMessage;

          // FLO-152: Buffer messages during reconnect sync to prevent race condition
          if (!wsReadyForMessages) {
            if (wsMessageBuffer.length < WS_MESSAGE_BUFFER_MAX) {
              wsMessageBuffer.push(msg);
              if (msg.seq !== undefined) {
                console.log('[WS] Buffered message during reconnect sync (seq:', msg.seq, ', total:', wsMessageBuffer.length, ')');
              } else {
                console.log('[WS] Buffered message during reconnect sync (total:', wsMessageBuffer.length, ')');
              }
            } else {
              console.warn('[WS] Message buffer full, dropping message');
            }
            return;
          }

          // Ready for messages - apply directly
          applyWsMessage(msg);
        } catch (err) {
          console.error('[WS] Failed to parse message:', err);
        }
      }
    };

    sharedWebSocket.onclose = (event) => {
      console.log('[WS] Disconnected, code:', event.code);
      sharedWebSocket = null;
      // Reconnect with exponential backoff
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      const backoffDelay = Math.min(
        WS_RECONNECT_DELAY * Math.pow(2, wsRetryCount),
        WS_MAX_RECONNECT_DELAY
      );
      wsRetryCount++;
      console.log(`[WS] Reconnecting in ${backoffDelay}ms (attempt ${wsRetryCount})`);
      wsReconnectTimer = window.setTimeout(connectWebSocket, backoffDelay);
    };

    sharedWebSocket.onerror = (error) => {
      console.error('[WS] Error:', error);
      // Update sync status so UI can show error state
      // Note: WebSocket error events don't contain useful details - the actual
      // diagnostic info comes through onclose. Set generic message here.
      setSyncStatus('error');
      setLastSyncError('WebSocket connection error. Reconnecting...');
      // onclose will fire next and handle reconnection
    };
  } catch (err) {
    console.error('[WS] Failed to connect:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

export interface UseSyncedYDocOptions {
  /** Debounce time for syncing updates to Rust (ms) */
  syncDebounce?: number;
}

export interface UseSyncedYDocReturn {
  /** The Y.Doc instance */
  doc: Y.Doc;
  /** Whether initial load is complete */
  isLoaded: () => boolean;
  /** Any error that occurred */
  error: () => string | null;
  /** Force sync to Rust */
  forceSync: () => Promise<void>;
  /** Undo last operation */
  undo: () => void;
  /** Redo last undone operation */
  redo: () => void;
  /** Check if undo is available */
  canUndo: () => boolean;
  /** Check if redo is available */
  canRedo: () => boolean;
  /** Clear undo/redo stacks (call after initial setup) */
  clearUndoStack: () => void;
}

export function useSyncedYDoc(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: UseSyncedYDocOptions = {}
): UseSyncedYDocReturn {
  // Note: syncDebounce option is now ignored - module-level DEFAULT_SYNC_DEBOUNCE is used
  // for the singleton handler. Keeping options for API compatibility.

  // Use the singleton doc
  const doc = sharedDoc;
  const [isLoaded, setIsLoaded] = createSignal(sharedDocLoaded);
  const [error, setError] = createSignal<string | null>(sharedDocError);

  // Force sync (bypass debounce) - delegates to module-level function
  const forceSync = async () => {
    if (sharedSyncTimer) {
      clearTimeout(sharedSyncTimer);
      sharedSyncTimer = null;
    }
    await flushUpdatesModule();
  };

  onMount(() => {
    // Load initial state only once (singleton pattern)
    async function loadInitialState() {
      // If already loaded, just update local signal and return
      if (sharedDocLoaded) {
        setIsLoaded(true);
        setError(sharedDocError);
        return;
      }

      // If currently loading, wait for it
      if (sharedDocLoadPromise) {
        await sharedDocLoadPromise;
        setIsLoaded(sharedDocLoaded);
        setError(sharedDocError);
        return;
      }

      // First load - do it
      sharedDocLoadPromise = (async () => {
        try {
          // CRITICAL: Initialize IndexedDB namespace BEFORE any backup operations
          // This isolates dev/release and different workspaces (FLO-247)
          try {
            const config = await invoke<AggregatorConfig>('get_ctx_config', {});
            initBackupNamespace(config.workspace_name || 'default');
          } catch (configErr) {
            console.warn('[useSyncedYDoc] Failed to load config for namespace, using unknown:', configErr);
            initBackupNamespace('unknown');
          }

          // Ensure HTTP client is initialized
          if (!isClientInitialized()) {
            throw new Error('HTTP client not initialized');
          }

          const httpClient = getHttpClient();

          // Check for backup (crash recovery) - migrates legacy localStorage if found
          const localBackup = await getLocalBackup();

          if (localBackup) {
            console.log('[useSyncedYDoc] Found backup, attempting reconciliation...');

            // Track whether local changes were successfully pushed
            let hadLocalChanges = false;
            let localChangesPushed = false;

            try {
              // Get server state vector to see what it has
              const serverSV = await httpClient.getStateVector();

              // Compute diff: what we have that server doesn't
              // diffUpdate returns an update containing only changes the server is missing
              const localDiff = Y.diffUpdate(localBackup, serverSV);

              // If diff is substantial (empty diff is ~2 bytes), push our changes first
              hadLocalChanges = localDiff.length > 2;
              if (hadLocalChanges) {
                console.log('[useSyncedYDoc] Pushing local changes to server:', localDiff.length, 'bytes');
                await httpClient.applyUpdate(localDiff);
                localChangesPushed = true;
              }

              // Now get server's full state (which now includes our pushed changes)
              const { state: serverState, latestSeq } = await httpClient.getState();

              // Apply server state to our doc - this already contains our pushed diff
              setApplyingRemote(true);
              Y.applyUpdate(doc, serverState, 'remote');
              setApplyingRemote(false);

              // Seed both seq trackers from server (full state = all seqs covered)
              if (latestSeq !== null) {
                updateLastSeenSeq(latestSeq);
                lastContiguousSeq = latestSeq;
              }

              console.log('[useSyncedYDoc] Reconciliation complete, seq:', latestSeq, ', clearing backup');
              clearBackup();
            } catch (reconcileErr) {
              console.error('[useSyncedYDoc] Reconciliation failed, falling back to server state:', reconcileErr);

              // Try to load server state as fallback
              try {
                const { state: stateBytes, latestSeq } = await httpClient.getState();
                if (stateBytes && stateBytes.length > 0) {
                  setApplyingRemote(true);
                  Y.applyUpdate(doc, stateBytes, 'remote');
                  setApplyingRemote(false);
                  // Seed both seq trackers (full state = all seqs covered)
                  if (latestSeq !== null) {
                    updateLastSeenSeq(latestSeq);
                    lastContiguousSeq = latestSeq;
                  }
                }
              } catch (stateErr) {
                console.error('[useSyncedYDoc] Failed to load server state:', stateErr);
              }

              // CRITICAL: Only clear backup if we successfully pushed local changes,
              // or if there were no local changes to begin with.
              // If push failed, preserve backup to retry next time.
              if (!hadLocalChanges || localChangesPushed) {
                console.warn('[useSyncedYDoc] Clearing backup (no local changes or already pushed)');
                clearBackup();
              } else {
                console.warn('[useSyncedYDoc] PRESERVING backup - local changes failed to push, will retry next startup');
                // Don't clear - user's local changes are still in IndexedDB
              }
            }
          } else {
            // Normal load - no local backup
            const { state: stateBytes, latestSeq } = await httpClient.getState();

            if (stateBytes && stateBytes.length > 0) {
              setApplyingRemote(true);
              Y.applyUpdate(doc, stateBytes, 'remote');
              setApplyingRemote(false);
              // Seed both seq trackers from server (full state = all seqs covered)
              if (latestSeq !== null) {
                updateLastSeenSeq(latestSeq);
                lastContiguousSeq = latestSeq;
                console.log('[useSyncedYDoc] Initial load complete, seq:', latestSeq);
              }
            }
          }

          sharedDocLoaded = true;
          sharedDocError = null;

          // Initialize UndoManager for blocks map AND rootIds (after initial load)
          // CRITICAL: Must track both structures to maintain consistency on undo/redo
          if (!sharedUndoManager) {
            const blocksMap = doc.getMap('blocks');
            const rootIds = doc.getArray('rootIds');
            sharedUndoManager = new Y.UndoManager([blocksMap, rootIds], {
              // Track user-originated changes (from useBlockStore transactions)
              // Excludes 'remote' (server sync) and 'hook' (automated processing)
              trackedOrigins: new Set([null, undefined, 'user']),
            });
            // Clear stack so user can't undo past loaded state
            // (prevents undoing the initial block creation)
            sharedUndoManager.clear();
          }

          // Connect to WebSocket for real-time sync
          connectWebSocket();

          // FLO-247: Startup sanity check - detect suspicious state
          validateSyncedState(doc);
        } catch (err) {
          console.error('Failed to load initial state from server:', err);
          sharedDocError = String(err);
        }
      })();

      await sharedDocLoadPromise;
      setIsLoaded(sharedDocLoaded);
      setError(sharedDocError);
    }

    // Attach singleton handler (ref-counted - only first caller actually attaches)
    attachHandler();
    loadInitialState();

    onCleanup(() => {
      // Detach singleton handler (ref-counted - only last caller actually detaches)
      detachHandler();
    });
  });

  // Undo/Redo functions
  const undo = () => {
    if (sharedUndoManager) {
      sharedUndoManager.undo();
    }
  };

  const redo = () => {
    if (sharedUndoManager) {
      sharedUndoManager.redo();
    }
  };

  const canUndo = () => {
    return sharedUndoManager ? sharedUndoManager.undoStack.length > 0 : false;
  };

  const canRedo = () => {
    return sharedUndoManager ? sharedUndoManager.redoStack.length > 0 : false;
  };

  const clearUndoStack = () => {
    if (sharedUndoManager) {
      sharedUndoManager.clear();
    }
  };

  return {
    doc,
    isLoaded,
    error,
    forceSync,
    undo,
    redo,
    canUndo,
    canRedo,
    clearUndoStack,
  };
}

// ═══════════════════════════════════════════════════════════════
// HMR CLEANUP
// ═══════════════════════════════════════════════════════════════

/**
 * Clean up module-level state for HMR.
 * Preserves Y.Doc data but closes connections and resets flags.
 */
function cleanupForHMR(): void {
  console.log('[useSyncedYDoc] HMR cleanup triggered');

  // Close WebSocket cleanly (prevent reconnect attempt)
  if (sharedWebSocket) {
    sharedWebSocket.onclose = null; // Prevent reconnect trigger
    sharedWebSocket.onerror = null;
    sharedWebSocket.onmessage = null;
    sharedWebSocket.close();
    sharedWebSocket = null;
  }

  // Clear all timers
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (sharedSyncTimer) {
    clearTimeout(sharedSyncTimer);
    sharedSyncTimer = null;
  }
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }

  // Remove Y.Doc update handler if attached
  if (moduleUpdateHandler) {
    sharedDoc.off('update', moduleUpdateHandler);
    moduleUpdateHandler = null;
  }

  // Reset module-level flags
  sharedDocLoaded = false;
  sharedDocError = null;
  sharedDocLoadPromise = null;
  sharedIsFlushing = false;
  sharedRetryCount = 0;
  isApplyingRemoteGlobal = false;

  // Reset WebSocket state
  wsHasConnectedOnce = false; // FLO-269: Reset for clean HMR cycle
  wsReadyForMessages = true;
  wsMessageBuffer = [];
  wsConnectionId = 0;
  wsRetryCount = 0;

  // Reset sequence tracking
  lastSeenSeq = null;
  lastContiguousSeq = null;
  isFetchingMissingUpdates = false;
  pendingGapQueue = [];

  // Reset handler tracking
  handlerRefCount = 0;
  txIdCounter = 0;

  // Clear collections
  sharedPendingUpdates = [];
  recentTxIds.clear();

  // Note: sharedDoc and sharedUndoManager are NOT cleared
  // - Y.Doc holds the actual CRDT data we want to preserve
  // - UndoManager can stay attached (cleared on next load if needed)
}

if (import.meta.hot) {
  import.meta.hot.dispose(cleanupForHMR);
}
