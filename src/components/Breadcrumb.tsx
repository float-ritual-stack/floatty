/**
 * Breadcrumb - Navigation trail for zoomed block view
 *
 * Shows path from root to current zoomed block.
 * Clicking any ancestor zooms to that level.
 * ◊ button zooms out to full tree.
 */

import { For } from 'solid-js';
import { blockStore } from '../hooks/useBlockStore';
import { paneStore } from '../hooks/usePaneStore';
import { useBlockOperations } from '../hooks/useBlockOperations';

interface BreadcrumbProps {
  blockId: string;
  paneId: string;
}

// Truncate content for breadcrumb display
function truncate(text: string, maxLen: number): string {
  if (!text) return '(empty)';
  const firstLine = text.split('\n')[0];
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.slice(0, maxLen - 1) + '…';
}

export function Breadcrumb(props: BreadcrumbProps) {
  const store = blockStore;
  const { getAncestors } = useBlockOperations();

  const ancestors = () => getAncestors(props.blockId);

  const handleZoomTo = (blockId: string | null) => {
    paneStore.setZoomedRoot(props.paneId, blockId);
  };

  return (
    <div class="breadcrumb">
      {/* Zoom out to full tree */}
      <button
        class="breadcrumb-item breadcrumb-root"
        onClick={() => handleZoomTo(null)}
        title="Zoom out to full view (Escape)"
      >
        ◊
      </button>

      <For each={ancestors()}>
        {(id, index) => {
          const block = () => store.blocks[id];
          const isLast = () => index() === ancestors().length - 1;

          return (
            <>
              <span class="breadcrumb-separator">→</span>
              <button
                class="breadcrumb-item"
                classList={{ 'breadcrumb-current': isLast() }}
                onClick={() => handleZoomTo(id)}
                title={block()?.content || ''}
              >
                {truncate(block()?.content || '', 20)}
              </button>
            </>
          );
        }}
      </For>
    </div>
  );
}
