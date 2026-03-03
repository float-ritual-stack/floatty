/**
 * IframePaneView — Full-pane iframe when zoomed into a block with url eval-result.
 *
 * Renders: Breadcrumb + URL bar + iframe filling remaining space.
 * Escape zooms out (handled by Outliner's existing keybind).
 */

import { createSignal, Show, onMount, onCleanup } from 'solid-js';
import type { Component } from 'solid-js/web';
import { Breadcrumb } from '../Breadcrumb';

interface IframePaneViewProps {
  url: string;
  blockId: string;
  paneId: string;
  onClose: () => void;
}

export const IframePaneView: Component<IframePaneViewProps> = (props) => {
  const [loaded, setLoaded] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    containerRef?.focus();
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  };

  return (
    <div
      ref={containerRef}
      class="iframe-pane-view"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <Breadcrumb blockId={props.blockId} paneId={props.paneId} />
      <div class="iframe-pane-url-bar">
        <span class="iframe-pane-url-label">{props.url}</span>
      </div>
      <div class="iframe-pane-content">
        <iframe
          src={props.url}
          class="iframe-pane-iframe"
          classList={{ loaded: loaded() }}
          title={props.url}
          sandbox="allow-scripts allow-same-origin allow-forms"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
};
