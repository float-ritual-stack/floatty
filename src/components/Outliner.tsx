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
  const { findNextVisibleBlock, findPrevVisibleBlock, findFocusAfterDelete, getAncestors } = useBlockOperations();
  const [focusedBlockId, setFocusedBlockId] = createSignal<string | null>(null);
  const [confirmClear, setConfirmClear] = createSignal(false);

  // FLO-74: Multi-select state
  const [selectedBlockIds, setSelectedBlockIds] = createSignal<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = createSignal<string | null>(null);

  // Note: tinykeys handles Cmd+A sequence state internally
  // (no need for expansion level tracking in component state)

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

  // FLO-74 Refinement: Indent-based progressive Cmd+A expansion
  // Level 0: focused block only
  // Level 1: siblings (same parent)
  // Level 2+: climb ancestor chain (parent scope, grandparent scope, etc.)
  // When level exceeds ancestor count: select all
  const selectByIndentLevel = (level: number): string[] => {
    const focusedId = focusedBlockId();
    if (!focusedId) return getVisibleBlockIds();

    const visibleIds = getVisibleBlockIds();
    const visibleSet = new Set(visibleIds);

    // Level 0: just focused block
    if (level === 0) {
      return [focusedId];
    }

    const ancestors = getAncestors(focusedId); // [rootId, ..., parentId, focusedId]

    // Level 1: siblings (same parent)
    if (level === 1) {
      const parentId = store.blocks[focusedId]?.parentId;
      if (!parentId) {
        // Top-level block - siblings are other roots
        return [...store.rootIds];
      }
      return getSiblingsWithDescendants(parentId, visibleSet);
    }

    // Level 2+: climb ancestors
    // level=2 → parent, level=3 → grandparent, etc.
    const targetAncestorIdx = ancestors.length - level;

    if (targetAncestorIdx < 0) {
      // Climbed past root - select all
      return visibleIds;
    }

    const scopeId = ancestors[targetAncestorIdx];
    return getBlockWithVisibleDescendants(scopeId, visibleSet);
  };

  // Helper: get all visible children of a parent + their visible descendants
  const getSiblingsWithDescendants = (parentId: string, visibleSet: Set<string>): string[] => {
    const parent = store.blocks[parentId];
    if (!parent) return [];

    const result: string[] = [];
    for (const childId of parent.childIds) {
      if (visibleSet.has(childId)) {
        result.push(childId);
        result.push(...getVisibleDescendantsOf(childId, visibleSet));
      }
    }
    return result;
  };

  // Helper: get block + all visible descendants
  const getBlockWithVisibleDescendants = (blockId: string, visibleSet: Set<string>): string[] => {
    if (!visibleSet.has(blockId)) return [];
    return [blockId, ...getVisibleDescendantsOf(blockId, visibleSet)];
  };

  // Helper: recursively gather visible descendants
  const getVisibleDescendantsOf = (blockId: string, visibleSet: Set<string>): string[] => {
    const block = store.blocks[blockId];
    if (!block) return [];

    const result: string[] = [];
    for (const childId of block.childIds) {
      if (visibleSet.has(childId)) {
        result.push(childId);
        result.push(...getVisibleDescendantsOf(childId, visibleSet));
      }
    }
    return result;
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

    // Find focus target based on selection
    // For single block: use findFocusAfterDelete (prefers parent)
    // For multi-select: find common ancestor's parent
    let focusTarget: string | null = null;
    const selectedArray = Array.from(selected);

    if (selectedArray.length === 1) {
      focusTarget = findFocusAfterDelete(selectedArray[0], props.paneId);
    } else {
      // Multi-select: find common ancestor
      // If common ancestor is NOT being deleted → focus it directly
      // If common ancestor IS being deleted → find its parent
      const ancestorLists = selectedArray.map(id => getAncestors(id));
      let commonDepth = 0;
      const firstList = ancestorLists[0];

      if (firstList) {
        for (let i = 0; i < firstList.length; i++) {
          if (ancestorLists.every(list => list[i] === firstList[i])) {
            commonDepth = i + 1;
          } else {
            break;
          }
        }

        if (commonDepth > 0) {
          const commonAncestor = firstList[commonDepth - 1];
          // Key fix: only climb to parent if ancestor itself is being deleted
          if (selected.has(commonAncestor)) {
            focusTarget = findFocusAfterDelete(commonAncestor, props.paneId);
          } else {
            focusTarget = commonAncestor;
          }
        }
      }
    }

    // Delete all selected blocks atomically (single undo operation)
    store.deleteBlocks([...selected]);

    clearSelection();

    // Edge case: if zoomed and zoomed root now has no children, unzoom
    // (simpler than auto-creating, works for cross-pane deletes too)
    const zoomedRoot = zoomedRootId();
    if (zoomedRoot) {
      const zoomedBlock = store.blocks[zoomedRoot];
      if (zoomedBlock && zoomedBlock.childIds.length === 0) {
        paneStore.setZoomedRoot(props.paneId, null);
        setFocusedBlockId(zoomedRoot); // Focus the (now unzoomed) block
        return;
      }
    }

    // Focus parent (or sibling fallback), or if all deleted, clear focus
    if (focusTarget) {
      setFocusedBlockId(focusTarget);
    } else {
      // No blocks left - clear focus so auto-create effect can set it properly
      setFocusedBlockId(null);
    }
  };

  // FLO-74: Global keyboard handler for selection operations
  const handleOutlinerKeyDown = (e: KeyboardEvent) => {
    const selected = selectedBlockIds();
    const modKey = isMac ? e.metaKey : e.ctrlKey;
    const activeEl = document.activeElement;
    const isEditing = activeEl?.getAttribute('contenteditable') === 'true';

    // FLO-74: Clear selection when typing starts (prevents accidental delete)
    // Printable character while editing with multi-select → clear selection, continue typing
    if (selected.size > 0 && isEditing && e.key.length === 1 && !modKey && !e.ctrlKey && !e.altKey) {
      clearSelection();
      // Don't preventDefault - let typing continue in focused block
      return;
    }

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

    // FLO-74 Refinement: Progressive Cmd+A with indent-based expansion
    // Sequence pattern: Cmd+A, then tap A (no Cmd) to expand further
    // Level progression: focused → siblings → parent scope → grandparent → ... → all
    if (containerRef) {
      // Helper to handle expansion at given level
      const expandToLevel = (level: number, e: KeyboardEvent) => {
        const isEditing = document.activeElement?.getAttribute('contenteditable') === 'true';
        if (isEditing) return; // Let browser select text
        e.preventDefault();

        const idsToSelect = selectByIndentLevel(level);
        setSelectedBlockIds(new Set(idsToSelect));
        setSelectionAnchor(idsToSelect[0] ?? null);
      };

      const unsubscribe = tinykeys(containerRef, {
        // Cmd+A → level 0 (focused block only)
        '$mod+a': (e) => expandToLevel(0, e),
        // Cmd+A, then A → level 1 (siblings)
        '$mod+a a': (e) => expandToLevel(1, e),
        // Cmd+A, A, A → level 2 (parent scope)
        '$mod+a a a': (e) => expandToLevel(2, e),
        // Cmd+A, A, A, A → level 3 (grandparent scope)
        '$mod+a a a a': (e) => expandToLevel(3, e),
        // Cmd+A, A, A, A, A → level 4+ (select all)
        '$mod+a a a a a': (e) => expandToLevel(4, e),
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
