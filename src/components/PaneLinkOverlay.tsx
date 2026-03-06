/**
 * PaneLinkOverlay — tmux display-panes style letter picker for pane linking
 *
 * When active, dims the screen and shows a letter label centered on each
 * candidate outliner pane with context (page name or content preview).
 * User presses a letter to link. Escape cancels.
 */

import { Show, For, createMemo, createEffect, on, onCleanup } from 'solid-js';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { paneStore } from '../hooks/usePaneStore';
import { blockStore } from '../hooks/useBlockStore';

/** Get a short label describing what's visible in a pane */
function getPaneLabel(paneId: string): string {
  const zoomedId = paneStore.getZoomedRootId(paneId);
  if (zoomedId) {
    const block = blockStore.getBlock(zoomedId);
    if (block?.content) {
      // Strip prefix markers and heading markers, take first 30 chars
      const clean = block.content.replace(/^#+\s*/, '').replace(/^\w+::\s*/, '');
      return clean.length > 30 ? clean.slice(0, 30) + '…' : clean;
    }
  }
  return 'Root';
}

export function PaneLinkOverlay() {
  const isActive = () => paneLinkStore.linkingBlockId() !== null;

  const candidates = createMemo(() => {
    const sourcePaneId = paneLinkStore.linkingSourcePaneId();
    if (!sourcePaneId) return [];
    return paneLinkStore.getCandidatePanes(sourcePaneId);
  });

  // Compute positions and labels from DOM when overlay becomes active
  const positioned = createMemo(() => {
    if (!isActive()) return [];
    return candidates().map(c => {
      const el = document.querySelector(`[data-pane-id="${CSS.escape(c.paneId)}"].pane-layout-leaf`);
      const rect = el?.getBoundingClientRect();
      const description = getPaneLabel(c.paneId);
      return { ...c, rect: rect ?? null, description };
    }).filter(c => c.rect !== null);
  });

  // Key listener for letter selection / escape
  createEffect(on(isActive, (active) => {
    if (!active) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        paneLinkStore.stopLinking();
        return;
      }

      const key = e.key.toLowerCase();
      const match = candidates().find(c => c.label === key);
      if (match) {
        const blockId = paneLinkStore.linkingBlockId();
        if (blockId) {
          paneLinkStore.setLink(blockId, match.paneId);
        }
        paneLinkStore.stopLinking();
      }
    };

    window.addEventListener('keydown', handler, { capture: true });
    onCleanup(() => window.removeEventListener('keydown', handler, { capture: true }));
  }));

  return (
    <Show when={isActive()}>
      <div
        class="pane-link-scrim"
        onClick={() => paneLinkStore.stopLinking()}
      >
        <For each={positioned()}>
          {(c) => (
            <div
              class="pane-link-label"
              style={{
                position: 'fixed',
                top: `${c.rect!.top}px`,
                left: `${c.rect!.left}px`,
                width: `${c.rect!.width}px`,
                height: `${c.rect!.height}px`,
              }}
            >
              <div class="pane-link-badge">
                <span class="pane-link-letter">{c.label}</span>
                <span class="pane-link-description">{c.description}</span>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
