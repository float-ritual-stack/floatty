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
  saveLastContiguousSeq as saveLastContiguousSeqIDB,
  getLastContiguousSeq as getLastContiguousSeqIDB,
} from '../lib/idbBackup';
import { configReady } from '../context/ConfigContext';
import { SyncSequenceTracker } from '../lib/syncSequenceTracker';
import {
  recordFullResync,
  recordDedupRepairs,
  recordGapFill,
  recordEchoGapFill,
  recordPhantomChildrenRemoved,
  recordCrossParentFixes,
} from '../lib/syncDiagnostics';
import { createLogger } from '../lib/logger';

const logger = createLogger('useSyncedYDoc');
const wsLogger = createLogger('WS');

// ═══════════════════════════════════════════════════════════════
// SYNC STATUS (singleton signals for UI visibility)
// ═══════════════════════════════════════════════════════════════

export type SyncStatus = 'synced' | 'pending' | 'error' | 'drift';

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

/** Set sync status externally (used by useSyncHealth for drift detection) */
export function setSyncStatusExternal(status: SyncStatus, error?: string | null): void {
  setSyncStatus(status);
  if (error !== undefined) setLastSyncError(error);
}

/**
 * Check if drift status is currently set.
 * Used to prevent normal sync paths from clobbering drift indicator —
 * only the health check should clear drift (after verifying counts match).
 */
export function isDriftStatus(): boolean {
  return syncStatus() === 'drift';
}

/**
 * Force a new undo capture boundary.
 * Useful for atomic operations that should always be one undo step.
 */
