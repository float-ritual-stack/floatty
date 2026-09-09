import { batch, createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { useWorkspace, type BlockStoreInterface, type PaneStoreInterface } from '../context/WorkspaceContext';

import { parseQuery } from '../lib/queryPredicate';
import { stampForQuery } from '../lib/queryStamp';
import { defaultPropTable, setMarkerValue } from '../lib/markerSurgery';
import { createLogger } from '../lib/logger';

const logger = createLogger('useBlockDrag');

type DropPosition = 'above' | 'below' | 'inside';

interface DragState {
  activeDragId: string | null;
  sourceQueryId: string | null;
  queryDropTargetId: string | null;
  dragRootId: string | null;
  sourcePaneId: string | null;
  dropTargetId: string | null;
  dropPosition: DropPosition | null;
  targetParentId: string | null;
  targetIndex: number;
  targetPaneId: string | null;
  isValidDrop: boolean;
  overlayVisible: boolean;
  overlayX: number;
  overlayY: number;
  overlayWidth: number;
}

type DropResolution = { kind: 'query-stamp'; queryBlockId: string; paneId: string | null } | BlockDropResolution;

interface BlockDropResolution {
  kind: 'block';
  targetId: string | null;
  targetParentId: string | null;
  targetIndex: number;
  position: DropPosition;
  targetPaneId: string | null;
  overlayX: number;
  overlayY: number;
  overlayWidth: number;
}

function createInitialDragState(): DragState {
  return {
    activeDragId: null,
    sourceQueryId: null,
    queryDropTargetId: null,
    dragRootId: null,
    sourcePaneId: null,
    dropTargetId: null,
    dropPosition: null,
    targetParentId: null,
    targetIndex: -1,
    targetPaneId: null,
    isValidDrop: false,
    overlayVisible: false,
    overlayX: 0,
    overlayY: 0,
    overlayWidth: 0,
  };
}

const runtime = createRoot(() => {
  const [state, setState] = createStore<DragState>(createInitialDragState());

  let rafId: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let pointerCapture: { target: Element; pointerId: number } | null = null;
  let moveListener: ((e: PointerEvent) => void) | null = null;
  let upListener: ((e: PointerEvent) => void) | null = null;
  let cancelListener: (() => void) | null = null;
  let keyListener: ((e: KeyboardEvent) => void) | null = null;
  let activeStore: BlockStoreInterface | null = null;
  let activePaneStore: PaneStoreInterface | null = null;

  const clearDropResolution = () => {
    batch(() => {
      setState('queryDropTargetId', null);
      setState('dropTargetId', null);
      setState('dropPosition', null);
      setState('targetParentId', null);
      setState('targetIndex', -1);
      setState('targetPaneId', null);
      setState('isValidDrop', false);
      setState('overlayVisible', false);
    });
  };

  const releasePointerCapture = () => {
    if (!pointerCapture) return;
    const { target, pointerId } = pointerCapture;
    pointerCapture = null;
    try {
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // no-op: target may already be detached
    }
  };

  const detachListeners = () => {
    if (moveListener) {
      window.removeEventListener('pointermove', moveListener);
      moveListener = null;
    }
    if (upListener) {
      window.removeEventListener('pointerup', upListener);
      upListener = null;
    }
    if (cancelListener) {
      window.removeEventListener('pointercancel', cancelListener);
      window.removeEventListener('blur', cancelListener);
      cancelListener = null;
    }
    if (keyListener) {
      window.removeEventListener('keydown', keyListener, true);
      keyListener = null;
    }
  };

  const resetDragState = () => {
    detachListeners();
    releasePointerCapture();
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    activeStore = null;
    activePaneStore = null;
    lastX = 0;
    lastY = 0;
    setState(createInitialDragState());
    document.body.classList.remove('block-dragging');
  };

  const isDescendant = (sourceId: string, targetId: string): boolean => {
    if (!activeStore) return false;
    const source = activeStore.getBlock(sourceId);
    if (!source) return false;

    const stack = [...source.childIds];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === targetId) return true;
      const block = activeStore.getBlock(id);
      if (block?.childIds.length) {
        stack.push(...block.childIds);
      }
    }

    return false;
  };

  const getPaneIdForContainer = (container: HTMLElement): string | null => {
    const attr = container.getAttribute('data-pane-id');
    if (attr) return attr;
    const parentWithPane = container.closest('[data-pane-id]');
    return parentWithPane?.getAttribute('data-pane-id') ?? null;
  };

  const isContainerInteractive = (container: HTMLElement): boolean => {
    const style = getComputedStyle(container);
    if (style.pointerEvents === 'none') return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  };

  const findContainerPane = (x: number, y: number): { paneId: string | null; zoomRoot: string | null } => {
    const containers = Array.from(document.querySelectorAll('.outliner-container')) as HTMLElement[];
    for (const container of containers) {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
      if (!isContainerInteractive(container)) continue;

      const paneId = getPaneIdForContainer(container);
      const zoomRoot = paneId && activePaneStore ? activePaneStore.getZoomedRootId(paneId) : null;
      return { paneId, zoomRoot };
    }
    return { paneId: null, zoomRoot: null };
  };

  const resolveDrop = (x: number, y: number): DropResolution | null => {
    if (!activeStore || !state.activeDragId) return null;

    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const queryArea = el?.closest<HTMLElement>('[data-query-drop]');
    if (queryArea?.dataset.queryDrop) {
      return { kind: 'query-stamp', queryBlockId: queryArea.dataset.queryDrop, paneId: getPaneIdForContainer(queryArea) };
    }
    const row = el?.closest('[data-block-id]') as HTMLElement | null;

    if (!row) {
      const { paneId, zoomRoot } = findContainerPane(x, y);
      if (!paneId) return null;

      if (zoomRoot) {
        const zoomedBlock = activeStore.getBlock(zoomRoot);
        return {
          kind: 'block',
          targetId: zoomRoot,
          targetParentId: zoomRoot,
          targetIndex: zoomedBlock?.childIds.length ?? 0,
          position: 'inside',
          targetPaneId: paneId,
          overlayX: x - 80,
          overlayY: y,
          overlayWidth: 160,
        };
      }

      return {
        kind: 'block',
        targetId: null,
        targetParentId: null,
        targetIndex: activeStore.rootIds.length,
        position: 'inside',
        targetPaneId: paneId,
        overlayX: x - 80,
        overlayY: y,
        overlayWidth: 160,
      };
    }

    const targetId = row.getAttribute('data-block-id');
    if (!targetId) return null;

    const targetPaneId = row.getAttribute('data-pane-id')
      ?? row.closest('[data-pane-id]')?.getAttribute('data-pane-id')
      ?? null;
    const target = activeStore.getBlock(targetId);
    if (!target) return null;

    const rect = row.getBoundingClientRect();
    const relY = y - rect.top;
    const topCut = rect.height * 0.25;
    const bottomCut = rect.height * 0.75;

    if (relY < topCut) {
      const parentId = target.parentId;
      const siblings = parentId ? (activeStore.getBlock(parentId)?.childIds ?? []) : activeStore.rootIds;
      return {
        kind: 'block',
        targetId,
        targetParentId: parentId,
        targetIndex: Math.max(0, siblings.indexOf(targetId)),
        position: 'above',
        targetPaneId,
        overlayX: rect.left + 24,
        overlayY: rect.top,
        overlayWidth: Math.max(40, rect.width - 28),
      };
    }

    if (relY > bottomCut) {
      const parentId = target.parentId;
      const siblings = parentId ? (activeStore.getBlock(parentId)?.childIds ?? []) : activeStore.rootIds;
      return {
        kind: 'block',
        targetId,
        targetParentId: parentId,
        targetIndex: Math.max(0, siblings.indexOf(targetId) + 1),
        position: 'below',
        targetPaneId,
        overlayX: rect.left + 24,
        overlayY: rect.bottom,
        overlayWidth: Math.max(40, rect.width - 28),
      };
    }

    // Pointer split policy for "inside":
    // upper half inserts at top, lower half inserts at end.
    const insideIndex = relY < rect.height / 2 ? 0 : target.childIds.length;
    return {
      kind: 'block',
      targetId,
      targetParentId: targetId,
      targetIndex: insideIndex,
      position: 'inside',
      targetPaneId,
      overlayX: rect.left + 36,
      overlayY: relY < rect.height / 2 ? rect.top + 6 : rect.bottom - 6,
      overlayWidth: Math.max(28, rect.width - 42),
    };
  };

  const isNoopMove = (sourceId: string, targetParentId: string | null, targetIndex: number): boolean => {
    if (!activeStore) return true;
    const source = activeStore.getBlock(sourceId);
    if (!source) return true;

    const oldParentId = source.parentId;
    const oldSiblings = oldParentId
      ? (activeStore.getBlock(oldParentId)?.childIds ?? [])
      : activeStore.rootIds;
    const oldIndex = oldSiblings.indexOf(sourceId);
    if (oldIndex < 0) return true;

    const targetSiblings = targetParentId
      ? (activeStore.getBlock(targetParentId)?.childIds ?? [])
      : activeStore.rootIds;
    const clampedTarget = Math.max(0, Math.min(targetIndex, targetSiblings.length));
    const adjustedTarget =
      oldParentId === targetParentId && oldIndex < clampedTarget
        ? clampedTarget - 1
        : clampedTarget;

    return oldParentId === targetParentId && oldIndex === adjustedTarget;
  };

  const isValidDrop = (sourceId: string, resolution: DropResolution): boolean => {
    if (!activeStore) return false;
    if (!activeStore.getBlock(sourceId)) return false;

    if (resolution.kind === 'query-stamp') {
      return sourceId !== resolution.queryBlockId
        && state.sourceQueryId !== resolution.queryBlockId
        && !isDescendant(sourceId, resolution.queryBlockId)
        && !parseQuery(activeStore.getBlock(sourceId)?.content ?? '').isQuery
        && parseQuery(activeStore.getBlock(resolution.queryBlockId)?.content ?? '').isQuery;
    }

    const { targetParentId } = resolution;
    if (targetParentId === sourceId) return false;
    if (targetParentId && isDescendant(sourceId, targetParentId)) return false;
    if (isNoopMove(sourceId, targetParentId, resolution.targetIndex)) return false;

    return true;
  };

  const applyResolution = (resolution: DropResolution | null) => {
    const sourceId = state.activeDragId;
    if (!sourceId || !resolution) {
      clearDropResolution();
      return;
    }

    const valid = isValidDrop(sourceId, resolution);
    if (resolution.kind === 'query-stamp') {
      clearDropResolution();
      batch(() => {
        setState('queryDropTargetId', resolution.queryBlockId);
        setState('targetPaneId', resolution.paneId);
        setState('isValidDrop', valid);
      });
      return;
    }
    batch(() => {
      setState('queryDropTargetId', null);
      setState('dropTargetId', resolution.targetId);
      setState('dropPosition', resolution.position);
      setState('targetParentId', resolution.targetParentId);
      setState('targetIndex', resolution.targetIndex);
      setState('targetPaneId', resolution.targetPaneId);
      setState('isValidDrop', valid);
      setState('overlayVisible', true);
      setState('overlayX', resolution.overlayX);
      setState('overlayY', resolution.overlayY);
      setState('overlayWidth', resolution.overlayWidth);
    });
  };

  const scheduleResolve = () => {
    if (rafId !== null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      applyResolution(resolveDrop(lastX, lastY));
    });
  };

  const finishDrag = (commit: boolean, finalResolution: DropResolution | null = null) => {
    const sourceId = state.activeDragId;
    const sourcePaneId = state.sourcePaneId;

    let movedBlockId: string | null = null;
    let stamped = false;

    if (commit && sourceId && activeStore) {
      const resolved = finalResolution ?? resolveDrop(lastX, lastY);
      if (resolved && isValidDrop(sourceId, resolved)) {
        if (resolved.kind === 'query-stamp') {
          // End the source editor's boundary BEFORE reading: blur commits any
          // pending typing, and releases useContentSync's focused/user gate.
          const active = document.activeElement;
          const sourceEditor = active instanceof HTMLElement
            && active.matches('[contenteditable="true"]')
            && active.closest('[data-block-id]')?.getAttribute('data-block-id') === sourceId
            ? active : null;
          const container = sourceEditor?.closest<HTMLElement>('.outliner-container');
          if (sourceEditor) {
            sourceEditor.blur();
            container?.focus({ preventScroll: true });
            if (sourcePaneId) activePaneStore?.setFocusedBlockId(sourcePaneId, null);
          }
          const source = activeStore.getBlock(sourceId);
          const query = activeStore.getBlock(resolved.queryBlockId);
          if (source && query && !parseQuery(source.content).isQuery) {
            const table = defaultPropTable();
            const stamp = stampForQuery(parseQuery(query.content), table);
            const change = setMarkerValue(source.content, { set: stamp, unset: [] }, table);
            if (Object.keys(change.rejected).length) {
              logger.warn('Query stamp rejected; block left untouched', { sourceId, rejected: change.rejected });
            } else {
              if (change.changed) activeStore.updateBlockContent(sourceId, change.content);
              stamped = true;
            }
          }
          if (sourceEditor && sourcePaneId) {
            // Leave selection-mode focus before the BlockItem focus effect.
            container?.blur();
            activePaneStore?.setFocusedBlockId(sourcePaneId, sourceId);
          }
        } else {
          const moved = activeStore.moveBlock(sourceId, resolved.targetParentId, resolved.targetIndex, {
            position: resolved.position,
            targetId: resolved.targetId,
            sourcePaneId: sourcePaneId ?? undefined,
            targetPaneId: resolved.targetPaneId ?? undefined,
            origin: 'user-drag',
          });
          if (moved) {
            movedBlockId = sourceId;
            // Expand collapsed target so the dropped block is visible
            if (resolved.position === 'inside' && resolved.targetPaneId && resolved.targetParentId && activePaneStore) {
              activePaneStore.setCollapsed(resolved.targetPaneId, resolved.targetParentId, false);
            }
          }
        }
      }
    }

    resetDragState();

    if (movedBlockId) {
      requestAnimationFrame(() => {
        const blockItem = document.querySelector(`[data-block-id="${movedBlockId}"]`);
        if (!blockItem) return;
        blockItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        // Add class to .block-wrapper (parent) so .block-children descendants also flash
        const wrapper = blockItem.closest('.block-wrapper');
        if (!wrapper) return;
        wrapper.classList.add('block-just-dropped');
        setTimeout(() => wrapper.classList.remove('block-just-dropped'), 1200);
      });
    }
    return stamped;
  };

  const startDrag = (
    event: PointerEvent,
    blockId: string,
    paneId: string,
    blockStore: BlockStoreInterface,
    paneStore: PaneStoreInterface
  ) => {
    if (event.button !== 0) return;
    if (!blockStore.getBlock(blockId)) return;

    resetDragState();
    activeStore = blockStore;
    activePaneStore = paneStore;

    const currentTarget = event.currentTarget;
    if (currentTarget instanceof Element) {
      try {
        currentTarget.setPointerCapture(event.pointerId);
        pointerCapture = { target: currentTarget, pointerId: event.pointerId };
      } catch {
        pointerCapture = null;
      }
    }

    batch(() => {
      setState('sourceQueryId', currentTarget instanceof Element
        ? currentTarget.closest<HTMLElement>('[data-query-drop]')?.dataset.queryDrop ?? null : null);
      setState('activeDragId', blockId);
      setState('dragRootId', blockId);
      setState('sourcePaneId', paneId);
    });

    lastX = event.clientX;
    lastY = event.clientY;
    document.body.classList.add('block-dragging');
    scheduleResolve();

    moveListener = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      lastX = moveEvent.clientX;
      lastY = moveEvent.clientY;
      scheduleResolve();
    };

    upListener = (upEvent: PointerEvent) => {
      lastX = upEvent.clientX;
      lastY = upEvent.clientY;
      const finalResolution = resolveDrop(lastX, lastY);
      finishDrag(true, finalResolution);
    };

    cancelListener = () => {
      finishDrag(false);
    };

    keyListener = (keydownEvent: KeyboardEvent) => {
      if (keydownEvent.key !== 'Escape') return;
      keydownEvent.preventDefault();
      keydownEvent.stopPropagation();
      finishDrag(false);
    };

    window.addEventListener('pointermove', moveListener, { passive: false });
    window.addEventListener('pointerup', upListener);
    window.addEventListener('pointercancel', cancelListener);
    window.addEventListener('blur', cancelListener);
    window.addEventListener('keydown', keyListener, true);
  };

  const moveToQuery = (
    blockId: string,
    sourceQueryId: string,
    queryBlockId: string,
    paneId: string,
    blockStore: BlockStoreInterface,
    paneStore: PaneStoreInterface,
  ) => {
    resetDragState();
    activeStore = blockStore;
    activePaneStore = paneStore;
    setState({ activeDragId: blockId, sourceQueryId, sourcePaneId: paneId });
    return finishDrag(true, { kind: 'query-stamp', queryBlockId, paneId });
  };

  return {
    state,
    startDrag,
    moveToQuery,
  };
});

