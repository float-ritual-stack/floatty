/**
 * usePaneHints - Manages Vimium-style hint mode for pane navigation
 *
 * This hook handles:
 * 1. Global keyboard listener when hint mode is active
 * 2. Processing letter input to select panes
 * 3. Executing the pending link navigation after pane selection
 *
 * Architecture:
 * - Global event listener captures keystrokes during hint mode
 * - ESC cancels hint mode
 * - Letter keys select the pane with matching hint
 * - After selection, navigates to the pending wikilink in that pane
 */

import { onMount, onCleanup } from 'solid-js';
import { layoutStore } from './useLayoutStore';
import { paneStore } from './usePaneStore';
import { navigateToWikilink } from './backlinkNavigation';
import type { Block } from '../lib/blockTypes';

interface UsePaneHintsOptions {
  blockStore: {
    blocks: Record<string, Block>;
    rootIds: string[];
    createBlockAfterWithContent: (afterId: string, content: string) => string;
  };
}

/**
 * Hook to handle hint mode keyboard interactions.
 * Call this from the main app component to enable global hint mode handling.
 */
export function usePaneHints(options: UsePaneHintsOptions) {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (!layoutStore.isHintModeActive()) return;

    // ESC cancels hint mode
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      layoutStore.exitHintMode();
      return;
    }

    // Single letter keys select panes
    if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();

      const paneId = layoutStore.getPaneByHint(e.key);
      if (paneId) {
        const hintState = layoutStore.getHintModeState();
        const { pendingLinkTarget } = hintState;

        // Exit hint mode first
        layoutStore.exitHintMode();

        // Navigate to the link in the selected pane
        if (pendingLinkTarget) {
          navigateToWikilink(pendingLinkTarget, paneId, {
            blockStore: options.blockStore,
            paneStore,
          });
        }
      }
    }
  };

  onMount(() => {
    // Use capture phase to intercept before other handlers
    window.addEventListener('keydown', handleKeyDown, true);
  });

  onCleanup(() => {
    window.removeEventListener('keydown', handleKeyDown, true);
  });

  return {
    /**
     * Trigger hint mode for link navigation.
     * Called when Alt+Click or Cmd+Shift+Enter on a wikilink.
     *
     * @param tabId - Current tab ID
     * @param linkTarget - The wikilink target to navigate to
     * @param sourcePaneId - The pane where the link was clicked
     */
    triggerHintMode: (tabId: string, linkTarget: string, sourcePaneId: string) => {
      layoutStore.enterHintMode(tabId, linkTarget, sourcePaneId);
    },

    /**
     * Cancel hint mode without navigation.
     */
    cancelHintMode: () => {
      layoutStore.exitHintMode();
    },

    /**
     * Check if hint mode is currently active.
     */
    isActive: () => layoutStore.isHintModeActive(),
  };
}
