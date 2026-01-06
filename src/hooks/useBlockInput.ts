/**
 * useBlockInput - Extracted keyboard handler logic
 *
 * This hook contains the pure logic for handling keyboard events in blocks.
 * By separating logic from the component, we can:
 * 1. Test keyboard behavior without rendering
 * 2. Mock dependencies cleanly
 * 3. Reduce BlockItem.tsx complexity
 *
 * The hook returns a handleKeyDown function configured with its dependencies.
 */

import { getActionForEvent } from '../lib/keybinds';
import { findHandler, executeBlock } from '../lib/executor';
import { setCursorAtOffset } from '../lib/cursorUtils';
import type { CursorState } from './useCursor';
import type { BlockStoreInterface, PaneStoreInterface } from '../context/WorkspaceContext';
import type { Block } from '../lib/blockTypes';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface BlockInputDependencies {
  // Block data
  blockId: string;
  paneId: string;
  getBlock: () => Block | undefined;
  isCollapsed: () => boolean;

  // Stores
  blockStore: BlockStoreInterface;
  paneStore: PaneStoreInterface;

  // Cursor
  cursor: CursorState;

  // Navigation
  findNextVisibleBlock: (id: string, paneId: string) => string | null;
  findPrevVisibleBlock: (id: string, paneId: string) => string | null;

  // Callbacks
  onFocus: (id: string) => void;

  // DOM access (for line operations - should be minimized)
  getContentRef: () => HTMLElement | undefined;
}

export interface BlockInputResult {
  handleKeyDown: (e: KeyboardEvent) => void;
}

/**
 * Actions returned by keyboard handlers (for testing)
 */
export type KeyboardAction =
  | { type: 'none' }
  | { type: 'preventDefault' }
  | { type: 'zoom_out' }
  | { type: 'zoom_in' }
  | { type: 'toggle_collapse' }
  | { type: 'delete_block'; prevId: string | null }
  | { type: 'navigate_up'; prevId: string | null }
  | { type: 'navigate_down'; nextId: string | null }
  | { type: 'navigate_up_with_selection'; prevId: string | null }  // FLO-74: Shift+ArrowUp
  | { type: 'navigate_down_with_selection'; nextId: string | null }  // FLO-74: Shift+ArrowDown
  | { type: 'create_trailing_block'; parentId: string | null }  // FLO-92: Create sibling when at tree end
  | { type: 'execute_block' }
  | { type: 'create_block_before'; newId: string }
  | { type: 'create_block_inside'; newId: string }
  | { type: 'split_block'; newId: string | null; offset: number }
  | { type: 'split_to_child'; newId: string | null; offset: number }
  | { type: 'indent' }
  | { type: 'outdent' }
  | { type: 'insert_spaces' }
  | { type: 'remove_spaces'; count: number }
  | { type: 'merge_with_previous'; prevId: string };

// ═══════════════════════════════════════════════════════════════
// PURE LOGIC (for testing)
// ═══════════════════════════════════════════════════════════════

/**
 * Determine what action to take for a keyboard event
 * This is the pure logic that can be tested without DOM
 */
