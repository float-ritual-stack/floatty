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

  // Position this terminal over its placeholder
  const updatePosition = () => {
    const placeholder = document.querySelector(`[data-pane-id="${props.placeholderId}"]`) as HTMLElement;

    if (!containerRef || !placeholder) return;

    const rect = placeholder.getBoundingClientRect();
    const parentRect = containerRef.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };

    containerRef.style.left = `${rect.left - parentRect.left}px`;
    containerRef.style.top = `${rect.top - parentRect.top}px`;
    containerRef.style.width = `${rect.width}px`;
    containerRef.style.height = `${rect.height}px`;

    // Refit terminal after resize
    if (attached) {
      terminalManager.fit(props.id);
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

    // Debounce resize updates to prevent rapid fit() calls during drag (FLO-88)
    // xterm.js docs recommend debouncing resize calls
    let resizeTimeout: ReturnType<typeof setTimeout> | undefined;
    const debouncedUpdate = () => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        updatePosition();
      }, 50);
    };

    const resizeObserver = new ResizeObserver(debouncedUpdate);
    resizeObserver.observe(placeholder);

    // Also update on window resize (placeholder might move)
    window.addEventListener('resize', debouncedUpdate);

    onCleanup(() => {
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeObserver.disconnect();
      window.removeEventListener('resize', debouncedUpdate);
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
