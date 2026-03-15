import { Show, createMemo, createEffect, createSignal, onCleanup, on, untrack } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { useCursor } from '../hooks/useCursor';
import { useBlockInput } from '../hooks/useBlockInput';
import { useBlockDrag } from '../hooks/useBlockDrag';
import { useWikilinkAutocomplete } from '../hooks/useWikilinkAutocomplete';
import { getAbsoluteCursorOffset, setCursorAtOffset } from '../lib/cursorUtils';
import { findTabIdByPaneId } from '../hooks/useBacklinkNavigation';
import { navigateToBlock, navigateToPage, handleChirpNavigate } from '../lib/navigation';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { isMac } from '../lib/keybinds';
import { resolveBlockIdPrefix, BLOCK_ID_PREFIX_RE } from '../lib/blockTypes';
import { parseAllInlineTokens, hasWikilinkPatterns, hasTablePattern, parseTableToken } from '../lib/inlineParser';
import { BlockDisplay, TableView } from './BlockDisplay';
import { WikilinkAutocomplete } from './WikilinkAutocomplete';
import { type SearchResults, type DoorEnvelope } from '../lib/handlers';
import { handleStructuredPaste } from '../lib/pasteHandler';
import { readFiles } from 'tauri-plugin-clipboard-api';
import { SearchResultsView, SearchErrorView } from './views/SearchResultsView';
import { FilterBlockDisplay } from './views/FilterBlockDisplay';
import { DoorHost, DoorExecCard } from './views/DoorHost';
import { ImgView } from './views/ImgView';
import { EvalOutput } from './EvalOutput';
import type { EvalResult } from '../lib/evalEngine';

// Debounce delay for Y.Doc updates (ms)
// Keeps typing responsive while reducing sync overhead
const UPDATE_DEBOUNCE_MS = 150;

