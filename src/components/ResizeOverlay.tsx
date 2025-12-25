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
  // Position is determined by finding the resize handle in DOM
  handleSelector: string;
}

// Collect all splits from a layout tree
function collectSplits(node: LayoutNode, path: string[] = []): SplitInfo[] {
  if (node.type === 'leaf') return [];

  const split = node as PaneSplit;
  const splits: SplitInfo[] = [{
    splitId: split.id,
    direction: split.direction,
    handleSelector: `[data-split-id="${split.id}"] > .resize-handle`,
  }];

  return [
    ...splits,
    ...collectSplits(split.children[0], [...path, '0']),
    ...collectSplits(split.children[1], [...path, '1']),
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

  // Find the visual resize handle and match its position
  const updatePosition = () => {
    // Skip position updates if ANOTHER handle is being dragged
    // This prevents sibling handles from jumping around during resize
    if (activeDragSplitId !== null && activeDragSplitId !== props.splitId) {
      return;
    }

    const handle = document.querySelector(
      `.pane-layout-split[data-split-id="${props.splitId}"] > .resize-handle`
    ) as HTMLElement | null;

    if (handle) {
      setRect(handle.getBoundingClientRect());
    }
  };

  // Update position on mount and observe container resize
  onMount(() => {
    // Initial position update
    updatePosition();

    // Observe BOTH the global container AND the specific split container
    // When sibling splits resize, the split container changes - we need to reposition
    const observer = new ResizeObserver(updatePosition);

    // Observe the specific split container (for when siblings resize)
    const splitContainer = document.querySelector(
      `.pane-layout-split[data-split-id="${props.splitId}"]`
    );
    if (splitContainer) {
      observer.observe(splitContainer);
    }

    // Also observe the global container (for window resize, sidebar toggle, etc.)
    const globalContainer = document.querySelector('.terminal-container');
    if (globalContainer) {
      observer.observe(globalContainer);
    }

    // Clean up observer on unmount
    onCleanup(() => {
      observer.disconnect();
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

    const handleOffset = 2;
    const rawRatio = (currentPos - handleOffset - parentStart) / parentSize;
    const clampedRatio = Math.max(0.1, Math.min(0.9, rawRatio));

    layoutStore.setRatio(props.tabId, props.splitId, clampedRatio);
  };

  const onWindowPointerUp = () => {
    if (!isDragging) return;
    isDragging = false;
    activeDragSplitId = null;  // Clear module-level drag state
    setIsDraggingVisual(false);
    document.body.classList.remove('resizing');
    window.removeEventListener('pointermove', onWindowPointerMove);
    window.removeEventListener('pointerup', onWindowPointerUp);

    // Update ALL overlay positions after drag ends
    // Use requestAnimationFrame to let layout settle first
    requestAnimationFrame(() => {
      // Dispatch a single event that all overlays listen to
      window.dispatchEvent(new CustomEvent('resize-overlay-update'));
    });
  };

  // Listen for resize-overlay-update to sync all handles after any drag ends
  onMount(() => {
    const handleOverlayUpdate = () => {
      // Only update if we're not currently dragging
      if (!isDragging) {
        const handle = document.querySelector(
          `.pane-layout-split[data-split-id="${props.splitId}"] > .resize-handle`
        ) as HTMLElement | null;
        if (handle) {
          setRect(handle.getBoundingClientRect());
        }
      }
    };
    window.addEventListener('resize-overlay-update', handleOverlayUpdate);
    onCleanup(() => {
      window.removeEventListener('resize-overlay-update', handleOverlayUpdate);
    });
  });

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    isDragging = true;
    activeDragSplitId = props.splitId;  // Set module-level drag state
    setIsDraggingVisual(true);
    document.body.classList.add('resizing');
    updatePosition();

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
          left: `${rect()!.left - 4}px`,  // Expand hit area
          top: `${rect()!.top - 4}px`,
          width: props.direction === 'horizontal' ? '12px' : `${rect()!.width + 8}px`,
          height: props.direction === 'horizontal' ? `${rect()!.height + 8}px` : '12px',
          cursor: props.direction === 'horizontal' ? 'col-resize' : 'row-resize',
          'z-index': 150,  // Above terminals (z-index: 100) but not excessive
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
