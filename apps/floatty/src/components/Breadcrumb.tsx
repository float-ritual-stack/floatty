/**
 * Breadcrumb - Navigation trail for zoomed block view
 *
 * Shows path from root to current zoomed block.
 * Clicking any ancestor zooms to that level.
 * ◊ button zooms out to full tree.
 */

import { For } from 'solid-js';
import { useWorkspace } from '../context/WorkspaceContext';
import { useBlockOperations } from '../hooks/useBlockOperations';
import { requestPaneZoom, isWithinPaneScope } from '../lib/navigation';

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
  const { blockStore } = useWorkspace();
  const store = blockStore;
  const { getAncestors } = useBlockOperations();

  const ancestors = () => getAncestors(props.blockId);

  const handleZoomTo = (blockId: string | null) => {
    // Route through the navigation funnel (floor-aware). Normal pane: zooms
    // in-pane, unchanged. Floored (pinned) pane: above-floor segments (◊,
    // pages::, ancestors of the pin) route to the linked pane or no-op instead
    // of escaping the pin. Origin is the CURRENT zoom target for focus restore.
    requestPaneZoom(props.paneId, blockId, { originBlockId: props.blockId });
  };

  // A segment is "above the floor" when it's outside this pane's scope (only
  // happens in a pinned/floored pane). Those segments are dimmed and their
  // click routes to the linked pane (or no-ops) rather than escaping the pin.
  const aboveFloor = (id: string | null) => !isWithinPaneScope(props.paneId, id);

  return (
    <div class="breadcrumb">
      {/* Zoom out to full tree (or, on a floored pane, escape to linked pane) */}
      <button
        class="breadcrumb-item breadcrumb-root"
        classList={{ 'breadcrumb-above-floor': aboveFloor(null) }}
        onClick={() => handleZoomTo(null)}
        title={
          aboveFloor(null)
            ? 'Outside this pin — opens in the linked pane'
            : 'Zoom out to full view (Escape)'
        }
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
                classList={{
                  'breadcrumb-current': isLast(),
                  'breadcrumb-above-floor': aboveFloor(id),
                }}
                onClick={() => handleZoomTo(id)}
                title={
                  aboveFloor(id)
                    ? `${block()?.content || ''} — opens in the linked pane`
                    : block()?.content || ''
                }
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
