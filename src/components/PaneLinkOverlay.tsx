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
      // Use .outliner-container (inside .terminal-pane-positioned) — it has display:none
      // for inactive tabs, so getBoundingClientRect returns zero dimensions. The
      // .pane-layout-leaf placeholders are always laid out across all tabs.
      const el = document.querySelector(`.outliner-container[data-pane-id="${CSS.escape(c.paneId)}"]`);
      const rect = el?.closest('.terminal-pane-positioned')?.getBoundingClientRect() ?? null;
      const description = getPaneLabel(c.paneId);
      return { ...c, rect, description };
    }).filter(c => c.rect !== null && c.rect.width > 0 && c.rect.height > 0);
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
