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
import { registry, executeHandler, createHookBlockStore } from '../lib/handlers';
import { setCursorAtOffset } from '../lib/cursorUtils';
import type { CursorState } from './useCursor';
import type { BlockStoreInterface, PaneStoreInterface } from '../context/WorkspaceContext';
import type { Block } from '../lib/blockTypes';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface BlockInputDependencies {
  // Block data - use getter to stay reactive when props change
  // (critical for zoomed root BlockItem where props.id changes on zoom)
  getBlockId: () => string;
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
  findFocusAfterDelete: (id: string, paneId: string) => string | null;

  // Callbacks
  onFocus: (id: string) => void;

  // Content sync
  flushContentUpdate: () => void;

  // Selection (optional - for multi-select support)
  onSelect?: (id: string, mode: 'set' | 'toggle' | 'range' | 'anchor') => void;
  selectionAnchor?: string | null;

  // Wikilink navigation (optional - for Cmd+Enter on [[links]])
  getWikilinkAtCursor?: () => string | null;
  navigateToPage?: (target: string, paneId: string) => { success: boolean; focusTargetId?: string };

  // Autocomplete gate (FLO-376)
  isAutocompleteOpen?: () => boolean;

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
  | { type: 'zoom_in_wikilink'; target: string }  // Cmd+Enter on [[wikilink]]
  | { type: 'toggle_collapse' }
  | { type: 'delete_block'; prevId: string | null }
  | { type: 'move_block_up' }   // FLO-75: Cmd+Up
  | { type: 'move_block_down' } // FLO-75: Cmd+Down
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
    findFocusAfterDelete: () => string | null;
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
      // Use findFocusAfterDelete which respects zoom boundaries
      return { type: 'delete_block', prevId: deps.findFocusAfterDelete() };

    case 'moveBlockUp':
      return { type: 'move_block_up' };

    case 'moveBlockDown':
      return { type: 'move_block_down' };
  }

  // Non-action keybinds
  if (key === 'ArrowUp') {
    // Shift+Arrow: always do block selection regardless of cursor position.
    // DESIGN DECISION: Outliner block selection wins over in-block text selection.
    // Multi-line blocks lose Shift+Arrow text selection — use mouse drag instead.
    if (shiftKey) {
      const prevId = deps.findPrevId();
      if (!prevId) return { type: 'none' };  // At first block — can't extend selection up
      return { type: 'navigate_up_with_selection', prevId };
    }
    // Plain ArrowUp: only navigate at content boundary
    if (cursorAtStart) {
      const prevId = deps.findPrevId();
      return { type: 'navigate_up', prevId };
    }
    return { type: 'none' };
  }

  if (key === 'ArrowDown') {
    // Shift+Arrow: always do block selection regardless of cursor position.
    if (shiftKey) {
      const nextId = deps.findNextId();
      if (nextId) {
        return { type: 'navigate_down_with_selection', nextId };
      }
      return { type: 'none' };
    }
    // Plain ArrowDown: only navigate at content boundary
    if (cursorAtEnd) {
      const nextId = deps.findNextId();
      if (nextId) {
        return { type: 'navigate_down', nextId };
      }
      // FLO-92: No next block exists - create trailing sibling for typeable target
      // BUT don't create if current block is already empty (avoid empty spam)
      if (deps.content !== '') {
        const targetParent = zoomedRootId ?? block.parentId;
        return { type: 'create_trailing_block', parentId: targetParent };
      }
    }
    return { type: 'none' };
  }

  if (key === 'Enter' && !shiftKey) {
    const content = block.content;
    const handler = registry.findHandler(content);

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
    // Only protect from merge if children are COLLAPSED (hidden from user)
    // If expanded, user can see children - allow merge and lift them
    const hasHiddenChildren = block.childIds.length > 0 && deps.isCollapsed;
    if (atStartWithSelection && !hasHiddenChildren) {
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

    // FLO-376: Defense-in-depth gate — BlockItem's handleKeyDownWithAutocomplete
    // intercepts these keys before this function is called, but guard here too
    // in case the call path changes in a future refactor.
    if (deps.isAutocompleteOpen?.()) {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        return;
      }
    }

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
        findPrevId: () => deps.findPrevVisibleBlock(deps.getBlockId(), deps.paneId),
        findNextId: () => deps.findNextVisibleBlock(deps.getBlockId(), deps.paneId),
        findFocusAfterDelete: () => deps.findFocusAfterDelete(deps.getBlockId(), deps.paneId),
        content: block.content,
      }
    );

    // Execute the determined action
    switch (keyAction.type) {
      case 'none':
        // ArrowDown/Up in trailing/leading newline regions: browser can't navigate
        // past the last bare <br> to (root, childCount). Let browser try first,
        // then exit block if cursor didn't actually move.
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && block.content) {
          const cursorOffset = deps.cursor.getOffset();
          const isTrailingNewlines = e.key === 'ArrowDown'
            && cursorOffset < block.content.length
            && /^\n+$/.test(block.content.slice(cursorOffset));
          const isLeadingNewlines = e.key === 'ArrowUp'
            && cursorOffset > 0
            && /^\n+$/.test(block.content.slice(0, cursorOffset));

          if (isTrailingNewlines || isLeadingNewlines) {
            const offsetBefore = cursorOffset;
            // Don't preventDefault — let browser try to navigate
            requestAnimationFrame(() => {
              const offsetAfter = deps.cursor.getOffset();
              if (offsetAfter === offsetBefore) {
                // Browser couldn't move — exit block
                if (e.key === 'ArrowDown') {
                  const nextId = deps.findNextVisibleBlock(deps.getBlockId(), deps.paneId);
                  if (nextId) {
                    if (deps.onSelect) deps.onSelect(nextId, 'set');
                    paneStore.setFocusCursorHint(deps.paneId, 'start');
                    deps.onFocus(nextId);
                  }
                } else {
                  const prevId = deps.findPrevVisibleBlock(deps.getBlockId(), deps.paneId);
                  if (prevId) {
                    if (deps.onSelect) deps.onSelect(prevId, 'set');
                    paneStore.setFocusCursorHint(deps.paneId, 'end');
                    deps.onFocus(prevId);
                  }
                }
              }
            });
          }
        }
        return;

      case 'zoom_out': {
        e.preventDefault();
        // FLO-180: Zoom out to roots, then push destination (standard browser model)
        paneStore.setZoomedRoot(deps.paneId, null);
        paneStore.pushNavigation(deps.paneId, null, deps.getBlockId());
        return;
      }

      case 'zoom_in': {
        e.preventDefault();

        // Check if cursor is inside a [[wikilink]] - navigate instead of zoom
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

        // No wikilink - toggle zoom behavior
        const currentZoom = paneStore.getZoomedRootId(deps.paneId);
        if (currentZoom === deps.getBlockId()) {
          // Already zoomed into this block - zoom out
          // FLO-180: Zoom out, then push destination (standard browser model)
          paneStore.setZoomedRoot(deps.paneId, null);
          paneStore.pushNavigation(deps.paneId, null, deps.getBlockId());
          return;
        }

        // Zoom into this block's subtree
        if (block.childIds.length === 0) {
          const newChildId = store.createBlockInside(deps.getBlockId());
          paneStore.setZoomedRoot(deps.paneId, deps.getBlockId());
          // FLO-180: Push destination AFTER zoom (standard browser model)
          paneStore.pushNavigation(deps.paneId, deps.getBlockId(), deps.getBlockId());
          if (newChildId) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => deps.onFocus(newChildId));
            });
          }
        } else {
          paneStore.setZoomedRoot(deps.paneId, deps.getBlockId());
          // FLO-180: Push destination AFTER zoom (standard browser model)
          paneStore.pushNavigation(deps.paneId, deps.getBlockId(), deps.getBlockId());
        }
        return;
      }

      case 'toggle_collapse':
        e.preventDefault();
        paneStore.toggleCollapsed(deps.paneId, deps.getBlockId(), deps.getBlock()?.collapsed || false);
        return;

      case 'delete_block':
        e.preventDefault();
        store.deleteBlock(deps.getBlockId());
        if (keyAction.prevId) deps.onFocus(keyAction.prevId);
        return;

      case 'move_block_up': {
        e.preventDefault();
        store.moveBlockUp(deps.getBlockId());
        // Double rAF: first for Y.Doc update, second for SolidJS DOM reconciliation
        const contentRef = deps.getContentRef();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => contentRef?.focus({ preventScroll: true }));
        });
        return;
      }

      case 'move_block_down': {
        e.preventDefault();
        store.moveBlockDown(deps.getBlockId());
        // Double rAF: first for Y.Doc update, second for SolidJS DOM reconciliation
        const contentRef = deps.getContentRef();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => contentRef?.focus({ preventScroll: true }));
        });
        return;
      }

      case 'navigate_up':
        e.preventDefault();
        if (keyAction.prevId) {
          // Plain navigation clears selection
          if (deps.onSelect) deps.onSelect(keyAction.prevId, 'set');
          // Coming from below → place cursor at end of target block
          deps.paneStore.setFocusCursorHint(deps.paneId, 'end');
          deps.onFocus(keyAction.prevId);
        }
        return;

      case 'navigate_down':
        e.preventDefault();
        if (keyAction.nextId) {
          // Plain navigation clears selection
          if (deps.onSelect) deps.onSelect(keyAction.nextId, 'set');
          // Coming from above → place cursor at start of target block
          deps.paneStore.setFocusCursorHint(deps.paneId, 'start');
          deps.onFocus(keyAction.nextId);
        }
        return;

      case 'navigate_up_with_selection':
        e.preventDefault();
        if (keyAction.prevId && deps.onSelect) {
          if (!deps.selectionAnchor) {
            // First Shift+Arrow: select current, set anchor, move focus only
            deps.onSelect(deps.getBlockId(), 'anchor');
          } else {
            // Subsequent: extend range to include THIS block
            deps.onSelect(deps.getBlockId(), 'range');
          }
          deps.onFocus(keyAction.prevId);
        } else if (keyAction.prevId) {
          deps.onFocus(keyAction.prevId);
        }
        return;

      case 'navigate_down_with_selection':
        e.preventDefault();
        if (keyAction.nextId && deps.onSelect) {
          if (!deps.selectionAnchor) {
            // First Shift+Arrow: select current, set anchor, move focus only
            deps.onSelect(deps.getBlockId(), 'anchor');
          } else {
            // Subsequent: extend range to include THIS block
            deps.onSelect(deps.getBlockId(), 'range');
          }
          deps.onFocus(keyAction.nextId);
        } else if (keyAction.nextId) {
          deps.onFocus(keyAction.nextId);
        }
        return;

      case 'create_trailing_block': {
        // FLO-92: Create block when at tree end (respects zoom scope)
        e.preventDefault();
        const targetParent = keyAction.parentId;
        // If targeting a specific parent (zoom context), create as last child
        // Otherwise fall back to creating sibling of current block
        const newId = targetParent
          ? store.createBlockInside(targetParent)
          : store.createBlockAfter(deps.getBlockId());
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'execute_block': {
        e.preventDefault();
        // Flush pending content before execute (debounced updates can race with store operations)
        deps.flushContentUpdate();
        const handler = registry.findHandler(block.content);
        if (handler) {
          // Create hook-compatible block store adapter (with zoom scope)
          const hookStore = createHookBlockStore(
            store.getBlock,
            store.blocks,
            store.rootIds,
            paneStore.getZoomedRootId(deps.paneId)
          );

          // Execute through hook-aware executor
          executeHandler(handler, deps.getBlockId(), block.content, {
            createBlockInside: store.createBlockInside,
            createBlockInsideAtTop: store.createBlockInsideAtTop,
            createBlockAfter: store.createBlockAfter,
            updateBlockContent: store.updateBlockContent,
            updateBlockContentFromExecutor: store.updateBlockContentFromExecutor,
            deleteBlock: store.deleteBlock,
            setBlockOutput: store.setBlockOutput,
            setBlockStatus: store.setBlockStatus,
            getBlock: store.getBlock,
            getParentId: (id) => store.getBlock(id)?.parentId ?? undefined,
            getChildren: (id) => store.getBlock(id)?.childIds ?? [],
            rootIds: store.rootIds,
            paneId: deps.paneId,
            focusBlock: deps.onFocus,
            // FLO-322: Batch block creation for bulk output
            batchCreateBlocksInside: store.batchCreateBlocksInside,
            batchCreateBlocksInsideAtTop: store.batchCreateBlocksInsideAtTop,
          }, hookStore).catch(err => {
            console.error('[useBlockInput] Handler execution failed:', err);
          });
        }
        return;
      }

      case 'create_block_before': {
        e.preventDefault();
        const newId = store.createBlockBefore(deps.getBlockId());
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'create_block_inside': {
        e.preventDefault();
        const newId = store.createBlockInsideAtTop(deps.getBlockId());
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'split_block': {
        e.preventDefault();
        // Flush pending content before split (debounced updates can race with store operations)
        deps.flushContentUpdate();
        const newId = store.splitBlock(deps.getBlockId(), keyAction.offset);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'split_to_child': {
        e.preventDefault();
        // Flush pending content before split (debounced updates can race with store operations)
        deps.flushContentUpdate();
        const newId = store.splitBlockToFirstChild(deps.getBlockId(), keyAction.offset);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'indent':
        e.preventDefault();
        store.indentBlock(deps.getBlockId());
        // FLO-61: After indent, ensure new parent is expanded in this pane
        requestAnimationFrame(() => {
          const updatedBlock = store.blocks[deps.getBlockId()];
          if (updatedBlock?.parentId) {
            deps.paneStore.setCollapsed(deps.paneId, updatedBlock.parentId, false);
          }
        });
        return;

      case 'outdent':
        e.preventDefault();
        store.outdentBlock(deps.getBlockId());
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
          // Use innerText for reading - textContent ignores <div>/<br>, losing line breaks
          const text = contentRef.innerText || '';
          const pos = deps.cursor.getOffset();
          const lineStart = text.lastIndexOf('\n', pos - 1) + 1;

          let spaces = 0;
          while (lineStart + spaces < text.length && text[lineStart + spaces] === ' ') {
            spaces++;
          }

          const toRemove = Math.min(spaces, 2);
          if (toRemove > 0) {
            const newText = text.slice(0, lineStart) + text.slice(lineStart + toRemove);
            contentRef.innerText = newText;
            store.updateBlockContent(deps.getBlockId(), newText);
            deps.cursor.setOffset(Math.max(lineStart, pos - toRemove));
          }
        }
        return;
      }

      case 'merge_with_previous': {
        e.preventDefault();
        // Flush pending content before merge (debounced updates can race with store operations)
        deps.flushContentUpdate();
        const prevBlock = store.blocks[keyAction.prevId];
        if (prevBlock) {
          const oldContent = block.content;
          const prevContentLength = prevBlock.content.length;
          const childrenToLift = [...block.childIds];  // Copy before mutation

          // FIX 1: Focus BEFORE mutations (optimistic - UI feels instant)
          deps.onFocus(keyAction.prevId);

          // If block has children, lift them to be siblings after merged block
          // This preserves the subtree when merging expanded blocks
          if (childrenToLift.length > 0) {
            store.liftChildrenToSiblings(deps.getBlockId(), keyAction.prevId);
          }

          // Mutations: merge content with newline separator and delete (now childless) block
          const separator = (prevBlock.content && oldContent) ? '\n' : '';
          store.updateBlockContent(keyAction.prevId, prevBlock.content + separator + oldContent);
          store.deleteBlock(deps.getBlockId());

          // FIX 2: Use queueMicrotask chain (not rAF)
          // 1st microtask: Y.Doc transaction batches
          // 2nd microtask: SolidJS effects propagate
          queueMicrotask(() => {
            queueMicrotask(() => {
              // Use document.activeElement (focus already moved via onFocus)
              // FIX 3: Use innerText for comparison (preserves newlines from <div>/<br>)
              const el = document.activeElement as HTMLElement;
              if (el) {
                setCursorAtOffset(el, prevContentLength);
              }
            });
          });
        }
        return;
      }
    }
  };

  return { handleKeyDown };
}