export function determineKeyAction(
  key: string,
  shiftKey: boolean,
  action: string | null,
  deps: {
    block: Block | undefined;
    isCollapsed: boolean;
    cursorAtStart: boolean;
    cursorAtEnd: boolean;
    cursorOffset: number;
    selectionCollapsed: boolean;
    zoomedRootId: string | null;
    findPrevId: () => string | null;
    findNextId: () => string | null;
    content: string;
  }
): KeyboardAction {
  const { block, isCollapsed, cursorAtStart, cursorAtEnd, cursorOffset, selectionCollapsed, zoomedRootId } = deps;

  if (!block) return { type: 'none' };

  // Check centralized keybind actions first
  switch (action) {
    case 'zoomOutBlock':
      if (zoomedRootId) return { type: 'zoom_out' };
      break;

    case 'zoomInBlock':
      return { type: 'zoom_in' };

    case 'collapseBlock':
      if (block.childIds && block.childIds.length > 0) {
        return { type: 'toggle_collapse' };
      }
      break;

    case 'deleteBlock':
      return { type: 'delete_block', prevId: deps.findPrevId() };
  }

  // Non-action keybinds
  if (key === 'ArrowUp') {
    // FLO-74: Shift+Arrow always navigates (bypasses cursor check for selection extension)
    const shouldNavigate = shiftKey || cursorAtStart;
    if (shouldNavigate) {
      const prevId = deps.findPrevId();
      if (shiftKey) {
        return { type: 'navigate_up_with_selection', prevId };
      }
      return { type: 'navigate_up', prevId };
    }
    return { type: 'none' };
  }

  if (key === 'ArrowDown') {
    // FLO-74: Shift+Arrow always navigates (bypasses cursor check for selection extension)
    const shouldNavigate = shiftKey || cursorAtEnd;
    if (shouldNavigate) {
      const nextId = deps.findNextId();
      if (nextId) {
        if (shiftKey) {
          return { type: 'navigate_down_with_selection', nextId };
        }
        return { type: 'navigate_down', nextId };
      }
      // FLO-92: No next block exists - create trailing sibling for typeable target
      // Only for plain navigation, not Shift+Arrow selection
      if (!shiftKey) {
        const targetParent = zoomedRootId ?? block.parentId;
        return { type: 'create_trailing_block', parentId: targetParent };
      }
    }
    return { type: 'none' };
  }

  if (key === 'Enter' && !shiftKey) {
    const content = block.content;
    const handler = findHandler(content);

    if (handler) {
      return { type: 'execute_block' };
    }

    const hasChildren = block.childIds && block.childIds.length > 0;
    const atEnd = cursorOffset >= content.length;
    const atStart = cursorOffset === 0;

    // At START of block with content → create sibling BEFORE
    if (atStart && content.length > 0) {
      return { type: 'create_block_before', newId: '' }; // newId filled by caller
    }

    // At end of block with EXPANDED children → create first child
    if (atEnd && hasChildren && !isCollapsed) {
      return { type: 'create_block_inside', newId: '' }; // newId filled by caller
    }

    // Middle split behavior
    const shouldNestSplit = hasChildren && !isCollapsed;

    return shouldNestSplit
      ? { type: 'split_to_child', newId: null, offset: cursorOffset }
      : { type: 'split_block', newId: null, offset: cursorOffset };
  }

  if (key === 'Tab') {
    if (cursorAtStart) {
      return shiftKey ? { type: 'outdent' } : { type: 'indent' };
    }
    return shiftKey ? { type: 'remove_spaces', count: 0 } : { type: 'insert_spaces' };
  }

  if (key === 'Backspace') {
    const atStartWithSelection = selectionCollapsed && cursorOffset === 0;
    if (atStartWithSelection && !block.childIds.length) {
      const prevId = deps.findPrevId();
      if (prevId) {
        return { type: 'merge_with_previous', prevId };
      }
    }
    return { type: 'none' };
  }

  return { type: 'none' };
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

/**
 * Create keyboard handler for a block
 */
export function useBlockInput(deps: BlockInputDependencies): BlockInputResult {
  const handleKeyDown = (e: KeyboardEvent) => {
    const block = deps.getBlock();
    if (!block) return;

    const action = getActionForEvent(e);
    const store = deps.blockStore;
    const paneStore = deps.paneStore;

    // Use the pure logic function to determine action
    const keyAction = determineKeyAction(
      e.key,
      e.shiftKey,
      action,
      {
        block,
        isCollapsed: deps.isCollapsed(),
        cursorAtStart: deps.cursor.isAtStart(),
        cursorAtEnd: deps.cursor.isAtEnd(),
        cursorOffset: deps.cursor.getOffset(),
        selectionCollapsed: deps.cursor.isSelectionCollapsed(),
        zoomedRootId: paneStore.getZoomedRootId(deps.paneId),
        findPrevId: () => deps.findPrevVisibleBlock(deps.blockId, deps.paneId),
        findNextId: () => deps.findNextVisibleBlock(deps.blockId, deps.paneId),
        content: block.content,
      }
    );

    // Execute the determined action
    switch (keyAction.type) {
      case 'none':
        return;

      case 'zoom_out':
        e.preventDefault();
        paneStore.setZoomedRoot(deps.paneId, null);
        return;

      case 'zoom_in':
        e.preventDefault();
        if (block.childIds.length === 0) {
          const newChildId = store.createBlockInside(deps.blockId);
          if (newChildId) {
            requestAnimationFrame(() => deps.onFocus(newChildId));
          }
        }
        paneStore.setZoomedRoot(deps.paneId, deps.blockId);
        return;

      case 'toggle_collapse':
        e.preventDefault();
        paneStore.toggleCollapsed(deps.paneId, deps.blockId);
        return;

      case 'delete_block':
        e.preventDefault();
        store.deleteBlock(deps.blockId);
        if (keyAction.prevId) deps.onFocus(keyAction.prevId);
        return;

      case 'navigate_up':
        e.preventDefault();
        if (keyAction.prevId) deps.onFocus(keyAction.prevId);
        return;

      case 'navigate_down':
        e.preventDefault();
        if (keyAction.nextId) deps.onFocus(keyAction.nextId);
        return;

      case 'navigate_up_with_selection':
        e.preventDefault();
        // Selection logic is handled by caller (BlockItem/Outliner)
        if (keyAction.prevId) deps.onFocus(keyAction.prevId);
        return;

      case 'navigate_down_with_selection':
        e.preventDefault();
        // Selection logic is handled by caller (BlockItem/Outliner)
        if (keyAction.nextId) deps.onFocus(keyAction.nextId);
        return;

      case 'create_trailing_block': {
        // FLO-92: Create sibling block after current when at tree end
        e.preventDefault();
        const newId = store.createBlockAfter(deps.blockId);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'execute_block':
        e.preventDefault();
        executeBlock(deps.blockId, block.content, {
          createBlockInside: store.createBlockInside,
          createBlockInsideAtTop: store.createBlockInsideAtTop,
          updateBlockContent: store.updateBlockContent,
          deleteBlock: store.deleteBlock,
          paneId: deps.paneId,
        });
        return;

      case 'create_block_before': {
        e.preventDefault();
        const newId = store.createBlockBefore(deps.blockId);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'create_block_inside': {
        e.preventDefault();
        const newId = store.createBlockInsideAtTop(deps.blockId);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'split_block': {
        e.preventDefault();
        const newId = store.splitBlock(deps.blockId, keyAction.offset);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'split_to_child': {
        e.preventDefault();
        const newId = store.splitBlockToFirstChild(deps.blockId, keyAction.offset);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'indent':
        e.preventDefault();
        store.indentBlock(deps.blockId);
        // FLO-61: After indent, ensure new parent is expanded in this pane
        requestAnimationFrame(() => {
          const updatedBlock = store.blocks[deps.blockId];
          if (updatedBlock?.parentId) {
            deps.paneStore.setCollapsed(deps.paneId, updatedBlock.parentId, false);
          }
        });
        return;

      case 'outdent':
        e.preventDefault();
        store.outdentBlock(deps.blockId);
        return;

      case 'insert_spaces':
        e.preventDefault();
        // Uses execCommand for undo support
        document.execCommand('insertText', false, '  ');
        return;

      case 'remove_spaces': {
        e.preventDefault();
        const contentRef = deps.getContentRef();
        if (contentRef) {
          const text = contentRef.textContent || '';
          const pos = deps.cursor.getOffset();
          const lineStart = text.lastIndexOf('\n', pos - 1) + 1;

          let spaces = 0;
          while (lineStart + spaces < text.length && text[lineStart + spaces] === ' ') {
            spaces++;
          }

          const toRemove = Math.min(spaces, 2);
          if (toRemove > 0) {
            const newText = text.slice(0, lineStart) + text.slice(lineStart + toRemove);
            contentRef.textContent = newText;
            store.updateBlockContent(deps.blockId, newText);
            deps.cursor.setOffset(Math.max(lineStart, pos - toRemove));
          }
        }
        return;
      }

      case 'merge_with_previous': {
        e.preventDefault();
        const prevBlock = store.blocks[keyAction.prevId];
        if (prevBlock) {
          const oldContent = block.content;
          const prevContentLength = prevBlock.content.length;

          store.updateBlockContent(keyAction.prevId, prevBlock.content + oldContent);
          store.deleteBlock(deps.blockId);
          deps.onFocus(keyAction.prevId);

          // Restore cursor after merge
          requestAnimationFrame(() => {
            const el = document.activeElement as HTMLElement;
            if (el && el.textContent === prevBlock.content + oldContent) {
              setCursorAtOffset(el, prevContentLength);
            }
          });
        }
        return;
      }
    }
  };

  return { handleKeyDown };
}
