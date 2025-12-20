/**
 * ResizeHandle - Draggable divider between split panes
 *
 * Uses PointerEvent for sub-pixel precision and proper capture.
 * During drag, terminals get pointer-events: none to prevent interference.
 *
 * NOTE: Uses ref for isDragging to avoid stale closure in pointer handlers.
 * State is only used for visual feedback (CSS class).
 */

import { useCallback, useRef, useState } from 'react';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  onResize: (ratio: number) => void;
  parentRef: React.RefObject<HTMLDivElement>;
}

export function ResizeHandle({ direction, onResize, parentRef }: ResizeHandleProps) {
  // Ref for actual drag state (avoids stale closure in handlers)
  const isDraggingRef = useRef(false);
  // State only for visual feedback (triggers re-render for CSS class)
  const [isDraggingVisual, setIsDraggingVisual] = useState(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Capture pointer for reliable tracking
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    isDraggingRef.current = true;
    setIsDraggingVisual(true);

    // Add resizing class to container (disables terminal pointer events)
    document.body.classList.add('resizing');
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;

    const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const parentRect = parentRef.current?.getBoundingClientRect();

    if (!parentRect) return;

    const parentStart = direction === 'horizontal' ? parentRect.left : parentRect.top;
    const parentSize = direction === 'horizontal' ? parentRect.width : parentRect.height;

    // Calculate new ratio based on pointer position within parent
    // Account for 4px handle width to get accurate ratio
    const handleWidth = 4;
    const effectiveSize = parentSize - handleWidth;
    const rawRatio = (currentPos - parentStart) / effectiveSize;
    // Clamp ratio to valid range before passing to handler
    const clampedRatio = Math.max(0.1, Math.min(0.9, rawRatio));
    onResize(clampedRatio);
  }, [direction, parentRef, onResize]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDraggingRef.current) return;

    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    isDraggingRef.current = false;
    setIsDraggingVisual(false);
    document.body.classList.remove('resizing');
  }, []);

  return (
    <div
      className={`resize-handle resize-handle-${direction} ${isDraggingVisual ? 'dragging' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
