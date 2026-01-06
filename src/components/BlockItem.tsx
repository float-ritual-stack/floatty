import { Show, createMemo, createEffect } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { useCursor } from '../hooks/useCursor';
import { navigateToPage } from '../hooks/useBacklinkNavigation';
import { findHandler, executeBlock } from '../lib/executor';
import { getActionForEvent, isMac } from '../lib/keybinds';
import { parseAllInlineTokens, hasWikilinkPatterns } from '../lib/inlineParser';
import { BlockDisplay } from './BlockDisplay';
import { setCursorAtOffset } from '../lib/cursorUtils'; // For merge cursor restore (runs outside block)
import { isDailyBlock, executeDailyBlock } from '../lib/dailyExecutor';
import { DailyView, DailyErrorView } from './views/DailyView';
import type { DailyNoteData } from '../lib/dailyExecutor';

interface BlockItemProps {
  id: string;
  paneId: string;
  depth: number;
  focusedBlockId: string | null;
  onFocus: (id: string) => void;
  // FLO-74: Multi-select
  isBlockSelected?: (id: string) => boolean;
  onSelect?: (id: string, mode: 'set' | 'toggle' | 'range' | 'anchor') => void;
  selectionAnchor?: string | null;
  getVisibleBlockIds?: () => string[];
}

