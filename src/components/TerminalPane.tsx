/**
 * TerminalPane - Simplified version using external terminal manager
 *
 * Key differences from useEffect-heavy version:
 * 1. Terminal lifecycle managed by terminalManager singleton
 * 2. Ref callback for DOM binding (sync, not effect)
 * 3. Only ONE useEffect for cleanup on unmount
 * 4. Callbacks stored in manager, not effect deps
 */

import { useCallback, useImperativeHandle, forwardRef, useEffect } from 'react';
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
  onPtySpawn?: (pid: number) => void;
  onPtyExit?: (exitCode: number) => void;
  onCtxMarker?: (marker: unknown) => void;
  onTitleChange?: (title: string) => void;
  isActive?: boolean;
}

export const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>(
  ({ id, cwd, onPtySpawn, onPtyExit, onCtxMarker, onTitleChange, isActive = true }, ref) => {
    // Update callbacks in manager (doesn't cause re-renders or re-init)
    // This runs on every render but just updates a Map - no side effects
    terminalManager.setCallbacks(id, {
      onPtySpawn,
      onPtyExit,
      onTitleChange,
      onCtxMarker: onCtxMarker as (marker: unknown) => void,
    });

    // Ref callback - runs synchronously when DOM mounts
    // Check manager.has() instead of local ref to handle HMR correctly
    const containerRef = useCallback((container: HTMLDivElement | null) => {
      if (container && !terminalManager.has(id)) {
        terminalManager.attach(id, container, cwd);
      }
    }, [id, cwd]);

    // Imperative handle - delegates to manager
    useImperativeHandle(ref, () => ({
      focus: () => terminalManager.focus(id),
      fit: () => terminalManager.fit(id),
      refresh: () => terminalManager.refresh(id),
      getPtyPid: () => terminalManager.getPtyPid(id),
      getTitle: () => terminalManager.getTitle(id),
    }), [id]);

    // Focus when becoming active - this is the ONE place we need reactive behavior
    // Could also do this in parent via imperative handle instead
    useEffect(() => {
      if (isActive) {
        terminalManager.focus(id);
      }
    }, [id, isActive]);

    // NOTE: We do NOT dispose on unmount here!
    // Terminal lifecycle is managed by explicit tab close (handleCloseTab in Terminal.tsx)
    // This prevents HMR from killing PTYs during development

    // Global resize listener
    useEffect(() => {
      const handleResize = () => {
        if (isActive) {
          terminalManager.fit(id);
        }
      };
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
    }, [id, isActive]);

    return (
      <div
        ref={containerRef}
        className="terminal-pane"
        data-pane-id={id}
      />
    );
  }
);

TerminalPane.displayName = 'TerminalPane';
