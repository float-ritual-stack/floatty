/**
 * DoorPaneView — full-pane door rendering when zoomed via Cmd+Enter
 *
 * Like IframePaneView for artifact:: blocks, this replaces the entire
 * outliner pane with the door's view component, filling available space.
 * Uses the standard Breadcrumb component for navigation consistency.
 *
 * Escape zooms out (same as iframe behavior).
 */

import { onMount } from 'solid-js';
import { Breadcrumb } from '../Breadcrumb';
import { DoorHost } from './DoorHost';
import type { DoorViewOutput } from '../../lib/handlers/doorTypes';
import { isMac } from '../../lib/keybinds';

interface DoorPaneViewProps {
  blockId: string;
  paneId: string;
  envelope: DoorViewOutput;
  onClose: () => void;
  onNavigate?: (target: string, opts?: { type?: string; splitDirection?: string }) => void;
}

export function DoorPaneView(props: DoorPaneViewProps) {
  let containerRef: HTMLDivElement | undefined;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  onMount(() => {
    containerRef?.focus();

    // Chirp listener: door components emit chirp CustomEvents for navigation.
    // Routes through onNavigate — same as BlockItem's wrapperRef chirp listener.
    containerRef?.addEventListener('chirp', ((e: CustomEvent) => {
      if (e.detail?.message === 'navigate' && e.detail?.target) {
        e.stopPropagation();
        const sourceEvent = e.detail.sourceEvent as MouseEvent | undefined;
        const modKey = sourceEvent ? (isMac ? sourceEvent.metaKey : sourceEvent.ctrlKey) : false;
        const optKey = sourceEvent?.altKey ?? false;
        let splitDirection: 'horizontal' | 'vertical' | undefined;
        if (modKey || optKey) {
          splitDirection = sourceEvent?.shiftKey ? 'vertical' : 'horizontal';
        }
        props.onNavigate?.(e.detail.target, { splitDirection });
      }
    }) as EventListener);
  });

  return (
    <div
      ref={containerRef}
      class="door-pane-view"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <Breadcrumb blockId={props.blockId} paneId={props.paneId} />
      <div class="door-pane-content">
        <DoorHost
          doorId={props.envelope.doorId}
          data={props.envelope.data}
          error={props.envelope.error}
          status="complete"
        />
      </div>
    </div>
  );
}
