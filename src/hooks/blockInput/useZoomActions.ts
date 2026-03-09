/**
 * useZoomActions - Block zoom-in/out and wikilink page navigation
 *
 * Handles: zoom_in, zoom_out
 */

import type { BlockStoreInterface, PaneStoreInterface } from '../../context/WorkspaceContext';
import type { Block } from '../../lib/blockTypes';
import type { KeyboardAction } from '../useBlockInput';

type ZoomKeyboardAction = Extract<KeyboardAction, { type: 'zoom_in' | 'zoom_out' }>;

export interface ZoomActionDeps {
  getBlockId: () => string;
  paneId: string;
  paneStore: Pick<PaneStoreInterface, 'getZoomedRootId' | 'setZoomedRoot' | 'pushNavigation'>;
  blockStore: Pick<BlockStoreInterface, 'createBlockInside'>;
  getBlock: () => Block | undefined;
  onFocus: (id: string) => void;
  // Optional — wikilink navigation (Cmd+Enter on [[target]])
  getWikilinkAtCursor?: () => string | null;
  navigateToPage?: (target: string, paneId: string) => { success: boolean; focusTargetId?: string };
}

export function useZoomActions(deps: ZoomActionDeps) {
  const handle = (e: KeyboardEvent, action: ZoomKeyboardAction): void => {
    const block = deps.getBlock();
    if (!block) return;

    switch (action.type) {
      case 'zoom_out':
        e.preventDefault();
        // FLO-180: Zoom out to roots, then push destination (standard browser model)
        deps.paneStore.setZoomedRoot(deps.paneId, null);
        deps.paneStore.pushNavigation(deps.paneId, null, deps.getBlockId());
        return;

      case 'zoom_in': {
        e.preventDefault();

        // Check if cursor is inside a [[wikilink]] — navigate to page instead of zoom
        if (deps.getWikilinkAtCursor && deps.navigateToPage) {
          const wikilinkTarget = deps.getWikilinkAtCursor();
          if (wikilinkTarget) {
            const result = deps.navigateToPage(wikilinkTarget, deps.paneId);
            if (result.success && result.focusTargetId) {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => deps.onFocus(result.focusTargetId!));
              });
            }
            return;
          }
        }

        // Toggle zoom if already zoomed into this block
        const currentZoom = deps.paneStore.getZoomedRootId(deps.paneId);
        if (currentZoom === deps.getBlockId()) {
          // FLO-180: Zoom out, then push destination (standard browser model)
          deps.paneStore.setZoomedRoot(deps.paneId, null);
          deps.paneStore.pushNavigation(deps.paneId, null, deps.getBlockId());
          return;
        }

        // Zoom into this block's subtree — create child if empty
        if (block.childIds.length === 0) {
          const newChildId = deps.blockStore.createBlockInside(deps.getBlockId());
          deps.paneStore.setZoomedRoot(deps.paneId, deps.getBlockId());
          // FLO-180: Push destination AFTER zoom (standard browser model)
          deps.paneStore.pushNavigation(deps.paneId, deps.getBlockId(), deps.getBlockId());
          if (newChildId) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => deps.onFocus(newChildId));
            });
          }
        } else {
          deps.paneStore.setZoomedRoot(deps.paneId, deps.getBlockId());
          // FLO-180: Push destination AFTER zoom (standard browser model)
          deps.paneStore.pushNavigation(deps.paneId, deps.getBlockId(), deps.getBlockId());
        }
        return;
      }
    }
  };

  return { handle };
}
