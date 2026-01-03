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
      await httpClient.applyUpdate(update);
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
// BASE64 UTILITIES (exported for tests and other consumers)
// ═══════════════════════════════════════════════════════════════

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Get the singleton Y.Doc instance.
 * Used for testing singleton behavior.
 */
export function getSharedDoc(): Y.Doc {
  return sharedDoc;
}

// ═══════════════════════════════════════════════════════════════
// SINGLETON Y.DOC
// ═══════════════════════════════════════════════════════════════

// Y.Doc is a singleton - survives component unmount/remount cycles.
// Only the update observer is cleaned up per-component.
const sharedDoc = new Y.Doc();
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

// WebSocket for real-time sync from server
let sharedWebSocket: WebSocket | null = null;
let wsReconnectTimer: number | null = null;
let wsRetryCount = 0;
const WS_RECONNECT_DELAY = 2000;
const WS_MAX_RECONNECT_DELAY = 30000;

// ═══════════════════════════════════════════════════════════════
// LOCAL STORAGE BACKUP (crash resilience)
// ═══════════════════════════════════════════════════════════════

const YDOC_BACKUP_KEY = 'floatty_ydoc_backup';
const BACKUP_DEBOUNCE_MS = 1000;
const BACKUP_MAX_SIZE = 5 * 1024 * 1024; // 5MB limit for localStorage
let backupTimer: number | null = null;

/**
 * Schedule a backup of current Y.Doc state to localStorage.
 * Called when local changes are queued, providing crash resilience.
 */
function scheduleBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = window.setTimeout(() => {
    try {
      const state = Y.encodeStateAsUpdate(sharedDoc);
      if (state.length > BACKUP_MAX_SIZE) {
        console.warn('[useSyncedYDoc] Y.Doc too large for localStorage backup:', state.length, 'bytes');
        return;
      }
      localStorage.setItem(YDOC_BACKUP_KEY, bytesToBase64(state));
      console.debug('[useSyncedYDoc] Backed up Y.Doc to localStorage:', state.length, 'bytes');
    } catch (err) {
      console.warn('[useSyncedYDoc] Failed to backup Y.Doc:', err);
    }
  }, BACKUP_DEBOUNCE_MS);
}

/**
 * Clear the localStorage backup (called when sync completes).
 */
function clearBackup() {
  try {
    localStorage.removeItem(YDOC_BACKUP_KEY);
    console.debug('[useSyncedYDoc] Cleared localStorage backup (synced)');
  } catch (err) {
    console.warn('[useSyncedYDoc] Failed to clear backup:', err);
  }
}

/**
 * Check if a localStorage backup exists.
 */