export function stopUndoCaptureBoundary(): void {
  sharedUndoManager?.stopCapturing();
}

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
    logger.warn('HTTP client not initialized, cannot force sync');
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
    if (!isDriftStatus()) {
      setSyncStatus('synced');
      setLastSyncError(null);
    }
    setPendingCount(0);
    clearBackup(); // All synced - clear crash backup
    logger.info('Force sync completed successfully');
  } catch (err) {
    logger.error('Force sync failed', { err });
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

// Re-export diagnostics for dev tools and health endpoint
export { getSyncDiagnostics } from '../lib/syncDiagnostics';

/**
 * Get the singleton Y.Doc instance.
 * Used for testing singleton behavior.
 */
export function getSharedDoc(): Y.Doc {
  return sharedDoc;
}

/**
 * Scan all blocks' childIds and rootIds for duplicate entries, remove them.
 * Safety net for edge cases where CRDT merge produces duplicated array entries
 * (e.g., from the old delete-all-then-push childIds mutation pattern).
 *
 * Returns the number of duplicates removed. All removals happen in a single
 * transaction with 'system' origin (excluded from UndoManager).
 */
export function deduplicateChildIds(): number {
  const doc = sharedDoc;
  const blocksMap = doc.getMap('blocks');
  const rootIds = doc.getArray<string>('rootIds');

  let totalRemoved = 0;

  // Collect duplicates before transacting (read phase)
  const blockDups: Array<{ blockId: string; indicesToRemove: number[] }> = [];

  blocksMap.forEach((value, blockId) => {
    if (!(value instanceof Y.Map)) return;
    const arr = value.get('childIds');
    if (!(arr instanceof Y.Array)) return;

    const items = arr.toArray() as string[];
    const seen = new Set<string>();
    const indicesToRemove: number[] = [];

    for (let i = 0; i < items.length; i++) {
      if (seen.has(items[i])) {
        indicesToRemove.push(i);
      } else {
        seen.add(items[i]);
      }
    }

    if (indicesToRemove.length > 0) {
      blockDups.push({ blockId, indicesToRemove });
    }
  });

  // Check rootIds
  const rootItems = rootIds.toArray();
  const rootSeen = new Set<string>();
  const rootIndicesToRemove: number[] = [];
  for (let i = 0; i < rootItems.length; i++) {
    if (rootSeen.has(rootItems[i])) {
      rootIndicesToRemove.push(i);
    } else {
      rootSeen.add(rootItems[i]);
    }
  }

  // Phase 2: Cross-parent dedup + phantom child detection
  // Builds childId → [parentIds] map and detects childIds pointing to non-existent blocks.
  const childToParents = new Map<string, string[]>();
  const phantomChildren: Array<{ parentId: string; childId: string }> = [];
  blocksMap.forEach((value, parentId) => {
    if (!(value instanceof Y.Map)) return;
    const arr = value.get('childIds');
    if (!(arr instanceof Y.Array)) return;
    for (const childId of arr.toArray() as string[]) {
      // Phantom: childIds references a block that doesn't exist
      if (!blocksMap.has(childId)) {
        phantomChildren.push({ parentId, childId });
        continue; // Don't add to cross-parent map
      }
      const parents = childToParents.get(childId) || [];
      parents.push(parentId);
      childToParents.set(childId, parents);
    }
  });

  // For multi-parent blocks: keep one parent, remove from the rest.
  // Prefer the canonical parent (matches block.parentId), but if it doesn't actually
  // claim the block in its childIds, adopt the first real parent instead.
  const crossParentRemovals: Array<{ parentId: string; childId: string }> = [];
  const parentIdUpdates: Array<{ childId: string; newParentId: string }> = [];
  for (const [childId, parents] of childToParents) {
    if (parents.length <= 1) continue;
    const childBlock = blocksMap.get(childId);
    const declaredParent = childBlock instanceof Y.Map
      ? (childBlock.get('parentId') as string | null)
      : null;

    // Check if declared parent is among the ones that actually have this child
    const declaredParentClaims = declaredParent !== null && parents.includes(declaredParent);
    const keepParent = declaredParentClaims ? declaredParent : parents[0];

    // If we're adopting a different parent, update block.parentId
    if (keepParent !== declaredParent) {
      parentIdUpdates.push({ childId, newParentId: keepParent });
    }

    for (const pid of parents) {
      if (pid !== keepParent) {
        crossParentRemovals.push({ parentId: pid, childId });
      }
    }
  }

  // Phase 3: Orphan blocks — exist in blocksMap but no parent's childIds references them
  // and they're not in rootIds. These are unreachable and cause ghost rendering issues.
  const referenced = new Set<string>(rootIds.toArray());
  blocksMap.forEach((value) => {
    if (!(value instanceof Y.Map)) return;
    const arr = value.get('childIds');
    if (!(arr instanceof Y.Array)) return;
    for (const cid of arr.toArray() as string[]) {
      referenced.add(cid);
    }
  });
  const orphanBlockIds: string[] = [];
  blocksMap.forEach((_value, blockId) => {
    if (!referenced.has(blockId)) {
      orphanBlockIds.push(blockId);
    }
  });

  const hasWork = blockDups.length > 0 || rootIndicesToRemove.length > 0
    || crossParentRemovals.length > 0 || phantomChildren.length > 0
    || orphanBlockIds.length > 0;
  if (!hasWork) {
    return 0;
  }

  // Write phase — single transaction
  doc.transact(() => {
    for (const { blockId, indicesToRemove } of blockDups) {
      const blockMap = blocksMap.get(blockId);
      if (!(blockMap instanceof Y.Map)) continue;
      const arr = blockMap.get('childIds');
      if (!(arr instanceof Y.Array)) continue;

      // Delete in reverse order so indices stay valid
      for (let i = indicesToRemove.length - 1; i >= 0; i--) {
        arr.delete(indicesToRemove[i], 1);
        totalRemoved++;
      }
    }

    // Dedup rootIds
    for (let i = rootIndicesToRemove.length - 1; i >= 0; i--) {
      rootIds.delete(rootIndicesToRemove[i], 1);
      totalRemoved++;
    }

    // Fix cross-parent duplication: remove from non-canonical parents
    for (const { parentId, childId } of crossParentRemovals) {
      const parentMap = blocksMap.get(parentId);
      if (!(parentMap instanceof Y.Map)) continue;
      const arr = parentMap.get('childIds');
      if (!(arr instanceof Y.Array)) continue;
      const items = arr.toArray() as string[];
      const idx = items.indexOf(childId);
      if (idx >= 0) {
        arr.delete(idx, 1);
        totalRemoved++;
      }
    }

    // Update parentId for blocks adopted by a different parent
    for (const { childId, newParentId } of parentIdUpdates) {
      const childBlock = blocksMap.get(childId);
      if (childBlock instanceof Y.Map) {
        childBlock.set('parentId', newParentId);
      }
    }

    // Remove phantom children (childIds referencing non-existent blocks)
    for (const { parentId, childId } of phantomChildren) {
      const parentMap = blocksMap.get(parentId);
      if (!(parentMap instanceof Y.Map)) continue;
      const arr = parentMap.get('childIds');
      if (!(arr instanceof Y.Array)) continue;
      const items = arr.toArray() as string[];
      const idx = items.indexOf(childId);
      if (idx >= 0) {
        arr.delete(idx, 1);
        totalRemoved++;
      }
    }

    // Delete orphan blocks (unreachable from any parent or rootIds)
    for (const orphanId of orphanBlockIds) {
      blocksMap.delete(orphanId);
      totalRemoved++;
    }
  }, 'system');

  if (totalRemoved > 0 || parentIdUpdates.length > 0) {
    const parts = [];
    if (blockDups.length > 0 || rootIndicesToRemove.length > 0) {
      parts.push('within-array duplicates');
    }
    if (crossParentRemovals.length > 0) {
      parts.push(`${crossParentRemovals.length} cross-parent`);
    }
    if (parentIdUpdates.length > 0) {
      parts.push(`${parentIdUpdates.length} re-homed`);
    }
    if (phantomChildren.length > 0) {
      parts.push(`${phantomChildren.length} phantom children`);
    }
    if (orphanBlockIds.length > 0) {
      parts.push(`${orphanBlockIds.length} orphan blocks deleted`);
    }
    logger.warn(`Tree integrity: fixed ${totalRemoved} issues (${parts.join(', ')})`);

    // Record diagnostics — use category-specific counts (not totalRemoved which double-counts)
    const withinArrayDedups = blockDups.reduce((sum, d) => sum + d.indicesToRemove.length, 0) + rootIndicesToRemove.length;
    recordDedupRepairs(withinArrayDedups);
    recordPhantomChildrenRemoved(phantomChildren.length);
    recordCrossParentFixes(crossParentRemovals.length);
  }

  return totalRemoved;
}

/**
 * Trigger a full bidirectional resync.
 *
 * Flow:
 * 1. GET /state-vector → compute what local has that server doesn't
 * 2. If non-trivial diff: POST /update → push local-only changes to server
 * 3. GET /state → pull server state to local (existing behavior)
 *
 * Push MUST happen before pull. If we pull first, CRDT merge makes local match
 * server (from server's perspective), so the subsequent diff would be empty.
 *
 * Returns { pushedBytes } for logging by health check.
 */
export async function switchOutline(name: string): Promise<void> {
  const httpClient = getHttpClient();
  if (httpClient.getOutline() === name) return;

  logger.info(`Switching outline: ${httpClient.getOutline()} → ${name}`);

  // 1. Close WebSocket
  if (sharedWebSocket) {
    sharedWebSocket.close();
    sharedWebSocket = null;
  }
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  // 2. Clear Y.Doc — destroy observers, create fresh doc
  if (sharedUndoManager) {
    sharedUndoManager.destroy();
    sharedUndoManager = null;
  }
  sharedDoc.destroy();
  sharedDoc = new Y.Doc({ gc: true });
  sharedDocLoaded = false;
  sharedDocError = null;
  sharedDocLoadPromise = null;

  // 3. Reset sync state
  sharedPendingUpdates = [];
  if (sharedSyncTimer) clearTimeout(sharedSyncTimer);
  sharedSyncTimer = null;
  sharedIsFlushing = false;
  sharedRetryCount = 0;
  handlerRefCount = 0;
  moduleUpdateHandler = null;
  wsRetryCount = 0;
  wsHasConnectedOnce = false;
  wsReadyForMessages = true;
  wsConnectionId++;
  setSyncStatus('pending');
  setPendingCount(0);
  setLastSyncError(null);

  // 4. Reset sequence tracker
  seqTracker.resetAll();

  // 5. Switch HTTP client to new outline
  httpClient.setOutline(name);

  // 6. Load state from new outline + reconnect WS
  await triggerFullResync();
  connectWebSocket();

  logger.info(`Switched to outline '${name}'`);
}

export async function triggerFullResync(): Promise<{ pushedBytes: number }> {
  if (!isClientInitialized()) {
    logger.warn('HTTP client not initialized, cannot trigger resync');
    return { pushedBytes: 0 };
  }

  logger.info('Triggering bidirectional resync');
  recordFullResync();
  const httpClient = getHttpClient();
  let pushedBytes = 0;

  try {
    // Step 1: Push local-only changes to server (if any)
    try {
      const serverStateVector = await httpClient.getStateVector();
      const localDiff = Y.encodeStateAsUpdate(sharedDoc, serverStateVector);

      // Empty diff is ~2 bytes (just header)
      if (localDiff.length > 2) {
        logger.debug(`Pushing local-only diff to server: ${localDiff.length} bytes`);
        const txId = generateTxId();
        await httpClient.applyUpdate(localDiff, txId);
        pushedBytes = localDiff.length;
      }
    } catch (pushErr) {
      // Push failure is non-fatal — we still pull server state
      logger.error('Failed to push local diff (continuing with pull)', { err: pushErr });
    }

    // Step 2: Pull server state to local (existing behavior)
    const { state: serverState, latestSeq } = await httpClient.getState();
    if (serverState && serverState.length > 2) {
      try {
        isApplyingRemoteGlobal = true;
        Y.applyUpdate(sharedDoc, serverState, 'reconnect-authority');
      } finally {
        isApplyingRemoteGlobal = false;
      }
      // Re-seed seq tracking from server's latestSeq via tracker
      // Full state means all seqs up to latestSeq are covered + clears gap queue
      if (latestSeq !== null) {
        seqTracker.seedFromFullSync(latestSeq);
      }
      logger.info(`Bidirectional resync complete: pushed ${pushedBytes} bytes, pulled ${serverState.length} bytes, seq: ${latestSeq}`);
    } else {
      logger.info('Server state empty, nothing to pull');
    }
    setLastSyncError(null);
    return { pushedBytes };
  } catch (err) {
    logger.error('Full resync failed', { err });
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
let sharedDoc = new Y.Doc({ gc: true });
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
    logger.warn('HTTP client not initialized, skipping flush');
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
      if (!isDriftStatus()) {
        setSyncStatus('synced');
        setLastSyncError(null);
      }
      clearBackup();
    }
    setPendingCount(sharedPendingUpdates.length);
  } catch (err) {
    sharedRetryCount++;
    logger.error(`Failed to sync to server (attempt ${sharedRetryCount}/${MAX_RETRIES})`, { err });
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
    logger.info('Attached singleton update handler');
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
    logger.info('Detached singleton update handler');

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
let wsBufferOverflowLatched = false; // FLO-289: first overflow triggers forced recovery
let wsOverflowRecoveryInFlight = false; // FLO-289: single-flight recovery guard

type ReconnectBufferAction = 'buffer' | 'overflow-first' | 'overflow-repeat';

/**
 * Decide reconnect buffering behavior.
 * - buffer: safe to enqueue message
 * - overflow-first: first overflow in this reconnect cycle (latch + recovery)
 * - overflow-repeat: overflow already latched; keep dropping to avoid replaying partial stream
 */
export function resolveReconnectBufferAction(
  bufferLength: number,
  maxBufferSize: number,
  overflowLatched: boolean
): ReconnectBufferAction {
  if (overflowLatched) return 'overflow-repeat';
  if (bufferLength < maxBufferSize) return 'buffer';
  return 'overflow-first';
}

/**
 * Returns true when reconnect overflow should trigger a new forced recovery.
 * Used to prevent resync storms.
 */
export function shouldStartOverflowRecovery(
  overflowLatched: boolean,
  recoveryInFlight: boolean
): boolean {
  return overflowLatched && !recoveryInFlight;
}

// ═══════════════════════════════════════════════════════════════
// SEQUENCE NUMBER TRACKING (gap detection & incremental reconnect)
// ═══════════════════════════════════════════════════════════════

/** WS message from server (now includes seq for gap detection) */
interface WsMessage {
  /** Sequence number from persistence layer (for gap detection). Missing on restore broadcasts. */
  seq?: number;
  /** Transaction ID for echo prevention */
  txId?: string;
  /** Base64-encoded Y.Doc update bytes. Undefined for heartbeat messages (seq-only). */
  data?: string;
}

// ═══════════════════════════════════════════════════════════════
// SEQUENCE TRACKING (extracted to SyncSequenceTracker)
// ═══════════════════════════════════════════════════════════════

/** How often to persist lastContiguousSeq (debounce interval) */
const CONTIGUOUS_SEQ_PERSIST_DEBOUNCE_MS = 5000;

/** Debounce timer for persisting lastContiguousSeq to IndexedDB */
let contiguousSeqPersistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a debounced save of lastContiguousSeq to IndexedDB.
 * Used as callback for SyncSequenceTracker.
 *
 * IMPORTANT: We persist lastContiguousSeq, NOT lastSeenSeq!
 * - lastSeenSeq may jump on gaps (e.g., receive seq 419 but missed 418)
 * - lastContiguousSeq only advances when ALL prior seqs are received
 * - On reload, "since lastContiguousSeq" fetches gaps + new updates safely
 */
function scheduleContiguousSeqPersist(seq: number): void {
  if (contiguousSeqPersistTimer !== null) {
    clearTimeout(contiguousSeqPersistTimer);
  }
  contiguousSeqPersistTimer = setTimeout(() => {
    contiguousSeqPersistTimer = null;
    saveLastContiguousSeqIDB(seq).catch((err: unknown) => {
      logger.warn('Failed to persist lastContiguousSeq', { err });
    });
  }, CONTIGUOUS_SEQ_PERSIST_DEBOUNCE_MS);
}

/**
 * Singleton sequence tracker instance.
 * Manages lastSeenSeq, lastContiguousSeq, gap queue, and fetch coordination.
 * Created with persistence callback that fires on CONTIGUOUS advancement.
 */
const seqTracker = new SyncSequenceTracker(scheduleContiguousSeqPersist);

/**
 * Threshold for gap size before falling back to full resync.
 * If gap > 100, fetching individual updates may be slower than full state.
 */
const GAP_THRESHOLD_FOR_FULL_RESYNC = 100;

/** Message buffer (seq-aware) */
let wsMessageBuffer: WsMessage[] = [];

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

// ═══════════════════════════════════════════════════════════════
// ECHO GAP DEBOUNCE (FLO-391)
// ═══════════════════════════════════════════════════════════════
// Server-side hooks (MetadataExtraction, InheritanceIndex) persist updates
// that consume seq numbers but — prior to FLO-391 — weren't broadcast.
// Now they ARE broadcast, but there's a timing race: the hook runs on
// spawn_blocking, so during fast typing the next client echo can arrive
// before the hook's broadcast. Debouncing echo gap-fill by 200ms lets
// hook broadcasts fill the gap naturally.

let echoGapTimer: ReturnType<typeof setTimeout> | null = null;
let pendingEchoGap: { fromSeq: number; toSeq: number } | null = null;

function scheduleEchoGapFetch(fromSeq: number, toSeq: number): void {
  // Merge with existing pending gap if present
  if (pendingEchoGap) {
    pendingEchoGap.fromSeq = Math.min(pendingEchoGap.fromSeq, fromSeq);
    pendingEchoGap.toSeq = Math.max(pendingEchoGap.toSeq, toSeq);
  } else {
    pendingEchoGap = { fromSeq, toSeq };
  }

  // Reset timer
  if (echoGapTimer) clearTimeout(echoGapTimer);
  echoGapTimer = setTimeout(() => {
    echoGapTimer = null;
    if (!pendingEchoGap) return;

    // Check if gap was filled by intervening messages (hook broadcasts)
    const contiguous = seqTracker.lastContiguousSeq;
    if (contiguous !== null && contiguous >= pendingEchoGap.toSeq - 1) {
      wsLogger.debug('Echo gap resolved by hook broadcasts, skipping fetch');
      pendingEchoGap = null;
      return;
    }

    // Gap still open — genuine missed update, fetch it
    wsLogger.warn(`Echo gap persisted after debounce, fetching: ${pendingEchoGap.fromSeq} → ${pendingEchoGap.toSeq}`);
    recordEchoGapFill();
    queueGapFetch(pendingEchoGap.fromSeq, pendingEchoGap.toSeq);
    pendingEchoGap = null;
  }, 200);
}

/**
 * Apply a WebSocket message to the Y.Doc.
 * Extracted to support buffering during reconnect (FLO-152).
 *
 * Now includes sequence number tracking for gap detection via SyncSequenceTracker.
 */
function applyWsMessage(msg: WsMessage) {
  // Echo prevention: skip APPLICATION if this is our own update
  // But still run gap detection - the seq may reveal missed updates from others
  if (msg.txId && recentTxIds.has(msg.txId)) {
    wsLogger.debug(`Skipping own update application (txId: ${msg.txId})`);
    recentTxIds.delete(msg.txId);

    // Gap detection for echoed messages via tracker
    // Our message's seq may reveal we missed updates from other clients
    // FLO-391: Debounce echo gap-fill by 200ms — hook broadcasts arrive in that window
    if (msg.seq !== undefined) {
      const gap = seqTracker.observeEcho(msg.seq);
      if (gap) {
        wsLogger.debug(`Echo gap (${gap.fromSeq} → ${gap.toSeq}), deferring fetch 200ms for hook broadcasts`);
        scheduleEchoGapFetch(gap.fromSeq, gap.toSeq);
      }
    }
    return;
  }

  // Heartbeat: seq-only message (no payload).
  // Use it only for gap detection; do NOT treat it as an applied update.
  if (msg.seq !== undefined && !msg.data) {
    const gap = seqTracker.observeHeartbeat(msg.seq);
    if (gap) {
      wsLogger.warn(`Gap detected (heartbeat): ${gap.fromSeq} → ${gap.toSeq} (missing up to ${gap.toSeq - gap.fromSeq} updates)`);
      queueGapFetch(gap.fromSeq, gap.toSeq);
    }
    return;
  }

  // Detect restore/full-state broadcasts: has data but no seq
  // These replace the entire Y.Doc state, so pre-restore seq tracking is stale.
  // Reset before applying to avoid false gap detection against old seq values.
  if (msg.seq === undefined && msg.data) {
    wsLogger.info('Restore broadcast detected (data without seq), resetting seq tracking');
    seqTracker.resetForRestore();
  }

  // Gap detection for regular (non-echo) messages via tracker
  if (msg.seq !== undefined) {
    const gap = seqTracker.observeSeq(msg.seq);
    if (gap) {
      // Gap detected! We missed seq(s) between gap.fromSeq and gap.toSeq
      wsLogger.warn(`Gap detected: ${gap.fromSeq} → ${gap.toSeq} (missing ${gap.toSeq - gap.fromSeq - 1} updates)`);

      // NOTE: We apply this message immediately even though earlier seq(s) are missing.
      // This is safe because Y.Doc CRDT merge is commutative — application order doesn't
      // affect the final document state. The gap-fill fetch runs async and applies the
      // missing updates when they arrive. The end state is identical regardless of order.
      queueGapFetch(gap.fromSeq, gap.toSeq);
    }
  }

  // Decode base64 and apply (skip for heartbeat messages with no data)
  if (msg.data) {
    const update = base64ToBytes(msg.data);
    Y.applyUpdate(sharedDoc, update, 'remote');
  }
}

/**
 * Queue a gap fetch. If no fetch is in progress, starts immediately.
 * If a fetch is in progress, queues the gap to be processed after.
 */
function queueGapFetch(fromSeq: number, toSeq: number): void {
  if (seqTracker.isFetching) {
    // Queue the gap - will be processed after current fetch
    seqTracker.queueGap(fromSeq, toSeq);
    wsLogger.debug(`Queued gap fetch (${fromSeq} → ${toSeq}), queue size: ${seqTracker.pendingGapQueue.length}`);
    return;
  }

  // No fetch in progress - start immediately
  // Note: fetchMissingUpdates has internal try/catch, but add .catch() for any
  // unexpected throws (e.g., dynamic import failure) to prevent unhandled rejection
  fetchMissingUpdates(fromSeq, toSeq).catch((err) =>
    wsLogger.error('Unhandled error in gap fetch', { err })
  );
}

/**
 * Process the next gap in the queue, if any.
 * Called after a gap fetch completes.
 */
function processNextQueuedGap(): void {
  // consolidateGaps handles: empty check, gap consolidation, coverage check, queue clearing
  const consolidated = seqTracker.consolidateGaps();
  if (!consolidated) {
    // Either no gaps queued, or already covered by lastContiguousSeq
    return;
  }

  wsLogger.debug(`Processing consolidated queued gap: ${consolidated.fromSeq} → ${consolidated.toSeq} (contiguous: ${seqTracker.lastContiguousSeq})`);
  fetchMissingUpdates(consolidated.fromSeq, consolidated.toSeq).catch((err) =>
    wsLogger.error('Unhandled error in queued gap fetch', { err })
  );
}

/**
 * Fetch missing updates when a gap is detected.
 * Runs async - doesn't block current message processing.
 * Falls back to full resync if gap is too large or updates are compacted.
 */
async function fetchMissingUpdates(fromSeq: number, toSeq: number): Promise<void> {
  // Guard against concurrent fetches (shouldn't happen with queue, but be safe)
  if (!seqTracker.markFetchStarted()) {
    wsLogger.warn('Unexpected concurrent fetch attempt, queueing');
    seqTracker.queueGap(fromSeq, toSeq);
    return;
  }

  const gapSize = toSeq - fromSeq - 1;

  // Large gap - full resync is faster
  if (gapSize > GAP_THRESHOLD_FOR_FULL_RESYNC) {
    wsLogger.info(`Gap too large (${gapSize} updates), triggering full resync`);
    seqTracker.resetForRestore(); // Clear queue and reset seq tracking
    seqTracker.markFetchDone();
    await triggerFullResync();
    return;
  }

  try {
    const { getHttpClient, isClientInitialized } = await import('../lib/httpClient');
    if (!isClientInitialized()) {
      wsLogger.warn('HTTP client not initialized, cannot fetch missing updates');
      return;
    }

    const httpClient = getHttpClient();
    recordGapFill();
    const result = await httpClient.getUpdatesSince(fromSeq, gapSize + 1);

    if (!result.ok) {
      // 410 Gone - updates were compacted, need full resync
      wsLogger.warn(`Updates compacted (through seq ${result.compactedThrough}), triggering full resync`);
      seqTracker.resetForRestore(); // Clear queue and reset seq tracking
      await triggerFullResync();
      return;
    }

    // Apply the missing updates
    const { updates, latestSeq } = result.response;
    wsLogger.info(`Fetched ${updates.length} missing updates (seq ${fromSeq} → ${latestSeq ?? 'unknown'})`);

    try {
      isApplyingRemoteGlobal = true;
      for (const entry of updates) {
        const update = base64ToBytes(entry.data);
        Y.applyUpdate(sharedDoc, update, 'gap-fill');
        // Gap-fill updates are contiguous - advance contiguous tracking
        seqTracker.advanceContiguous(entry.seq);
      }
    } finally {
      isApplyingRemoteGlobal = false;
    }
  } catch (err) {
    wsLogger.error('Failed to fetch missing updates', { err });
    // Fall back to full resync on any error
    seqTracker.resetForRestore(); // Clear queue and reset seq tracking
    await triggerFullResync();
  } finally {
    seqTracker.markFetchDone();
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
      logger.debug(`Backed up Y.Doc to IndexedDB: ${state.length} bytes`);
    } catch (err) {
      logger.error('Failed to backup Y.Doc', { err });
    }
  }, BACKUP_DEBOUNCE_MS);
}

