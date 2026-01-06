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

import { createEffect, onMount, onCleanup } from 'solid-js';
import { terminalManager } from '../lib/terminalManager';
import { type PaneHandle } from '../lib/layoutTypes';
import '@xterm/xterm/css/xterm.css';

export type TerminalPaneHandle = PaneHandle;

export interface TerminalPaneProps {
  id: string;
  cwd?: string;
  placeholderId: string;  // ID of placeholder div to position over
  onPtySpawn?: (pid: number) => void;
  onPtyExit?: (exitCode: number) => void;
  onCtxMarker?: (marker: unknown) => void;
  onTitleChange?: (title: string) => void;
  onSemanticStateChange?: (state: unknown) => void;  // OSC 133/1337 state updates
  onPaneClick?: () => void;  // Called when pane is clicked (for focus tracking)
  isActive?: boolean;
  isVisible?: boolean;  // Whether the tab containing this pane is visible
  ref?: (handle: TerminalPaneHandle | null) => void;
}

export function TerminalPane(props: TerminalPaneProps) {
  let containerRef: HTMLDivElement | undefined;
  let attached = false;

  // Minimum dimension threshold - xterm.js misbehaves (scroll jumps, 0 rows) below this
  const MIN_DIMENSION = 10;

  // Debounce state for fit() - CSS updates are immediate, fit() is debounced
  let fitTimeout: ReturnType<typeof setTimeout> | undefined;

  // Component-level cleanup - ensures fitTimeout is cleared even if onMount exits early
  onCleanup(() => {
    if (fitTimeout) clearTimeout(fitTimeout);
  });

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
    });
  });

  // Initial attachment and position tracking
  onMount(async () => {
    if (!containerRef) return;

    // Expose the handle via ref callback
    props.ref?.(handle);

    // Attach terminal once (await config load)
    if (!attached) {
      await terminalManager.attach(props.id, containerRef, props.cwd);
      attached = true;

    }

    // Initial position
    updatePosition();

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

  // Update position when visibility changes (tab switch)
  createEffect(() => {
    const isVisible = props.isVisible ?? true;
    const isActive = props.isActive ?? true;

    let rafId: number | undefined;
    if (isVisible) {
      // Delay to let layout settle after tab switch
      rafId = requestAnimationFrame(() => {
        updatePosition();
        if (isActive) {
          terminalManager.focus(props.id);
        }
      });
    }

    onCleanup(() => {
      if (rafId !== undefined) {
        cancelAnimationFrame(rafId);
      }
    });
  });

  return (
    <div
      ref={containerRef}
      class={`terminal-pane-positioned ${props.isActive ? 'active' : ''}`}
      data-terminal-id={props.id}
      onMouseDown={() => props.onPaneClick?.()}
      style={{
        position: 'absolute',
        overflow: 'hidden',
        display: (props.isVisible ?? true) ? 'block' : 'none',
      }}
    />
  );
}
