/**
 * ResizeHandle - Draggable divider between split panes
 *
 * Uses PointerEvent for sub-pixel precision and proper capture.
 * During drag, terminals get pointer-events: none to prevent interference.
 */

import { useCallback, useRef, useState } from 'react';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  onResize: (ratio: number) => void;
  parentRef: React.RefObject<HTMLDivElement>;
}

export function ResizeHandle({ direction, onResize, parentRef }: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false);
  const startPosRef = useRef(0);
  const startSizeRef = useRef(0);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // Capture pointer for reliable tracking
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    setIsDragging(true);

    // Store starting position
    startPosRef.current = direction === 'horizontal' ? e.clientX : e.clientY;

    // Get parent container size
    if (parentRef.current) {
      const rect = parentRef.current.getBoundingClientRect();
      startSizeRef.current = direction === 'horizontal' ? rect.width : rect.height;
    }

    // Add resizing class to container (disables terminal pointer events)
    document.body.classList.add('resizing');
  }, [direction, parentRef]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;

    const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const parentRect = parentRef.current?.getBoundingClientRect();

    if (!parentRect) return;

    const parentStart = direction === 'horizontal' ? parentRect.left : parentRect.top;
    const parentSize = direction === 'horizontal' ? parentRect.width : parentRect.height;

    // Calculate new ratio based on pointer position within parent
    // Account for 4px handle width to get accurate ratio
    const handleWidth = 4;
    const effectiveSize = parentSize - handleWidth;
    const newRatio = (currentPos - parentStart) / effectiveSize;
    onResize(newRatio);
  }, [isDragging, direction, parentRef, onResize]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!isDragging) return;

    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    setIsDragging(false);
    document.body.classList.remove('resizing');
  }, [isDragging]);

  return (
    <div
      className={`resize-handle resize-handle-${direction} ${isDragging ? 'dragging' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}
