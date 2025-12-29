import { Show, createMemo, createEffect } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { useCursor } from '../hooks/useCursor';
import { findHandler, executeBlock } from '../lib/executor';
import { getActionForEvent } from '../lib/keybinds';
import { BlockDisplay } from './BlockDisplay';
import { setCursorAtOffset } from '../lib/cursorUtils'; // For merge cursor restore (runs outside block)

interface BlockItemProps {
  id: string;
  paneId: string;
  depth: number;
  focusedBlockId: string | null;
  onFocus: (id: string) => void;
}

export function BlockItem(props: BlockItemProps) {
  const { blockStore, paneStore } = useWorkspace();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock } = useBlockOperations();
  const block = createMemo(() => store.blocks[props.id]);
  const isFocused = createMemo(() => props.focusedBlockId === props.id);
  const isCollapsed = createMemo(() => paneStore.isCollapsed(props.paneId, props.id, block()?.collapsed || false));
  let contentRef: HTMLDivElement | undefined;

  // Cursor abstraction - enables mocking in tests
  const cursor = useCursor(() => contentRef);

  // Handle focus changes from props
  createEffect(() => {
    if (isFocused() && contentRef) {
      requestAnimationFrame(() => {
        contentRef?.focus();
      });
    }
  });

  // Sync content from store to DOM, but respect focus to prevent cursor jumps
  // NOTE: Use innerText for comparison (preserves newlines from <div>/<br> elements)
  createEffect(() => {
    const currentBlock = block();
    if (contentRef && currentBlock) {
      const domContent = contentRef.innerText;
      const storeContent = currentBlock.content;
      const isFocusedNow = document.activeElement === contentRef;

      if (domContent !== storeContent && !isFocusedNow) {
        contentRef.innerText = storeContent;
      }
    }
  });

  // CRITICAL: Sync DOM when focus leaves (catches splits where store updated while focused)
  const handleBlur = () => {
    const currentBlock = block();
    if (contentRef && currentBlock) {
      if (contentRef.innerText !== currentBlock.content) {
        contentRef.innerText = currentBlock.content;
      }
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!block()) return;

    // Check centralized keybind system first for block-level actions
    const action = getActionForEvent(e);

    switch (action) {
      case 'zoomOutBlock': {
        // Escape: zoom out if currently zoomed
        const zoomedRoot = paneStore.getZoomedRootId(props.paneId);
        if (zoomedRoot) {
          e.preventDefault();
          paneStore.setZoomedRoot(props.paneId, null);
          return;
        }
        break; // Not zoomed - let Escape propagate naturally (blur, etc.)
      }

      case 'zoomInBlock': {
        // Cmd+Enter: Always zoom into block's subtree
        e.preventDefault();
        // Auto-create child if block has none (avoids stuck-on-empty-block bug)
        if (block()!.childIds.length === 0) {
          const newChildId = store.createBlockInside(props.id);
          if (newChildId) {
            // Focus the new child after zoom
            requestAnimationFrame(() => props.onFocus(newChildId));
          }
        }
        paneStore.setZoomedRoot(props.paneId, props.id);
        return;
      }

      case 'collapseBlock': {
        // Cmd+. to toggle collapse
        e.preventDefault();
        const currentBlock = block();
        const hasChildren = currentBlock?.childIds && currentBlock.childIds.length > 0;
        if (hasChildren) {
          paneStore.toggleCollapsed(props.paneId, props.id);
        }
        return;
      }

      case 'deleteBlock': {
        // Cmd+Backspace: Delete block and subtree
        e.preventDefault();
        const prevId = findPrevVisibleBlock(props.id, props.paneId);
        store.deleteBlock(props.id);
        if (prevId) props.onFocus(prevId);
        return;
      }
    }

    // Non-action keybinds (navigation, editing)
    if (e.key === 'ArrowUp') {
      // Only exit block if cursor is at absolute start of content
      // Otherwise let browser handle multi-line navigation within block
      if (cursor.isAtStart()) {
        e.preventDefault();
        const prev = findPrevVisibleBlock(props.id, props.paneId);
        if (prev) props.onFocus(prev);
      }
      // No preventDefault = browser handles internal line navigation
    } else if (e.key === 'ArrowDown') {
      // Only exit block if cursor is at absolute end of content
      // Otherwise let browser handle multi-line navigation within block
      if (cursor.isAtEnd()) {
        e.preventDefault();
        const next = findNextVisibleBlock(props.id, props.paneId);
        if (next) {
          props.onFocus(next);
        } else {
          // FLO-92: No next block - create trailing sibling for typeable target
          const newId = store.createBlockAfter(props.id);
          if (newId) props.onFocus(newId);
        }
      }
      // No preventDefault = browser handles internal line navigation
    } else if (e.key === 'Enter' && !e.shiftKey) {
      // NOTE: Cmd+Enter (zoomInBlock) is handled above via getActionForEvent()

      // Plain Enter on executable blocks = execute (unified handler)
      if (block()) {
        const content = block()!.content;
        const handler = findHandler(content);

        if (handler) {
          e.preventDefault();
          executeBlock(props.id, content, {
            createBlockInside: store.createBlockInside,
            createBlockInsideAtTop: store.createBlockInsideAtTop,
            updateBlockContent: store.updateBlockContent,
            deleteBlock: store.deleteBlock,
          });
          return;
        }
      }

      e.preventDefault();

      // CRITICAL: Use absolute offset, not anchorOffset (which is text-node-relative)
      const offset = cursor.getOffset();
      const currentContent = block()?.content || '';
      const hasChildren = block()?.childIds && block()!.childIds.length > 0;
      const atEnd = offset >= currentContent.length;
      const atStart = offset === 0;

      // At START of block with content → create sibling BEFORE (not split)
      if (atStart && currentContent.length > 0) {
        const newId = store.createBlockBefore(props.id);
        if (newId) props.onFocus(newId);
        return;
      }

      // At end of block with EXPANDED children → create first child (continue under heading)
      // COLLAPSED blocks with children → fall through to sibling behavior
      if (atEnd && hasChildren && !isCollapsed()) {
        const newId = store.createBlockInsideAtTop(props.id);
        if (newId) props.onFocus(newId);
        return;
      }

      // Middle split: behavior depends on expanded/collapsed state
      // EXPANDED with children → split content becomes first child (nest inside)
      // COLLAPSED or no children → normal split (sibling after)
      const blockIsCollapsed = isCollapsed();
      const shouldNestSplit = hasChildren && !blockIsCollapsed;

      const newId = shouldNestSplit
        ? store.splitBlockToFirstChild(props.id, offset)
        : store.splitBlock(props.id, offset);

      if (newId) {
        // Trust the store - it updates old block's content to slice(0, offset)
        // Reactive effect syncs DOM when focus moves (guard at line 44)
        props.onFocus(newId);
      }
    } else if (e.key === 'Tab') {
      // FIRST: prevent browser default (Shift+Tab can collapse content otherwise)
      e.preventDefault();

      // Use absolute block start (0,0), not just line start
      const atAbsoluteStart = cursor.isAtStart();

      if (atAbsoluteStart) {
        // At absolute block start: Tab/Shift+Tab controls tree structure
        if (e.shiftKey) {
          store.outdentBlock(props.id);
        } else {
          store.indentBlock(props.id);
        }
      } else {
        // Anywhere else: Tab/Shift+Tab works on LINE content (inline indentation)
        if (e.shiftKey) {
          // Shift+Tab: remove up to 2 leading spaces from current line
          if (contentRef) {
            const text = contentRef.textContent || '';
            const pos = cursor.getOffset();

            // Find line start (look backwards for newline)
            const lineStart = text.lastIndexOf('\n', pos - 1) + 1;

            // Count leading spaces on this line
            let spaces = 0;
            while (lineStart + spaces < text.length && text[lineStart + spaces] === ' ') {
              spaces++;
            }

            // Remove up to 2 spaces
            const toRemove = Math.min(spaces, 2);
            if (toRemove > 0) {
              const newText = text.slice(0, lineStart) + text.slice(lineStart + toRemove);
              contentRef.textContent = newText;
              store.updateBlockContent(props.id, newText);

              // Restore cursor position using proper utility
              const newPos = Math.max(lineStart, pos - toRemove);
              cursor.setOffset(newPos);
            }
          }
        } else {
          // Tab: insert 2 spaces
          document.execCommand('insertText', false, '  ');
        }
      }
      // NOTE: Cmd+. (collapseBlock) handled above via getActionForEvent()
      // NOTE: Cmd+Backspace (deleteBlock) handled above via getActionForEvent()
    } else if (e.key === 'Backspace') {
      // CRITICAL: Use absolute offset for multi-line content
      // Also check isCollapsed - if text is selected (Cmd+A), let browser handle delete
      const isAtStart = cursor.isSelectionCollapsed() && cursor.getOffset() === 0;

      if (isAtStart) {
          // Only merge if no children to avoid deleting subtree accidentally
          if (block()?.childIds.length) {
             return;
          }

          // Merge with previous block
          const prevId = findPrevVisibleBlock(props.id, props.paneId);
          if (prevId) {
             const prevBlock = store.blocks[prevId];
             if (prevBlock) {
                e.preventDefault();
                const oldContent = block()?.content || '';
                const prevContentLength = prevBlock.content.length;
                const prevContent = prevBlock.content;
                
                // Update previous block content
                store.updateBlockContent(prevId, prevContent + oldContent);
                
                // Delete current block
                store.deleteBlock(props.id);
                
                // Focus previous block
                props.onFocus(prevId);
                
                // Restore cursor position using proper utility
                requestAnimationFrame(() => {
                   const el = document.activeElement as HTMLElement;
                   if (el && el.textContent === prevContent + oldContent) {
                      setCursorAtOffset(el, prevContentLength);
                   }
                });
             }
          }
      }
    }
  };

  const handleInput = (e: InputEvent) => {
    const target = e.target as HTMLDivElement;
    // CRITICAL: Use innerText, not textContent!
    // textContent ignores <div> and <br> elements, losing line breaks.
    // innerText respects visual line breaks and converts them to \n.
    store.updateBlockContent(props.id, target.innerText || '');
  };

  const bulletClass = () => {
    const type = block()?.type;
    if (!type) return '';
    return `block-bullet-${type}`;
  };

  const contentClass = () => {
    const type = block()?.type;
    if (!type) return '';
    return `block-content-${type}`;
  };

  const bulletChar = () => {
    const hasChildren = block()?.childIds && block()!.childIds.length > 0;
    if (hasChildren) {
      return isCollapsed() ? '▸' : '▾';
    }
    return '•';
  };

  return (
    <div class="block-wrapper">
      <div 
        class="block-item" 
        classList={{ 'block-focused': isFocused() }}
        onClick={() => props.onFocus(props.id)}
      >
        <div
          class={`block-bullet ${bulletClass()}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            paneStore.toggleCollapsed(props.paneId, props.id);
          }}
        >
          {bulletChar()}
        </div>

        <div class={`block-content-wrapper ${contentClass()}`}>
          {/* DISPLAY LAYER: styled inline tokens (pointer-events: none) */}
          <BlockDisplay content={block()?.content || ''} />

          {/* EDIT LAYER: contentEditable with transparent text, visible cursor */}
          <div
            ref={contentRef}
            contentEditable
            class="block-content block-edit"
            spellcheck={false}
            autocapitalize="off"
            autocorrect="off"
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => props.onFocus(props.id)}
            onBlur={handleBlur}
          />
        </div>
      </div>

      <Show when={!isCollapsed() && block()?.childIds.length}>
        <div class="block-children">
          <Key each={block()?.childIds} by={(id) => id}>
            {(childId) => {
              const id = childId();
              return (
                <BlockItem
                  id={id}
                  paneId={props.paneId}
                  depth={props.depth + 1}
                  focusedBlockId={props.focusedBlockId}
                  onFocus={props.onFocus}
                />
              );
            }}
          </Key>
        </div>
      </Show>
    </div>
  );
};