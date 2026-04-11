/**
 * DoorPaneView — Full-pane door rendering when zoomed via Cmd+Enter.
 *
 * Like IframePaneView for eval-result url blocks, this replaces the entire
 * outliner pane with the door's view component. Escape zooms out.
 *
 * Focus contract: Container owns focus (tabIndex={-1}).
 * Chirp contract: Listens for CustomEvent 'chirp' on container, routes to onNavigate.
 */

import { onMount, createSignal } from 'solid-js';
import { useWorkspace } from '../../context/WorkspaceContext';
import { Breadcrumb } from '../Breadcrumb';
import { DoorHost } from './DoorHost';
import type { DoorViewOutput } from '../../lib/handlers/doorTypes';
import { handleChirpWrite, isChirpWriteVerb, type ChirpWriteData } from '../../lib/chirpWriteHandler';
import { useDoorChirpListener } from '../../hooks/useDoorChirpListener';
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
  const [containerRef, setContainerRef] = createSignal<HTMLElement | undefined>(undefined);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  // Chirp listener via shared hook (FM #9: proper cleanup)
  useDoorChirpListener(containerRef, {
    getBlockId: () => props.blockId,
    getStore: () => blockStore,
    onNavigate: (target, opts) => {
      props.onNavigate?.(target, opts);
    },
  });

  onMount(() => {
    containerRef()?.focus();
  });

  return (
    <div
      ref={(el) => setContainerRef(el)}
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
