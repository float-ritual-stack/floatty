/**
 * useEditingActions - Block creation, splitting, merging, structural ops, text editing
 *
 * Handles: toggle_collapse, delete_block, move_block_up/down,
 * create_block_before/inside, split_block, split_to_child,
 * indent, outdent, insert_spaces, remove_spaces, merge_with_previous
 */

import { setCursorAtOffset } from '../../lib/cursorUtils';
import type { BlockStoreInterface, PaneStoreInterface } from '../../context/WorkspaceContext';
import type { CursorState } from '../useCursor';
import type { Block } from '../../lib/blockTypes';
import type { KeyboardAction } from '../useBlockInput';

type EditingKeyboardAction = Extract<
  KeyboardAction,
  {
    type:
      | 'toggle_collapse'
      | 'delete_block'
      | 'move_block_up'
      | 'move_block_down'
      | 'create_block_before'
      | 'create_block_inside'
      | 'split_block'
      | 'split_to_child'
      | 'indent'
      | 'outdent'
      | 'insert_spaces'
      | 'remove_spaces'
      | 'merge_with_previous';
  }
>;

export interface EditingActionDeps {
  getBlockId: () => string;
  paneId: string;
  paneStore: Pick<PaneStoreInterface, 'toggleCollapsed' | 'setCollapsed'>;
  blockStore: Pick<
    BlockStoreInterface,
    | 'blocks'
    | 'deleteBlock'
    | 'moveBlockUp'
    | 'moveBlockDown'
    | 'createBlockBefore'
    | 'createBlockInsideAtTop'
    | 'splitBlock'
    | 'splitBlockToFirstChild'
    | 'indentBlock'
    | 'outdentBlock'
    | 'updateBlockContent'
    | 'liftChildrenToSiblings'
  >;
  getBlock: () => Block | undefined;
  cursor: CursorState;
  getContentRef: () => HTMLElement | undefined;
  flushContentUpdate: () => void;
  onFocus: (id: string) => void;
}

export function useEditingActions(deps: EditingActionDeps) {
  const handle = (e: KeyboardEvent, action: EditingKeyboardAction): void => {
    switch (action.type) {
      case 'toggle_collapse':
        e.preventDefault();
        deps.paneStore.toggleCollapsed(deps.paneId, deps.getBlockId());
        return;

      case 'delete_block':
        e.preventDefault();
        deps.blockStore.deleteBlock(deps.getBlockId());
        if (action.prevId) deps.onFocus(action.prevId);
        return;

      case 'move_block_up': {
        e.preventDefault();
        deps.blockStore.moveBlockUp(deps.getBlockId());
        // Double rAF: first for Y.Doc update, second for SolidJS DOM reconciliation
        const contentRef = deps.getContentRef();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => contentRef?.focus({ preventScroll: true }));
        });
        return;
      }

      case 'move_block_down': {
        e.preventDefault();
        deps.blockStore.moveBlockDown(deps.getBlockId());
        // Double rAF: first for Y.Doc update, second for SolidJS DOM reconciliation
        const contentRef = deps.getContentRef();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => contentRef?.focus({ preventScroll: true }));
        });
        return;
      }

      case 'create_block_before': {
        e.preventDefault();
        const newId = deps.blockStore.createBlockBefore(deps.getBlockId());
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'create_block_inside': {
        e.preventDefault();
        const newId = deps.blockStore.createBlockInsideAtTop(deps.getBlockId());
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'split_block': {
        e.preventDefault();
        // Flush pending content before split (debounced updates can race with store operations)
        deps.flushContentUpdate();
        const newId = deps.blockStore.splitBlock(deps.getBlockId(), action.offset);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'split_to_child': {
        e.preventDefault();
        // Flush pending content before split (debounced updates can race with store operations)
        deps.flushContentUpdate();
        const newId = deps.blockStore.splitBlockToFirstChild(deps.getBlockId(), action.offset);
        if (newId) deps.onFocus(newId);
        return;
      }

      case 'indent':
        e.preventDefault();
        deps.blockStore.indentBlock(deps.getBlockId());
        // FLO-61: After indent, ensure new parent is expanded in this pane
        requestAnimationFrame(() => {
          const updatedBlock = deps.blockStore.blocks[deps.getBlockId()];
          if (updatedBlock?.parentId) {
            deps.paneStore.setCollapsed(deps.paneId, updatedBlock.parentId, false);
          }
        });
        return;

      case 'outdent':
        e.preventDefault();
        deps.blockStore.outdentBlock(deps.getBlockId());
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
          // Use innerText for reading — textContent ignores <div>/<br>, losing line breaks
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
            deps.blockStore.updateBlockContent(deps.getBlockId(), newText);
            deps.cursor.setOffset(Math.max(lineStart, pos - toRemove));
          }
        }
        return;
      }

      case 'merge_with_previous': {
        e.preventDefault();
        // Flush pending content before merge (debounced updates can race with store operations)
        deps.flushContentUpdate();
        const block = deps.getBlock();
        const prevBlock = deps.blockStore.blocks[action.prevId];
        if (block && prevBlock) {
          const oldContent = block.content;
          const prevContentLength = prevBlock.content.length;
          const childrenToLift = [...block.childIds]; // Copy before mutation

          // FIX 1: Focus BEFORE mutations (optimistic - UI feels instant)
          deps.onFocus(action.prevId);

          // If block has children, lift them to be siblings after merged block
          // This preserves the subtree when merging expanded blocks
          if (childrenToLift.length > 0) {
            deps.blockStore.liftChildrenToSiblings(deps.getBlockId(), action.prevId);
          }

          // Merge content with newline separator and delete the (now childless) block
          const separator = prevBlock.content && oldContent ? '\n' : '';
          deps.blockStore.updateBlockContent(action.prevId, prevBlock.content + separator + oldContent);
          deps.blockStore.deleteBlock(deps.getBlockId());

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

  return { handle };
}
