import { createEffect, onMount, onCleanup, createSignal } from 'solid-js';
import { Outliner } from './Outliner';
import { type PaneHandle } from '../lib/layoutTypes';

export type OutlinerPaneHandle = PaneHandle;

interface OutlinerPaneProps {
  id: string;
  placeholderId: string;
  isActive: boolean;
  isVisible: boolean;
  onPaneClick?: () => void;  // Called when pane is clicked (for focus tracking)
  ref?: (handle: OutlinerPaneHandle) => void;
}

export function OutlinerPane(props: OutlinerPaneProps) {
  let containerRef: HTMLDivElement | undefined;
  const [rect, setRect] = createSignal<{ top: number; left: number; width: number; height: number }>({
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  });

  // Imperative handle for parent
  const handle: OutlinerPaneHandle = {
    focus: () => {
      // Focus the first root block's editor (more specific than generic [contenteditable])
      const firstBlock = containerRef?.querySelector('[data-block-id]') as HTMLElement;
      const editor = firstBlock?.querySelector('[contenteditable]') as HTMLElement;
      editor?.focus();
    },
    fit: () => {
      updatePosition();
    },
    refresh: () => {
      updatePosition();
    }
  };

  // Register handle and set up resize tracking
  onMount(() => {
    props.ref?.(handle);
    updatePosition();

    // Watch for placeholder size/position changes (matches TerminalPane pattern)
    const placeholder = document.querySelector(`[data-pane-id="${props.placeholderId}"]`) as HTMLElement;
    let resizeObserver: ResizeObserver | undefined;

    if (placeholder) {
      resizeObserver = new ResizeObserver(() => {
        updatePosition();
      });
      resizeObserver.observe(placeholder);
    }

    // Also update on window resize (placeholder might move)
    window.addEventListener('resize', updatePosition);

    onCleanup(() => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updatePosition);
    });
  });

  // Update absolute position based on placeholder in PaneLayout
  const updatePosition = () => {
    const placeholder = document.querySelector(`[data-pane-id="${props.placeholderId}"]`);
    if (placeholder && containerRef) {
      const pRect = placeholder.getBoundingClientRect();
      const parentRect = containerRef.parentElement?.getBoundingClientRect();
      
      if (parentRect) {
        setRect({
          top: pRect.top - parentRect.top,
          left: pRect.left - parentRect.left,
          width: pRect.width,
          height: pRect.height,
        });
      }
    }
  };

  // Re-position whenever visibility or layout changes
  createEffect(() => {
    if (props.isVisible) {
      // Small delay to ensure DOM has updated after layout change
      requestAnimationFrame(() => {
        updatePosition();
      });
    }
  });

  return (
    <div
      ref={containerRef}
      class="terminal-pane-positioned"
      classList={{
        'pane-active': props.isActive,
      }}
      onMouseDown={() => props.onPaneClick?.()}
      style={{
        position: 'absolute',
        top: `${rect().top}px`,
        left: `${rect().left}px`,
        width: `${rect().width}px`,
        height: `${rect().height}px`,
        display: props.isVisible ? 'block' : 'none',
        "z-index": props.isActive ? 10 : 1,
      }}
    >
      <Outliner paneId={props.id} />
    </div>
  );
};
