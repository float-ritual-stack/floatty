import { Show, createMemo, createEffect, createSignal, onCleanup, on, untrack } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { useCursor } from '../hooks/useCursor';
import { useBlockInput } from '../hooks/useBlockInput';
import { useBlockDrag } from '../hooks/useBlockDrag';
import { useWikilinkAutocomplete } from '../hooks/useWikilinkAutocomplete';
import { getAbsoluteCursorOffset, setCursorAtOffset } from '../lib/cursorUtils';
import { useContentSync } from '../hooks/useContentSync';
import { useDoorChirpListener } from '../hooks/useDoorChirpListener';
import { findTabIdByPaneId } from '../hooks/useLayoutStore';
import { navigateToBlock, navigateToPage, handleChirpNavigate, resolveSameTabLink } from '../lib/navigation';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { isMac } from '../lib/keybinds';
import { resolveBlockIdPrefix, BLOCK_ID_PREFIX_RE } from '../lib/blockTypes';
import { isOutputBlock, hasCollapsibleOutput, resolveImgFilename } from '../lib/blockItemHelpers';
import { parseAllInlineTokens, hasWikilinkPatterns, hasTablePattern, parseTableToken } from '../lib/inlineParser';
import { BlockDisplay, TableView } from './BlockDisplay';
import { WikilinkAutocomplete } from './WikilinkAutocomplete';
import { handleStructuredPaste } from '../lib/pasteHandler';
import { readFiles } from 'tauri-plugin-clipboard-api';
import { FilterBlockDisplay } from './views/FilterBlockDisplay';
import { BlockOutputView } from './BlockOutputView';
import { useConfig } from '../context/ConfigContext';
import { registry, executeHandler, createHookBlockStore } from '../lib/handlers';
import { createLogger } from '../lib/logger';

