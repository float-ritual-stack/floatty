/**
 * PaneHintOverlay - Renders letter hints over panes during hint mode
 *
 * Architecture:
 * - Positions absolutely over the PaneLayout
 * - Displays letter hints centered on each pane
 * - High z-index to appear above all content
 * - Click anywhere or ESC to dismiss
 *
 * This component is rendered at the Terminal.tsx level to overlay
 * the entire pane layout.
 */

import { Show, For, createMemo } from 'solid-js';
import { layoutStore } from '../hooks/useLayoutStore';

interface PaneHintOverlayProps {
  tabId: string;
}

export function PaneHintOverlay(props: PaneHintOverlayProps) {
  // Only render when hint mode is active for this tab
  const isActive = createMemo(() => {
    const hintState = layoutStore.getHintModeState();
    return hintState.active && hintState.tabId === props.tabId;
  });

  // Get hints for rendering
  const hints = createMemo(() => {
    if (!isActive()) return [];

    const hintState = layoutStore.getHintModeState();
    return Object.entries(hintState.hints).map(([paneId, letter]) => ({
      paneId,
      letter,
    }));
  });

  // Click overlay to dismiss
  const handleOverlayClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    layoutStore.exitHintMode();
  };

  return (
    <Show when={isActive()}>
      <div class="pane-hint-overlay" onClick={handleOverlayClick}>
        <For each={hints()}>
          {(hint) => (
            <PaneHint paneId={hint.paneId} letter={hint.letter} />
          )}
        </For>
      </div>
    </Show>
  );
}

interface PaneHintProps {
  paneId: string;
  letter: string;
}

/**
 * Individual hint badge that positions itself over the pane.
 */
function PaneHint(props: PaneHintProps) {
  // Position hint over the pane using DOM query
  // We use createMemo to only query once and cache the position
  const position = createMemo(() => {
    const paneElement = document.querySelector(`[data-pane-id="${props.paneId}"]`);
    if (!paneElement) return null;

    const rect = paneElement.getBoundingClientRect();
    return {
      top: rect.top + rect.height / 2,
      left: rect.left + rect.width / 2,
    };
  });

  return (
    <Show when={position()}>
      <div
        class="pane-hint-badge"
        style={{
          top: `${position()!.top}px`,
          left: `${position()!.left}px`,
        }}
      >
        {props.letter}
      </div>
    </Show>
  );
}
