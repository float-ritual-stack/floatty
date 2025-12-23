/**
 * useSyncedYDoc - Bridge between Rust (yrs) and Frontend (yjs)
 *
 * Handles:
 * - Loading initial state from Rust on mount
 * - Observing local Y.Doc changes and syncing to Rust
 * - Applying updates from Rust to local Y.Doc
 */

import { onMount, onCleanup, createSignal } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import * as Y from 'yjs';

// ═══════════════════════════════════════════════════════════════
// BASE64 UTILITIES
// ═══════════════════════════════════════════════════════════════

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
}

export function useSyncedYDoc(
  options: UseSyncedYDocOptions = {}
): UseSyncedYDocReturn {
  const { syncDebounce = 50 } = options;

  const doc = new Y.Doc();
  const [isLoaded, setIsLoaded] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Track whether we're currently applying an update from Rust
  let isApplyingRemote = false;

  // Debounce timer for syncing
  let syncTimer: number | null = null;

  // Sync local changes to Rust
  const syncToRust = async () => {
    if (isApplyingRemote) return;

    try {
      const update = Y.encodeStateAsUpdate(doc);
      const updateB64 = bytesToBase64(update);
      await invoke('apply_update', { updateB64 });
    } catch (err) {
      console.error('Failed to sync to Rust:', err);
      setError(String(err));
    }
  };

  // Debounced sync
  const debouncedSync = () => {
    if (syncTimer) {
      clearTimeout(syncTimer);
    }
    syncTimer = window.setTimeout(syncToRust, syncDebounce);
  };

  // Force sync (bypass debounce)
  const forceSync = async () => {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    await syncToRust();
  };

  onMount(() => {
    async function loadInitialState() {
      try {
        const stateB64 = await invoke<string>('get_initial_state');
        if (stateB64) {
          const stateBytes = base64ToBytes(stateB64);

          isApplyingRemote = true;
          Y.applyUpdate(doc, stateBytes);
          isApplyingRemote = false;
        }

        setIsLoaded(true);
      } catch (err) {
        console.error('Failed to load initial state:', err);
        setError(String(err));
      }
    }

    // Observe all changes
    const updateHandler = (_update: Uint8Array, origin: unknown) => {
      // Don't sync back changes that came from Rust
      if (origin === 'remote' || isApplyingRemote) return;
      debouncedSync();
    };

    doc.on('update', updateHandler);
    loadInitialState();

    onCleanup(() => {
      doc.off('update', updateHandler);
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      doc.destroy();
    });
  });

  return {
    doc,
    isLoaded,
    error,
    forceSync,
  };
}
