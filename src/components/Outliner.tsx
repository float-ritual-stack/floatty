import { createSignal, createEffect, createMemo, onMount, onCleanup, Show, on, batch } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { tinykeys } from 'tinykeys';
import { useSyncedYDoc } from '../hooks/useSyncedYDoc';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { useOutlinerSelection } from '../hooks/useOutlinerSelection';
import { useTreeCollapse } from '../hooks/useTreeCollapse';
import { BlockItem } from './BlockItem';
import { Breadcrumb } from './Breadcrumb';
import { LinkedReferences, isPageBlock } from './LinkedReferences';
import { isMac } from '../lib/keybinds';
import { blocksToMarkdown } from '../lib/markdownExport';
import { invoke, type AggregatorConfig } from '../lib/tauriTypes';
import { downloadJSON } from '../lib/jsonExport';
import type { ExportedOutline } from '../lib/jsonExport';
import { getHttpClient, isClientInitialized } from '../lib/httpClient';
import { downloadBinary } from '../lib/binaryExport';
import { validateForExport, type ValidationWarning } from '../lib/validation';
import { ExportValidation } from './ExportValidation';
import { themeStore } from '../hooks/useThemeStore';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { findTabIdByPaneId } from '../hooks/useBacklinkNavigation';
import { tabStore } from '../hooks/useTabStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { IframePaneView } from './views/IframePaneView';
import { handleChirpNavigate } from '../lib/navigation';
import type { EvalResult } from '../lib/evalEngine';

interface OutlinerProps {
  paneId: string;
  // FLO-197: Initial collapse depth for split panes (0 = disabled)
  // Blocks deeper than this depth will be force-collapsed on mount
  initialCollapseDepth?: number;
}

