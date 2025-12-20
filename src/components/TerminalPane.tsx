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

import { useImperativeHandle, forwardRef, useCallback, useRef, useLayoutEffect } from 'react';
import { terminalManager } from '../lib/terminalManager';
import '@xterm/xterm/css/xterm.css';

export interface TerminalPaneHandle {
  focus: () => void;
  fit: () => void;
  refresh: () => void;
  getPtyPid: () => number | null;
  getTitle: () => string;
}

export interface TerminalPaneProps {
  id: string;
  cwd?: string;
  placeholderId: string;  // ID of placeholder div to position over
  onPtySpawn?: (pid: number) => void;
  onPtyExit?: (exitCode: number) => void;
  onCtxMarker?: (marker: unknown) => void;
  onTitleChange?: (title: string) => void;
  isActive?: boolean;
  isVisible?: boolean;  // Whether the tab containing this pane is visible
}

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(
  ({ id, cwd, placeholderId, onPtySpawn, onPtyExit, onCtxMarker, onTitleChange, isActive = true, isVisible = true }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const attachedRef = useRef(false);

    // Update callbacks in manager when they change
    useLayoutEffect(() => {
      terminalManager.setCallbacks(id, {
        onPtySpawn,
        onPtyExit,
        onTitleChange,
        onCtxMarker: onCtxMarker as (marker: unknown) => void,
      });
    }, [id, onPtySpawn, onPtyExit, onTitleChange, onCtxMarker]);

    // Position this terminal over its placeholder
    const updatePosition = useCallback(() => {
      const container = containerRef.current;
      const placeholder = document.querySelector(`[data-pane-id="${placeholderId}"]`) as HTMLElement;

      if (!container || !placeholder) return;

      const rect = placeholder.getBoundingClientRect();
      const parentRect = container.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };

      container.style.left = `${rect.left - parentRect.left}px`;
      container.style.top = `${rect.top - parentRect.top}px`;
      container.style.width = `${rect.width}px`;
      container.style.height = `${rect.height}px`;

      // Refit terminal after resize
      if (attachedRef.current) {
        terminalManager.fit(id);
      }
    }, [id, placeholderId]);

    // Initial attachment and position tracking
    useLayoutEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      // Attach terminal once
      if (!attachedRef.current) {
        terminalManager.attach(id, container, cwd);
        attachedRef.current = true;
      }

      // Initial position
      updatePosition();

      // Watch for placeholder size/position changes
      const placeholder = document.querySelector(`[data-pane-id="${placeholderId}"]`) as HTMLElement;
      if (!placeholder) return;

      const resizeObserver = new ResizeObserver(() => {
        updatePosition();
      });
      resizeObserver.observe(placeholder);

      // Also update on window resize (placeholder might move)
      window.addEventListener('resize', updatePosition);

      return () => {
        resizeObserver.disconnect();
        window.removeEventListener('resize', updatePosition);
      };
    }, [id, cwd, placeholderId, updatePosition]);

    // Update position when visibility changes (tab switch)
    useLayoutEffect(() => {
      let rafId: number | undefined;
      if (isVisible) {
        // Delay to let layout settle after tab switch
        rafId = requestAnimationFrame(() => {
          updatePosition();
          if (isActive) {
            terminalManager.focus(id);
          }
        });
      }
      return () => {
        if (rafId !== undefined) {
          cancelAnimationFrame(rafId);
        }
      };
    }, [id, isVisible, isActive, updatePosition]);

    // Imperative handle
    useImperativeHandle(ref, () => ({
      focus: () => terminalManager.focus(id),
      fit: () => {
        updatePosition();
        terminalManager.fit(id);
      },
      refresh: () => terminalManager.refresh(id),
      getPtyPid: () => terminalManager.getPtyPid(id),
      getTitle: () => terminalManager.getTitle(id),
    }), [id, updatePosition]);

    return (
      <div
        ref={containerRef}
        className={`terminal-pane-positioned ${isActive ? 'active' : ''}`}
        data-terminal-id={id}
        style={{
          position: 'absolute',
          overflow: 'hidden',
          display: isVisible ? 'block' : 'none',
        }}
      />
    );
  }
);

TerminalPane.displayName = 'TerminalPane';
