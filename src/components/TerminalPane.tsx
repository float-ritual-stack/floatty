/**
 * TerminalPane - Terminal that positions itself over a placeholder
 *
 * Architecture (learned from VS Code / Hyper):
 * - xterm.js doesn't support reparenting
 * - So we render terminals in a SEPARATE layer from the layout
 * - Each terminal positions itself absolutely over its placeholder
 * - When layout changes, placeholders move, terminals reposition
 * - Terminals NEVER unmount during layout changes
 */

import { createEffect, on, onMount, onCleanup } from 'solid-js';
import { terminalManager } from '../lib/terminalManager';
import { type PaneHandle } from '../lib/layoutTypes';
import '@xterm/xterm/css/xterm.css';

export type TerminalPaneHandle = PaneHandle;

export interface TerminalPaneProps {
  id: string;
  cwd?: string;
  tmuxSession?: string;  // tmux session name for auto-reattach on restart
  placeholderId: string;  // ID of placeholder div to position over
  onPtySpawn?: (pid: number) => void;
  onPtyExit?: (exitCode: number) => void;
  onCtxMarker?: (marker: unknown) => void;
  onTitleChange?: (title: string) => void;
  onSemanticStateChange?: (state: unknown) => void;  // OSC 133/1337 state updates
  onStickyChange?: (sticky: boolean) => void;  // FLO-220: Scroll state changes
  onPaneClick?: () => void;  // Called when pane is clicked (for focus tracking)
  onDragHandlePointerDown?: (e: PointerEvent) => void;
  isActive?: boolean;
  isBeingDragged?: boolean;
  isVisible?: boolean;  // Whether the tab containing this pane is visible
  ref?: (handle: TerminalPaneHandle | null) => void;
}

