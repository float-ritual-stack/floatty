/**
 * ResizeHandle - Draggable divider between split panes
 *
 * Uses PointerEvent for sub-pixel precision and proper capture.
 * During drag, terminals get pointer-events: none to prevent interference.
 *
 * NOTE: Uses a variable for isDragging to avoid stale closure in pointer handlers.
 * Signal is only used for visual feedback (CSS class).
 */

import { createSignal } from 'solid-js';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  onResize: (ratio: number) => void;
  parentRef: () => HTMLDivElement | undefined;
}

export function ResizeHandle(props: ResizeHandleProps) {
  // Variable for actual drag state (avoids stale closure in handlers)
  let isDragging = false;
  // Signal only for visual feedback (triggers re-render for CSS class)
  const [isDraggingVisual, setIsDraggingVisual] = createSignal(false);

  const handlePointerDown = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Capture pointer for reliable tracking
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    isDragging = true;
    setIsDraggingVisual(true);

    // Add resizing class to container (disables terminal pointer events)
    document.body.classList.add('resizing');
  };

  const handlePointerMove = (e: PointerEvent) => {
    if (!isDragging) return;

    const currentPos = props.direction === 'horizontal' ? e.clientX : e.clientY;
    const parentRect = props.parentRef()?.getBoundingClientRect();

    if (!parentRect) return;

    const parentStart = props.direction === 'horizontal' ? parentRect.left : parentRect.top;
    const parentSize = props.direction === 'horizontal' ? parentRect.width : parentRect.height;

    // Calculate ratio - offset by half handle width so pointer stays centered on handle
    const handleOffset = 2; // half of 4px handle
    const rawRatio = (currentPos - handleOffset - parentStart) / parentSize;
    // Clamp ratio to valid range before passing to handler
    const clampedRatio = Math.max(0.1, Math.min(0.9, rawRatio));
    props.onResize(clampedRatio);
  };

  const handlePointerUp = (e: PointerEvent) => {
    if (!isDragging) return;

    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    isDragging = false;
    setIsDraggingVisual(false);
    document.body.classList.remove('resizing');
  };

  return (
    <div
      class={`resize-handle resize-handle-${props.direction} ${isDraggingVisual() ? 'dragging' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
