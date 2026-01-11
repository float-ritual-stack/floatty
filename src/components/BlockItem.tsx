import { Show, createMemo, createEffect, createSignal, onCleanup } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { useCursor } from '../hooks/useCursor';
import { navigateToPage, findTabIdByPaneId } from '../hooks/useBacklinkNavigation';
import { layoutStore } from '../hooks/useLayoutStore';
import { getActionForEvent, isMac } from '../lib/keybinds';
import { parseAllInlineTokens, hasWikilinkPatterns } from '../lib/inlineParser';
import { BlockDisplay } from './BlockDisplay';
import { setCursorAtOffset } from '../lib/cursorUtils'; // For merge cursor restore (runs outside block)
import { registry, type DailyNoteData } from '../lib/handlers';
import { handleStructuredPaste } from '../lib/pasteHandler';
import { DailyView, DailyErrorView } from './views/DailyView';

// Debounce delay for Y.Doc updates (ms)
// Keeps typing responsive while reducing sync overhead
const UPDATE_DEBOUNCE_MS = 150;

/**
 * Creates a debounced function with flush and cancel capabilities.
 * - Immediate DOM updates happen outside this (contentEditable handles it)
 * - Only Y.Doc/store updates are debounced
 */
function createDebouncedUpdater<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number
): { debounced: (...args: Args) => void; flush: () => void; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  const debounced = (...args: Args) => {
    pendingArgs = args;
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      if (pendingArgs) {
        fn(...pendingArgs);
        pendingArgs = null;
      }
      timeoutId = null;
    }, delay);
  };

  const flush = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (pendingArgs) {
      fn(...pendingArgs);
      pendingArgs = null;
    }
  };

  const cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    pendingArgs = null;
  };

  return { debounced, flush, cancel };
}

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

  // Capture ID once at component creation - prevents reactive tracking issues
  // when used in DOM attributes (SolidJS quirk with data-* attributes)
  const blockId = props.id;

  const block = createMemo(() => store.blocks[props.id]);
  const isFocused = createMemo(() => props.focusedBlockId === props.id);
  const isCollapsed = createMemo(() => paneStore.isCollapsed(props.paneId, props.id, block()?.collapsed || false));
  let contentRef: HTMLDivElement | undefined;

  // Local display content - updated immediately on input for responsive overlay
  // Store content is debounced (150ms), but overlay needs to track DOM immediately
  const [displayContent, setDisplayContent] = createSignal(block()?.content || '');

  // IME composition state - prevents debounced updates during CJK character composition
  // Without this, incomplete characters would be synced to Y.Doc mid-composition
  const [isComposing, setIsComposing] = createSignal(false);

  // Cursor abstraction - enables mocking in tests
  const cursor = useCursor(() => contentRef);

  // Debounced Y.Doc updates - DOM stays immediate via contentEditable
  // Flush on blur, cancel on unmount
  const { debounced: debouncedUpdateContent, flush: flushContentUpdate, cancel: cancelContentUpdate } =
    createDebouncedUpdater((id: string, content: string) => {
      store.updateBlockContent(id, content);
    }, UPDATE_DEBOUNCE_MS);

  // Cleanup: flush pending edits on unmount (don't discard user's work)
  onCleanup(() => {
    flushContentUpdate();
  });

  // Handle focus changes from props
  // NOTE: Don't steal focus from block selection mode (when outliner container is focused)
  createEffect((prevFrameId: number | undefined) => {
    // Cancel any pending focus from previous effect run
    if (prevFrameId) cancelAnimationFrame(prevFrameId);

    if (isFocused() && contentRef) {
      const frameId = requestAnimationFrame(() => {
        // If outliner container has focus (block selection mode), don't steal it
        const activeEl = document.activeElement;
        const isBlockSelectionMode = activeEl?.classList.contains('outliner-container');
        if (!isBlockSelectionMode) {
          contentRef?.focus();
        }
      });
      return frameId; // Pass to next effect run for cleanup
    }
    return undefined;
  });

  // TODO: AUTO-EXECUTE for external blocks (API/CRDT sync)
  // Pattern documented in docs/BLOCK_TYPE_PATTERNS.md
  // Needs: track locally-modified blocks to distinguish from external
  // For now: Enter-to-execute only

  // Sync content from store to DOM and displayContent signal
  // Origin-aware gate:
  //   - Not focused → always sync (split pane, unfocused blocks)
  //   - Focused + user origin → skip (don't echo typing back, causes cursor jump)
  //   - Focused + non-user origin → sync (undo, redo, remote are authoritative)
  // NOTE: Use innerText for comparison (preserves newlines from <div>/<br> elements)
  createEffect(() => {
    const currentBlock = block();
    if (contentRef && currentBlock) {
      const domContent = contentRef.innerText;
      const storeContent = currentBlock.content;
      const isFocusedNow = document.activeElement === contentRef;

      // Check if this update is from user's own typing (should skip when focused)
      // UndoManager sets its own instance as origin, not 'user'
      const origin = store.lastUpdateOrigin;
      const isUserOrigin = origin === 'user';

      // Gate: sync if not focused, OR if focused but not from user typing
      // This gate applies to BOTH displayContent and DOM sync
      // When focused + user origin: handleInput already updated displayContent immediately
      const shouldSync = !isFocusedNow || !isUserOrigin;

      if (shouldSync) {
        // Sync displayContent for overlay
        if (displayContent() !== storeContent) {
          setDisplayContent(storeContent);
        }

        // Sync DOM
        if (domContent !== storeContent) {
          contentRef.innerText = storeContent;
        }
      }
    }
  });

  // CRITICAL: Sync DOM when focus leaves (catches splits where store updated while focused)
  const handleBlur = () => {
    // Flush any pending debounced content updates to Y.Doc before blur completes
    // This ensures the store has the final content when focus leaves
    flushContentUpdate();

    const currentBlock = block();
    if (contentRef && currentBlock) {
      if (contentRef.innerText !== currentBlock.content) {
        contentRef.innerText = currentBlock.content;
      }
    }
  };

  // FLO-62, FLO-128: Smart paste with markdown structure parsing
  const handlePaste = (e: ClipboardEvent) => {
    // Get plain text only (fixes FLO-62: rich text causing duplicates)
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    // Try structured paste (FLO-128: structure like sh:: cat output)
    const result = handleStructuredPaste(props.id, text, {
      getBlock: (id) => store.blocks[id],
      createBlockAfter: store.createBlockAfter,
      createBlockInside: store.createBlockInside,
      updateBlockContent: store.updateBlockContent,
    });

    if (result.handled) {
      e.preventDefault();
      // Focus last inserted block after DOM settles
      if (result.focusId) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            props.onFocus(result.focusId!);
          });
        });
      }
    }
    // If not handled, browser does default plain text paste
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
          const result = navigateToPage(wikilinkTarget, props.paneId, 'none');
          // Focus first child of page (in current pane)
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
      // FLO-145: Shift+Arrow only navigates at boundary (not mid-block)
      // This allows browser to handle text selection within block
      const shouldNavigate = cursor.isAtStart();

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
      // FLO-145: Shift+Arrow only navigates at boundary (not mid-block)
      // This allows browser to handle text selection within block
      const shouldNavigate = cursor.isAtEnd();

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

      // Plain Enter on executable blocks = execute via handler registry
      if (block()) {
        const content = block()!.content;
        const handler = registry.findHandler(content);

        if (handler) {
          e.preventDefault();
          handler.execute(props.id, content, {
            createBlockInside: store.createBlockInside,
            createBlockInsideAtTop: store.createBlockInsideAtTop,
            updateBlockContent: store.updateBlockContent,
            deleteBlock: store.deleteBlock,
            setBlockOutput: store.setBlockOutput,
            setBlockStatus: store.setBlockStatus,
            getBlock: (id) => store.blocks[id],
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
            // Use innerText for reading - textContent ignores <div>/<br>, losing line breaks
            const text = contentRef.innerText || '';
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
              contentRef.innerText = newText;
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
    const content = target.innerText || '';

    // Update display content IMMEDIATELY for responsive overlay
    // (overlay reads from displayContent signal, not debounced store)
    setDisplayContent(content);

    // Skip Y.Doc update during IME composition (CJK input)
    // Incomplete characters would cause sync issues and cursor jumps
    // The final character will sync when composition ends
    if (isComposing()) return;

    // DOM is already updated by contentEditable (immediate feedback)
    // Debounce Y.Doc/store update to reduce sync overhead
    // Cursor/selection remain live (not affected by this debounce)
    debouncedUpdateContent(props.id, content);

    // FLO-136: Typing pins ephemeral panes (user is engaging with content)
    const tabId = findTabIdByPaneId(props.paneId);
    if (tabId) {
      layoutStore.pinPane(tabId, props.paneId);
    }
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
  // Cmd+Click → permanent horizontal split, Cmd+Shift+Click → permanent vertical split
  // Opt+Click → ephemeral horizontal split, Shift+Opt+Click → ephemeral vertical split (FLO-136)
  const handleWikilinkClick = (target: string, e: MouseEvent) => {
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const optKey = e.altKey;

    let splitDirection: 'none' | 'horizontal' | 'vertical' = 'none';
    let ephemeral = false;

    if (optKey) {
      // Opt+Click = ephemeral split (preview mode)
      splitDirection = e.shiftKey ? 'vertical' : 'horizontal';
      ephemeral = true;
    } else if (modKey) {
      // Cmd+Click = permanent split (existing behavior)
      splitDirection = e.shiftKey ? 'vertical' : 'horizontal';
    }

    const result = navigateToPage(target, props.paneId, splitDirection, ephemeral);
    if (!result.success) {
      console.warn('[BlockItem] Wikilink navigation failed:', result.error);
    } else {
      // FLO-135: Focus in the CORRECT pane (new split, not source)
      if (result.focusTargetId && result.targetPaneId) {
        // Set focus on the target pane directly (not via source pane's callback)
        paneStore.setFocusedBlockId(result.targetPaneId, result.focusTargetId);

        // Also set active pane so keyboard focus follows
        const tabId = findTabIdByPaneId(result.targetPaneId);
        if (tabId) {
          layoutStore.setActivePaneId(tabId, result.targetPaneId);
        }

        // If navigating within current pane, still call onFocus for DOM focus
        if (result.targetPaneId === props.paneId) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => props.onFocus(result.focusTargetId!));
          });
        }
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
        data-block-id={blockId}
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
              <Show when={block()?.outputStatus === 'running' || block()?.outputStatus === 'pending'}>
                <div class="daily-running">
                  <span class="daily-running-spinner">◐</span>
                  <span class="daily-running-text">Extracting...</span>
                </div>
              </Show>
              <Show when={block()?.outputType === 'daily-view' && block()?.outputStatus === 'complete'}>
                <DailyView data={block()!.output as DailyNoteData} />
              </Show>
              <Show when={block()?.outputType === 'daily-error' && block()?.outputStatus !== 'running' && block()?.outputStatus !== 'pending'}>
                <DailyErrorView error={(block()!.output as { error: string }).error} />
              </Show>
            </div>
          </Show>

          {/* REGULAR BLOCK: display + edit layers (hidden when daily output) */}
          <Show when={block()?.type !== 'picker' && !block()?.outputType?.startsWith('daily-')}>
            {/* DISPLAY LAYER: styled inline tokens (pointer-events: none) */}
            {/* Uses displayContent (immediate) instead of store content (150ms debounced) */}
            <BlockDisplay content={displayContent()} onWikilinkClick={handleWikilinkClick} />

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
              onPaste={handlePaste}
              onFocus={() => props.onFocus(props.id)}
              onBlur={handleBlur}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={(e) => {
                setIsComposing(false);
                // Trigger final update after composition completes
                // The IME has committed the final character(s)
                handleInput(e as unknown as InputEvent);
              }}
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