export function Outliner(props: OutlinerProps) {
  const { doc, isLoaded, undo, redo, clearUndoStack } = useSyncedYDoc();
  const { blockStore, paneStore } = useWorkspace();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock, findFocusAfterDelete, getAncestors } = useBlockOperations();

  // FLO-77: Use paneStore for focusedBlockId (enables clone-on-split)
  const focusedBlockId = () => paneStore.getFocusedBlockId(props.paneId);
  const setFocusedBlockId = (id: string | null) => paneStore.setFocusedBlockId(props.paneId, id);
  const [confirmClear, setConfirmClear] = createSignal(false);

  // FLO-349: Non-blocking export validation
  const [exportWarnings, setExportWarnings] = createSignal<ValidationWarning[] | null>(null);
  const [pendingExportData, setPendingExportData] = createSignal<{ json: string; parsed: ExportedOutline } | null>(null);

  // FLO-197/P5: Gate render on config loaded (prevents 10K render freeze)
  // For split panes (props.initialCollapseDepth set), ready immediately after applying depth
  // For initial load, ready after async config load completes
  const [configReady, setConfigReady] = createSignal(false);

  // Phase 0.5: Cache config for homebase keybind (Cmd+Shift+0)
  const [cachedConfig, setCachedConfig] = createSignal<AggregatorConfig | null>(null);

  // Get current zoomed root for this pane (null = show all roots)
  const zoomedRootId = () => paneStore.getZoomedRootId(props.paneId);

  // Unit 11.0: Detect zoom into an iframe block (url eval-result)
  const isIframeZoom = createMemo(() => {
    const id = zoomedRootId();
    if (!id) return false;
    const b = store.blocks[id];
    return b?.outputType === 'eval-result'
      && (b?.output as EvalResult | undefined)?.type === 'url';
  });

  // FLO-320: Initialize store AFTER Y.Doc is populated (prevents 13.8k block observer storm)
  // Must fire BEFORE the config effect below so store.rootIds is populated for applyCollapseDepth.
  // In the old code, initFromYDoc ran in onMount on an EMPTY doc, so when the async load completed,
  // the observer processed all blocks via slow per-key setState. Now the doc is full before init.
  createEffect(() => {
    if (!isLoaded()) return;
    const dispose = store.initFromYDoc(doc);
    onCleanup(dispose);
  });

  // FLO-197/P5: Apply collapse depth BEFORE first render
  // This effect runs when isLoaded() becomes true, applies collapse, THEN enables rendering
  createEffect(() => {
    if (!isLoaded()) return;
    if (configReady()) return; // Already processed

    // Helper to force-collapse blocks deeper than threshold
    const applyCollapseDepth = (depth: number) => {
      if (depth <= 0) return;

      const roots = zoomedRootId() ? [zoomedRootId()!] : store.rootIds;
      console.log(`[FLO-197] Applying initial_collapse_depth ${depth} to ${roots.length} roots`);

      const forceCollapseDeeper = (id: string, currentDepth: number) => {
        const block = store.blocks[id];
        if (!block || block.childIds.length === 0) return;

        // Force-collapse blocks AT and DEEPER than threshold.
        // depth=1 collapses root blocks themselves (only 7 indicators visible).
        // depth=2 collapses root children (roots visible, children collapsed).
        // Matches collapseToDepth semantics: currentDepth >= depth.
        if (currentDepth >= depth) {
          paneStore.setCollapsed(props.paneId, id, true);
          return; // No need to recurse — children are hidden anyway
        }

        for (const childId of block.childIds) {
          forceCollapseDeeper(childId, currentDepth + 1);
        }
      };

      for (const rootId of roots) {
        forceCollapseDeeper(rootId, 1);
      }
    };

    // Load config (always needed for homebase keybind Cmd+Shift+0)
    const configPromise = invoke('get_ctx_config', {}).then((config: AggregatorConfig) => {
      setCachedConfig(config);  // Cache for homebase keybind
      // Apply diagnostics visibility from config
      themeStore.setDiagnostics(config.show_diagnostics);
      themeStore.setServerPort(config.server_port);
      themeStore.setIsDevBuild(config.is_dev_build);
      themeStore.setConfigPath(`${config.data_dir}/config.toml`);
      return config;
    }).catch((err: unknown) => {
      console.warn('[Outliner] Failed to load config:', err);
      return null;
    });

    // Split pane case: use prop directly (sync, fast)
    // Check !== undefined to treat 0 as valid override (disabled, but don't fall back to config)
    if (props.initialCollapseDepth !== undefined) {
      if (props.initialCollapseDepth > 0) {
        applyCollapseDepth(props.initialCollapseDepth);
      }
      setConfigReady(true);
      return;
    }

    // Initial load case: use config for initial_collapse_depth (async)
    configPromise.then((config) => {
      if (config?.initial_collapse_depth && config.initial_collapse_depth > 0) {
        applyCollapseDepth(config.initial_collapse_depth);
      }
      setConfigReady(true);
    });
  });

  // Container ref for tinykeys and collapse focus management
  let containerRef: HTMLDivElement | undefined;

  // FLO-74: Get all visible block IDs in document order (for range selection)
  const getVisibleBlockIds = createMemo(() => {
    const result: string[] = [];
    const rootsToWalk = zoomedRootId() ? [zoomedRootId()!] : store.rootIds;

    const walk = (id: string) => {
      const block = store.blocks[id];
      if (!block) return;
      result.push(id);
      const collapsed = paneStore.isCollapsed(props.paneId, id, block.collapsed);
      if (!collapsed && block.childIds.length > 0) {
        for (const childId of block.childIds) {
          walk(childId);
        }
      }
    };

    for (const rootId of rootsToWalk) {
      walk(rootId);
    }
    return result;
  });

  // FLO-74/95: Multi-select state and operations (extracted to hook)
  const selection = useOutlinerSelection({
    blockStore: store,
    paneStore,
    paneId: props.paneId,
    focusedBlockId,
    setFocusedBlockId,
    zoomedRootId,
    getVisibleBlockIds,
    getAncestors,
    findFocusAfterDelete,
  });

  // FLO-66: Progressive expand/collapse (extracted to hook)
  const collapse = useTreeCollapse({
    blockStore: store,
    paneStore,
    paneId: props.paneId,
    zoomedRootId,
    focusedBlockId,
    setFocusedBlockId,
    getVisibleBlockIds,
    getAncestors,
    getContainerRef: () => containerRef,
  });

  // Auto-expand when zooming into a block
  // This ensures collapsed blocks become navigable when you Cmd+Enter into them
  // CRITICAL: Use on() to track ONLY zoomedRootId changes, not block content updates.
  // Without on(), expandToDepth's internal store reads create spurious dependencies,
  // causing the effect to re-run on every Y.Doc content update (FLO-180 bug fix).
  createEffect(on(zoomedRootId, (zoomTarget, prevTarget) => {
    // FLO-211: Skip auto-expand for history navigation (back/forward)
    // This preserves the user's collapse state when returning to a previous location
    if (paneStore.consumeHistoryNavigation(props.paneId)) {
      return;
    }

    if (zoomTarget && zoomTarget !== prevTarget) {
      // Expand the zoom target so its children are visible, then collapse
      // all direct children — giving "top-level list, collapsed" on every
      // navigate. Batched so SolidJS renders once, not N times.
      // (Replaces ensureExpandedToDepth which expanded children too,
      //  causing lock-up on large containers like pages:: with 368 children.)
      batch(() => {
        paneStore.setCollapsed(props.paneId, zoomTarget, false);
        const block = store.blocks[zoomTarget];
        if (block) {
          for (const childId of block.childIds) {
            const child = store.blocks[childId];
            if (child && child.childIds.length > 0) {
              paneStore.setCollapsed(props.paneId, childId, true);
            }
          }
        }
      });
    }
  }));

  // FLO-74: Global keyboard handler for selection operations
  const handleOutlinerKeyDown = (e: KeyboardEvent) => {
    const selected = selection.selectedBlockIds();
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const activeEl = document.activeElement;
    const isEditing = activeEl?.getAttribute('contenteditable') === 'true';

    // FLO-74: Clear selection when typing starts (prevents accidental delete)
    if (selected.size > 0 && isEditing && e.key.length === 1 && !modKey && !e.ctrlKey && !e.altKey) {
      selection.clearSelection();
      return;
    }

    // Escape clears selection
    if (e.key === 'Escape' && selected.size > 0) {
      e.preventDefault();
      selection.clearSelection();
      return;
    }

    // Progressive Cmd+A handled by tinykeys (see onMount)

    // Cmd+C copy selection
    if (modKey && e.key === 'c' && selected.size > 0) {
      e.preventDefault();
      selection.copySelection();
      return;
    }

    // Arrow keys (without Shift) escape block selection mode → return to editing
    // Shift+Arrow extends selection — don't clear it
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !e.shiftKey && selected.size > 0 && !isEditing) {
      e.preventDefault();
      const currentFocused = focusedBlockId();
      selection.clearSelection();
      // Restore editing focus so user isn't in keyboard limbo
      if (currentFocused) {
        setFocusedBlockId(currentFocused);
      }
      return;
    }

    // Delete/Backspace on selection (only when not editing a block)
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
      if (!isEditing) {
        e.preventDefault();
        selection.deleteSelection();
      }
    }
  };

  // Export functions (used by both tinykeys and global handlers)
  const exportToMarkdown = async () => {
    const allIds = selection.getAllBlockIds();
    if (allIds.length === 0) return;

    const allIdsSet = new Set(allIds);
    const markdown = blocksToMarkdown(allIdsSet, store.blocks, allIds);

    try {
      await navigator.clipboard.writeText(markdown);
      console.log(`[FLO-102] Exported ${allIds.length} blocks to clipboard`);
    } catch (err) {
      console.error('[FLO-102] Failed to write to clipboard:', err);
    }
  };

  const exportToJSON = async () => {
    // Flush any pending contentEditable edits before export
    (document.activeElement as HTMLElement)?.blur();

    try {
      // FLO-393: Single export path — fetch from server (same as /api/v1/export/json)
      if (!isClientInitialized()) {
        throw new Error('Server not connected');
      }
      const httpClient = getHttpClient();
      const json = await httpClient.exportJSON();
      const data = JSON.parse(json) as ExportedOutline;

      const validation = validateForExport(data);

      if (validation.warnings.length > 0) {
        // FLO-349: Show warnings panel, let user decide
        console.log(`[FLO-349] Export has ${validation.warnings.length} warnings`);
        setExportWarnings(validation.warnings);
        setPendingExportData({ json, parsed: data });
        return;
      }

      // No warnings — export directly
      await downloadJSON(json);
      console.log(`[FLO-247] Exported ${data.blockCount} blocks to JSON`);
    } catch (err) {
      console.error('[FLO-247] JSON export failed:', err);
      alert(`JSON export failed: ${err}`);
    }
  };

  const handleExportAnyway = async () => {
    const pending = pendingExportData();
    setExportWarnings(null);
    setPendingExportData(null);
    if (!pending) return;

    try {
      await downloadJSON(pending.json);
      console.log(`[FLO-349] Exported ${pending.parsed.blockCount} blocks to JSON (with warnings)`);
    } catch (err) {
      console.error('[FLO-349] JSON export failed:', err);
      alert(`JSON export failed: ${err}`);
    }
  };

  const handleExportCancel = () => {
    setExportWarnings(null);
    setPendingExportData(null);
    console.log('[FLO-349] Export cancelled by user');
  };

  const exportToBinary = async () => {
    // Flush any pending contentEditable edits before export
    (document.activeElement as HTMLElement)?.blur();

    try {
      await downloadBinary(doc);
      console.log('[FLO-247] Exported Y.Doc binary');
    } catch (err) {
      console.error('[FLO-247] Binary export failed:', err);
      alert(`Binary export failed: ${err}`);
    }
  };

  onMount(() => {
    console.log('Outliner mounted for pane:', props.paneId);
    // FLO-320: initFromYDoc moved to createEffect gated on isLoaded()
    // This ensures the Y.Doc is populated before store init, avoiding the observer storm.

    // FLO-197/P5: Collapse depth now handled in createEffect BEFORE render
    // (see effect above that gates on configReady)

    // FLO-197: Scroll focused block into view after mount (e.g., after split)
    // Without this, new pane starts at scroll top 0 which is disorienting
    const focusedId = focusedBlockId();
    if (focusedId && containerRef) {
      requestAnimationFrame(() => {
        const blockEl = containerRef?.querySelector(`[data-block-id="${focusedId}"]`);
        blockEl?.scrollIntoView({ block: 'center', behavior: 'instant' });
        // Also focus the contentEditable (BlockItem's effect might be blocked by guards)
        const editor = blockEl?.querySelector('[contenteditable]') as HTMLElement;
        editor?.focus({ preventScroll: true });
      });
    }

    // FLO-74 Refinement: Progressive Cmd+A with indent-based expansion
    // FLO-66: Progressive expand/collapse with ⌘E / ⌘⇧E
    if (containerRef) {
      // Helper to set selection from list of IDs
      const setSelectionFromIds = (ids: string[]) => {
        if (ids.length === 0) return;
        // Use 'anchor' not 'set' - 'set' clears selection, 'anchor' actually selects
        selection.handleSelect(ids[0], 'anchor');
        for (let i = 1; i < ids.length; i++) {
          selection.handleSelect(ids[i], 'toggle');
        }
      };

      // Export functions now defined outside onMount (see above)

      // Robust check for "all text in element is selected" using Range boundary comparison.
      // String length comparison fails for multi-line blocks (textContent strips div boundaries,
      // sel.toString() includes visual newlines — lengths diverge).
      const isElementFullySelected = (el: HTMLElement, sel: Selection): boolean => {
        if (sel.isCollapsed || sel.rangeCount === 0) return false;
        try {
          const range = sel.getRangeAt(0);
          const fullRange = document.createRange();
          fullRange.selectNodeContents(el);
          const startsAtOrBefore =
            range.compareBoundaryPoints(Range.START_TO_START, fullRange) <= 0;
          const endsAtOrAfter =
            range.compareBoundaryPoints(Range.END_TO_END, fullRange) >= 0;
          return startsAtOrBefore && endsAtOrAfter;
        } catch (err) {
          console.debug('[isElementFullySelected] Range comparison failed:', err);
          return false;
        }
      };

      const expandSelectionToLevel = (level: number, e: KeyboardEvent) => {
        const activeEl = document.activeElement as HTMLElement;
        const isEditing = activeEl?.getAttribute('contenteditable') === 'true';

        // FLO-58: Let table cell inputs handle their own Cmd+A
        if (activeEl?.classList.contains('md-table-input') || activeEl?.classList.contains('md-table-raw')) {
          return; // Input will handle select-all natively
        }

        if (isEditing) {
          const sel = window.getSelection();

          // Empty blocks have nothing to select-all — skip straight to block selection
          if (!activeEl.textContent?.length) {
            activeEl.blur();
            containerRef?.focus();
          } else {
            const allTextSelected = sel ? isElementFullySelected(activeEl, sel) : false;

            if (!allTextSelected) {
              // First Cmd+A: select all text in the block (native selection)
              e.preventDefault();
              const range = document.createRange();
              range.selectNodeContents(activeEl);
              sel?.removeAllRanges();
              sel?.addRange(range);
              return;
            }

            // Text already selected → exit text mode, do block selection
            activeEl.blur();
            containerRef?.focus();
          }
        }

        e.preventDefault();
        const ids = selection.selectByIndentLevel(level);
        setSelectionFromIds(ids);
      };

      const unsubscribe = tinykeys(containerRef, {
        // FLO-95: Progressive Cmd+A expansion with extended levels
        '$mod+a': (e) => expandSelectionToLevel(0, e),
        '$mod+a a': (e) => expandSelectionToLevel(1, e),
        '$mod+a a a': (e) => expandSelectionToLevel(2, e),
        '$mod+a a a a': (e) => expandSelectionToLevel(3, e),
        '$mod+a a a a a': (e) => expandSelectionToLevel(4, e),
        '$mod+a a a a a a': (e) => expandSelectionToLevel(5, e),
        '$mod+a a a a a a a': (e) => expandSelectionToLevel(6, e),
        '$mod+a a a a a a a a': (e) => expandSelectionToLevel(7, e),
        '$mod+a a a a a a a a a': (e) => expandSelectionToLevel(8, e),
        '$mod+a a a a a a a a a a': (e) => expandSelectionToLevel(9, e),

        // FLO-66: Progressive expand/collapse (scoped to focused subtree)
        // FLO-XXX: Pass focusedBlockId instead of null to avoid expanding entire outline
        '$mod+e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(focusedBlockId(), 1);
          collapse.ensureVisibleFocus();
        },
        '$mod+e e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(focusedBlockId(), 2);
          collapse.ensureVisibleFocus();
        },
        '$mod+e e e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(focusedBlockId(), 3);
          collapse.ensureVisibleFocus();
        },
        '$mod+e e e e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(focusedBlockId(), Infinity);
          collapse.ensureVisibleFocus();
        },
        // Cmd+Shift+E → Global expand (all roots, capped at 3 for safety)
        // Phase 0.5: Restores "old" behavior for occasional "see everything" use
        '$mod+Shift+e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(null, 3);  // null = all roots, capped at depth 3
          collapse.ensureVisibleFocus();
        },
        '$mod+Shift+e e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(null, Infinity);  // Explicit "show everything"
          collapse.ensureVisibleFocus();
        },
        // Cmd+Shift+7/8/9 → Quick expand to depth 1/2/3 (scoped to focused block)
        // macOS with Cmd held: Shift does NOT remap digits (key="7" not "&").
        // Verified via MCP keydown capture: {key:"8", code:"Digit8", meta:true, shift:true}
        '$mod+Shift+7': (e) => {
          e.preventDefault();
          collapse.expandToDepth(focusedBlockId(), 1);
          collapse.ensureVisibleFocus();
        },
        '$mod+Shift+8': (e) => {
          e.preventDefault();
          collapse.expandToDepth(focusedBlockId(), 2);
          collapse.ensureVisibleFocus();
        },
        '$mod+Shift+9': (e) => {
          e.preventDefault();
          collapse.expandToDepth(focusedBlockId(), 3);
          collapse.ensureVisibleFocus();
        },
        // Cmd+Shift+0 → Homebase (collapse all to config.initial_collapse_depth)
        // Phase 0.5: Reset after progressive expansion session
        '$mod+Shift+0': (e) => {
          e.preventDefault();
          const depth = cachedConfig()?.initial_collapse_depth ?? 2;
          collapse.collapseToDepth(null, depth);  // null = all roots
          collapse.ensureVisibleFocus();
        },

        // Undo/Redo (Y.Doc UndoManager)
        // Use ensureVisibleFocus to handle both deleted blocks AND
        // blocks hidden by restored collapsed state
        // FLO-197: Blur first to flush uncommitted edits before undo
        // (prevents losing text typed but not yet debounce-committed)
        '$mod+z': (e) => {
          e.preventDefault();
          // Flush uncommitted edits by blurring focused contentEditable
          const activeEl = document.activeElement as HTMLElement;
          if (activeEl?.contentEditable === 'true') {
            activeEl.blur();  // Triggers handleBlur → flushContentUpdate
          }
          undo();
          requestAnimationFrame(() => {
            collapse.ensureVisibleFocus();
          });
        },
        '$mod+Shift+z': (e) => {
          e.preventDefault();
          // Flush uncommitted edits by blurring focused contentEditable
          const activeEl = document.activeElement as HTMLElement;
          if (activeEl?.contentEditable === 'true') {
            activeEl.blur();  // Triggers handleBlur → flushContentUpdate
          }
          redo();
          requestAnimationFrame(() => {
            collapse.ensureVisibleFocus();
          });
        },

        // Export keybinds moved to global document listener (see below)

        // FLO-223 R9: Cmd+L handled in global document listener below

        // FLO-180/211: Navigation history (back/forward) with focus restoration
        '$mod+[': (e) => {
          e.preventDefault();
          const blockExists = (id: string) => !!store.getBlock(id);
          const entry = paneStore.goBack(props.paneId, blockExists);
          if (entry) {
            console.log('[FLO-180] Navigated back to:', entry.zoomedRootId ?? 'roots', 'focus:', entry.focusedBlockId);
            // FLO-211: Restore focus after DOM updates
            requestAnimationFrame(() => {
              if (entry.focusedBlockId && blockExists(entry.focusedBlockId)) {
                // Expand path to focused block, then let BlockItem's effect handle focus
                collapse.expandAncestors(entry.focusedBlockId);
              } else {
                // Fallback for entries without focus (old history or deleted blocks)
                collapse.ensureVisibleFocus();
              }
            });
          }
        },
        '$mod+]': (e) => {
          e.preventDefault();
          const blockExists = (id: string) => !!store.getBlock(id);
          const entry = paneStore.goForward(props.paneId, blockExists);
          if (entry) {
            console.log('[FLO-180] Navigated forward to:', entry.zoomedRootId ?? 'roots', 'focus:', entry.focusedBlockId);
            // FLO-211: Restore focus after DOM updates
            requestAnimationFrame(() => {
              if (entry.focusedBlockId && blockExists(entry.focusedBlockId)) {
                // Expand path to focused block, then let BlockItem's effect handle focus
                collapse.expandAncestors(entry.focusedBlockId);
              } else {
                // Fallback for entries without focus (old history or deleted blocks)
                collapse.ensureVisibleFocus();
              }
            });
          }
        },
      });
      onCleanup(unsubscribe);
    }
  });

  // Global export keybinds (work even when editing blocks)
  createEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const isMod = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      // Cmd+Shift+M - Export markdown
      if (isMod && isShift && e.key === 'm') {
        e.preventDefault();
        exportToMarkdown();
      }
      // Cmd+Shift+J - Export JSON
      else if (isMod && isShift && e.key === 'j') {
        e.preventDefault();
        exportToJSON();
      }
      // Cmd+Shift+B - Export binary
      else if (isMod && isShift && e.key === 'b') {
        e.preventDefault();
        exportToBinary();
      }
      // Unit 12.0: Cmd+Shift+F - Toggle full-width on focused block
      // Guard: active tab AND active pane (all outliners register on document)
      else if (isMod && isShift && e.key === 'f') {
        const myTab = findTabIdByPaneId(props.paneId);
        if (myTab !== tabStore.activeTabId()) return;
        const layout = layoutStore.layouts[myTab];
        if (layout?.activePaneId !== props.paneId) return;
        const focused = focusedBlockId();
        if (focused) {
          e.preventDefault();
          paneStore.toggleFullWidth(props.paneId, focused);
        }
      }
      // FLO-223 R9: Cmd+L - Open pane link overlay (always, even if already linked — re-link)
      // Guard: active tab AND active pane (all outliners register on document, only focused one fires)
      else if (isMod && !isShift && e.key === 'l') {
        const myTab = findTabIdByPaneId(props.paneId);
        if (myTab !== tabStore.activeTabId()) return;
        const layout = layoutStore.layouts[myTab];
        if (layout?.activePaneId !== props.paneId) return;
        e.preventDefault();
        paneLinkStore.startLinking(props.paneId);
      }
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    onCleanup(() => document.removeEventListener('keydown', handleGlobalKeyDown));
  });

  // Auto-create first block when workspace is empty
  createEffect(() => {
    if (isLoaded() && store.rootIds.length === 0) {
      const id = store.createInitialBlock();
      if (id) {
        setFocusedBlockId(id);
        clearUndoStack();
      }
    }
  });

  const handleFocus = (id: string) => {
    setFocusedBlockId(id);
  };

  const handleNavigateUp = (id: string) => {
    const prev = findPrevVisibleBlock(id, props.paneId);
    if (prev) setFocusedBlockId(prev);
  };

  const handleNavigateDown = (id: string) => {
    const next = findNextVisibleBlock(id, props.paneId);
    if (next) setFocusedBlockId(next);
  };

  return (
    <div
      ref={containerRef}
      class="outliner-container"
      data-pane-id={props.paneId}
      role="listbox"
      aria-multiselectable="true"
      aria-label="Block outliner"
      onKeyDown={handleOutlinerKeyDown}
      tabIndex={-1}
    >
      <Show when={isLoaded() && configReady()} fallback={<div class="ctx-empty-state">Loading workspace...</div>}>
        <Show when={store.rootIds.length > 0 || zoomedRootId()}>
          {/* Clear button - only show when not zoomed */}
          <Show when={!zoomedRootId()}>
            <div style={{ display: 'flex', "justify-content": 'flex-end', "margin-bottom": '4px', "padding-right": '4px' }}>
              <button
                class="outliner-clear-button"
                classList={{ 'outliner-clear-confirm': confirmClear() }}
                title="Clear entire workspace"
                onClick={() => {
                  if (confirmClear()) {
                    store.clearWorkspace();
                    setConfirmClear(false);
                  } else {
                    setConfirmClear(true);
                  }
                }}
                onMouseLeave={() => setConfirmClear(false)}
              >
                {confirmClear() ? 'Confirm?' : 'Clear'}
              </button>
            </div>
          </Show>

          {/* Zoomed view or full tree */}
          <Show
            when={zoomedRootId()}
            fallback={
              <Key each={store.rootIds} by={(id) => id}>
                {(rootId) => {
                  const id = rootId();
                  return (
                    <BlockItem
                      id={id}
                      paneId={props.paneId}
                      depth={0}
                      focusedBlockId={focusedBlockId()}
                      onFocus={handleFocus}
                      onNavigateUp={() => handleNavigateUp(id)}
                      onNavigateDown={() => handleNavigateDown(id)}
                      isBlockSelected={(blockId) => selection.selectedBlockIds().has(blockId)}
                      onSelect={selection.handleSelect}
                      selectionAnchor={selection.selectionAnchor()}
                      getVisibleBlockIds={getVisibleBlockIds}
                    />
                  );
                }}
              </Key>
            }
          >
            {/* Zoomed: full-pane iframe OR breadcrumb + block subtree */}
            <Show when={isIframeZoom()} fallback={
              <>
                <Breadcrumb blockId={zoomedRootId()!} paneId={props.paneId} />
                <BlockItem
                  id={zoomedRootId()!}
                  paneId={props.paneId}
                  depth={0}
                  focusedBlockId={focusedBlockId()}
                  onFocus={handleFocus}
                  onNavigateUp={() => handleNavigateUp(zoomedRootId()!)}
                  onNavigateDown={() => handleNavigateDown(zoomedRootId()!)}
                  isBlockSelected={(blockId) => selection.selectedBlockIds().has(blockId)}
                  onSelect={selection.handleSelect}
                  selectionAnchor={selection.selectionAnchor()}
                  getVisibleBlockIds={getVisibleBlockIds}
                />
                {/* LinkedReferences: show when zoomed into a page under pages:: */}
                <Show when={isPageBlock(zoomedRootId()!)}>
                  <LinkedReferences
                    pageBlockId={zoomedRootId()!}
                    paneId={props.paneId}
                    onFocusBlock={handleFocus}
                  />
                </Show>
              </>
            }>
              <IframePaneView
                url={String((store.blocks[zoomedRootId()!]?.output as EvalResult)?.data ?? '')}
                blockId={zoomedRootId()!}
                paneId={props.paneId}
                onClose={() => paneStore.zoomTo(props.paneId, null)}
                onChirp={(message: string, data?: unknown) => {
                  if (message === 'navigate' && typeof data === 'object' && data) {
                    const nav = data as { target: string; type?: 'block' | 'page' | 'wikilink'; splitDirection?: 'horizontal' | 'vertical' };
                    handleChirpNavigate(nav.target, {
                      type: nav.type,
                      sourcePaneId: props.paneId,
                      sourceBlockId: zoomedRootId()!,
                      splitDirection: nav.splitDirection,
                    });
                  }
                }}
              />
            </Show>
          </Show>
        </Show>
      </Show>

      {/* FLO-349: Non-blocking export validation warnings */}
      <Show when={exportWarnings()}>
        <ExportValidation
          warnings={exportWarnings()!}
          onExport={handleExportAnyway}
          onCancel={handleExportCancel}
        />
      </Show>
    </div>
  );
}
