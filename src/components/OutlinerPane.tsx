import { createEffect, onMount, onCleanup, createSignal } from 'solid-js';
import { Outliner } from './Outliner';
import { type PaneHandle } from '../lib/layoutTypes';

export type OutlinerPaneHandle = PaneHandle;

interface OutlinerPaneProps {
  id: string;
  placeholderId: string;
  isActive: boolean;
  isVisible: boolean;
  // FLO-77: Initial scroll position for cloned panes
  initialScrollTop?: number;
  // FLO-136: Ephemeral pane indicator (preview mode)
  ephemeral?: boolean;
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

    // FLO-77: Apply initial scroll position for cloned panes
    // Use requestIdleCallback to avoid blocking initial render
    let scrollIdleId: number | undefined;
    let scrollRafId: number | undefined;
    let scrollTimeoutId: ReturnType<typeof setTimeout> | undefined;

    if (props.initialScrollTop !== undefined && props.initialScrollTop > 0) {
      const applyScroll = () => {
        const outlinerEl = containerRef?.querySelector('.outliner-container');
        if (outlinerEl) {
          outlinerEl.scrollTop = props.initialScrollTop!;
        }
      };
      // Prefer idle callback, fallback to rAF with delay
      if ('requestIdleCallback' in window) {
        scrollIdleId = requestIdleCallback(applyScroll, { timeout: 100 });
      } else {
        scrollRafId = requestAnimationFrame(() => {
          scrollTimeoutId = setTimeout(applyScroll, 16);
        });
      }
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
      // Cancel pending scroll restoration
      if (scrollIdleId !== undefined) cancelIdleCallback(scrollIdleId);
      if (scrollRafId !== undefined) cancelAnimationFrame(scrollRafId);
      if (scrollTimeoutId !== undefined) clearTimeout(scrollTimeoutId);
      // Disconnect observers
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
        'pane-ephemeral': props.ephemeral,
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
