import { Show, createMemo, createEffect, createSignal, onCleanup } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { useCursor } from '../hooks/useCursor';
import { useBlockInput } from '../hooks/useBlockInput';
import { getAbsoluteCursorOffset, setCursorAtOffset } from '../lib/cursorUtils';
import { navigateToPage, findTabIdByPaneId } from '../hooks/useBacklinkNavigation';
import { layoutStore } from '../hooks/useLayoutStore';
import { isMac } from '../lib/keybinds';
import { parseAllInlineTokens, hasWikilinkPatterns } from '../lib/inlineParser';
import { BlockDisplay } from './BlockDisplay';
import { type DailyNoteData, type SearchResults } from '../lib/handlers';
import { handleStructuredPaste } from '../lib/pasteHandler';
import { DailyView, DailyErrorView } from './views/DailyView';
import { SearchResultsView, SearchErrorView } from './views/SearchResultsView';
import { FilterBlockDisplay } from './views/FilterBlockDisplay';

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
  const isCollapsed = createMemo(() => {
    const b = block();
    const defaultCollapsed = b?.collapsed || false;
    return paneStore.isCollapsed(props.paneId, props.id, defaultCollapsed);
  });
  let contentRef: HTMLDivElement | undefined;

  // Local display content - updated immediately on input for responsive overlay
  // Store content is debounced (150ms), but overlay needs to track DOM immediately
  const [displayContent, setDisplayContent] = createSignal(block()?.content || '');

  // IME composition state - prevents debounced updates during CJK character composition
  // Without this, incomplete characters would be synced to Y.Doc mid-composition
  const [isComposing, setIsComposing] = createSignal(false);

  // FLO-197: Dirty flag pattern - tracks uncommitted local edits
  // Prevents content sync effect from overwriting pending debounced changes
  // when another block's change triggers effect re-evaluation
  const [hasLocalChanges, setHasLocalChanges] = createSignal(false);

  // Cursor abstraction - enables mocking in tests
  const cursor = useCursor(() => contentRef);

  // Debounced Y.Doc updates - DOM stays immediate via contentEditable
  // Flush on blur, cancel on unmount
  // FLO-197: Clear dirty flag after store commit (enables content sync for non-local changes)
  const { debounced: debouncedUpdateContent, flush: flushContentUpdate } =
    createDebouncedUpdater((id: string, content: string) => {
      store.updateBlockContent(id, content);
      setHasLocalChanges(false);
    }, UPDATE_DEBOUNCE_MS);

  // Cleanup: flush pending edits on unmount (don't discard user's work)
  onCleanup(() => {
    flushContentUpdate();
  });

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

  // Wrapper for navigateToPage that matches hook's expected signature
  const navigateToPageForHook = (target: string, paneId: string) => {
    const result = navigateToPage(target, paneId, 'none');
    return { success: result.success, focusTargetId: result.focusTargetId };
  };

  // Wire up the keyboard handler hook - single source of truth for keyboard logic
  // getBlockId is a getter to stay reactive when zoomed root changes (same component, new props)
  const { handleKeyDown } = useBlockInput({
    getBlockId: () => props.id,
    paneId: props.paneId,
    getBlock: () => block(),
    isCollapsed,
    blockStore: store,
    paneStore,
    cursor,
    findNextVisibleBlock,
    findPrevVisibleBlock,
    findFocusAfterDelete,
    onFocus: props.onFocus,
    flushContentUpdate,
    onSelect: props.onSelect,
    selectionAnchor: props.selectionAnchor,
    getWikilinkAtCursor,
    navigateToPage: navigateToPageForHook,
    getContentRef: () => contentRef,
  });

  // Handle focus changes from props
  // NOTE: Don't steal focus from block selection mode (when outliner container is focused)
  // FLO-147: Disable scroll during focus - preventScroll unreliable on contentEditable
  // Browser can queue its own scroll task AFTER our restore logic runs.
  // Solution: Lock scrolling entirely via overflow:hidden during focus transition.
  createEffect((prevFrameId: number | undefined) => {
    // Cancel any pending focus from previous effect run
    if (prevFrameId) cancelAnimationFrame(prevFrameId);

    if (isFocused() && contentRef) {
      const frameId = requestAnimationFrame(() => {
        // If outliner container has focus (block selection mode), don't steal it
        const activeEl = document.activeElement;
        const isBlockSelectionMode = activeEl?.classList.contains('outliner-container');
        if (!isBlockSelectionMode) {
          const container = contentRef?.closest('.outliner-container') as HTMLElement | null;

          if (container) {
            // Lock scroll by disabling overflow - browser can't scroll what can't scroll
            const originalOverflow = container.style.overflow;
            container.style.overflow = 'hidden';

            contentRef?.focus({ preventScroll: true });

            // Re-enable scroll after browser's focus handling completes
            // setTimeout(0) pushes past any queued scroll tasks
            setTimeout(() => {
              container.style.overflow = originalOverflow || '';
              // FLO-XXX: Scroll focused block into view if outside viewport
              // 'nearest' = minimal scroll (no movement if already visible)
              // 'instant' = no animation (rapid keyboard nav would lag with smooth)
              contentRef?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            }, 0);
          } else {
            contentRef?.focus({ preventScroll: true });
          }
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
    if (!contentRef || !currentBlock) return;

    // FLO-197: CRITICAL - Skip sync if we have uncommitted local changes
    // This prevents the race condition where:
    // 1. User types in block A, debounce pending
    // 2. Block B changes with 'remote'/'hook' origin
    // 3. This effect re-runs (triggered by global lastUpdateOrigin)
    // 4. Without this guard, DOM would be overwritten with stale store content
    if (hasLocalChanges()) return;

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

    // DEBUG: Track unexpected syncs that might cause cursor jumps
    if (shouldSync && isFocusedNow && domContent !== storeContent) {
      console.warn('[BlockItem CURSOR DEBUG] Syncing focused block!', {
        blockId: currentBlock.id,
        origin,
        isUserOrigin,
        domContent: domContent.slice(0, 50),
        storeContent: storeContent.slice(0, 50),
        activeElement: document.activeElement?.tagName,
      });
    }

    if (shouldSync) {
      // Sync displayContent for overlay
      if (displayContent() !== storeContent) {
        setDisplayContent(storeContent);
      }

      // Sync DOM - DEFENSIVE: Save/restore cursor if focused to prevent jump
      if (domContent !== storeContent) {
        // If focused, save cursor position before DOM manipulation
        const savedOffset = isFocusedNow ? getAbsoluteCursorOffset(contentRef) : -1;

        contentRef.innerText = storeContent;

        // Restore cursor position if we were focused
        // Clamp to new content length in case content shortened
        if (savedOffset >= 0) {
          const clampedOffset = Math.min(savedOffset, storeContent.length);
          setCursorAtOffset(contentRef, clampedOffset);
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
      // DEBUG: Track content mismatch on blur
      if (contentRef.innerText !== currentBlock.content) {
        console.log('[BlockItem BLUR DEBUG] Content mismatch on blur', {
          blockId: currentBlock.id,
          domContent: contentRef.innerText.slice(0, 50),
          storeContent: currentBlock.content.slice(0, 50),
        });
        contentRef.innerText = currentBlock.content;
      }
      // CRITICAL: Also sync displayContent for overlay layer
      // After block splits, the effect may not re-run (focus guard), so sync here
      if (displayContent() !== currentBlock.content) {
        setDisplayContent(currentBlock.content);
      }
    }
  };

  // FLO-62, FLO-128: Smart paste with markdown structure parsing
  const handlePaste = (e: ClipboardEvent) => {
    // Get plain text only (fixes FLO-62: rich text causing duplicates)
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    // FIX: Flush pending content before structured paste check
    // Without this, store.blocks[id] may be stale (150ms debounce)
    // and handleStructuredPaste might incorrectly think block is empty
    flushContentUpdate();

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

  /**
   * Core content update logic extracted for reuse by input and composition handlers.
   * Avoids unsafe type casting between InputEvent and CompositionEvent.
   */
  const updateContentFromDom = (target: HTMLDivElement) => {
    // CRITICAL: Use innerText, not textContent!
    // textContent ignores <div> and <br> elements, losing line breaks.
    // innerText respects visual line breaks and converts them to \n.
    const content = target.innerText || '';

    // FLO-197: Mark as dirty BEFORE any updates
    // Prevents content sync effect from overwriting pending edits
    setHasLocalChanges(true);

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

  const handleInput = (e: InputEvent) => {
    updateContentFromDom(e.target as HTMLDivElement);
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

  return (
    <div class="block-wrapper">
      <div
        class="block-item"
        data-block-id={blockId}
        role="option"
        aria-selected={props.isBlockSelected?.(props.id) || false}
        classList={{ 'block-focused': isFocused(), 'block-selected': props.isBlockSelected?.(props.id) }}
        onMouseDown={(e: MouseEvent) => {
          // Save scroll position BEFORE browser focus/scroll happens
          // This runs before onClick and before native contentEditable focus
          const container = (e.target as HTMLElement)?.closest('.outliner-container') as HTMLElement | null;
          if (container) {
            const savedScrollTop = container.scrollTop;
            // Restore after browser's focus handling completes
            requestAnimationFrame(() => {
              if (container.scrollTop !== savedScrollTop) {
                container.scrollTop = savedScrollTop;
              }
            });
          }
        }}
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
            paneStore.toggleCollapsed(props.paneId, props.id, block()?.collapsed || false);
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

          {/* SEARCH OUTPUT VIEW: replaces normal content when outputType is search-* */}
          <Show when={block()?.outputType === 'search-results' || block()?.outputType === 'search-error'}>
            <div class="search-output">
              <Show when={block()?.outputStatus === 'running' || block()?.outputStatus === 'pending'}>
                <div class="daily-running">
                  <span class="daily-running-spinner">◐</span>
                  <span class="daily-running-text">Searching...</span>
                </div>
              </Show>
              <Show when={block()?.outputType === 'search-results' && block()?.outputStatus === 'complete'}>
                <SearchResultsView data={block()!.output as SearchResults} paneId={props.paneId} />
              </Show>
              <Show when={block()?.outputType === 'search-error' && block()?.outputStatus !== 'running' && block()?.outputStatus !== 'pending'}>
                <SearchErrorView data={block()!.output as { error: string; query?: string }} />
              </Show>
            </div>
          </Show>

          {/* REGULAR BLOCK: display + edit layers (hidden when daily/search output) */}
          <Show when={block()?.type !== 'picker' && !block()?.outputType?.startsWith('daily-') && !block()?.outputType?.startsWith('search-')}>
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
                updateContentFromDom(e.target as HTMLDivElement);
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

      {/* FILTER BLOCK: live query results (rendered after children which are rules) */}
      <Show when={block()?.type === 'filter'}>
        <FilterBlockDisplay block={block()!} paneId={props.paneId} />
      </Show>
    </div>
  );
};