/**
 * ResizeOverlay - Renders VISIBLE resize handles ABOVE the terminal layer
 *
 * Architecture: PaneLayout renders invisible spacer divs between panes.
 * This overlay renders visible, interactive handles positioned over those spacers.
 * This solves the problem of terminals blocking pointer events on the layout layer.
 */

import { createSignal, Show, createMemo, createEffect, on, onMount, onCleanup } from 'solid-js';
import { createLogger } from '../lib/logger';
import { Key } from '@solid-primitives/keyed';
import { layoutStore } from '../hooks/useLayoutStore';
import { terminalManager } from '../lib/terminalManager';
import type { LayoutNode, PaneSplit } from '../lib/layoutTypes';

// Layout constants
const Z_INDEX_RESIZE_OVERLAY = 150;  // Above terminals (typically z-index: 100)
const HANDLE_CENTER_OFFSET = 2;      // Offset to center cursor on handle during drag
const MIN_SPLIT_RATIO = 0.1;         // Minimum pane size (10%)
const MAX_SPLIT_RATIO = 0.9;         // Maximum pane size (90%)
const RESIZE_THROTTLE_MS = 50;       // Throttle resize events during drag
const RESIZE_DRAG_TICK_EVENT = 'floatty:resize-drag-tick';
// Note: Hit area expansion (4px padding) is handled via CSS ::before pseudo-element