/**
 * Clear the IndexedDB backup (called when sync completes).
 */
function clearBackup() {
  clearBackupIDB()
    .then(() => {
      logger.debug('Cleared IndexedDB backup (synced)');
    })
    .catch(err => {
      logger.warn('Failed to clear backup', { err });
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
      logger.debug('Found legacy localStorage backup, migrating to IndexedDB');
      const bytes = base64ToBytes(lsBackup);
      await saveBackupIDB(bytes);
      localStorage.removeItem(YDOC_BACKUP_KEY);
      logger.debug('Migration complete');
      return bytes;
    }

    return null;
  } catch (err) {
    logger.warn('Failed to read backup', { err });
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
        logger.warn('Server returned empty but IndexedDB backup exists!');
        logger.warn('This could indicate server wipe. Check ctx_markers.db in your FLOATTY_DATA_DIR');
        return;
      }
    }

    // Suspicious: Very few blocks (might be test data)
    if (blockCount > 0 && blockCount < 10) {
      logger.warn(`Very few blocks (${blockCount}) - might be test data`);
    }

    // Suspicious: No roots but blocks exist (orphaned blocks)
    if (rootCount === 0 && blockCount > 0) {
      logger.warn(`${blockCount} blocks exist but no root IDs!`);
      return;
    }

    // Suspicious: More roots than expected (usually 2-3)
    if (rootCount > 20) {
      logger.warn(`Unusually many root blocks (${rootCount})`);
    }

    logger.info(`State looks healthy: ${blockCount} blocks, ${rootCount} roots`);
  } catch (err) {
    logger.warn('Sanity check failed', { err });
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
    logger.warn('HTTP client not initialized, cannot flush');
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
    setPendingCount(sharedPendingUpdates.length);
    wsLogger.info('Successfully flushed pending updates on reconnect');
  } catch (err) {
    wsLogger.error('Failed to flush pending updates on reconnect', { err });
    // Restore updates for retry
    sharedPendingUpdates = [...updates, ...sharedPendingUpdates];
    setPendingCount(sharedPendingUpdates.length);
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
    wsLogger.warn('Server URL not set, skipping WebSocket');
    return;
  }

  // Convert http://localhost:8765 to ws://localhost:8765/ws(?outline=name)
  const outline = getHttpClient().getOutline();
  let wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  if (outline !== 'default') {
    wsUrl += `?outline=${encodeURIComponent(outline)}`;
  }
  wsLogger.info(`Connecting to ${wsUrl}`);

  try {
    sharedWebSocket = new WebSocket(wsUrl);

    sharedWebSocket.onopen = () => {
      wsLogger.info('Connected');
      // Reset retry count on successful connection
      wsRetryCount = 0;

      const isReconnect = wsHasConnectedOnce;
      wsHasConnectedOnce = true;

      // FLO-152: Increment connection ID to invalidate any stale IIFEs
      const thisConnectionId = ++wsConnectionId;

      // Clear any previous connection error now that we're connected
      if (sharedPendingUpdates.length === 0 && !isDriftStatus()) {
        setSyncStatus('synced');
        setLastSyncError(null);
      }

      if (isReconnect) {
        // RECONNECT: sync with buffering (FLO-152)
        // Now supports incremental sync via lastSeenSeq when available
        // FLO-152: Mark NOT ready for messages - buffer incoming until sync completes
        wsReadyForMessages = false;
        wsMessageBuffer = [];
        wsBufferOverflowLatched = false;

        // Reconnection sync: flush local pending, then fetch any missed server updates.
        // This prevents stale state if server received updates while we were disconnected.
        // FLO-152: Use IIFE instead of queueMicrotask to control message buffering
        (async () => {
          try {
            // 1. Flush local pending updates first
            if (sharedPendingUpdates.length > 0) {
              wsLogger.debug(`Flushing ${sharedPendingUpdates.length} pending updates on reconnect`);
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
            if (seqTracker.lastSeenSeq !== null) {
              wsLogger.debug(`Attempting incremental reconnect sync (since seq: ${seqTracker.lastSeenSeq})`);
              let currentSeq = seqTracker.lastSeenSeq;
              let totalApplied = 0;
              let pageCount = 0;

              // Loop until we've fetched all pages (or hit ceiling)
              while (pageCount < MAX_RECONNECT_PAGES) {
                pageCount++;
                const result = await httpClient.getUpdatesSince(currentSeq);

                if (!result.ok) {
                  // 410 Gone - updates were compacted, need full resync
                  wsLogger.warn(`Incremental sync unavailable (compacted through ${result.compactedThrough}), falling back to full sync`);
                  break;
                }

                const { updates, latestSeq } = result.response;

                if (updates.length === 0) {
                  // No more updates to fetch
                  if (totalApplied > 0) {
                    wsLogger.info(`Incremental sync complete: applied ${totalApplied} updates total`);
                  } else {
                    wsLogger.debug('Incremental sync: no new updates (already up to date)');
                  }
                  syncedIncrementally = true;
                  break;
                }

                // Apply this page of updates
                wsLogger.debug(`Incremental sync: applying ${updates.length} updates (seq ${currentSeq} → ${updates[updates.length - 1].seq})`);
                try {
                  isApplyingRemoteGlobal = true;
                  for (const entry of updates) {
                    const update = base64ToBytes(entry.data);
                    Y.applyUpdate(sharedDoc, update, 'reconnect-authority');
                    // Reconnect sync updates are contiguous - observeSeq handles both seen + contiguous
                    seqTracker.observeSeq(entry.seq);
                    currentSeq = entry.seq;
                  }
                } finally {
                  isApplyingRemoteGlobal = false;
                }
                totalApplied += updates.length;

                // Check if we've caught up (latestSeq matches what we just applied)
                if (latestSeq !== null && currentSeq >= latestSeq) {
                  wsLogger.info(`Incremental sync complete: applied ${totalApplied} updates, caught up to seq ${latestSeq}`);
                  syncedIncrementally = true;
                  break;
                }

                // Continue fetching more pages
              }

              // Hit page ceiling without catching up - fall back to full sync
              if (pageCount >= MAX_RECONNECT_PAGES && !syncedIncrementally) {
                wsLogger.warn(`Incremental sync exceeded ${MAX_RECONNECT_PAGES} pages (${totalApplied} updates), falling back to full sync`);
              }
            }

            // Fall back to full state sync if incremental sync not possible/failed
            if (!syncedIncrementally) {
              const { state: serverState, latestSeq } = await httpClient.getState();
              if (serverState && serverState.length > 2) {
                wsLogger.info(`Full state sync after reconnect: ${serverState.length} bytes`);
                // FLO-256: Wrap in isApplyingRemoteGlobal to prevent update observer from echoing
                try {
                  isApplyingRemoteGlobal = true;
                  Y.applyUpdate(sharedDoc, serverState, 'reconnect-authority');
                } finally {
                  isApplyingRemoteGlobal = false;
                }
              }
              // Re-seed both seq trackers from server's latestSeq via tracker
              // Full state means all seqs up to latestSeq are covered + clears gap queue
              if (latestSeq !== null) {
                seqTracker.seedFromFullSync(latestSeq);
                wsLogger.debug(`Seq tracking re-seeded to: ${latestSeq}`);
              }
            }

            // FLO-152: Guard against stale IIFE from previous connection
            if (thisConnectionId !== wsConnectionId) {
              wsLogger.debug('Stale connection IIFE, ignoring');
              return;
            }

            wsReadyForMessages = true;

            // FLO-289: Buffer overflow means replay stream is incomplete.
            // Skip replay and force one full recovery to converge safely.
            if (wsBufferOverflowLatched) {
              wsMessageBuffer = [];

              if (shouldStartOverflowRecovery(wsBufferOverflowLatched, wsOverflowRecoveryInFlight)) {
                wsOverflowRecoveryInFlight = true;
                wsLogger.warn('Reconnect buffer overflow latched, triggering forced recovery sync');
                try {
                  await triggerFullResync();
                } catch (resyncErr) {
                  wsLogger.error('Forced overflow recovery failed', { err: resyncErr });
                  setLastSyncError(`Overflow recovery failed: ${String(resyncErr)}`);
                } finally {
                  wsOverflowRecoveryInFlight = false;
                }
              } else {
                wsLogger.warn('Overflow recovery already running, skipping duplicate trigger');
              }

              wsBufferOverflowLatched = false;
              return;
            }

            // FLO-152: NOW safe to process messages - replay buffered ones
            wsLogger.info(`Reconnect sync complete, replaying ${wsMessageBuffer.length} buffered messages`);
            for (const msg of wsMessageBuffer) {
              applyWsMessage(msg);
            }
            wsMessageBuffer = [];
          } catch (err) {
            wsLogger.error('Reconnect sync failed', { err });
            // FLO-152: Guard against stale IIFE from previous connection
            if (thisConnectionId !== wsConnectionId) {
              wsLogger.debug('Stale connection IIFE error path, ignoring');
              return;
            }
            // Even on failure, start accepting messages (better than blocking forever)
            wsReadyForMessages = true;
            wsMessageBuffer = [];

            // FLO-289: If reconnect failed after overflow, still force one recovery sync.
            if (wsBufferOverflowLatched) {
              if (shouldStartOverflowRecovery(wsBufferOverflowLatched, wsOverflowRecoveryInFlight)) {
                wsOverflowRecoveryInFlight = true;
                wsLogger.warn('Reconnect failed with overflow latched, forcing recovery sync');
                try {
                  await triggerFullResync();
                } catch (resyncErr) {
                  wsLogger.error('Forced overflow recovery after reconnect failure failed', { err: resyncErr });
                  setLastSyncError(`Overflow recovery failed: ${String(resyncErr)}`);
                } finally {
                  wsOverflowRecoveryInFlight = false;
                }
              } else {
                wsLogger.warn('Overflow recovery already running after reconnect failure');
              }

              wsBufferOverflowLatched = false;
            }
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
        wsBufferOverflowLatched = false;
        wsLogger.debug('First connection — accepting messages immediately (no redundant fetch)');
      }
    };

    sharedWebSocket.onmessage = (event) => {
      // Server sends JSON text messages: { seq?: number, txId?: string, data: string (base64) }
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data) as WsMessage;

          // FLO-152: Buffer messages during reconnect sync to prevent race condition
          if (!wsReadyForMessages) {
            const bufferAction = resolveReconnectBufferAction(
              wsMessageBuffer.length,
              WS_MESSAGE_BUFFER_MAX,
              wsBufferOverflowLatched
            );

            if (bufferAction === 'buffer') {
              wsMessageBuffer.push(msg);
              if (msg.seq !== undefined) {
                wsLogger.debug(`Buffered message during reconnect sync (seq: ${msg.seq}, total: ${wsMessageBuffer.length})`);
              } else {
                wsLogger.debug(`Buffered message during reconnect sync (total: ${wsMessageBuffer.length})`);
              }
            } else if (bufferAction === 'overflow-first') {
              wsBufferOverflowLatched = true;
              wsMessageBuffer = [];
              setSyncStatus('drift');
              setLastSyncError(`WebSocket reconnect buffer overflowed (${WS_MESSAGE_BUFFER_MAX} messages); forcing recovery sync`);
              wsLogger.error('Message buffer overflow during reconnect sync, replay disabled until forced recovery');
            } else {
              wsLogger.warn('Message dropped while overflow recovery is latched');
            }
            return;
          }

          // Ready for messages - apply directly
          applyWsMessage(msg);
        } catch (err) {
          wsLogger.error('Failed to parse message', { err });
        }
      }
    };

    sharedWebSocket.onclose = (event) => {
      wsLogger.info(`Disconnected, code: ${event.code}`);
      sharedWebSocket = null;
      // Reconnect with exponential backoff
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      const backoffDelay = Math.min(
        WS_RECONNECT_DELAY * Math.pow(2, wsRetryCount),
        WS_MAX_RECONNECT_DELAY
      );
      wsRetryCount++;
      wsLogger.debug(`Reconnecting in ${backoffDelay}ms (attempt ${wsRetryCount})`);
      wsReconnectTimer = window.setTimeout(connectWebSocket, backoffDelay);
    };

    sharedWebSocket.onerror = (error) => {
      wsLogger.error('Error', { err: error });
      // Update sync status so UI can show error state
      // Note: WebSocket error events don't contain useful details - the actual
      // diagnostic info comes through onclose. Set generic message here.
      setSyncStatus('error');
      setLastSyncError('WebSocket connection error. Reconnecting...');
      // onclose will fire next and handle reconnection
    };
  } catch (err) {
    wsLogger.error('Failed to connect', { err });
    setSyncStatus('error');
    setLastSyncError(`WebSocket connection failed: ${err}`);
    // Schedule reconnect — onclose won't fire since the socket never opened
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    const backoffDelay = Math.min(
      WS_RECONNECT_DELAY * Math.pow(2, wsRetryCount),
      WS_MAX_RECONNECT_DELAY
    );
    wsRetryCount++;
    wsLogger.debug(`Reconnecting in ${backoffDelay}ms (attempt ${wsRetryCount})`);
    wsReconnectTimer = window.setTimeout(connectWebSocket, backoffDelay);
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
          let workspaceName = 'default';
          try {
            const config = await configReady;
            workspaceName = config.workspace_name || 'default';
          } catch (err) {
            logger.warn('Config IPC failed for namespace, using default', { err });
          }
          initBackupNamespace(workspaceName);

          // Load persisted lastContiguousSeq for incremental sync after browser refresh
          // IMPORTANT: We persist lastContiguousSeq (not lastSeenSeq) because:
          // - lastSeenSeq may have jumped due to gaps (e.g., saw 419 but missed 418)
          // - lastContiguousSeq is safe baseline where ALL prior seqs were received
          // - Requesting "since lastContiguousSeq" will fetch any gaps + new updates
          try {
            const persistedSeq = await getLastContiguousSeqIDB();
            if (persistedSeq !== null) {
              // Seed tracker with persisted contiguous seq (sets both values)
              seqTracker.seedFromFullSync(persistedSeq);
              logger.debug(`Loaded persisted lastContiguousSeq: ${persistedSeq}`);
            }
          } catch (seqErr) {
            logger.warn('Failed to load lastContiguousSeq', { err: seqErr });
          }

          // Ensure HTTP client is initialized
          if (!isClientInitialized()) {
            throw new Error('HTTP client not initialized');
          }

          const httpClient = getHttpClient();

          // Check for backup (crash recovery) - migrates legacy localStorage if found
          const localBackup = await getLocalBackup();

          if (localBackup) {
            logger.debug('Found backup, attempting reconciliation...');

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
                logger.debug(`Pushing local changes to server: ${localDiff.length} bytes`);
                await httpClient.applyUpdate(localDiff);
                localChangesPushed = true;
              }

              // Now get server's full state (which now includes our pushed changes)
              const { state: serverState, latestSeq } = await httpClient.getState();

              // Apply server state to our doc - this already contains our pushed diff
              setApplyingRemote(true);
              try {
                Y.applyUpdate(doc, serverState, 'remote');
              } finally {
                setApplyingRemote(false);
              }

              // Seed seq tracking from server via tracker (full state = all seqs covered)
              if (latestSeq !== null) {
                seqTracker.seedFromFullSync(latestSeq);
              }

              logger.info(`Reconciliation complete, seq: ${latestSeq}, clearing backup`);
              clearBackup();
            } catch (reconcileErr) {
              logger.error('Reconciliation failed, falling back to server state', { err: reconcileErr });

              // Try to load server state as fallback
              try {
                const { state: stateBytes, latestSeq } = await httpClient.getState();
                if (stateBytes && stateBytes.length > 0) {
                  setApplyingRemote(true);
                  try {
                    Y.applyUpdate(doc, stateBytes, 'remote');
                  } finally {
                    setApplyingRemote(false);
                  }
                  // Seed seq tracking via tracker (full state = all seqs covered)
                  if (latestSeq !== null) {
                    seqTracker.seedFromFullSync(latestSeq);
                  }
                }
              } catch (stateErr) {
                logger.error('Failed to load server state', { err: stateErr });
              }

              // CRITICAL: Only clear backup if we successfully pushed local changes,
              // or if there were no local changes to begin with.
              // If push failed, preserve backup to retry next time.
              if (!hadLocalChanges || localChangesPushed) {
                logger.warn('Clearing backup (no local changes or already pushed)');
                clearBackup();
              } else {
                logger.warn('PRESERVING backup - local changes failed to push, will retry next startup');
                // Don't clear - user's local changes are still in IndexedDB
              }
            }
          } else {
            // Normal load - no local backup
            const { state: stateBytes, latestSeq } = await httpClient.getState();

            if (stateBytes && stateBytes.length > 0) {
              setApplyingRemote(true);
              try {
                Y.applyUpdate(doc, stateBytes, 'remote');
              } finally {
                setApplyingRemote(false);
              }
              // Seed seq tracking via tracker (full state = all seqs covered)
              if (latestSeq !== null) {
                seqTracker.seedFromFullSync(latestSeq);
                logger.info(`Initial load complete, seq: ${latestSeq}`);
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
              trackedOrigins: new Set([null, undefined, 'user', 'user-drag']),
            });
            // Clear stack so user can't undo past loaded state
            // (prevents undoing the initial block creation)
            sharedUndoManager.clear();
          }

          // Connect to WebSocket for real-time sync
          connectWebSocket();

          // FLO-247: Startup sanity check - detect suspicious state
          validateSyncedState(doc).catch(err => {
            logger.warn('Startup sanity check error', { err });
          });

          // FLO-280: Dedup childIds on startup (catches pre-existing duplicates)
          const startupDeduped = deduplicateChildIds();
          if (startupDeduped > 0) {
            logger.warn(`Startup dedup removed ${startupDeduped} duplicate childIds`);
          }
        } catch (err) {
          logger.error('Failed to load initial state from server', { err });
          sharedDocError = String(err);
        }
      })();

      await sharedDocLoadPromise;
      setIsLoaded(sharedDocLoaded);
      setError(sharedDocError);
    }

    // Attach singleton handler (ref-counted - only first caller actually attaches)
    attachHandler();
    loadInitialState().catch(err => {
      logger.error('loadInitialState failed', { err });
      setSyncStatus('error');
    });

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
  logger.info('HMR cleanup triggered');

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
  if (contiguousSeqPersistTimer) {
    clearTimeout(contiguousSeqPersistTimer);
    contiguousSeqPersistTimer = null;
  }
  if (echoGapTimer) {
    clearTimeout(echoGapTimer);
    echoGapTimer = null;
  }
  pendingEchoGap = null;

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
  wsBufferOverflowLatched = false;
  wsOverflowRecoveryInFlight = false;
  wsConnectionId = 0;
  wsRetryCount = 0;

  // Reset sequence tracking via tracker (full reset including fetch state)
  seqTracker.resetAll();

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
