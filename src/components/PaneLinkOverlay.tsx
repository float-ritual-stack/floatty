/**
 * PaneLinkOverlay — tmux display-panes style letter picker
 *
 * Two modes:
 * - 'link': Pick a target pane to link navigation to (excludes source)
 * - 'focus': Pick any pane to jump focus to (includes all panes)
 *
 * Dims the screen, shows letter labels centered on each pane.
 * User presses a letter to act. Escape cancels.
 */

import { Show, For, createMemo, createEffect, on, onCleanup } from 'solid-js';
import { paneLinkStore } from '../hooks/usePaneLinkStore';
import { layoutStore } from '../hooks/useLayoutStore';
import { paneStore } from '../hooks/usePaneStore';
import { blockStore } from '../hooks/useBlockStore';
import { tabStore } from '../hooks/useTabStore';
import { findTabIdByPaneId } from '../hooks/useLayoutStore';

/** Get a short label describing what's visible in a pane */
function getPaneLabel(paneId: string, leafType?: string): string {
  if (leafType === 'terminal') return 'Terminal';
  const zoomedId = paneStore.getZoomedRootId(paneId);
  if (zoomedId) {
    const block = blockStore.getBlock(zoomedId);
    if (block?.content) {
      const clean = block.content.replace(/^#+\s*/, '').replace(/^\w+::\s*/, '');
      return clean.length > 30 ? clean.slice(0, 30) + '…' : clean;
    }
  }
  return 'Root';
}

export function PaneLinkOverlay() {
  const isActive = () => paneLinkStore.overlayMode() !== null;
  const mode = () => paneLinkStore.overlayMode();

  const candidates = createMemo((): { paneId: string; label: string; leafType?: string }[] => {
    const sourcePaneId = paneLinkStore.linkingSourcePaneId();
    if (!sourcePaneId) return [];
    if (mode() === 'focus') {
      return paneLinkStore.getAllPanes(sourcePaneId);
    }
    return paneLinkStore.getCandidatePanes(sourcePaneId);
  });

  // Compute positions and labels from DOM when overlay becomes active
  const positioned = createMemo(() => {
    if (!isActive()) return [];
    return candidates().map(c => {
      // Layout placeholder has data-pane-id directly; use it for all pane types
      const leafEl = document.querySelector(`.pane-layout-leaf[data-pane-id="${CSS.escape(c.paneId)}"]`);
      const rect = leafEl?.getBoundingClientRect() ?? null;
      const description = getPaneLabel(c.paneId, c.leafType);
      return { ...c, rect, description };
    }).filter(c => c.rect !== null && c.rect!.width > 0 && c.rect!.height > 0);
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
      if (!match) return;

      const currentMode = mode();

      if (currentMode === 'focus') {
        // Focus mode: jump to the selected pane
        const tabId = findTabIdByPaneId(match.paneId);
        if (tabId) {
          layoutStore.setActivePaneId(tabId, match.paneId);
          requestAnimationFrame(() => {
            const paneEl = document.querySelector(`[data-pane-id="${CSS.escape(match.paneId)}"]`) as HTMLElement | null;
            const focusTarget = paneEl?.querySelector('[contenteditable], .xterm-helper-textarea') as HTMLElement | null;
            (focusTarget ?? paneEl)?.focus();
          });
        }
      } else {
        // Link mode: create pane link + set sidebar target for active tab
        const sourcePaneId = paneLinkStore.linkingSourcePaneId();
        if (sourcePaneId) {
          paneLinkStore.setPaneLink(sourcePaneId, match.paneId);
          // Also link sidebar → this target so chirp navigation follows the same link
          const activeTab = tabStore.activeTabId();
          if (activeTab) {
            paneLinkStore.setSidebarLink(activeTab, match.paneId);
          }
        }
      }

      paneLinkStore.stopLinking();
    };

    window.addEventListener('keydown', handler, { capture: true });
    onCleanup(() => window.removeEventListener('keydown', handler, { capture: true }));
  }));

  return (
    <Show when={isActive()}>
      <div
        class={`pane-link-scrim ${mode() === 'focus' ? 'pane-focus-mode' : ''}`}
        role="dialog"
        aria-label={mode() === 'focus'
          ? 'Focus pane — press a letter to jump, Escape to cancel'
          : 'Link pane — press a letter to select target, Escape to cancel'}
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