export function TerminalPane(props: TerminalPaneProps) {
  let containerRef: HTMLDivElement | undefined;
  let terminalHostRef: HTMLDivElement | undefined;
  let attached = false;

  // Minimum dimension threshold - xterm.js misbehaves (scroll jumps, 0 rows) below this
  const MIN_DIMENSION = 10;

  // Debounce state for fit() - CSS updates are immediate, fit() is debounced
  let fitTimeout: ReturnType<typeof setTimeout> | undefined;

  // Schedule a debounced fit() call - expensive operation, rate-limited
  const scheduleFit = () => {
    if (fitTimeout) clearTimeout(fitTimeout);
    fitTimeout = setTimeout(() => {
      if (attached) {
        terminalManager.fit(props.id);
      }
    }, 50);
  };

  // Update CSS geometry synchronously - keeps terminal visually glued to placeholder
  // Uses provided dimensions (from ResizeObserver entry) or falls back to getBoundingClientRect
  const updateGeometry = (providedWidth?: number, providedHeight?: number) => {
    const placeholder = document.querySelector(`[data-pane-id="${props.placeholderId}"]`) as HTMLElement;

    if (!containerRef || !placeholder) return false;

    const rect = placeholder.getBoundingClientRect();
    const width = providedWidth ?? rect.width;
    const height = providedHeight ?? rect.height;

    // Zero-height guard: xterm.js calculates 0 rows on tiny containers,
    // causing scroll resets and undefined behavior (FLO-88 hardening)
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) return false;

    const parentRect = containerRef.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };

    containerRef.style.left = `${rect.left - parentRect.left}px`;
    containerRef.style.top = `${rect.top - parentRect.top}px`;
    containerRef.style.width = `${width}px`;
    containerRef.style.height = `${height}px`;

    return true;
  };

  // Full update: geometry (sync) + fit (debounced)
  // Used by imperative handle and visibility effect
  const updatePosition = () => {
    if (updateGeometry()) {
      scheduleFit();
    }
  };

  // Create the imperative handle
  const handle: TerminalPaneHandle = {
    focus: () => terminalManager.focus(props.id),
    fit: () => {
      // updatePosition() already calls fit(), so just call that
      updatePosition();
    },
    refresh: () => terminalManager.refresh(props.id),
    getPtyPid: () => terminalManager.getPtyPid(props.id),
    getTitle: () => terminalManager.getTitle(props.id),
  };

  // Update callbacks in manager when they change
  createEffect(() => {
    terminalManager.setCallbacks(props.id, {
      onPtySpawn: props.onPtySpawn,
      onPtyExit: props.onPtyExit,
      onTitleChange: props.onTitleChange,
      onCtxMarker: props.onCtxMarker as (marker: unknown) => void,
      onSemanticStateChange: props.onSemanticStateChange as (state: unknown) => void,
      onStickyChange: props.onStickyChange,
    });
  });

  // Initial attachment and position tracking
  onMount(async () => {
    if (!containerRef || !terminalHostRef) return;

    // Expose the handle via ref callback
    props.ref?.(handle);

    // Attach terminal once (await config load)
    if (!attached) {
      // Keep terminal attached to inner host while geometry is applied on outer container.
      // The host is kept 100% x 100% via CSS so fit() measures the positioned pane area.
      await terminalManager.attach(props.id, terminalHostRef, props.cwd, props.tmuxSession);
      attached = true;

    }

    // Initial position — skip when hidden (background tab).
    // fitAddon.fit() on a display:none container clamps to 2×1 cols,
    // corrupting tmux line wrapping. The visibility effect handles
    // fit-on-show when the tab becomes active.
    if (props.isVisible ?? true) {
      updatePosition();
    }

    // Watch for placeholder size/position changes
    const placeholder = document.querySelector(`[data-pane-id="${props.placeholderId}"]`) as HTMLElement;
    if (!placeholder) return;

    // ResizeObserver: CSS geometry updates SYNCHRONOUSLY, fit() is DEBOUNCED
    // This keeps the terminal visually glued to placeholder during resize
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const { width, height } = entry.contentRect;

      // Zero-height guard using entry dimensions directly (FLO-88 hardening)
      if (width < MIN_DIMENSION || height < MIN_DIMENSION) return;

      // Sync CSS update using entry dimensions (no layout thrashing)
      if (updateGeometry(width, height)) {
        // Schedule debounced fit() - expensive xterm operation
        scheduleFit();
      }
    });
    resizeObserver.observe(placeholder);

    // Window resize: placeholder position may change (not just size)
    // Full updatePosition() needed since we don't have entry dimensions
    window.addEventListener('resize', updatePosition);

    onCleanup(() => {
      if (fitTimeout) clearTimeout(fitTimeout);
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePosition);
      // Note: We intentionally do NOT clear the ref here.
      // Terminal disposal is handled explicitly by handleClosePane/handleCloseTab,
      // not by component unmount. This prevents losing the handle during layout flickers.
    });
  });

  // Bypass debounce on tab-switch: column count goes stale while hidden.
  let hasBeenHidden = !(props.isVisible ?? true);

  // Refit + reposition when visibility changes (tab switch).
  // Scoped to isVisible via on() so isActive changes don't re-trigger.
  createEffect(on(
    () => props.isVisible ?? true,
    (isVisible) => {
      let rafId: number | undefined;
      if (isVisible) {
        const isTabSwitch = hasBeenHidden;
        if (isTabSwitch && terminalHostRef) {
          // Hide terminal content before browser paints stale column layout.
          // Applied to inner host (not outer container) to avoid fighting
          // the reactive display style. Revealed after fit in the rAF.
          terminalHostRef.style.visibility = 'hidden';
        }
        rafId = requestAnimationFrame(() => {
          updateGeometry();
          if (isTabSwitch) {
            terminalManager.fit(props.id);
            if (terminalHostRef) {
              terminalHostRef.style.visibility = '';
            }
          } else {
            scheduleFit();
          }
          if (props.isActive ?? true) {
            terminalManager.focus(props.id);
          }
        });
      } else {
        hasBeenHidden = true;
      }

      onCleanup(() => {
        if (rafId !== undefined) {
          cancelAnimationFrame(rafId);
        }
      });
    }
  ));

  return (
    <div
      ref={containerRef}
      class={`terminal-pane-positioned ${props.isActive ? 'active' : ''}`}
      classList={{
        'pane-drag-source': props.isBeingDragged === true,
      }}
      data-terminal-id={props.id}
      onMouseDown={() => props.onPaneClick?.()}
      style={{
        position: 'absolute',
        overflow: 'hidden',
        display: (props.isVisible ?? true) ? 'block' : 'none',
      }}
    >
      <div
        class="pane-drag-handle"
        title="Drag to move pane"
        aria-label="Drag to move pane"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onDragHandlePointerDown?.(e);
        }}
      >
        ⋮⋮
      </div>
      <div
        ref={terminalHostRef}
        class="terminal-pane-host"
      />
    </div>
  );
}
