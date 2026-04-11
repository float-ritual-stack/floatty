/**
 * useDoorChirpListener — shared chirp CustomEvent handler for door views.
 *
 * Extracted from BlockItem.tsx + DoorPaneView.tsx (Unit 1.5, FLO-539).
 * Wraps chirpWriteHandler.ts — handles the addEventListener lifecycle,
 * verb routing (navigate → onNavigate, write verbs → handleChirpWrite),
 * and modifier key parsing for split direction.
 *
 * FM #9: Every addEventListener has matching onCleanup removeEventListener.
 * FM #5: Uses getter functions for blockId/paneId (stale closure prevention).
 */
import { createEffect, onCleanup } from 'solid-js';
import { handleChirpWrite, isChirpWriteVerb, type ChirpWriteData, type ChirpWriteStore } from '../lib/chirpWriteHandler';
import { isMac } from '../lib/keybinds';

export interface ChirpListenerDeps {
  getBlockId: () => string;
  getStore: () => ChirpWriteStore;
  onNavigate: (target: string, opts: { type?: string; splitDirection?: 'horizontal' | 'vertical' }) => void;
}

/**
 * Attaches a chirp CustomEvent listener to the element returned by `elementAccessor`.
 * Re-attaches when the element changes. Cleans up on unmount and re-run (FM #9).
 *
 * Routes:
 * - 'navigate' → onNavigate callback (with modifier key → split direction)
 * - write verbs ('create-child', 'upsert-child') → handleChirpWrite
 */
export function useDoorChirpListener(
  elementAccessor: () => HTMLElement | undefined,
  deps: ChirpListenerDeps,
): void {
  createEffect(() => {
    const el = elementAccessor();
    if (!el) return;

    const handler = ((e: CustomEvent) => {
      const msg = e.detail?.message;
      if (msg === 'navigate' && e.detail?.target) {
        e.stopPropagation();
        const sourceEvent = e.detail.sourceEvent as MouseEvent | undefined;
        const modKey = sourceEvent ? (isMac ? sourceEvent.metaKey : sourceEvent.ctrlKey) : false;
        const optKey = sourceEvent?.altKey ?? false;
        let splitDirection: 'horizontal' | 'vertical' | undefined;
        if (modKey || optKey) {
          splitDirection = sourceEvent?.shiftKey ? 'vertical' : 'horizontal';
        }
        deps.onNavigate(e.detail.target, { splitDirection });
      } else if (isChirpWriteVerb(msg)) {
        e.stopPropagation();
        handleChirpWrite(msg, e.detail?.data as ChirpWriteData, deps.getBlockId(), deps.getStore());
      }
    }) as EventListener;

    el.addEventListener('chirp', handler);
    onCleanup(() => el.removeEventListener('chirp', handler));
  });
}
