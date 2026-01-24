import { createSignal, createEffect, createMemo, onMount, onCleanup, Show } from 'solid-js';
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

  // FLO-197/P5: Gate render on config loaded (prevents 10K render freeze)
  // For split panes (props.initialCollapseDepth set), ready immediately after applying depth
  // For initial load, ready after async config load completes
  const [configReady, setConfigReady] = createSignal(false);

  // Get current zoomed root for this pane (null = show all roots)
  const zoomedRootId = () => paneStore.getZoomedRootId(props.paneId);

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

        // Only force-collapse blocks DEEPER than threshold
        // Blocks at/above threshold keep their existing state
        if (currentDepth > depth) {
          paneStore.setCollapsed(props.paneId, id, true);
        }

        for (const childId of block.childIds) {
          forceCollapseDeeper(childId, currentDepth + 1);
        }
      };

      for (const rootId of roots) {
        forceCollapseDeeper(rootId, 1);
      }
    };

    // Split pane case: use prop directly (sync, fast)
    // Check !== undefined to treat 0 as valid override (disabled, but don't fall back to config)
    if (props.initialCollapseDepth !== undefined) {
      if (props.initialCollapseDepth > 0) {
        applyCollapseDepth(props.initialCollapseDepth);
      }
      setConfigReady(true);
      return;
    }

    // Initial load case: check config for initial_collapse_depth (async)
    invoke('get_ctx_config', {}).then((config: AggregatorConfig) => {
      if (config.initial_collapse_depth && config.initial_collapse_depth > 0) {
        applyCollapseDepth(config.initial_collapse_depth);
      }
      setConfigReady(true);
    }).catch((err: unknown) => {
      console.warn('[FLO-197] Failed to load config for initial_collapse_depth:', err);
      setConfigReady(true); // Still allow render even if config fails
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

    // Delete/Backspace on selection (only when not editing a block)
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
      if (!isEditing) {
        e.preventDefault();
        selection.deleteSelection();
      }
    }
  };

  onMount(() => {
    console.log('Outliner mounted for pane:', props.paneId);
    const dispose = store.initFromYDoc(doc);
    onCleanup(dispose);

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

      // FLO-102: Export outline to markdown (copies to clipboard)
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

      const expandSelectionToLevel = (level: number, e: KeyboardEvent) => {
        const activeEl = document.activeElement as HTMLElement;
        const isEditing = activeEl?.getAttribute('contenteditable') === 'true';

        if (isEditing) {
          // Check if all text is already selected
          const sel = window.getSelection();
          const textContent = activeEl.textContent || '';
          const allTextSelected = sel && !sel.isCollapsed &&
            sel.toString().length >= textContent.length;

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

        // FLO-66: Progressive expand/collapse
        '$mod+e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(null, 1);
          collapse.ensureVisibleFocus();
        },
        '$mod+e e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(null, 2);
          collapse.ensureVisibleFocus();
        },
        '$mod+e e e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(null, 3);
          collapse.ensureVisibleFocus();
        },
        '$mod+e e e e': (e) => {
          e.preventDefault();
          collapse.expandToDepth(null, Infinity);
          collapse.ensureVisibleFocus();
        },
        // Cmd+Shift+E → collapse (Shift inverts direction)
        '$mod+Shift+e': (e) => {
          e.preventDefault();
          collapse.collapseToDepth(null, 1);
          collapse.ensureVisibleFocus();
        },
        '$mod+Shift+e e': (e) => {
          e.preventDefault();
          collapse.collapseToDepth(null, 2);
          collapse.ensureVisibleFocus();
        },
        '$mod+Shift+e e e': (e) => {
          e.preventDefault();
          collapse.collapseToDepth(null, 3);
          collapse.ensureVisibleFocus();
        },
        '$mod+Shift+e e e e': (e) => {
          e.preventDefault();
          const maxDepth = collapse.getMaxDepthFrom(null);
          collapse.collapseToDepth(null, maxDepth);
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

        // FLO-102: Export to markdown (copies to clipboard)
        '$mod+Shift+m': (e) => {
          e.preventDefault();
          exportToMarkdown();
        },
      });
      onCleanup(unsubscribe);
    }
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
            {/* Zoomed: breadcrumb + single block subtree */}
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
              <LinkedReferences pageBlockId={zoomedRootId()!} paneId={props.paneId} />
            </Show>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
