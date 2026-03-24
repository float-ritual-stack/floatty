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
          onNavigate={props.onNavigate}
        />
      </div>
    </div>
  );
}