export function useBlockDrag() {
  const { blockStore, paneStore } = useWorkspace();

  return {
    onHandlePointerDown: (event: PointerEvent, blockId: string, paneId: string) => {
      runtime.startDrag(event, blockId, paneId, blockStore, paneStore);
    },
    moveToQuery: (blockId: string, sourceQueryId: string, queryBlockId: string, paneId: string) => {
      return runtime.moveToQuery(blockId, sourceQueryId, queryBlockId, paneId, blockStore, paneStore);
    },
    isQueryDropTarget: (blockId: string, paneId: string) => runtime.state.queryDropTargetId === blockId
      && runtime.state.targetPaneId === paneId && runtime.state.isValidDrop,
    activeDragId: () => runtime.state.activeDragId,
    dragRootId: () => runtime.state.dragRootId,
    dropTargetId: () => runtime.state.dropTargetId,
    dropPosition: () => runtime.state.dropPosition,
    isValidDrop: () => runtime.state.isValidDrop,
    showOverlayFor: (blockId: string) =>
      runtime.state.overlayVisible && runtime.state.activeDragId === blockId,
    overlayStyle: () => ({
      position: 'fixed',
      transform: `translate3d(${Math.round(runtime.state.overlayX)}px, ${Math.round(runtime.state.overlayY)}px, 0)`,
      width: `${Math.max(24, Math.round(runtime.state.overlayWidth))}px`,
    }),
  };
}