export function BlockItem(props: BlockItemProps) {
  const { blockStore, paneStore } = useWorkspace();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock, findFocusAfterDelete } = useBlockOperations();
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

  // TODO: AUTO-EXECUTE for external blocks (API/CRDT sync)
  // Pattern documented in docs/BLOCK_TYPE_PATTERNS.md
  // Needs: track locally-modified blocks to distinguish from external
  // For now: Enter-to-execute only

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
        // Cmd+Enter: Navigate wikilink OR toggle zoom
        e.preventDefault();

        // Check if cursor is inside a [[wikilink]] - navigate instead of zoom
        const wikilinkTarget = getWikilinkAtCursor();
        if (wikilinkTarget) {
          console.log('[Wikilink] Keyboard nav to:', wikilinkTarget);
          const result = navigateToPage(wikilinkTarget, props.paneId, false);
          // Focus first child of page
          if (result.success && result.focusTargetId) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => props.onFocus(result.focusTargetId!));
            });
          }
          return;
        }

        // No wikilink at cursor - normal zoom behavior
        const currentZoom = paneStore.getZoomedRootId(props.paneId);

        if (currentZoom === props.id) {
          // Already zoomed into this block - zoom out
          paneStore.setZoomedRoot(props.paneId, null);
          return;
        }

        // Zoom into this block's subtree
        // Auto-create child if block has none (avoids stuck-on-empty-block bug)
        if (block()!.childIds.length === 0) {
          const newChildId = store.createBlockInside(props.id);
          paneStore.setZoomedRoot(props.paneId, props.id);
          if (newChildId) {
            // Double rAF: first for zoom render, second to focus after child mounts
            requestAnimationFrame(() => {
              requestAnimationFrame(() => props.onFocus(newChildId));
            });
          }
        } else {
          paneStore.setZoomedRoot(props.paneId, props.id);
        }
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
        // Cmd+Backspace: Delete block and subtree, focus parent (for better undo context)
        e.preventDefault();
        const focusTarget = findFocusAfterDelete(props.id, props.paneId);
        store.deleteBlock(props.id);
        if (focusTarget) props.onFocus(focusTarget);
        return;
      }

      // FLO-75: Block movement via Cmd+Up/Down
      case 'moveBlockUp': {
        e.preventDefault();
        store.moveBlockUp(props.id);
        // Double rAF: first for Y.Doc update, second for SolidJS DOM reconciliation
        requestAnimationFrame(() => {
          requestAnimationFrame(() => contentRef?.focus());
        });
        return;
      }

      case 'moveBlockDown': {
        e.preventDefault();
        store.moveBlockDown(props.id);
        // Double rAF: first for Y.Doc update, second for SolidJS DOM reconciliation
        requestAnimationFrame(() => {
          requestAnimationFrame(() => contentRef?.focus());
        });
        return;
      }
    }

    // Non-action keybinds (navigation, editing)
    if (e.key === 'ArrowUp') {
      // FLO-74: Shift+Arrow always extends block selection (bypass cursor check)
      // Plain navigation: only exit block if cursor is at absolute start
      const shouldNavigate = e.shiftKey || cursor.isAtStart();

      if (shouldNavigate) {
        e.preventDefault();
        const prev = findPrevVisibleBlock(props.id, props.paneId);
        if (prev) {
          if (e.shiftKey && props.onSelect) {
            if (!props.selectionAnchor) {
              // First Shift+Arrow: select current, set anchor, move focus only
              props.onSelect(props.id, 'anchor');
              props.onFocus(prev);
              return;
            }
            // Subsequent: extend range to include THIS block, then move focus
            props.onSelect(props.id, 'range');
            props.onFocus(prev);
            return;
          } else if (props.onSelect) {
            // Plain navigation clears selection
            props.onSelect(prev, 'set');
          }
          props.onFocus(prev);
        }
      }
      // No preventDefault = browser handles internal line navigation
    } else if (e.key === 'ArrowDown') {
      // FLO-74: Shift+Arrow always extends block selection (bypass cursor check)
      // Plain navigation: only exit block if cursor is at absolute end
      const shouldNavigate = e.shiftKey || cursor.isAtEnd();

      if (shouldNavigate) {
        e.preventDefault();

        const next = findNextVisibleBlock(props.id, props.paneId);
        if (next) {
          if (e.shiftKey && props.onSelect) {
            if (!props.selectionAnchor) {
              // First Shift+Arrow: select current, set anchor, move focus only
              props.onSelect(props.id, 'anchor');
              props.onFocus(next);
              return;
            }
            // Subsequent: extend range to include THIS block, then move focus
            props.onSelect(props.id, 'range');
            props.onFocus(next);
            return;
          } else if (props.onSelect) {
            // Plain navigation clears selection
            props.onSelect(next, 'set');
          }
          props.onFocus(next);
        } else if (!e.shiftKey) {
          // FLO-92: No next visible block - create sibling for typeable target
          // BUT don't create if current block is already empty (avoid empty spam)
          // Only on plain navigation, not Shift+Arrow
          const currentContent = block()?.content || '';
          if (currentContent === '') return;

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

        // Daily:: blocks: execute via dedicated handler (child-output pattern)
        if (isDailyBlock(content)) {
          e.preventDefault();
          executeDailyBlock(props.id, content, {
            createBlockInside: store.createBlockInside,
            updateContent: store.updateBlockContent,
            setBlockOutput: store.setBlockOutput,
            setBlockStatus: store.setBlockStatus,
            deleteBlock: store.deleteBlock,
            getBlock: (id) => store.blocks[id],
          });
          return;
        }

        // Other executable blocks (sh::, ai::, etc.)
        const handler = findHandler(content);

        if (handler) {
          e.preventDefault();
          executeBlock(props.id, content, {
            createBlockInside: store.createBlockInside,
            createBlockInsideAtTop: store.createBlockInsideAtTop,
            updateBlockContent: store.updateBlockContent,
            deleteBlock: store.deleteBlock,
            paneId: props.paneId,
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
          // FLO-61: After indent, ensure new parent is expanded in this pane
          // indentBlock sets block.collapsed=false on Y.Doc, but paneStore may have override
          requestAnimationFrame(() => {
            const updatedBlock = store.blocks[props.id];
            if (updatedBlock?.parentId) {
              paneStore.setCollapsed(props.paneId, updatedBlock.parentId, false);
            }
          });
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
      // CRITICAL: Use cursor.isAtStart() for robust start detection (handles edge cases)
      // Also check isCollapsed - if text is selected (Cmd+A), let browser handle delete
      const isAtStart = cursor.isAtStart() && cursor.isSelectionCollapsed();

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

  // [[Wikilink]] click handler - navigate to page
  // Cmd+Click → horizontal split, Cmd+Shift+Click → vertical split
  const handleWikilinkClick = (target: string, e: MouseEvent) => {
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const splitDirection = modKey
      ? (e.shiftKey ? 'vertical' : 'horizontal')
      : 'none';
    console.log('[Wikilink] Click:', { target, modKey, shiftKey: e.shiftKey, splitDirection });
    const result = navigateToPage(target, props.paneId, splitDirection);
    if (!result.success) {
      console.warn('[BlockItem] Wikilink navigation failed:', result.error);
    } else {
      console.log('[Wikilink] Navigation result:', result);
      // Focus first child of page (or newly created empty child)
      if (result.focusTargetId) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => props.onFocus(result.focusTargetId!));
        });
      }
    }
  };

  // Find wikilink at cursor position (for keyboard navigation)
  const getWikilinkAtCursor = (): string | null => {
    const content = block()?.content || '';
    if (!hasWikilinkPatterns(content)) return null;

    const cursorOffset = cursor.getOffset();
    const tokens = parseAllInlineTokens(content);

    for (const token of tokens) {
      if (token.type === 'wikilink' && token.target) {
        // Check if cursor is within this wikilink's range
        if (cursorOffset >= token.start && cursorOffset <= token.end) {
          return token.target;
        }
      }
    }
    return null;
  };

  return (
    <div class="block-wrapper">
      <div
        class="block-item"
        role="option"
        aria-selected={props.isBlockSelected?.(props.id) || false}
        classList={{ 'block-focused': isFocused(), 'block-selected': props.isBlockSelected?.(props.id) }}
        onClick={(e: MouseEvent) => {
          // FLO-74: Handle selection modifiers
          if (props.onSelect) {
            if (e.shiftKey) {
              props.onSelect(props.id, 'range');
            } else if (e.metaKey || e.ctrlKey) {
              props.onSelect(props.id, 'toggle');
            } else {
              props.onSelect(props.id, 'set');
            }
          }
          props.onFocus(props.id);
        }}
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
          {/* PICKER BLOCK: special rendering with terminal container */}
          <Show when={block()?.type === 'picker'}>
            <div class="picker-block">
              <div class="picker-label">{block()?.content || 'picker::'}</div>
              <div class="picker-terminal" data-block-id={props.id} data-pane-id={props.paneId} />
            </div>
          </Show>

          {/* DAILY OUTPUT VIEW: replaces normal content when outputType is daily-* */}
          <Show when={block()?.outputType === 'daily-view' || block()?.outputType === 'daily-error'}>
            <div class="daily-output">
              <Show when={block()?.outputStatus === 'running'}>
                <div class="daily-running">
                  <span class="daily-running-spinner">◐</span>
                  <span class="daily-running-text">Extracting...</span>
                </div>
              </Show>
              <Show when={block()?.outputType === 'daily-view' && block()?.outputStatus === 'complete'}>
                <DailyView data={block()!.output as DailyNoteData} />
              </Show>
              <Show when={block()?.outputType === 'daily-error' && block()?.outputStatus !== 'running'}>
                <DailyErrorView error={(block()!.output as { error: string }).error} />
              </Show>
            </div>
          </Show>

          {/* REGULAR BLOCK: display + edit layers (hidden when daily output) */}
          <Show when={block()?.type !== 'picker' && !block()?.outputType?.startsWith('daily-')}>
            {/* DISPLAY LAYER: styled inline tokens (pointer-events: none) */}
            <BlockDisplay content={block()?.content || ''} onWikilinkClick={handleWikilinkClick} />

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
          </Show>
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
                  isBlockSelected={props.isBlockSelected}
                  onSelect={props.onSelect}
                  selectionAnchor={props.selectionAnchor}
                  getVisibleBlockIds={props.getVisibleBlockIds}
                />
              );
            }}
          </Key>
        </div>
      </Show>
    </div>
  );
};