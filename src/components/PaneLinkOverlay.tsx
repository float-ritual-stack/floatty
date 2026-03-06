/**
 * PaneLinkOverlay — tmux display-panes style letter picker for pane linking
 *
 * When active, dims the screen and shows a letter label centered on each
 * candidate outliner pane. User presses a letter to link the source block
 * to that pane. Escape cancels.
 */

import { Show, For, createMemo, createEffect, on, onCleanup } from 'solid-js';
import { paneLinkStore } from '../hooks/usePaneLinkStore';

export function PaneLinkOverlay() {
  const isActive = () => paneLinkStore.linkingBlockId() !== null;

  const candidates = createMemo(() => {
    const sourcePaneId = paneLinkStore.linkingSourcePaneId();
    if (!sourcePaneId) return [];
    return paneLinkStore.getCandidatePanes(sourcePaneId);
  });

  // Compute positions from DOM when overlay becomes active
  const positioned = createMemo(() => {
    if (!isActive()) return [];
    return candidates().map(c => {
      const el = document.querySelector(`[data-pane-id="${CSS.escape(c.paneId)}"]`);
      const rect = el?.getBoundingClientRect();
      return { ...c, rect: rect ?? null };
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
              <span class="pane-link-letter">{c.label}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}
