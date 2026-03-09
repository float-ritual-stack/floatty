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
  onChirp?: (message: string, data?: unknown) => void;
}

export const IframePaneView: Component<IframePaneViewProps> = (props) => {
  const [loaded, setLoaded] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;
  let iframeRef: HTMLIFrameElement | undefined;

  onMount(() => {
    containerRef?.focus();

    // Chirp bridge: listen for postMessage from this iframe (mirrors EvalOutput UrlViewer)
    const handleMessage = (e: MessageEvent) => {
      if (!props.onChirp) return;
      if (!iframeRef || e.source !== iframeRef.contentWindow) return;
      if (e.data?.type === 'chirp' && typeof e.data.message === 'string') {
        props.onChirp(e.data.message, e.data.data);
      }
    };
    window.addEventListener('message', handleMessage);
    onCleanup(() => window.removeEventListener('message', handleMessage));
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
        {/* See EvalOutput.tsx for sandbox rationale — allow-same-origin is required
            for external/localhost iframes in Tauri (cross-origin from tauri://). */}
        <iframe
          ref={el => iframeRef = el}
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