/** Place cursor at end of contentEditable element. Used by focus effect for 'end' cursor hint. */
function placeCursorAtEnd(element: HTMLElement): void {
  try {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (err) {
    console.debug('[BlockItem] Failed to place cursor at end:', err);
  }
}

/** Place cursor at start of contentEditable element. Used by focus effect for 'start' cursor hint.
 * Explicit placement needed because focus() may restore last-known cursor position, not position 0. */
function placeCursorAtStart(element: HTMLElement): void {
  try {
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (err) {
    console.debug('[BlockItem] Failed to place cursor at start:', err);
  }
}

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
  const { blockStore, paneStore, pageNames, pageNameSet, stubPageNameSet, shortHashIndex } = useWorkspace();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock, findFocusAfterDelete } = useBlockOperations();
  const drag = useBlockDrag();

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
  // Render limit for large child lists — prevents mounting 300+ BlockItems at once.
  // Resets to 100 when block collapses so re-expand stays fast.
  const CHILD_RENDER_LIMIT = 100;
  const [childLimit, setChildLimit] = createSignal(CHILD_RENDER_LIMIT);
  createEffect(on(isCollapsed, (collapsed) => { if (collapsed) setChildLimit(CHILD_RENDER_LIMIT); }));
  createEffect(on(() => props.id, () => setChildLimit(CHILD_RENDER_LIMIT)));
  const visibleChildIds = createMemo(() => (block()?.childIds ?? []).slice(0, childLimit()));

  // FLO-472: Todo progress counter for first block in a consecutive todo group
  const todoCounter = createMemo(() => {
    const b = block();
    if (b?.type !== 'todo') return null;

    // Find parent to get siblings
    const parentId = b.parentId;
    const siblings = parentId
      ? store.blocks[parentId]?.childIds ?? []
      : store.rootIds ?? [];

    const myIdx = siblings.indexOf(props.id);
    if (myIdx < 0) return null;

    // Am I the first todo in a consecutive run?
    if (myIdx > 0) {
      const prevSibling = store.blocks[siblings[myIdx - 1]];
      if (prevSibling?.type === 'todo') return null; // not first in group
    }

    // Count consecutive todos from here
    let total = 0;
    let done = 0;
    for (let i = myIdx; i < siblings.length; i++) {
      const sib = store.blocks[siblings[i]];
      if (sib?.type !== 'todo') break;
      total++;
      if (/^- \[[xX]\] /.test(sib.content)) done++;
    }

    if (total < 2) return null; // only show for 2+ consecutive
    return { done, total };
  });

  // FLO-58: Detect table blocks for picker pattern rendering
  const isTableBlock = createMemo(() => hasTablePattern(block()?.content ?? ''));
  // FLO-58: Lift showRaw state to persist across TableView remounts
  // (remounts happen when raw editing temporarily breaks table syntax)
  const [tableShowRaw, setTableShowRaw] = createSignal(false);
  let contentRef: HTMLDivElement | undefined;
  let outputFocusRef: HTMLDivElement | undefined;
  let wrapperRef: HTMLDivElement | undefined;

  // FLO-58: When entering table raw mode, sync content to contentEditable and focus it
  // contentRef isn't reactive, so the main sync effect won't re-run when it mounts
  createEffect(() => {
    if (tableShowRaw() && isTableBlock()) {
      // Wait for contentEditable to mount
      queueMicrotask(() => {
        if (contentRef) {
          const content = block()?.content ?? '';
          contentRef.innerText = content;
          setDisplayContent(content);
          contentRef.focus();
        }
      });
    }
  });

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

  // FLO-376: Wikilink autocomplete (FLO-322: pageNames from singleton context)
  const autocomplete = useWikilinkAutocomplete(pageNames);

  // Dismiss autocomplete on scroll (anchorRect goes stale)
  createEffect(on(() => autocomplete.isOpen(), (open) => {
    if (!open) return;
    const handler = () => autocomplete.dismiss();
    // Capture phase catches scroll on any ancestor
    window.addEventListener('scroll', handler, { capture: true, passive: true });
    onCleanup(() => window.removeEventListener('scroll', handler, { capture: true }));
  }));

  // Debounced Y.Doc updates - DOM stays immediate via contentEditable
  // Flush on blur, cancel on unmount
  // FLO-197: Clear dirty flag after store commit (enables content sync for non-local changes)
  const { debounced: debouncedUpdateContent, flush: flushContentUpdate, cancel: cancelContentUpdate } =
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

  // Detect output blocks that need special keyboard handling
  const isOutputBlock = createMemo(() => {
    const ot = block()?.outputType;
    return ot?.startsWith('search-') || ot === 'door' || ot === 'img-view';
  });

  // img:: auto-render — fires when content starts with img:: AND filename has a known extension.
  // Extension-gated to prevent 404 spam while the user is still typing the filename.
  // Also strips to basename so pasted absolute paths work (e.g. /Users/evan/.floatty/__attachments/photo.jpg).
  createEffect(on(() => block()?.content, (content) => {
    if (!content) return;
    const lower = content.toLowerCase();
    if (!lower.startsWith('img::')) return;
    const rawPath = content.slice(5).trim();
    if (!rawPath) return;
    // Strip to basename — handles pasted full paths
    const filename = rawPath.replace(/.*[/\\]/g, '');
    if (!filename) return;
    // Only trigger when filename has a recognized extension (prevents 404 while mid-typing)
    if (!/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|pdf|html|htm)$/i.test(filename)) return;
    // Guard: only write if output is stale (prevents loop)
    const current = block();
    if (current?.outputType === 'img-view' && (current?.output as { filename?: string })?.filename === filename) return;
    store.setBlockOutput(props.id, { filename }, 'img-view');
  }));

  // Search results keyboard navigation state
  // Focus stays on outputFocusRef — SearchResultsView is display-only.
  // All keyboard nav handled here because moving focus to a child element
  // would trigger the focus routing effect which steals it back.
  const [searchFocusedIdx, setSearchFocusedIdx] = createSignal(-1);

  // Reset search focus when output type/status changes (prevents stale state)
  createEffect(() => {
    const ot = block()?.outputType;
    const st = block()?.outputStatus;
    if (ot !== 'search-results' || st !== 'complete') {
      setSearchFocusedIdx(-1);
    }
  });

  // Reset search focus on focus GAIN (e.g., back-navigation via Cmd+[)
  // Uses on() to fire only on false→true transition — interior nav doesn't change isFocused()
  createEffect(on(isFocused, (focused, wasFocused) => {
    if (focused && !wasFocused && isOutputBlock()) {
      setSearchFocusedIdx(-1);
    }
  }));

  // Keyboard handler for output blocks (no contentEditable → need manual nav)
  const handleOutputBlockKeyDown = (e: KeyboardEvent) => {
    const idx = searchFocusedIdx();

    // Block-level operations (work at any idx)
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    // Re-focus after DOM rearrangement — SolidJS moves nodes but browser drops focus
    const refocusAfterMove = () => {
      requestAnimationFrame(() => outputFocusRef?.focus({ preventScroll: true }));
    };

    if (modKey && e.key === 'ArrowUp') {
      e.preventDefault();
      store.moveBlockUp(props.id);
      refocusAfterMove();
      return;
    } else if (modKey && e.key === 'ArrowDown') {
      e.preventDefault();
      store.moveBlockDown(props.id);
      refocusAfterMove();
      return;
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        store.outdentBlock(props.id);
      } else {
        store.indentBlock(props.id);
      }
      refocusAfterMove();
      return;
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      // Guard: don't delete blocks with children unless explicitly selected
      const hasChildren = !!block()?.childIds?.length;
      const isSelected = props.isBlockSelected?.(props.id) ?? false;
      if (hasChildren && !isSelected) return;
      const target = findFocusAfterDelete(props.id, props.paneId);
      store.deleteBlock(props.id);
      if (target) props.onFocus(target);
      return;
    } else if (e.key === 'Escape' && block()?.outputType === 'img-view') {
      // Escape from img-view → back to edit mode (contentEditable shows, user can fix filename)
      // The auto-execute effect won't re-fire unless content actually changes.
      e.preventDefault();
      store.setBlockOutput(props.id, null, '');
      return;
    }

    // When navigating inside search results (idx >= 0)
    if (idx >= 0) {
      const data = block()?.output as SearchResults | undefined;
      const hits = data?.hits ?? [];
      if (!hits.length) { setSearchFocusedIdx(-1); return; }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (idx < hits.length - 1) {
          setSearchFocusedIdx(idx + 1);
        } else {
          // At last result — escape to next block
          setSearchFocusedIdx(-1);
          const next = findNextVisibleBlock(props.id, props.paneId);
          if (next) props.onFocus(next);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (idx > 0) {
          setSearchFocusedIdx(idx - 1);
        } else {
          // At first result — escape to prev block (symmetric with ArrowDown at last)
          setSearchFocusedIdx(-1);
          const prev = findPrevVisibleBlock(props.id, props.paneId);
          if (prev) props.onFocus(prev);
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const hit = hits[idx];
        if (hit) {
          navigateToBlock(hit.blockId, {
            paneId: props.paneId,
            highlight: true,
            originBlockId: props.id,
          });
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setSearchFocusedIdx(-1);
      }
      return;
    }

    // Block-level navigation (idx === -1, accent border shown)
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      // Enter results from the bottom (symmetric with ArrowDown entering from top)
      const ot = block()?.outputType;
      if (ot === 'search-results' && block()?.outputStatus === 'complete') {
        const data = block()?.output as SearchResults | undefined;
        if (data?.hits?.length) {
          setSearchFocusedIdx(data.hits.length - 1);
          return;
        }
      }
      const prev = findPrevVisibleBlock(props.id, props.paneId);
      if (prev) props.onFocus(prev);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      // If this is a search output block with results, enter the results list
      const ot = block()?.outputType;
      if (ot === 'search-results' && block()?.outputStatus === 'complete') {
        const data = block()?.output as SearchResults | undefined;
        if (data?.hits?.length) {
          setSearchFocusedIdx(0);
          return;
        }
      }
      const next = findNextVisibleBlock(props.id, props.paneId);
      if (next) props.onFocus(next);
    }
  };

  // Wrapper for navigateToPage that matches hook's expected signature
  const navigateToPageForHook = (target: string, paneId: string) => {
    const result = navigateToPage(target, { paneId });
    return { success: result.success };
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
    isAutocompleteOpen: autocomplete.isOpen,
    getContentRef: () => contentRef,
  });

  // FLO-376: Autocomplete selection — replaces text from [[ to cursor with [[Page Name]]
  const handleAutocompleteSelect = (pageName: string) => {
    if (!contentRef) return;

    const acState = autocomplete.state();
    if (!acState) { autocomplete.dismiss(); return; }

    // Cancel pending debounced update — it would overwrite our replacement
    // (e.g., revert [[Page Name]] back to [[pa)
    cancelContentUpdate();

    const startOffset = acState.startOffset;
    const replacement = `[[${pageName}]]`;

    // Use store content as source of truth (DOM innerText can diverge under concurrent edits)
    const storeBlock = store.getBlock(props.id);
    const content = storeBlock?.content ?? contentRef.innerText ?? '';
    const cursorOffset = getAbsoluteCursorOffset(contentRef);

    // Validate: cursor must be after [[ trigger, and [[ must still exist at expected position
    if (cursorOffset < startOffset + 2 || cursorOffset > content.length) {
      console.debug('[BlockItem] Autocomplete aborted: cursor offset out of range', {
        cursorOffset, startOffset, contentLength: content.length,
      });
      autocomplete.dismiss();
      return;
    }
    if (content.slice(startOffset, startOffset + 2) !== '[[') {
      console.debug('[BlockItem] Autocomplete aborted: [[ trigger moved (concurrent edit?)');
      autocomplete.dismiss();
      return;
    }

    // Replace from startOffset to current cursor position
    const newContent = content.slice(0, startOffset) + replacement + content.slice(cursorOffset);

    // Update DOM and store
    contentRef.innerText = newContent;
    store.updateBlockContent(props.id, newContent);
    setDisplayContent(newContent);
    setHasLocalChanges(false);

    // Position cursor after ]]
    const newCursorPos = startOffset + replacement.length;
    queueMicrotask(() => {
      if (contentRef && document.contains(contentRef)) {
        setCursorAtOffset(contentRef, newCursorPos);
      }
    });

    autocomplete.dismiss();
  };

  // FLO-376: Keyboard handler that intercepts for autocomplete when open
  const handleKeyDownWithAutocomplete = (e: KeyboardEvent) => {
    if (autocomplete.isOpen()) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        autocomplete.navigate('down');
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        autocomplete.navigate('up');
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const sel = autocomplete.getSelection();
        if (sel) {
          handleAutocompleteSelect(sel.pageName);
        } else {
          autocomplete.dismiss();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        autocomplete.dismiss();
        return;
      }
    }

    // Fall through to normal block keyboard handling
    handleKeyDown(e);
  };

  // Handle focus changes from props
  // NOTE: Don't steal focus from block selection mode (when outliner container is focused)
  // FLO-147/FLO-278: Disable scroll during focus using CSS class toggle
  // Browser can queue its own scroll task AFTER our restore logic runs.
  // Solution: Lock scrolling via CSS class (not inline style) during focus transition.
  // CSS class approach prevents race condition with RAF-based scroll preservation.
  createEffect((prevFrameId: number | undefined) => {
    // Cancel any pending focus from previous effect run
    if (prevFrameId) cancelAnimationFrame(prevFrameId);

    if (isFocused() && contentRef && !isOutputBlock()) {
      // Consume cursor hint synchronously (before RAF) so it's not stale
      const cursorHint = paneStore.consumeFocusCursorHint(props.paneId);

      const frameId = requestAnimationFrame(() => {
        // If outliner container has focus (block selection mode), don't steal it
        const activeEl = document.activeElement;
        const isBlockSelectionMode = activeEl?.classList.contains('outliner-container');
        if (!isBlockSelectionMode) {
          const container = contentRef?.closest('.outliner-container') as HTMLElement | null;

          if (container) {
            // FLO-278: Lock scroll via CSS class - cleaner than inline style
            container.classList.add('scroll-locked');

            contentRef?.focus({ preventScroll: true });

            // Place cursor based on navigation direction
            if (contentRef) {
              if (cursorHint === 'end') placeCursorAtEnd(contentRef);
              else if (cursorHint === 'start') placeCursorAtStart(contentRef);
            }

            // Re-enable scroll after browser's focus handling completes
            // setTimeout(0) pushes past any queued scroll tasks
            setTimeout(() => {
              container.classList.remove('scroll-locked');
              // FLO-XXX: Scroll focused block into view if outside viewport
              // 'nearest' = minimal scroll (no movement if already visible)
              // 'instant' = no animation (rapid keyboard nav would lag with smooth)
              contentRef?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            }, 0);
          } else {
            contentRef?.focus({ preventScroll: true });

            if (contentRef) {
              if (cursorHint === 'end') placeCursorAtEnd(contentRef);
              else if (cursorHint === 'start') placeCursorAtStart(contentRef);
            }
          }
        }
      });
      return frameId; // Pass to next effect run for cleanup
    }
    return undefined;
  });

  // Focus routing for output blocks (no contentEditable to receive focus)
  createEffect(() => {
    if (isFocused() && isOutputBlock() && outputFocusRef) {
      requestAnimationFrame(() => {
        outputFocusRef?.focus({ preventScroll: true });
        outputFocusRef?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      });
    }
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

    const origin = untrack(() => store.lastUpdateOrigin);

    // FLO-256: Authoritative origins bypass the hasLocalChanges guard
    // These origins represent state that MUST sync to DOM:
    // - 'reconnect-authority': Server state on WebSocket reconnect (server is truth)
    // - UndoManager instance: Undo/redo operations (CRDT history is truth)
    const isAuthoritative =
      origin === 'reconnect-authority' ||
      (origin && typeof origin === 'object' && 'undo' in origin);

    // FLO-197: CRITICAL - Skip sync if we have uncommitted local changes
    // UNLESS the origin is authoritative (reconnect, undo/redo)
    // This prevents the race condition where:
    // 1. User types in block A, debounce pending
    // 2. Block B changes with 'remote'/'hook' origin
    // 3. This effect re-runs (triggered by global lastUpdateOrigin)
    // 4. Without this guard, DOM would be overwritten with stale store content
    // FLO-256: With reconnect-authority, we WANT to overwrite - server is truth
    if (hasLocalChanges()) {
      if (!isAuthoritative) return;
      // Authoritative update while local changes pending:
      // Cancel debounce and clear dirty flag to prevent stale content from being flushed
      cancelContentUpdate();
      setHasLocalChanges(false);
    }

    const domContent = contentRef.innerText;
    const storeContent = currentBlock.content;
    const isFocusedNow = document.activeElement === contentRef;

    // Check if this update is from user's own typing (should skip when focused)
    // UndoManager sets its own instance as origin, not 'user'
    // NOTE: origin already captured above for authoritative check
    const isUserOrigin = origin === 'user';

    // Gate: sync if not focused, OR if focused but not from user typing
    // This gate applies to BOTH displayContent and DOM sync
    // When focused + user origin: handleInput already updated displayContent immediately
    const shouldSync = !isFocusedNow || !isUserOrigin;

    // Warn on unexpected focused-block syncs (could cause cursor jump)
    if (shouldSync && isFocusedNow && domContent !== storeContent) {
      console.warn('[BlockItem] Syncing focused block (origin:', typeof origin === 'string' ? origin : typeof origin, ')');
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

        // DEFENSIVE: Verify ref is actually in document (ghost node detection)
        if (!document.contains(contentRef)) {
          console.warn('[BlockItem] Ghost node detected - skipping DOM sync', currentBlock.id);
          return;
        }

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
    // FLO-376: Dismiss autocomplete on blur
    autocomplete.dismiss();

    // Flush any pending debounced content updates to Y.Doc before blur completes
    // This ensures the store has the final content when focus leaves
    flushContentUpdate();

    const currentBlock = block();
    if (contentRef && currentBlock) {
      // Sync DOM to store on blur (catches remote updates that arrived while focused)
      if (contentRef.innerText !== currentBlock.content) {
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

    const pasteActions = {
      getBlock: (id: string) => store.blocks[id],
      updateBlockContent: store.updateBlockContent,
      batchCreateBlocksAfter: store.batchCreateBlocksAfter,
      batchCreateBlocksInside: store.batchCreateBlocksInside,
    };

    // If no text, probe for file paths (Finder Cmd+C doesn't populate
    // clipboardData.files in Tauri WKWebView — readFiles() reads NSPasteboard directly)
    if (!text) {
      e.preventDefault();
      readFiles().then((files) => {
        if (!files || files.length === 0) return;
        const paths = files.map(p => p.includes(' ') ? `"${p}"` : p).join('\n');
        // Re-focus contentEditable before execCommand (focus may drift during async)
        if (contentRef && document.contains(contentRef) && document.activeElement !== contentRef) {
          contentRef.focus();
        }
        flushContentUpdate();
        const result = handleStructuredPaste(props.id, paths, pasteActions);
        if (result.handled && result.focusId) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              props.onFocus(result.focusId!);
            });
          });
        } else {
          document.execCommand('insertText', false, paths);
        }
      }).catch((err) => {
        // readFiles() throws on non-file clipboard (expected for image/screenshot paste)
        console.debug('[BlockItem] readFiles probe:', err);
      });
      return;
    }

    // FIX: Flush pending content before structured paste check
    // Without this, store.blocks[id] may be stale (150ms debounce)
    // and handleStructuredPaste might incorrectly think block is empty
    flushContentUpdate();

    // Try structured paste (FLO-128, FLO-322: batch transaction)
    const result = handleStructuredPaste(props.id, text, pasteActions);

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

    // FLO-376: Check for [[ autocomplete trigger
    if (contentRef) {
      const offset = getAbsoluteCursorOffset(contentRef);
      autocomplete.checkTrigger(content, offset, contentRef);
    }

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

  const hasCollapsibleOutput = createMemo(() => {
    const b = block();
    return b?.outputType === 'eval-result' && !!b?.output;
  });

  const bulletChar = () => {
    const hasChildren = block()?.childIds && block()!.childIds.length > 0;
    if (hasChildren || hasCollapsibleOutput()) {
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

    // Block-ID links: full UUID or partial hex prefix (git-sha style)
    const blockIds = Object.keys(store.blocks);
    const resolvedBlockId = resolveBlockIdPrefix(target, blockIds, shortHashIndex());
    if (resolvedBlockId) {
      // Block must exist in the outline (resolveBlockIdPrefix may return a full UUID
      // that matches the regex but the block isn't in this outline)
      if (!store.getBlock(resolvedBlockId)) {
        console.warn('[BlockItem] Wikilink block ID not in outline', { target: resolvedBlockId });
        return;
      }
      let targetPaneId = props.paneId;
      if (splitDirection === 'none') {
        const linkedPaneId = paneLinkStore.resolveLink(props.paneId);
        if (linkedPaneId) {
          // Verify linked pane is on same tab (don't navigate cross-tab)
          const sourceTab = findTabIdByPaneId(props.paneId);
          const linkedTab = findTabIdByPaneId(linkedPaneId);
          if (sourceTab && sourceTab === linkedTab) {
            targetPaneId = linkedPaneId;
          }
        }
      }
      navigateToBlock(resolvedBlockId, {
        paneId: targetPaneId,
        highlight: true,
        splitDirection: splitDirection !== 'none' ? splitDirection : undefined,
        originBlockId: props.id,
      });
      return;
    }

    // Guard: hex prefix that didn't resolve → never create a page for block ID lookalikes
    if (BLOCK_ID_PREFIX_RE.test(target)) {
      console.warn('[BlockItem] Block ID prefix did not resolve, not creating page', {
        target,
        blockCount: Object.keys(store.blocks).length,
      });
      return;
    }

    // FLO-223: Plain click + explicit pane link → navigate in linked target pane
    // Uses resolveLink (no fallback) — wikilinks only redirect when explicitly linked
    if (splitDirection === 'none') {
      const linkedPaneId = paneLinkStore.resolveLink(props.paneId);
      if (linkedPaneId) {
        // Same-tab check: don't send navigation to another tab
        const sourceTab = findTabIdByPaneId(props.paneId);
        const linkedTab = findTabIdByPaneId(linkedPaneId);
        if (sourceTab && sourceTab === linkedTab) {
          navigateToPage(target, { paneId: linkedPaneId, highlight: true, originBlockId: props.id });
          return;
        }
      }
    }

    // FLO-211: Pass current block as origin for focus restoration on back navigation
    const result = navigateToPage(target, {
      paneId: props.paneId,
      splitDirection: splitDirection === 'none' ? undefined : splitDirection,
      ephemeral,
      originBlockId: props.id,
    });
    if (!result.success) {
      console.warn('[BlockItem] Wikilink navigation failed:', result.error);
    } else {
      // FLO-135: Focus + active pane in the CORRECT pane (new split, not source)
      // navigateToPage already sets focusedBlockId via the wrapper.
      // We still need to set activePaneId so keyboard focus follows.
      if (result.targetPaneId) {
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
    <div
      ref={wrapperRef}
      class="block-wrapper"
      classList={{ 'block-full-width': paneStore.isFullWidth(props.paneId, props.id) }}
      data-depth={props.depth}
      style={{ '--block-depth': String(props.depth) }}
    >
      <div
        class="block-item"
        data-block-id={blockId}
        data-pane-id={props.paneId}
        role="option"
        aria-selected={props.isBlockSelected?.(props.id) || false}
        classList={{
          'block-focused': isFocused(),
          'block-selected': props.isBlockSelected?.(props.id),
          'block-drag-source': drag.activeDragId() === props.id,
          'block-drop-target': drag.dropTargetId() === props.id,
          'block-drop-invalid': drag.dropTargetId() === props.id && !drag.isValidDrop(),
          'has-collapsed-children': isCollapsed() && ((block()?.childIds?.length ?? 0) > 0 || hasCollapsibleOutput()),
        }}
        // FLO-278: Removed onMouseDown scroll preservation - was causing race condition
        // with focus routing's scroll lock. CSS class-based scroll lock now handles this.
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
          class="block-drag-handle"
          title="Drag block"
          aria-label="Drag block"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            drag.onHandlePointerDown(e, props.id, props.paneId);
          }}
        >
          ⋮⋮
        </div>

        <div
          class={`block-bullet ${bulletClass()}`}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            paneStore.toggleCollapsed(props.paneId, props.id, block()?.collapsed || false);
          }}
          onDblClick={(e) => {
            // FLO-473: Double-click bullet on todo blocks toggles checkbox
            const b = block();
            if (b?.type !== 'todo') return;
            e.stopPropagation();
            e.preventDefault();
            const content = b.content;
            const toggled = content.startsWith('- [x] ') || content.startsWith('- [X] ')
              ? content.replace(/^- \[[xX]\] /, '- [ ] ')
              : content.replace(/^- \[ \] /, '- [x] ');
            if (toggled !== content) {
              store.updateBlockContent(props.id, toggled);
            }
          }}
        >
          {bulletChar()}
        </div>

        {/* FLO-472: Todo progress counter */}
        <Show when={todoCounter()}>
          {(counter) => (
            <span
              class="todo-counter"
              title={`${counter().done}/${counter().total} done`}
            >
              {counter().done}/{counter().total}
            </span>
          )}
        </Show>

        {/* FLO-223: Pane link indicator on iframe-output blocks (artifact/door/eval-url) */}
        <Show when={paneLinkStore.hasPaneLink(props.paneId) && (block()?.outputType === 'eval-result' || block()?.outputType === 'door')}>
          <span
            class="block-link-indicator"
            title="Pane linked (Cmd+L to unlink)"
            onClick={(e) => {
              e.stopPropagation();
              paneLinkStore.clearPaneLink(props.paneId);
            }}
          >⇥</span>
        </Show>

        <div class={`block-content-wrapper ${contentClass()}`}>
          {/* PICKER BLOCK: special rendering with terminal container */}
          <Show when={block()?.type === 'picker'}>
            <div class="picker-block">
              <div class="picker-label">{block()?.content || 'picker::'}</div>
              <div class="picker-terminal" data-block-id={props.id} data-pane-id={props.paneId} />
            </div>
          </Show>

          {/* TABLE BLOCK: render TableView when NOT in raw mode */}
          {/* Raw mode uses the regular contentEditable below instead */}
          <Show when={isTableBlock() && !tableShowRaw()}>
            <div class="table-block-container">
              {(() => {
                const token = parseTableToken(block()?.content ?? '');
                return token ? (
                  <TableView
                    token={token}
                    blockId={props.id}
                    onUpdate={(content) => store.updateBlockContent(props.id, content)}
                    onWikilinkClick={handleWikilinkClick}
                    isFocused={isFocused()}
                    onNavigateOut={(direction) => {
                      // Navigate to prev/next block when exiting table bounds
                      const nextBlockId = direction === 'up'
                        ? findPrevVisibleBlock(props.id, props.paneId)
                        : findNextVisibleBlock(props.id, props.paneId);
                      if (nextBlockId) {
                        props.onFocus(nextBlockId);
                      }
                    }}
                    onSwitchToRaw={() => setTableShowRaw(true)}
                    tableConfig={block()?.tableConfig}
                    onTableConfigChange={(config) => store.updateTableConfig(props.id, config)}
                  />
                ) : null;
              })()}
            </div>
          </Show>

          {/* OUTPUT BLOCKS: search-* and door get a focusable wrapper for keyboard nav */}
          <Show when={isOutputBlock()}>
            <div
              ref={outputFocusRef}
              tabIndex={0}
              class="output-block-focus-target"
              onKeyDown={handleOutputBlockKeyDown}
              onFocus={() => props.onFocus(props.id)}
            >
              {/* SEARCH OUTPUT VIEW */}
              <Show when={block()?.outputType === 'search-results' || block()?.outputType === 'search-error'}>
                <div class="search-output">
                  <Show when={block()?.outputStatus === 'running' || block()?.outputStatus === 'pending'}>
                    <div class="daily-running">
                      <span class="daily-running-spinner">◐</span>
                      <span class="daily-running-text">Searching...</span>
                    </div>
                  </Show>
                  <Show when={block()?.outputType === 'search-results' && block()?.outputStatus === 'complete'}>
                    <SearchResultsView
                      data={block()!.output as SearchResults}
                      paneId={props.paneId}
                      blockId={props.id}
                      focusedIdx={searchFocusedIdx}
                    />
                  </Show>
                  <Show when={block()?.outputType === 'search-error' && block()?.outputStatus !== 'running' && block()?.outputStatus !== 'pending'}>
                    <SearchErrorView data={block()!.output as { error: string; query?: string }} />
                  </Show>
                </div>
              </Show>

              {/* DOOR OUTPUT VIEW — single branch for all doors */}
              <Show when={block()?.outputType === 'door'}>
                {(() => {
                  const envelope = block()!.output as DoorEnvelope;
                  if (!envelope || !envelope.kind) return null;
                  return envelope.kind === 'view'
                    ? <DoorHost
                        doorId={envelope.doorId}
                        data={envelope.data}
                        error={envelope.error}
                        status={block()?.outputStatus}
                        onNavigate={(target, opts) => {
                          handleChirpNavigate(target, {
                            type: opts?.type,
                            sourcePaneId: props.paneId,
                            sourceBlockId: props.id,
                            splitDirection: opts?.splitDirection,
                            originBlockId: props.id,
                          });
                        }}
                      />
                    : <DoorExecCard
                        doorId={envelope.doorId}
                        ok={envelope.ok}
                        startedAt={envelope.startedAt}
                        finishedAt={envelope.finishedAt}
                        summary={envelope.summary}
                        error={envelope.error}
                        createdBlockIds={envelope.createdBlockIds}
                      />;
                })()}
              </Show>

              {/* IMG VIEW — local attachment from __attachments/ */}
              <Show when={block()?.outputType === 'img-view'}>
                <ImgView
                  filename={(block()!.output as { filename: string })?.filename ?? ''}
                  serverUrl={window.__FLOATTY_SERVER_URL__ ?? ''}
                  apiKey={window.__FLOATTY_API_KEY__ ?? ''}
                />
              </Show>
            </div>
          </Show>

          {/* REGULAR BLOCK: display + edit layers (hidden for special block types) */}
          {/* FLO-58: Also show for table blocks in raw mode - use contentEditable for raw markdown editing */}
          <Show when={block()?.type !== 'picker' && (!isTableBlock() || tableShowRaw()) && !isOutputBlock()}>
            {/* DISPLAY LAYER: styled inline tokens (pointer-events: none) */}
            {/* Skip for table raw mode - just show contentEditable directly */}
            <Show when={!tableShowRaw()}>
              <BlockDisplay
                content={displayContent()}
                onWikilinkClick={handleWikilinkClick}
                blockId={props.id}
                onUpdateContent={(content) => store.updateBlockContent(props.id, content)}
                pageNameSet={pageNameSet()}
                stubPageNameSet={stubPageNameSet()}
              />
            </Show>

            {/* TABLE RAW MODE: wrap in container with toggle button at top-right */}
            <Show when={tableShowRaw()}>
              <div class="table-raw-container">
                <button
                  class="table-raw-toggle"
                  onClick={() => setTableShowRaw(false)}
                  title="Switch to table view"
                >
                  ⊞
                </button>
                <div
                  ref={contentRef}
                  contentEditable
                  class="block-content block-edit block-edit-raw"
                  spellcheck={false}
                  autocapitalize="off"
                  autocorrect="off"
                  onInput={handleInput}
                  onKeyDown={handleKeyDownWithAutocomplete}
                  onPaste={handlePaste}
                  onFocus={() => {
                    props.onFocus(props.id);
                  }}
                  onBlur={handleBlur}
                  onCompositionStart={() => setIsComposing(true)}
                  onCompositionEnd={(e) => {
                    setIsComposing(false);
                    updateContentFromDom(e.target as HTMLDivElement);
                  }}
                />
              </div>
            </Show>

            {/* EDIT LAYER: contentEditable with transparent text, visible cursor */}
            {/* Skip for table raw mode - handled above with container */}
            <Show when={!tableShowRaw()}>
              <div
                ref={contentRef}
                contentEditable
                class="block-content block-edit"
                spellcheck={false}
                autocapitalize="off"
                autocorrect="off"
                onInput={handleInput}
                onKeyDown={handleKeyDownWithAutocomplete}
                onPaste={handlePaste}
                onFocus={() => {
                  props.onFocus(props.id);
                }}
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
          </Show>

          {/* EVAL OUTPUT: inline result below contentEditable for eval:: blocks */}
          <Show when={block()?.outputType === 'eval-result' && block()?.output && !isCollapsed()}>
            {(() => {
              let pokeIframe: ((message: string, data?: unknown) => void) | undefined;
              return (
                <EvalOutput
                  output={block()!.output as EvalResult}
                  onChirp={(message: string, data?: unknown) => {
                    // Route navigate intents through unified chirp handler
                    if (message === 'navigate' && typeof data === 'object' && data) {
                      const nav = data as { target: string; type?: 'block' | 'page' | 'wikilink'; splitDirection?: 'horizontal' | 'vertical' };
                      const result = handleChirpNavigate(nav.target, {
                        type: nav.type,
                        sourcePaneId: props.paneId,
                        sourceBlockId: props.id,
                        splitDirection: nav.splitDirection,
                        originBlockId: props.id,
                      });
                      pokeIframe?.('ack: navigate', { success: result.success, target: nav.target, error: result.error });
                      return;
                    }
                    // Default: create child block (throttled to max 10/sec to prevent runaway iframes)
                    const now = Date.now();
                    const key = `chirp_${props.id}`;
                    const lastTime = (window as Record<string, unknown>)[key] as number | undefined;
                    if (lastTime && now - lastTime < 100) {
                      pokeIframe?.(`ack: ${message}`, { throttled: true });
                      return;
                    }
                    (window as Record<string, unknown>)[key] = now;
                    const [childId] = store.batchCreateBlocksInside(props.id, [{ content: `chirp:: ${message}` }]);
                    // Auto-poke back so the iframe knows we received it
                    pokeIframe?.(`ack: ${message}`, data);
                  }}
                  onPokeReady={(poke) => { pokeIframe = poke; }}
                />
              );
            })()}
          </Show>

          {/* FLO-376: Wikilink autocomplete popup */}
          <Show when={autocomplete.state()}>
            {(acState) => (
              <WikilinkAutocomplete
                state={acState()}
                onSelect={handleAutocompleteSelect}
                onHover={autocomplete.setSelectedIndex}
                onDismiss={autocomplete.dismiss}
              />
            )}
          </Show>
        </div>
      </div>

      <Show when={drag.showOverlayFor(props.id)}>
        <div
          class="block-drop-overlay-line"
          classList={{ invalid: !drag.isValidDrop() }}
          style={drag.overlayStyle()}
        />
      </Show>

      <Show when={!isCollapsed() && block()?.childIds.length}>
        <div class="block-children">
          <Key each={visibleChildIds()} by={(id) => id}>
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
          <Show when={(block()?.childIds.length ?? 0) > childLimit()}>
            <div
              class="block-children-more"
              onClick={() => setChildLimit(n => n + CHILD_RENDER_LIMIT)}
            >
              {(block()?.childIds.length ?? 0) - childLimit()} more...
            </div>
          </Show>
        </div>
      </Show>

      {/* FILTER BLOCK: live query results (rendered after children which are rules) */}
      <Show when={block()?.type === 'filter'}>
        <FilterBlockDisplay block={block()!} paneId={props.paneId} />
      </Show>
    </div>
  );
};
