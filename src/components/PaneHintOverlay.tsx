import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { layoutStore } from '../hooks/useLayoutStore';
import { tabStore } from '../hooks/useTabStore';

interface PaneHintOverlayProps {
  tabId: string;
}

export function PaneHintOverlay(props: PaneHintOverlayProps) {
  let containerRef: HTMLDivElement | undefined;
  const [positions, setPositions] = createSignal<Record<string, { top: number; left: number }>>({});

  const isVisible = createMemo(() => {
    return layoutStore.hintModeActive && tabStore.activeTabId() === props.tabId;
  });

  const computePositions = () => {
    if (!containerRef) return;

    const containerRect = containerRef.getBoundingClientRect();
    const nextPositions: Record<string, { top: number; left: number }> = {};

    Object.keys(layoutStore.validPaneHints).forEach((paneId) => {
      const paneEl = document.querySelector(`[data-pane-id="${paneId}"]`) as HTMLElement | null;
      if (!paneEl) return;
      const rect = paneEl.getBoundingClientRect();
      nextPositions[paneId] = {
        top: rect.top - containerRect.top + rect.height / 2,
        left: rect.left - containerRect.left + rect.width / 2,
      };
    });

    setPositions(nextPositions);
  };

  createEffect(() => {
    if (!isVisible()) return;

    computePositions();
    window.addEventListener('resize', computePositions);
    onCleanup(() => window.removeEventListener('resize', computePositions));
  });

  return (
    <Show when={isVisible()}>
      <div ref={containerRef} class="pane-hint-overlay">
        {Object.entries(layoutStore.validPaneHints).map(([paneId, hint]) => (
          <div
            class="pane-hint"
            style={{
              top: `${positions()[paneId]?.top ?? 0}px`,
              left: `${positions()[paneId]?.left ?? 0}px`,
            }}
          >
            {hint}
          </div>
        ))}
      </div>
    </Show>
  );
}
