/**
 * ResizeOverlay - Renders resize handles ABOVE the terminal layer
 *
 * The problem: PaneLayout renders resize handles in the layout layer,
 * but terminals are absolutely positioned on top, blocking pointer events.
 *
 * The fix: Render invisible resize hit areas in a layer ABOVE the terminals.
 * These overlay the visual resize handles and forward events to the layout store.
 */

import { createSignal, For, Show, createMemo, onMount, onCleanup } from 'solid-js';
import { layoutStore } from '../hooks/useLayoutStore';
import type { LayoutNode, PaneSplit } from '../lib/layoutTypes';

// Layout constants
const Z_INDEX_RESIZE_OVERLAY = 150;  // Above terminals (typically z-index: 100)
const HIT_AREA_PADDING = 4;          // Pixels to expand hit area beyond visual handle
const HANDLE_CENTER_OFFSET = 2;      // Offset to center cursor on handle during drag
const MIN_SPLIT_RATIO = 0.1;         // Minimum pane size (10%)
const MAX_SPLIT_RATIO = 0.9;         // Maximum pane size (90%)

// Module-level drag state - prevents non-dragging handles from repositioning during drag
// This fixes the bug where dragging one handle causes sibling handles to jump around
let activeDragSplitId: string | null = null;

interface ResizeOverlayProps {
  tabId: string;
  isVisible: boolean;
}

interface SplitInfo {
  splitId: string;
  direction: 'horizontal' | 'vertical';
}

// Collect all splits from a layout tree
function collectSplits(node: LayoutNode): SplitInfo[] {
  if (node.type === 'leaf') return [];

  const split = node as PaneSplit;
  return [
    { splitId: split.id, direction: split.direction },
    ...collectSplits(split.children[0]),
    ...collectSplits(split.children[1]),
  ];
}