const logger = createLogger('BlockItem');

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
    logger.debug(`Failed to place cursor at end: ${err}`);
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
    logger.debug(`Failed to place cursor at start: ${err}`);
  }
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
  const config = useConfig();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock, findFocusAfterDelete } = useBlockOperations();
  const drag = useBlockDrag();

  // Capture ID once at component creation - prevents reactive tracking issues
  // when used in DOM attributes (SolidJS quirk with data-* attributes)
  const blockId = props.id;

  const block = createMemo(() => store.blocks[props.id]);
  const isFocused = createMemo(() => props.focusedBlockId === props.id);
  // pages:: children default collapsed — untrack parent content read to avoid
  // N×M reactivity (265 children re-evaluating on every keystroke in parent).
  // pages:: prefix is structural, doesn't change while children are mounted.
  const isPageChild = createMemo(() => {
    const parentId = block()?.parentId;
    if (!parentId) return false;
    return untrack(() => store.blocks[parentId]?.content?.startsWith('pages::') ?? false);
  });
  const isCollapsed = createMemo(() => {
    const b = block();
    const defaultCollapsed = isPageChild() || (b?.collapsed || false);
    return paneStore.isCollapsed(props.paneId, props.id, defaultCollapsed);
  });
  // Render limit for large child lists (config-driven, 0 = no limit).
  const configLimit = createMemo(() => config()?.child_render_limit ?? 0);
  const [childLimit, setChildLimit] = createSignal(0);
  createEffect(on(configLimit, (limit) => { if (limit > 0) setChildLimit(limit); }));
  createEffect(on(isCollapsed, (collapsed) => { const l = configLimit(); if (collapsed && l > 0) setChildLimit(l); }));
  createEffect(on(() => props.id, () => { const l = configLimit(); if (l > 0) setChildLimit(l); }));
  const visibleChildIds = createMemo(() => {
    const ids = block()?.childIds ?? [];
    const limit = childLimit();
    return limit > 0 ? ids.slice(0, limit) : ids;
  });

  // FLO-58: Detect table blocks for picker pattern rendering
  const isTableBlock = createMemo(() => hasTablePattern(block()?.content ?? ''));
  // FLO-58: Lift showRaw state to persist across TableView remounts
  // (remounts happen when raw editing temporarily breaks table syntax)
  const [tableShowRaw, setTableShowRaw] = createSignal(false);

  let contentRef: HTMLDivElement | undefined;
  let outputFocusRef: HTMLDivElement | undefined;
  let renderTitleRef: HTMLDivElement | undefined;
  let wrapperRef: HTMLDivElement | undefined;
  const [inlineDoorRef, setInlineDoorRef] = createSignal<HTMLElement | undefined>(undefined);

  // Cursor abstraction - enables mocking in tests.
  // FLO-387: owns the per-element snapshot cache shared by useContentSync
  // (for invalidate() after programmatic innerText sync) and useBlockInput
  // (for the single-walk snapshot() read in determineKeyAction).
  // Declared before useContentSync so the dep can reference it directly.
  const cursor = useCursor(() => contentRef);

  // Content sync hook — handles debounced Y.Doc updates, origin-aware sync,
  // blur flush, input handling, IME composition, and dirty flag (FLO-197/FLO-256)
  const contentSync = useContentSync({
    getBlockId: () => props.id,
    getBlock: () => block(),
    getContentRef: () => contentRef,
    store,
    cursor,
    onAutocompleteCheck: (content, offset, ref) => autocomplete.checkTrigger(content, offset, ref),
    onContentChange: () => {
      const tabId = findTabIdByPaneId(props.paneId);
      if (tabId) layoutStore.pinPane(tabId, props.paneId);
    },
  });
  const {
    displayContent, setDisplayContent,
    isComposing, setIsComposing,
    hasLocalChanges, setHasLocalChanges,
    cancelContentUpdate, flushContentUpdate,
    handleInput, handleBlurSync, updateContentFromDom,
  } = contentSync;

  // render:: title toggle: show generated title instead of full prompt (Unit 1.3a)
  // Display-only — does NOT change isOutputBlock, focus, collapse, zoom, or navigation.
  const [renderShowTitle, setRenderShowTitle] = createSignal(true);

  // Does this render:: block have a valid generated title?
  const renderTitle = createMemo(() => {
    const b = block();
    if (b?.outputType !== 'door' || !b?.output) return null;
    if (!b?.content?.toLowerCase().startsWith('render::')) return null;
    const title = (b.output as { data?: { title?: string } })?.data?.title;
    if (!title || typeof title !== 'string') return null;
    const trimmed = title.trim();
    // Reject garbage: JSON blobs, excessive length
    if (trimmed.length > 120 || trimmed.startsWith('{') || trimmed.startsWith('[')) return null;
    return trimmed;
  });

  const effectiveDisplayContent = createMemo(() => {
    const title = renderTitle();
    if (!renderShowTitle() || !title) return displayContent();
    if (title.toLowerCase().startsWith('render::')) return title;
    return `render:: ${title}`;
  });

  // FLO-569: title mode — true when render:: block has valid title and title display is enabled.
  // When true: contentEditable hidden, render-title-wrapper drives height to title size.
  const isRenderTitleMode = createMemo(() => !!renderTitle() && renderShowTitle());

  // FLO-58: When entering table raw mode, sync content to contentEditable and focus it
  // contentRef isn't reactive, so the main sync effect won't re-run when it mounts
  createEffect(() => {
    if (tableShowRaw() && isTableBlock()) {
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

  // FLO-569: Same pattern — when exiting render title mode (clicking ⊞ to show raw),
  // contentEditable remounts but useContentSync won't re-run (contentRef isn't reactive)
  createEffect(() => {
    if (!renderShowTitle() && renderTitle()) {
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

  // Shared chirp listener for inline door output (FM #9: cleanup on unmount/re-run)
  useDoorChirpListener(inlineDoorRef, {
    getBlockId: () => props.id,
    getStore: () => store,
    onNavigate: (target, opts) => {
      handleChirpNavigate(target, {
        type: opts?.type,
        sourcePaneId: props.paneId,
        sourceBlockId: props.id,
        splitDirection: opts?.splitDirection,
        originBlockId: props.id,
      });
    },
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
  const isOutputBlockMemo = createMemo(() => isOutputBlock(block()));

  // img:: auto-render — fires when content starts with img:: AND filename has a known extension.
  // Parsing extracted to lib/blockItemHelpers.ts (resolveImgFilename).
  createEffect(on(() => block()?.content, (content) => {
    if (!content) return;
    const filename = resolveImgFilename(content);
    if (!filename) return;
    // Guard: only write if output is stale (prevents loop)
    const current = block();
    if (current?.outputType === 'img-view' && (current?.output as { filename?: string })?.filename === filename) return;
    store.setBlockOutput(props.id, { filename }, 'img-view');
  }));

  // Shared wikilink navigation: block-ID resolution, pane link, page fallback.
  // Used by both handleWikilinkClick (mouse) and navigateToPageForHook (Cmd+Enter).
  // Prevents the hydra: one path for "follow a [[wikilink]]", regardless of trigger.
  const navigateWikilink = (
    target: string,
    sourcePaneId: string,
    opts: { splitDirection?: 'horizontal' | 'vertical' } = {},
  ): { success: boolean; focusTargetId?: string } => {
    const { splitDirection } = opts;

    // FLO-378: Resolve pane link once at top (FM #7: at call site, not in funnel)
    // Skip resolution when splitting — new pane is the target
    const targetPaneId = splitDirection ? sourcePaneId : resolveSameTabLink(sourcePaneId);

    // Block-ID links: full UUID or partial hex prefix (git-sha style)
    const blockIds = Object.keys(store.blocks);
    const resolvedBlockId = resolveBlockIdPrefix(target, blockIds, shortHashIndex());
    if (resolvedBlockId) {
      if (!store.getBlock(resolvedBlockId)) {
        logger.warn('Wikilink block ID not in outline', { target: resolvedBlockId });
        return { success: false };
      }
      navigateToBlock(resolvedBlockId, {
        paneId: targetPaneId,
        highlight: true,
        splitDirection,
        originBlockId: props.id,
      });
      return { success: true };
    }

    // Guard: hex prefix that didn't resolve → never create a page for block ID lookalikes
    if (BLOCK_ID_PREFIX_RE.test(target)) {
      logger.warn('Block ID prefix did not resolve, not creating page', {
        target,
        blockCount: Object.keys(store.blocks).length,
      });
      return { success: false };
    }

    const result = navigateToPage(target, {
      paneId: targetPaneId,
      splitDirection,
      originBlockId: props.id,
    });

    if (!result.success) {
      logger.warn(`Wikilink navigation failed: ${result.error}`);
      return { success: false };
    }

    // FLO-135: Focus + active pane in the CORRECT pane
    if (result.targetPaneId) {
      const tabId = findTabIdByPaneId(result.targetPaneId);
      if (tabId) {
        layoutStore.setActivePaneId(tabId, result.targetPaneId);
      }
      if (result.targetPaneId === props.paneId && result.focusTargetId) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => props.onFocus(result.focusTargetId!));
        });
      }
    }

    return { success: true, focusTargetId: result.focusTargetId ?? undefined };
  };

  // Wrapper for navigateToPage that matches hook's expected signature (Cmd+Enter on [[wikilink]])
  const navigateToPageForHook = (target: string, _paneId: string) => {
    return navigateWikilink(target, props.paneId);
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
    cancelContentUpdate,
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

    // FLO-387: Sync the user's in-flight DOM content to the store BEFORE reading
    // the replacement source. Under blur-is-the-boundary, the store never holds
    // the latest typed content during a focus session — it lags behind the DOM
    // until flush/blur. Without this flush, `store.getBlock(props.id).content`
    // returns the last-committed value (often empty or stale), the validation
    // guards below detect the mismatch (cursorOffset > content.length), and the
    // autocomplete silently dismisses without inserting the wikilink.
    //
    // Same pattern as handleStructuredPaste and useEditingActions.remove_spaces:
    // "boundary writers flush first, then operate on the synchronized state."
    // The old cancelContentUpdate() call here was a no-op under blur-boundary
    // (no debounce timer exists) and is covered by the setHasLocalChanges(false)
    // at the end of this function.
    flushContentUpdate();

    const startOffset = acState.startOffset;
    const replacement = `[[${pageName}]]`;

    // Use store content as source of truth (DOM innerText can diverge under concurrent edits)
    const storeBlock = store.getBlock(props.id);
    const content = storeBlock?.content ?? contentRef.innerText ?? '';
    const cursorOffset = getAbsoluteCursorOffset(contentRef);

    // Validate: cursor must be after [[ trigger, and [[ must still exist at expected position
    if (cursorOffset < startOffset + 2 || cursorOffset > content.length) {
      logger.debug('Autocomplete aborted: cursor offset out of range', {
        cursorOffset, startOffset, contentLength: content.length,
      });
      autocomplete.dismiss();
      return;
    }
    if (content.slice(startOffset, startOffset + 2) !== '[[') {
      logger.debug('Autocomplete aborted: [[ trigger moved (concurrent edit?)');
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

    if (isFocused() && contentRef && !isOutputBlockMemo() && !isRenderTitleMode()) {
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

  // Focus routing for output blocks is handled by BlockOutputView.

  // ─── Focus routing for render:: title mode (FLO-569) ──────────────
  createEffect(() => {
    if (isFocused() && isRenderTitleMode() && renderTitleRef) {
      requestAnimationFrame(() => {
        renderTitleRef?.focus({ preventScroll: true });
        renderTitleRef?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      });
    }
  });

  // ─── Keyboard handler for render:: title mode (FLO-569) ──────────
  // Dedicated handler — can't reuse handleKeyDown because it reads cursor
  // state from contentEditable which is hidden in title mode.
  const handleRenderTitleKeyDown = (e: KeyboardEvent) => {
    cancelContentUpdate();
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    const refocusAfterMove = () => {
      requestAnimationFrame(() => renderTitleRef?.focus({ preventScroll: true }));
    };

    // Cmd+Enter → zoom into block
    if (e.key === 'Enter' && modKey) {
      e.preventDefault();
      paneStore.zoomTo(props.paneId, props.id);
      return;
    }

    // Shift+Enter → create new sibling BEFORE (matches "Enter at start" behavior:
    // new empty block appears above, render:: block stays in place)
    if (e.key === 'Enter' && e.shiftKey && !modKey) {
      e.preventDefault();
      const newId = store.createBlockBefore(props.id);
      if (newId) props.onFocus(newId);
      return;
    }

    // Enter → execute handler (same path as useBlockInput execute_block)
    if (e.key === 'Enter' && !e.shiftKey && !modKey) {
      e.preventDefault();
      const b = block();
      if (!b) return;
      const handler = registry.findHandler(b.content);
      if (handler) {
        const hookStore = createHookBlockStore(
          store.getBlock, store.blocks, store.rootIds,
          paneStore.getZoomedRootId(props.paneId)
        );
        executeHandler(handler, props.id, b.content, {
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
          paneId: props.paneId,
          focusBlock: props.onFocus,
          batchCreateBlocksAfter: store.batchCreateBlocksAfter,
          batchCreateBlocksInside: store.batchCreateBlocksInside,
          batchCreateBlocksInsideAtTop: store.batchCreateBlocksInsideAtTop,
          moveBlock: (blockId, targetParentId, targetIndex) =>
            store.moveBlock(blockId, targetParentId, targetIndex, { origin: 'user' }),
        }, hookStore).catch(err => {
          logger.error('Handler execution failed (render title)', { err });
        });
      }
      return;
    }

    // Cmd+. → toggle collapse
    if (modKey && e.key === '.') {
      e.preventDefault();
      const b = block();
      if (b && (b.childIds?.length > 0 || b.outputType)) {
        paneStore.toggleCollapsed(props.paneId, props.id, b.collapsed || false);
      }
      return;
    }

    // Cmd+Arrow → move block
    if (modKey && e.key === 'ArrowUp') {
      e.preventDefault();
      store.moveBlockUp(props.id);
      refocusAfterMove();
      return;
    }
    if (modKey && e.key === 'ArrowDown') {
      e.preventDefault();
      store.moveBlockDown(props.id);
      refocusAfterMove();
      return;
    }

    // Tab/Shift+Tab → indent/outdent
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey) {
        store.outdentBlock(props.id);
      } else {
        store.indentBlock(props.id);
      }
      refocusAfterMove();
      return;
    }

    // Cmd+Backspace → force delete block + subtree (no children guard)
    if ((e.key === 'Backspace' || e.key === 'Delete') && modKey) {
      e.preventDefault();
      const target = findFocusAfterDelete(props.id, props.paneId);
      store.deleteBlock(props.id);
      if (target) props.onFocus(target);
      return;
    }

    // Backspace/Delete → delete block (guarded: only if no children or block selected)
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      const hasChildren = !!block()?.childIds?.length;
      const isSelected = props.isBlockSelected?.(props.id) ?? false;
      if (hasChildren && !isSelected) return;
      const target = findFocusAfterDelete(props.id, props.paneId);
      store.deleteBlock(props.id);
      if (target) props.onFocus(target);
      return;
    }

    // ArrowUp/Down → navigate between blocks
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = findPrevVisibleBlock(props.id, props.paneId);
      if (prev) {
        paneStore.setFocusCursorHint(props.paneId, 'end');
        props.onFocus(prev);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = findNextVisibleBlock(props.id, props.paneId);
      if (next) {
        paneStore.setFocusCursorHint(props.paneId, 'start');
        props.onFocus(next);
      }
      return;
    }
  };

  // TODO: AUTO-EXECUTE for external blocks (API/CRDT sync)
  // Pattern documented in docs/BLOCK_TYPE_PATTERNS.md
  // Needs: track locally-modified blocks to distinguish from external
  // For now: Enter-to-execute only

  // Content sync effect + blur sync are handled by useContentSync hook.
  // Wrap blur to also dismiss autocomplete (BlockItem-specific concern).
  const handleBlur = () => {
    autocomplete.dismiss();
    handleBlurSync();
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
        logger.debug(`readFiles probe: ${err}`);
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

  const hasCollapsibleOutputMemo = createMemo(() => hasCollapsibleOutput(block()));

  const bulletChar = () => {
    const hasChildren = block()?.childIds && block()!.childIds.length > 0;
    if (hasChildren || hasCollapsibleOutputMemo()) {
      return isCollapsed() ? '▸' : '▾';
    }
    return '•';
  };

  // [[Wikilink]] click handler — delegates to navigateWikilink with mouse-event modifiers
  // Cmd+Click / Opt+Click → horizontal split, +Shift → vertical split
  const handleWikilinkClick = (target: string, e: MouseEvent) => {
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const optKey = e.altKey;

    let splitDirection: 'horizontal' | 'vertical' | undefined;
    if (modKey || optKey) {
      splitDirection = e.shiftKey ? 'vertical' : 'horizontal';
    }

    navigateWikilink(target, props.paneId, { splitDirection });
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
          'has-collapsed-children': isCollapsed() && ((block()?.childIds?.length ?? 0) > 0 || hasCollapsibleOutputMemo()),
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
        >
          {bulletChar()}
        </div>

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

          {/* Output blocks (search, door, img, eval, inline door, filter) — rendered by BlockOutputView */}

          {/* RENDER TITLE MODE (FLO-569): collapsed height display with dedicated focus */}
          {/* contentEditable is hidden — this wrapper drives height to title size */}
          <Show when={isRenderTitleMode()}>
            <div
              ref={renderTitleRef}
              tabIndex={0}
              class="block-content-wrapper render-title-wrapper"
              onKeyDown={handleRenderTitleKeyDown}
              onFocus={() => props.onFocus(props.id)}
            >
              <BlockDisplay
                content={effectiveDisplayContent()}
                onWikilinkClick={handleWikilinkClick}
                blockId={props.id}
                pageNameSet={pageNameSet()}
                stubPageNameSet={stubPageNameSet()}
              />
              <button
                class="block-mode-toggle"
                onClick={() => setRenderShowTitle(false)}
                title="Show full prompt"
              >
                ⊞
              </button>
            </div>
          </Show>

          {/* REGULAR BLOCK: display + edit layers (hidden for special block types) */}
          {/* FLO-58: Also show for table blocks in raw mode - use contentEditable for raw markdown editing */}
          {/* FLO-569: Also hidden when in render:: title mode (title wrapper above handles display) */}
          <Show when={block()?.type !== 'picker' && (!isTableBlock() || tableShowRaw()) && !isOutputBlockMemo() && !isRenderTitleMode()}>
            {/* DISPLAY LAYER: styled inline tokens (pointer-events: none) */}
            {/* Skip for table raw mode - just show contentEditable directly */}
            <Show when={!tableShowRaw()}>
              <BlockDisplay
                content={effectiveDisplayContent()}
                onWikilinkClick={handleWikilinkClick}
                blockId={props.id}
                onUpdateContent={(content) => store.updateBlockContent(props.id, content)}
                pageNameSet={pageNameSet()}
                stubPageNameSet={stubPageNameSet()}
              />
              {/* render:: title toggle — switch between generated title and full prompt */}
              <Show when={renderTitle()}>
                <button
                  class="block-mode-toggle"
                  onClick={() => setRenderShowTitle(v => !v)}
                  title={renderShowTitle() ? 'Show full prompt' : 'Show title'}
                >
                  {renderShowTitle() ? '⊞' : '⊟'}
                </button>
              </Show>
            </Show>

            {/* TABLE RAW MODE: wrap in container with toggle button at top-right */}
            <Show when={tableShowRaw()}>
              <div class="table-raw-container">
                <button
                  class="block-mode-toggle"
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

          <BlockOutputView
            blockId={props.id}
            paneId={props.paneId}
            isFocused={isFocused}
            isCollapsed={isCollapsed}
            isOutputBlock={isOutputBlockMemo}
            onFocus={props.onFocus}
            cancelContentUpdate={cancelContentUpdate}
            isBlockSelected={props.isBlockSelected}
            setInlineDoorRef={setInlineDoorRef}
          />

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
          <Show when={childLimit() > 0 && (block()?.childIds.length ?? 0) > childLimit()}>
            <div
              class="block-children-more"
              onClick={() => setChildLimit(n => n + (configLimit() || 100))}
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
