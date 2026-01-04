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
import { isMac } from '../lib/keybinds';
import { blocksToMarkdown } from '../lib/markdownExport';

interface OutlinerProps {
  paneId: string;
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

  // Get current zoomed root for this pane (null = show all roots)
  const zoomedRootId = () => paneStore.getZoomedRootId(props.paneId);

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

        await navigator.clipboard.writeText(markdown);
        console.log(`[FLO-102] Exported ${allIds.length} blocks to clipboard`);
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
        '$mod+z': (e) => {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement;
          activeEl?.blur?.();
          undo();
          requestAnimationFrame(() => {
            collapse.ensureVisibleFocus();
          });
        },
        '$mod+Shift+z': (e) => {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement;
          activeEl?.blur?.();
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
      <Show when={isLoaded()} fallback={<div class="ctx-empty-state">Loading workspace...</div>}>
        <Show when={store.rootIds.length > 0 || zoomedRootId()}>
          {/* Clear button - only show when not zoomed */}
          <Show when={!zoomedRootId()}>
            <div style={{ display: 'flex', "justify-content": 'flex-end', "margin-bottom": '4px', "padding-right": '4px' }}>
              <button
                class="ctx-retry-button"
                style={{
                  "font-size": "10px",
                  padding: "2px 6px",
                  border: '1px solid',
                  color: confirmClear() ? '#ef4444' : '#888',
                  "border-color": confirmClear() ? '#ef4444' : '#555',
                  background: confirmClear() ? 'rgba(239, 68, 68, 0.1)' : 'transparent'
                }}
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
          </Show>
        </Show>
      </Show>
    </div>
  );
}
