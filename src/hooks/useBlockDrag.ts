import { batch, createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { useWorkspace, type BlockStoreInterface, type PaneStoreInterface } from '../context/WorkspaceContext';

type DropPosition = 'above' | 'below' | 'inside';

interface DragState {
  activeDragId: string | null;
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

interface DropResolution {
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

  const findContainerPane = (x: number, y: number): { paneId: string | null; zoomRoot: string | null } => {
    const containers = Array.from(document.querySelectorAll('.outliner-container')) as HTMLElement[];
    for (const container of containers) {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;

      const paneId = getPaneIdForContainer(container);
      const zoomRoot = paneId && activePaneStore ? activePaneStore.getZoomedRootId(paneId) : null;
      return { paneId, zoomRoot };
    }
    return { paneId: null, zoomRoot: null };
  };

  const resolveDrop = (x: number, y: number): DropResolution | null => {
    if (!activeStore || !state.activeDragId) return null;

    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const row = el?.closest('[data-block-id]') as HTMLElement | null;

    if (!row) {
      const { paneId, zoomRoot } = findContainerPane(x, y);
      if (!paneId) return null;

      if (zoomRoot) {
        const zoomedBlock = activeStore.getBlock(zoomRoot);
        return {
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
    batch(() => {
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

    if (commit && sourceId && activeStore) {
      const resolved = finalResolution ?? resolveDrop(lastX, lastY);
      if (resolved && isValidDrop(sourceId, resolved)) {
        activeStore.moveBlock(sourceId, resolved.targetParentId, resolved.targetIndex, {
          position: resolved.position,
          targetId: resolved.targetId,
          sourcePaneId: sourcePaneId ?? undefined,
          targetPaneId: resolved.targetPaneId ?? undefined,
          origin: 'user-drag',
        });
      }
    }

    resetDragState();
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

  return {
    state,
    startDrag,
  };
});

export function useBlockDrag() {
  const { blockStore, paneStore } = useWorkspace();

  return {
    onHandlePointerDown: (event: PointerEvent, blockId: string, paneId: string) => {
      runtime.startDrag(event, blockId, paneId, blockStore, paneStore);
    },
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
