/**
 * DoorPaneView — Full-pane door rendering when zoomed via Cmd+Enter.
 *
 * Like IframePaneView for eval-result url blocks, this replaces the entire
 * outliner pane with the door's view component. Escape zooms out.
 *
 * Focus contract: Container owns focus (tabIndex={-1}).
 * Chirp contract: Listens for CustomEvent 'chirp' on container, routes to onNavigate.
 */

import { onMount, onCleanup } from 'solid-js';
import { useWorkspace } from '../../context/WorkspaceContext';
import { Breadcrumb } from '../Breadcrumb';
import { DoorHost } from './DoorHost';
import type { DoorViewOutput } from '../../lib/handlers/doorTypes';
import { handleChirpWrite, isChirpWriteVerb, type ChirpWriteData } from '../../lib/chirpWriteHandler';
import { isMac } from '../../lib/keybinds';
import './doors.css';

interface DoorPaneViewProps {
  blockId: string;
  paneId: string;
  envelope: DoorViewOutput;
  onClose: () => void;
  onNavigate?: (target: string, opts?: { type?: string; splitDirection?: string }) => void;
}

export function DoorPaneView(props: DoorPaneViewProps) {
  const { blockStore } = useWorkspace();
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
    // Routes through onNavigate — same pattern as BlockItem's wrapperRef chirp listener.
    const handleChirp = ((e: CustomEvent) => {
      const message = e.detail?.message;
      if (message === 'navigate' && e.detail?.target) {
        e.stopPropagation();
        const sourceEvent = e.detail.sourceEvent as MouseEvent | undefined;
        const modKey = sourceEvent ? (isMac ? sourceEvent.metaKey : sourceEvent.ctrlKey) : false;
        const optKey = sourceEvent?.altKey ?? false;
        let splitDirection: 'horizontal' | 'vertical' | undefined;
        if (modKey || optKey) {
          splitDirection = sourceEvent?.shiftKey ? 'vertical' : 'horizontal';
        }
        props.onNavigate?.(e.detail.target, { splitDirection });
      } else if (isChirpWriteVerb(message)) {
        e.stopPropagation();
        handleChirpWrite(message, e.detail?.data as ChirpWriteData, props.blockId, blockStore);
      }
    }) as EventListener;

    containerRef?.addEventListener('chirp', handleChirp);
    onCleanup(() => containerRef?.removeEventListener('chirp', handleChirp));
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
          onChirp={(message, data) => {
            if (isChirpWriteVerb(message)) {
              handleChirpWrite(message, data as ChirpWriteData, props.blockId, blockStore);
            }
          }}
        />
      </div>
    </div>
  );
}
