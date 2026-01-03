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

import { onMount, onCleanup, createSignal } from 'solid-js';
import { getHttpClient, isClientInitialized } from '../lib/httpClient';
import * as Y from 'yjs';

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
    } catch (err) {
      sharedRetryCount++;
      console.error(`Failed to sync to server (attempt ${sharedRetryCount}/${MAX_RETRIES}):`, err);
      // Restore unsent updates to front of queue for retry
      sharedPendingUpdates = [...updates.slice(sentCount), ...sharedPendingUpdates];

      if (sharedRetryCount >= MAX_RETRIES) {
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
    scheduleFlush();
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
          const stateBytes = await httpClient.getState();

          if (stateBytes && stateBytes.length > 0) {
            isApplyingRemote = true;
            Y.applyUpdate(doc, stateBytes);
            isApplyingRemote = false;
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