const logger = createLogger('ResizeOverlay');

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
  let lastResizeDispatch = 0;  // Throttle resize events during drag
  const [isDraggingVisual, setIsDraggingVisual] = createSignal(false);
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  let splitContainerCache: HTMLElement | null = null;

  // Track active window listeners for cleanup on unmount
  let activePointerMoveListener: ((e: PointerEvent) => void) | null = null;
  let activePointerUpListener: (() => void) | null = null;

  // Query the spacer element for this split (used for positioning)
  const getSpacerElement = (): HTMLElement | null => {
    return document.querySelector(
      `.pane-layout-split[data-split-id="${props.splitId}"] > .resize-spacer`
    );
  };

  // Cache split container during drag to avoid repeated selector scans
  const getSplitContainer = (): HTMLElement | null => {
    if (splitContainerCache && splitContainerCache.isConnected) {
      return splitContainerCache;
    }
    splitContainerCache = document.querySelector(
      `.pane-layout-split[data-split-id="${props.splitId}"]`
    ) as HTMLElement | null;
    return splitContainerCache;
  };

  // Sync overlay position to match the spacer
  const syncPosition = () => {
    const spacer = getSpacerElement();
    if (spacer) {
      setRect(spacer.getBoundingClientRect());
    }
  };

  // Find the spacer and match its position
  // All handles update during drag - siblings need to track layout changes too
  const updatePosition = () => {
    syncPosition();
  };

  // Update position on mount and observe container resize
  onMount(() => {
    const observer = new ResizeObserver(updatePosition);
    let retryCount = 0;
    const maxRetries = 10;
    const retryDelay = 50; // ms

    // Try to find and observe the split container, with retries for timing issues
    const trySetupObserver = () => {
      const splitContainer = getSplitContainer();

      if (splitContainer) {
        observer.observe(splitContainer);
        updatePosition();
        return true;
      }

      // Retry if DOM not ready yet (happens after layout changes)
      if (retryCount < maxRetries) {
        retryCount++;
        setTimeout(trySetupObserver, retryDelay);
        return false;
      }

      logger.warn(`Could not find split container for ${props.splitId} after ${maxRetries} retries`);
      return false;
    };

    trySetupObserver();

    const globalContainer = document.querySelector('.terminal-container');
    if (globalContainer) {
      observer.observe(globalContainer);
    }

    onCleanup(() => {
      observer.disconnect();

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
        layoutStore.setDraggingSplitId(null);
        document.body.classList.remove('resizing');
        // FIX: Reset terminal manager drag state to unblock fit() calls
        terminalManager.setDragging(false);
      }
    });
  });

  // Sync all handles during drag - siblings need to track layout changes
  createEffect(() => {
    const dragging = layoutStore.draggingSplitId;
    if (dragging === null) {
      // Dragging ended - final sync
      requestAnimationFrame(syncPosition);
    } else if (dragging !== props.splitId) {
      // Another handle is being dragged - follow its resize ticks.
      const handleDragTick = () => {
        syncPosition();
      };
      window.addEventListener(RESIZE_DRAG_TICK_EVENT, handleDragTick);

      // Cleanup when effect reruns or component unmounts
      onCleanup(() => {
        window.removeEventListener(RESIZE_DRAG_TICK_EVENT, handleDragTick);
      });
    }
  });

  // Re-sync handle position when layout tree structure changes.
  // ResizeObserver only fires on size changes, not position changes.
  // After pane drag-drop rearrangement, a split container may move without resizing.
  createEffect(on(
    () => layoutStore.layouts[props.tabId]?.root,
    () => {
      splitContainerCache = null;
      requestAnimationFrame(syncPosition);
    },
    { defer: true }
  ));

  // Use window listeners for move/up to avoid pointer capture issues
  const onWindowPointerMove = (e: PointerEvent) => {
    if (!isDragging) return;

    // Find the parent split container to calculate ratio
    const splitContainer = getSplitContainer();

    if (!splitContainer) return;

    const parentRect = splitContainer.getBoundingClientRect();
    const currentPos = props.direction === 'horizontal' ? e.clientX : e.clientY;
    const parentStart = props.direction === 'horizontal' ? parentRect.left : parentRect.top;
    const parentSize = props.direction === 'horizontal' ? parentRect.width : parentRect.height;

    const rawRatio = (currentPos - HANDLE_CENTER_OFFSET - parentStart) / parentSize;
    const clampedRatio = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, rawRatio));

    layoutStore.setRatio(props.tabId, props.splitId, clampedRatio);

    // Sync overlay handle position to match updated spacer position
    // Must happen AFTER setRatio updates the flex layout
    requestAnimationFrame(syncPosition);

    // Throttled resize event to keep terminals in sync during drag
    const now = Date.now();
    if (now - lastResizeDispatch > RESIZE_THROTTLE_MS) {
      lastResizeDispatch = now;
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event(RESIZE_DRAG_TICK_EVENT));
    }
  };

  const onWindowPointerUp = () => {
    if (!isDragging) return;
    isDragging = false;
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

    // Clear drag state in store - this triggers createEffect in all handles to resync
    layoutStore.setDraggingSplitId(null);

    // Signal drag end to terminalManager (FLO-88)
    // This starts a 150ms timeout that:
    // 1. Keeps isDragging=true to suppress debounced fit() calls
    // 2. Then does one clean fit() + scroll restore per terminal
    // No need to dispatch resize event - the restoration timeout handles it
    terminalManager.setDragging(false);
  };

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    layoutStore.setDraggingSplitId(props.splitId);  // Set drag state in store
    terminalManager.setDragging(true);  // Suppress fit() during drag (FLO-88)
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
        class={`resize-overlay-handle resize-overlay-${props.direction} ${isDraggingVisual() ? 'dragging' : ''}`}
        style={{
          position: 'fixed',
          // Position exactly on the spacer - CSS handles hit area expansion
          left: `${rect()!.left}px`,
          top: `${rect()!.top}px`,
          width: `${rect()!.width}px`,
          height: `${rect()!.height}px`,
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
      {/* Use <Key> for stable identity - <For> would unmount/remount on layout changes */}
      <Key each={splits()} by={(split) => split.splitId}>
        {(split) => (
          <ResizeHitArea
            tabId={props.tabId}
            splitId={split().splitId}
            direction={split().direction}
          />
        )}
      </Key>
    </Show>
  );
}