function ResizeHitArea(props: {
  tabId: string;
  splitId: string;
  direction: 'horizontal' | 'vertical';
}) {
  let isDragging = false;
  const [isDraggingVisual, setIsDraggingVisual] = createSignal(false);
  const [rect, setRect] = createSignal<DOMRect | null>(null);

  // Track active window listeners for cleanup on unmount
  let activePointerMoveListener: ((e: PointerEvent) => void) | null = null;
  let activePointerUpListener: (() => void) | null = null;

  // Query the visual handle element for this split
  const getHandleElement = (): HTMLElement | null => {
    return document.querySelector(
      `.pane-layout-split[data-split-id="${props.splitId}"] > .resize-handle`
    );
  };

  // Sync overlay position to match the visual handle
  const syncPosition = () => {
    const handle = getHandleElement();
    if (handle) {
      setRect(handle.getBoundingClientRect());
    }
  };

  // Find the visual resize handle and match its position
  const updatePosition = () => {
    // Skip position updates if ANOTHER handle is being dragged
    // This prevents sibling handles from jumping around during resize
    if (activeDragSplitId !== null && activeDragSplitId !== props.splitId) {
      return;
    }
    syncPosition();
  };

  // Update position on mount, observe container resize, and listen for overlay updates
  onMount(() => {
    updatePosition();

    // Observe BOTH the global container AND the specific split container
    // When sibling splits resize, the split container changes - we need to reposition
    const observer = new ResizeObserver(updatePosition);

    const splitContainer = document.querySelector(
      `.pane-layout-split[data-split-id="${props.splitId}"]`
    );
    if (splitContainer) {
      observer.observe(splitContainer);
    }

    const globalContainer = document.querySelector('.terminal-container');
    if (globalContainer) {
      observer.observe(globalContainer);
    }

    // Listen for resize-overlay-update to sync all handles after any drag ends
    // Use module-level activeDragSplitId to avoid stale closure issues with local isDragging
    const handleOverlayUpdate = () => {
      // Only sync if THIS handle is not currently being dragged
      if (activeDragSplitId !== props.splitId) {
        syncPosition();
      }
    };
    window.addEventListener('resize-overlay-update', handleOverlayUpdate);

    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('resize-overlay-update', handleOverlayUpdate);

      // CRITICAL: Clean up window listeners if unmount happens mid-drag
      // This prevents memory leak where orphaned listeners reference stale component state
      if (activePointerMoveListener) {
        window.removeEventListener('pointermove', activePointerMoveListener);
        activePointerMoveListener = null;
      }
      if (activePointerUpListener) {
        window.removeEventListener('pointerup', activePointerUpListener);
        activePointerUpListener = null;
      }
      if (isDragging) {
        isDragging = false;
        activeDragSplitId = null;
        document.body.classList.remove('resizing');
      }
    });
  });

  // Use window listeners for move/up to avoid pointer capture issues
  const onWindowPointerMove = (e: PointerEvent) => {
    if (!isDragging) return;

    // Find the parent split container to calculate ratio
    const splitContainer = document.querySelector(
      `.pane-layout-split[data-split-id="${props.splitId}"]`
    ) as HTMLElement | null;

    if (!splitContainer) return;

    const parentRect = splitContainer.getBoundingClientRect();
    const currentPos = props.direction === 'horizontal' ? e.clientX : e.clientY;
    const parentStart = props.direction === 'horizontal' ? parentRect.left : parentRect.top;
    const parentSize = props.direction === 'horizontal' ? parentRect.width : parentRect.height;

    const rawRatio = (currentPos - HANDLE_CENTER_OFFSET - parentStart) / parentSize;
    const clampedRatio = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, rawRatio));

    layoutStore.setRatio(props.tabId, props.splitId, clampedRatio);
  };

  const onWindowPointerUp = () => {
    if (!isDragging) return;
    isDragging = false;
    activeDragSplitId = null;  // Clear module-level drag state
    setIsDraggingVisual(false);
    document.body.classList.remove('resizing');

    // Remove and clear tracked listeners
    if (activePointerMoveListener) {
      window.removeEventListener('pointermove', activePointerMoveListener);
      activePointerMoveListener = null;
    }
    if (activePointerUpListener) {
      window.removeEventListener('pointerup', activePointerUpListener);
      activePointerUpListener = null;
    }

    // Update ALL overlay positions after drag ends
    // Use requestAnimationFrame to let layout settle first
    requestAnimationFrame(() => {
      // Dispatch a single event that all overlays listen to
      window.dispatchEvent(new CustomEvent('resize-overlay-update'));
    });
  };

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    activeDragSplitId = props.splitId;  // Set module-level drag state
    setIsDraggingVisual(true);
    document.body.classList.add('resizing');
    updatePosition();

    // Store references for cleanup (memory leak prevention)
    activePointerMoveListener = onWindowPointerMove;
    activePointerUpListener = onWindowPointerUp;

    // Add window listeners for move/up
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
  };

  return (
    <Show when={rect()}>
      <div
        class={`resize-overlay-handle ${isDraggingVisual() ? 'dragging' : ''}`}
        style={{
          position: 'fixed',
          left: `${rect()!.left - HIT_AREA_PADDING}px`,
          top: `${rect()!.top - HIT_AREA_PADDING}px`,
          width: props.direction === 'horizontal'
            ? `${HIT_AREA_PADDING * 2 + 4}px`  // 4px visual handle + padding on each side
            : `${rect()!.width + HIT_AREA_PADDING * 2}px`,
          height: props.direction === 'horizontal'
            ? `${rect()!.height + HIT_AREA_PADDING * 2}px`
            : `${HIT_AREA_PADDING * 2 + 4}px`,
          cursor: props.direction === 'horizontal' ? 'col-resize' : 'row-resize',
          'z-index': Z_INDEX_RESIZE_OVERLAY,
        }}
        onPointerDown={handlePointerDown}
      />
    </Show>
  );
}

export function ResizeOverlay(props: ResizeOverlayProps) {
  const splits = createMemo(() => {
    const layout = layoutStore.layouts[props.tabId];
    if (!layout) return [];
    return collectSplits(layout.root);
  });

  return (
    <Show when={props.isVisible}>
      <For each={splits()}>
        {(split) => (
          <ResizeHitArea
            tabId={props.tabId}
            splitId={split.splitId}
            direction={split.direction}
          />
        )}
      </For>
    </Show>
  );
}
