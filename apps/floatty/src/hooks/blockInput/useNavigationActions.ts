/**
 * useNavigationActions - Block-level navigation and selection
 *
 * Handles: navigate_up, navigate_down, navigate_up/down_with_selection,
 * create_trailing_block, and the 'none' trailing-newline edge case.
 */

import type { PaneStoreInterface, BlockStoreInterface } from '../../context/WorkspaceContext';
import type { CursorState } from '../useCursor';
import type { Block } from '../../lib/blockTypes';
import type { KeyboardAction } from '../useBlockInput';

type SelectMode = 'set' | 'toggle' | 'range' | 'anchor';

type NavigationKeyboardAction = Extract<
  KeyboardAction,
  {
    type:
      | 'navigate_up'
      | 'navigate_down'
      | 'navigate_up_with_selection'
      | 'navigate_down_with_selection'
      | 'create_trailing_block';
  }
>;

export interface NavigationActionDeps {
  getBlockId: () => string;
  paneId: string;
  paneStore: Pick<PaneStoreInterface, 'setFocusCursorHint'>;
  blockStore: Pick<BlockStoreInterface, 'createBlockInside' | 'createBlockAfter'>;
  findNextVisibleBlock: (id: string, paneId: string) => string | null;
  findPrevVisibleBlock: (id: string, paneId: string) => string | null;
  onFocus: (id: string) => void;
  onSelect?: (id: string, mode: SelectMode) => void;
  selectionAnchor?: string | null;
  cursor: Pick<CursorState, 'getOffset'>;
  getBlock: () => Block | undefined;
}

export function useNavigationActions(deps: NavigationActionDeps) {
  const handle = (e: KeyboardEvent, action: NavigationKeyboardAction): void => {
    switch (action.type) {
      case 'navigate_up':
        e.preventDefault();
        if (action.prevId) {
          if (deps.onSelect) deps.onSelect(action.prevId, 'set');
          deps.paneStore.setFocusCursorHint(deps.paneId, 'end');
          deps.onFocus(action.prevId);
        }
        return;

      case 'navigate_down':
        e.preventDefault();
        if (action.nextId) {
          if (deps.onSelect) deps.onSelect(action.nextId, 'set');
          deps.paneStore.setFocusCursorHint(deps.paneId, 'start');
          deps.onFocus(action.nextId);
        }
        return;

      case 'navigate_up_with_selection':
        e.preventDefault();
        if (action.prevId && deps.onSelect) {
          if (!deps.selectionAnchor) {
            // First Shift+Arrow: select current, set anchor, move focus only
            deps.onSelect(deps.getBlockId(), 'anchor');
          } else {
            // Subsequent: extend range to include THIS block
            deps.onSelect(deps.getBlockId(), 'range');
          }
          deps.onFocus(action.prevId);
        } else if (action.prevId) {
          deps.onFocus(action.prevId);
        }
        return;

      case 'navigate_down_with_selection':
        e.preventDefault();
        if (action.nextId && deps.onSelect) {
          if (!deps.selectionAnchor) {
            // First Shift+Arrow: select current, set anchor, move focus only
            deps.onSelect(deps.getBlockId(), 'anchor');
          } else {
            // Subsequent: extend range to include THIS block
            deps.onSelect(deps.getBlockId(), 'range');
          }
          deps.onFocus(action.nextId);
        } else if (action.nextId) {
          deps.onFocus(action.nextId);
        }
        return;

      case 'create_trailing_block': {
        // FLO-92: Create block when at tree end (respects zoom scope)
        e.preventDefault();
        const targetParent = action.parentId;
        // If targeting a specific parent (zoom context), create as last child
        // Otherwise fall back to creating sibling of current block
        const newId = targetParent
          ? deps.blockStore.createBlockInside(targetParent)
          : deps.blockStore.createBlockAfter(deps.getBlockId());
        if (newId) deps.onFocus(newId);
        return;
      }
    }
  };

  /**
   * Handle the 'none' case: trailing/leading newlines where browser can't
   * navigate past the last bare <br>. Let the browser try first; if the cursor
   * doesn't move, exit the block.
   */
  const handleNone = (e: KeyboardEvent): void => {
    const block = deps.getBlock();
    if (!block?.content) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;

    const cursorOffset = deps.cursor.getOffset();

    const isTrailingNewlines =
      e.key === 'ArrowDown' &&
      cursorOffset < block.content.length &&
      /^\n+$/.test(block.content.slice(cursorOffset));

    const isLeadingNewlines =
      e.key === 'ArrowUp' &&
      cursorOffset > 0 &&
      /^\n+$/.test(block.content.slice(0, cursorOffset));

    if (!isTrailingNewlines && !isLeadingNewlines) return;

    // Don't preventDefault — let browser try to navigate
    const offsetBefore = cursorOffset;
    requestAnimationFrame(() => {
      const offsetAfter = deps.cursor.getOffset();
      if (offsetAfter !== offsetBefore) return; // Browser moved — nothing to do

      // Browser couldn't move — exit block ourselves
      if (e.key === 'ArrowDown') {
        const nextId = deps.findNextVisibleBlock(deps.getBlockId(), deps.paneId);
        if (nextId) {
          if (deps.onSelect) deps.onSelect(nextId, 'set');
          deps.paneStore.setFocusCursorHint(deps.paneId, 'start');
          deps.onFocus(nextId);
        }
      } else {
        const prevId = deps.findPrevVisibleBlock(deps.getBlockId(), deps.paneId);
        if (prevId) {
          if (deps.onSelect) deps.onSelect(prevId, 'set');
          deps.paneStore.setFocusCursorHint(deps.paneId, 'end');
          deps.onFocus(prevId);
        }
      }
    });
  };

  return { handle, handleNone };
}