export function hasLocalBackup(): boolean {
  try {
    return localStorage.getItem(YDOC_BACKUP_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Get the localStorage backup if it exists.
 */
export function getLocalBackup(): Uint8Array | null {
  try {
    const backup = localStorage.getItem(YDOC_BACKUP_KEY);
    if (!backup) return null;
    return base64ToBytes(backup);
  } catch (err) {
    console.warn('[useSyncedYDoc] Failed to read backup:', err);
    return null;
  }
}

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
      await httpClient.applyUpdate(update);
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
      // Clear any previous connection error now that we're connected
      if (sharedPendingUpdates.length === 0) {
        setSyncStatus('synced');
        setLastSyncError(null);
      }

      // Reconnection sync: flush local pending, then fetch any missed server updates.
      // This prevents stale state if server received updates while we were disconnected.
      queueMicrotask(async () => {
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
          // Server state includes all updates; applyUpdate is idempotent (no-op for already-seen)
          const { getHttpClient } = await import('../lib/httpClient');
          const httpClient = getHttpClient();
          const serverState = await httpClient.getState();
          if (serverState && serverState.length > 2) {
            console.log('[WS] Syncing server state after reconnect:', serverState.length, 'bytes');
            Y.applyUpdate(sharedDoc, serverState, 'remote');
          }
        } catch (err) {
          console.error('[WS] Reconnect sync failed:', err);
          // Non-fatal: we'll receive live updates via WebSocket going forward
        }
      });
    };

    sharedWebSocket.onmessage = (event) => {
      // Server sends binary Y.Doc updates
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => {
          const update = new Uint8Array(buffer);
          console.log('[WS] Received update:', update.length, 'bytes');
          // Apply with 'remote' origin so we don't echo it back
          Y.applyUpdate(sharedDoc, update, 'remote');
        });
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
  options: UseSyncedYDocOptions = {}
): UseSyncedYDocReturn {
  const { syncDebounce = DEFAULT_SYNC_DEBOUNCE } = options;

  // Use the singleton doc
  const doc = sharedDoc;
  const [isLoaded, setIsLoaded] = createSignal(sharedDocLoaded);
  const [error, setError] = createSignal<string | null>(sharedDocError);

  // Track whether we're currently applying an update from Rust
  let isApplyingRemote = false;

  // Schedule a flush with optional delay override (for backoff)
  const scheduleFlush = (delay?: number) => {
    if (sharedSyncTimer) {
      clearTimeout(sharedSyncTimer);
    }
    sharedSyncTimer = window.setTimeout(flushUpdates, delay ?? syncDebounce);
  };

  // Send pending updates to server via HTTP
  const flushUpdates = async () => {
    // Guard against concurrent flushes
    if (sharedIsFlushing || sharedPendingUpdates.length === 0) return;

    // Ensure HTTP client is initialized
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
      // Send each delta individually - they're small and we want granular persistence
      for (const update of updates) {
        await httpClient.applyUpdate(update);
        sentCount++;
      }
      sharedRetryCount = 0; // Reset on success

      // Update sync status - only mark synced if queue is empty
      if (sharedPendingUpdates.length === 0) {
        setSyncStatus('synced');
        setLastSyncError(null);
        clearBackup(); // All synced - clear crash backup
      }
      setPendingCount(sharedPendingUpdates.length);
    } catch (err) {
      sharedRetryCount++;
      console.error(`Failed to sync to server (attempt ${sharedRetryCount}/${MAX_RETRIES}):`, err);
      // Restore unsent updates to front of queue for retry
      sharedPendingUpdates = [...updates.slice(sentCount), ...sharedPendingUpdates];
      setPendingCount(sharedPendingUpdates.length);

      if (sharedRetryCount >= MAX_RETRIES) {
        setSyncStatus('error');
        setLastSyncError(`Sync failed after ${MAX_RETRIES} attempts. Changes may not be saved.`);
        setError(`Sync failed after ${MAX_RETRIES} attempts. Changes may not be saved.`);
        sharedRetryCount = 0; // Allow future attempts after user interaction
      } else if (sharedPendingUpdates.length > 0) {
        // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms
        const backoffDelay = Math.min(syncDebounce * Math.pow(2, sharedRetryCount), 10000);
        scheduleFlush(backoffDelay);
      }
    } finally {
      sharedIsFlushing = false;
    }
  };

  // Queue an update and schedule flush
  const queueUpdate = (update: Uint8Array) => {
    sharedPendingUpdates.push(update);
    setPendingCount(sharedPendingUpdates.length);
    setSyncStatus('pending');
    scheduleFlush();
    scheduleBackup(); // Crash resilience - backup to localStorage
  };

  // Force sync (bypass debounce)
  const forceSync = async () => {
    if (sharedSyncTimer) {
      clearTimeout(sharedSyncTimer);
      sharedSyncTimer = null;
    }
    await flushUpdates();
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
          // Ensure HTTP client is initialized
          if (!isClientInitialized()) {
            throw new Error('HTTP client not initialized');
          }

          const httpClient = getHttpClient();

          // Check for localStorage backup (crash recovery)
          const localBackup = getLocalBackup();

          if (localBackup) {
            console.log('[useSyncedYDoc] Found localStorage backup, attempting reconciliation...');

            try {
              // Get server state vector to see what it has
              const serverSV = await httpClient.getStateVector();

              // Compute diff: what we have that server doesn't
              // diffUpdate returns an update containing only changes the server is missing
              const localDiff = Y.diffUpdate(localBackup, serverSV);

              // If diff is substantial (empty diff is ~2 bytes), push our changes first
              if (localDiff.length > 2) {
                console.log('[useSyncedYDoc] Pushing local changes to server:', localDiff.length, 'bytes');
                await httpClient.applyUpdate(localDiff);
              }

              // Now get server's full state (which now includes our pushed changes)
              const serverState = await httpClient.getState();

              // Apply server state to our doc - this already contains our pushed diff
              isApplyingRemote = true;
              Y.applyUpdate(doc, serverState, 'remote');
              isApplyingRemote = false;

              console.log('[useSyncedYDoc] Reconciliation complete, clearing backup');
              clearBackup();
            } catch (reconcileErr) {
              console.error('[useSyncedYDoc] Reconciliation failed, falling back to server state:', reconcileErr);
              // Fall back to just loading server state
              const stateBytes = await httpClient.getState();
              if (stateBytes && stateBytes.length > 0) {
                isApplyingRemote = true;
                Y.applyUpdate(doc, stateBytes, 'remote');
                isApplyingRemote = false;
              }
              // Clear the failing backup to prevent retry loops on every app start.
              // The backup was already attempted and server state has been applied.
              console.warn('[useSyncedYDoc] Clearing failed backup after server state fallback');
              clearBackup();
            }
          } else {
            // Normal load - no local backup
            const stateBytes = await httpClient.getState();

            if (stateBytes && stateBytes.length > 0) {
              isApplyingRemote = true;
              Y.applyUpdate(doc, stateBytes, 'remote');
              isApplyingRemote = false;
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
              // Track all origins except 'remote' (which is from server)
              trackedOrigins: new Set([null, undefined]),
            });
            // Clear stack so user can't undo past loaded state
            // (prevents undoing the initial block creation)
            sharedUndoManager.clear();
          }

          // Connect to WebSocket for real-time sync
          connectWebSocket();
        } catch (err) {
          console.error('Failed to load initial state from server:', err);
          sharedDocError = String(err);
        }
      })();

      await sharedDocLoadPromise;
      setIsLoaded(sharedDocLoaded);
      setError(sharedDocError);
    }

    // Observe all changes - use the actual delta, not full state
    const updateHandler = (update: Uint8Array, origin: unknown) => {
      // Don't sync back changes that came from Rust
      if (origin === 'remote' || isApplyingRemote) return;
      queueUpdate(update);
    };

    doc.on('update', updateHandler);
    loadInitialState();

    onCleanup(() => {
      // Only cleanup the observer, NOT the doc or sync machinery (singleton survives)
      doc.off('update', updateHandler);
      // NOTE: Don't clear sharedSyncTimer - other components may still need it
      // NOTE: Don't destroy doc - it's shared across component lifecycles
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
