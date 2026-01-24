import { createEffect, onMount, onCleanup, createSignal } from 'solid-js';
import { Outliner } from './Outliner';
import { type PaneHandle } from '../lib/layoutTypes';
import { useWorkspace } from '../context/WorkspaceContext';

export type OutlinerPaneHandle = PaneHandle;

interface OutlinerPaneProps {
  id: string;
  placeholderId: string;
  isActive: boolean;
  isVisible: boolean;
  // FLO-77: Initial scroll position for cloned panes
  initialScrollTop?: number;
  // FLO-197: Initial collapse depth for split panes (0 = clone exact state)
  initialCollapseDepth?: number;
  onPaneClick?: () => void;  // Called when pane is clicked (for focus tracking)
  ref?: (handle: OutlinerPaneHandle) => void;
}

export function OutlinerPane(props: OutlinerPaneProps) {
  const { paneStore } = useWorkspace();
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
      // FLO-197: Focus the stored focusedBlockId, not always the first block
      // This prevents the focus jump when clicking between panes
      const focusedId = paneStore.getFocusedBlockId(props.id);
      let targetBlock: HTMLElement | null = null;

      if (focusedId) {
        targetBlock = containerRef?.querySelector(`[data-block-id="${focusedId}"]`) as HTMLElement;
      }

      // Fallback to first block if focusedId not found in DOM
      if (!targetBlock) {
        targetBlock = containerRef?.querySelector('[data-block-id]') as HTMLElement;
      }

      const editor = targetBlock?.querySelector('[contenteditable]') as HTMLElement;
      editor?.focus({ preventScroll: true });
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

    // FLO-77: Apply initial scroll position for cloned panes
    if (props.initialScrollTop !== undefined && props.initialScrollTop > 0) {
      // Wait for Outliner to render, then apply scroll
      requestAnimationFrame(() => {
        const outlinerEl = containerRef?.querySelector('.outliner-container');
        if (outlinerEl) {
          outlinerEl.scrollTop = props.initialScrollTop!;
        }
      });
    }

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
      const frameId = requestAnimationFrame(() => {
        updatePosition();
      });
      // Cancel animation frame if effect re-runs or component unmounts
      onCleanup(() => {
        cancelAnimationFrame(frameId);
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
      <Outliner paneId={props.id} initialCollapseDepth={props.initialCollapseDepth} />
    </div>
  );
};
