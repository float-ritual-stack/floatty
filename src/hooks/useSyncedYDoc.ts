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
const WS_RECONNECT_DELAY = 2000;

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
  // Already connected or connecting
  if (sharedWebSocket?.readyState === WebSocket.OPEN ||
      sharedWebSocket?.readyState === WebSocket.CONNECTING) {
    return;
  }

  // Get server URL from httpClient config
  const serverUrl = (window as any).__FLOATTY_SERVER_URL__ as string | undefined;
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
      // Force flush any pending HTTP updates to ensure server has our latest state
      // before we start receiving broadcasts. This prevents the "phantom data loss"
      // scenario where local edits made during disconnect appear to vanish.
      if (sharedPendingUpdates.length > 0) {
        console.log('[WS] Flushing', sharedPendingUpdates.length, 'pending updates on reconnect');
        // Clear any existing timer and flush immediately
        if (sharedSyncTimer) {
          clearTimeout(sharedSyncTimer);
          sharedSyncTimer = null;
        }
        // Use a microtask to ensure flush happens after connection is fully established
        queueMicrotask(async () => {
          await forceFlushOnReconnect();
        });
      }
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
      // Reconnect after delay
      if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
      wsReconnectTimer = window.setTimeout(connectWebSocket, WS_RECONNECT_DELAY);
    };

    sharedWebSocket.onerror = (error) => {
      console.error('[WS] Error:', error);
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
              // Keep the backup in case user wants to try again
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

          // Initialize UndoManager for blocks map (after initial load)
          if (!sharedUndoManager) {
            const blocksMap = doc.getMap('blocks');
            sharedUndoManager = new Y.UndoManager(blocksMap, {
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
