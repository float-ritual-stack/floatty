import { createSignal, createEffect, createMemo, onMount, onCleanup, Show } from 'solid-js';
import { Key } from '@solid-primitives/keyed';
import { tinykeys } from 'tinykeys';
import { useSyncedYDoc } from '../hooks/useSyncedYDoc';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { BlockItem } from './BlockItem';
import { Breadcrumb } from './Breadcrumb';
import { blocksToMarkdown } from '../lib/markdownExport';
import { isMac } from '../lib/keybinds';

interface OutlinerProps {
  paneId: string;
}

export function Outliner(props: OutlinerProps) {
  const { doc, isLoaded, undo, redo, clearUndoStack } = useSyncedYDoc();
  const { blockStore, paneStore } = useWorkspace();
  const store = blockStore;
  const { findNextVisibleBlock, findPrevVisibleBlock } = useBlockOperations();
  const [focusedBlockId, setFocusedBlockId] = createSignal<string | null>(null);
  const [confirmClear, setConfirmClear] = createSignal(false);

  // FLO-74: Multi-select state
  const [selectedBlockIds, setSelectedBlockIds] = createSignal<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = createSignal<string | null>(null);

  // FLO-74: Cleanup deleted blocks from selection (prevents memory leak)
  createEffect(() => {
    const selected = selectedBlockIds();
    const anchor = selectionAnchor();

    // Filter out any block IDs that no longer exist
    const validIds = new Set<string>();
    for (const id of selected) {
      if (store.blocks[id]) {
        validIds.add(id);
      }
    }

    // Only update if we removed any invalid IDs
    if (validIds.size !== selected.size) {
      setSelectedBlockIds(validIds);
    }

    // Clear anchor if it no longer exists
    if (anchor && !store.blocks[anchor]) {
      setSelectionAnchor(null);
    }
  });

  // Helper: move focus to valid block if current focus is orphaned
  const ensureValidFocus = () => {
    const focused = focusedBlockId();
    if (focused && !store.blocks[focused]) {
      const firstRoot = store.rootIds[0];
      setFocusedBlockId(firstRoot ?? null);
    }
  };

  // Get current zoomed root for this pane (null = show all roots)
  const zoomedRootId = () => paneStore.getZoomedRootId(props.paneId);

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

  // FLO-74: Selection handlers
  const handleSelect = (blockId: string, mode: 'set' | 'toggle' | 'range') => {
    if (mode === 'set') {
      // Clear selection, set anchor
      setSelectedBlockIds(new Set());
      setSelectionAnchor(blockId);
    } else if (mode === 'toggle') {
      // Toggle block in selection
      const current = new Set(selectedBlockIds());
      if (current.has(blockId)) {
        current.delete(blockId);
      } else {
        current.add(blockId);
      }
      setSelectedBlockIds(current);
      setSelectionAnchor(blockId);
    } else if (mode === 'range') {
      // Select range from anchor to blockId
      const anchor = selectionAnchor();
      if (!anchor) {
        setSelectedBlockIds(new Set([blockId]));
        setSelectionAnchor(blockId);
        return;
      }

      const visibleIds = getVisibleBlockIds();
      const anchorIdx = visibleIds.indexOf(anchor);
      const targetIdx = visibleIds.indexOf(blockId);

      if (anchorIdx === -1 || targetIdx === -1) {
        // Anchor or target not visible (collapsed/deleted) - reset to target
        setSelectedBlockIds(new Set([blockId]));
        setSelectionAnchor(blockId);
        return;
      }

      const [from, to] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      const rangeIds = visibleIds.slice(from, to + 1);
      setSelectedBlockIds(new Set(rangeIds));
    }
  };

  const clearSelection = () => {
    setSelectedBlockIds(new Set());
  };

  // Progressive Cmd+A: select focused → expand to heading scope → select all
  const selectFocused = () => {
    const focused = focusedBlockId();
    if (focused) {
      setSelectedBlockIds(new Set([focused]));
      setSelectionAnchor(focused);
    }
  };

  const selectHeadingScope = () => {
    const focused = focusedBlockId();
    if (!focused) return;

    const visibleIds = getVisibleBlockIds();
    const focusedIdx = visibleIds.indexOf(focused);
    if (focusedIdx === -1) return;

    // Find the heading that scopes this block (walk up to find h1/h2/h3)
    let scopeStart = focusedIdx;
    for (let i = focusedIdx - 1; i >= 0; i--) {
      const block = store.blocks[visibleIds[i]];
      if (block && (block.type === 'h1' || block.type === 'h2' || block.type === 'h3')) {
        scopeStart = i;
        break;
      }
    }

    // Find next heading of same or higher level (scope end)
    const scopeBlock = store.blocks[visibleIds[scopeStart]];
    if (!scopeBlock) return; // Block was deleted
    const scopeLevel = scopeBlock.type === 'h1' ? 1 : scopeBlock.type === 'h2' ? 2 : 3;
    let scopeEnd = visibleIds.length - 1;

    for (let i = scopeStart + 1; i < visibleIds.length; i++) {
      const block = store.blocks[visibleIds[i]];
      if (block) {
        const level = block.type === 'h1' ? 1 : block.type === 'h2' ? 2 : block.type === 'h3' ? 3 : 99;
        if (level <= scopeLevel) {
          scopeEnd = i - 1;
          break;
        }
      }
    }

    // Select all blocks in scope
    const scopeIds = visibleIds.slice(scopeStart, scopeEnd + 1);
    setSelectedBlockIds(new Set(scopeIds));
    setSelectionAnchor(visibleIds[scopeStart]);
  };

  const selectAll = () => {
    const allIds = getVisibleBlockIds();
    setSelectedBlockIds(new Set(allIds));
    if (allIds.length > 0) {
      setSelectionAnchor(allIds[0]);
    }
  };

  const copySelection = async () => {
    const selected = selectedBlockIds();
    if (selected.size === 0) {
      // Copy focused block if no selection
      const focused = focusedBlockId();
      if (focused) {
        const block = store.blocks[focused];
        if (block) {
          await navigator.clipboard.writeText(block.content);
        }
      }
      return;
    }

    const markdown = blocksToMarkdown(selected, store.blocks, getVisibleBlockIds());
    await navigator.clipboard.writeText(markdown);
  };

  const deleteSelection = () => {
    const selected = selectedBlockIds();
    if (selected.size === 0) return;

    // Find next block to focus after deletion
    const visibleIds = getVisibleBlockIds();
    const selectedArray = Array.from(selected);
    const firstSelectedIdx = Math.min(...selectedArray.map(id => visibleIds.indexOf(id)));
    const nextFocusId = visibleIds.find((id, idx) => idx > firstSelectedIdx && !selected.has(id))
      ?? visibleIds.find((id, idx) => idx < firstSelectedIdx && !selected.has(id));

    // Delete all selected blocks atomically (single undo operation)
    store.deleteBlocks([...selected]);

    clearSelection();

    // Focus next block, or if all deleted, clear focus and let auto-create handle it
    if (nextFocusId) {
      setFocusedBlockId(nextFocusId);
    } else {
      // No blocks left - clear focus so auto-create effect can set it properly
      setFocusedBlockId(null);
    }
  };

  // FLO-74: Global keyboard handler for selection operations
  const handleOutlinerKeyDown = (e: KeyboardEvent) => {
    const selected = selectedBlockIds();
    const modKey = isMac ? e.metaKey : e.ctrlKey;

    // Escape clears selection
    if (e.key === 'Escape' && selected.size > 0) {
      e.preventDefault();
      clearSelection();
      return;
    }

    // Progressive Cmd+A handled by tinykeys (see onMount)

    // Cmd+C copy selection
    if (modKey && e.key === 'c' && selected.size > 0) {
      e.preventDefault();
      copySelection();
      return;
    }

    // Delete/Backspace on selection (only when not editing a block)
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
      // Check if we're actively editing (contentEditable focused)
      const activeEl = document.activeElement;
      const isEditing = activeEl?.getAttribute('contenteditable') === 'true';
      if (!isEditing) {
        e.preventDefault();
        deleteSelection();
      }
    }
  };

  // Container ref for tinykeys
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    console.log('Outliner mounted for pane:', props.paneId);
    const dispose = store.initFromYDoc(doc);
    onCleanup(dispose);

    // Progressive Cmd+A sequences via tinykeys
    // Pattern: Cmd+A enters selection mode, then plain A expands
    if (containerRef) {
      const unsubscribe = tinykeys(containerRef, {
        // Progressive Cmd+A: only intercept when NOT editing text
        // When editing, let browser handle text selection
        '$mod+a': (e) => {
          const isEditing = document.activeElement?.getAttribute('contenteditable') === 'true';
          if (isEditing) return; // Let browser select text
          e.preventDefault();
          selectFocused();
        },
        // Second A (after Cmd+A): expand to heading scope
        '$mod+a a': (e) => {
          const isEditing = document.activeElement?.getAttribute('contenteditable') === 'true';
          if (isEditing) return;
          e.preventDefault();
          selectHeadingScope();
        },
        // Third A: select all
        '$mod+a a a': (e) => {
          const isEditing = document.activeElement?.getAttribute('contenteditable') === 'true';
          if (isEditing) return;
          e.preventDefault();
          selectAll();
        },
        // Undo/Redo (Y.Doc UndoManager)
        // Blur first so BlockItem syncs content from store on blur,
        // then validate focus and refocus
        '$mod+z': (e) => {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement;
          activeEl?.blur?.();
          undo();
          // After Y.Doc update, ensure focus is valid then refocus
          requestAnimationFrame(() => {
            ensureValidFocus();
            const focused = focusedBlockId();
            if (focused && store.blocks[focused]) {
              // Trigger refocus by resetting the signal
              setFocusedBlockId(null);
              setFocusedBlockId(focused);
            }
          });
        },
        '$mod+Shift+z': (e) => {
          e.preventDefault();
          const activeEl = document.activeElement as HTMLElement;
          activeEl?.blur?.();
          redo();
          requestAnimationFrame(() => {
            ensureValidFocus();
            const focused = focusedBlockId();
            if (focused && store.blocks[focused]) {
              setFocusedBlockId(null);
              setFocusedBlockId(focused);
            }
          });
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
        // Clear undo stack so user can't undo past the initial block
        // (prevents entering invalid zero-block state)
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
                      isBlockSelected={(blockId) => selectedBlockIds().has(blockId)}
                      onSelect={handleSelect}
                      selectionAnchor={selectionAnchor()}
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
              isBlockSelected={(blockId) => selectedBlockIds().has(blockId)}
              onSelect={handleSelect}
              selectionAnchor={selectionAnchor()}
              getVisibleBlockIds={getVisibleBlockIds}
            />
          </Show>
        </Show>
      </Show>
    </div>
  );
};
