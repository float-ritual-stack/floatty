/**
 * EvalOutput — Dynamic viewer dispatch for eval:: block results
 *
 * Uses SolidJS <Dynamic> to pick the right viewer based on result type.
 * Viewers: value (toString), json (pretty-print), table (array→table), error (red).
 */

import { createSignal, createEffect, on, onMount, onCleanup, Show } from 'solid-js';
import { Dynamic, type Component } from 'solid-js/web';
import type { EvalResult } from '../lib/evalEngine';

// ═══════════════════════════════════════════════════════════════
// VIEWERS
// ═══════════════════════════════════════════════════════════════

interface ViewerProps {
  data: unknown;
}

const ValueViewer: Component<ViewerProps> = (props) => (
  <div class="eval-output-value">{String(props.data)}</div>
);

const JsonViewer: Component<ViewerProps> = (props) => (
  <pre class="eval-output-json">{JSON.stringify(props.data, null, 2)}</pre>
);

const TableViewer: Component<ViewerProps> = (props) => {
  const rows = () => props.data as Record<string, unknown>[];
  const cols = () => {
    const r = rows();
    if (!r.length) return [];
    return Object.keys(r[0]);
  };

  return (
    <table class="eval-output-table">
      <thead>
        <tr>
          {cols().map((col) => <th>{col}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows().map((row) => (
          <tr>
            {cols().map((col) => <td>{String(row[col] ?? '')}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const ErrorViewer: Component<ViewerProps> = (props) => (
  <div class="eval-output-error">{String(props.data)}</div>
);

const UrlViewer: Component<ViewerProps> = (props) => {
  const [height, setHeight] = createSignal(300);
  const [loaded, setLoaded] = createSignal(false);
  const [inView, setInView] = createSignal(false);
  let containerRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!containerRef) return;
    const observer = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { rootMargin: '200px' }
    );
    observer.observe(containerRef);
    onCleanup(() => observer.disconnect());
  });

  // Reset loaded state when iframe remounts (inView toggles Show)
  createEffect(on(inView, (visible) => {
    if (visible) setLoaded(false);
  }));

  const onResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height();
    const iframe = containerRef?.querySelector('iframe');
    if (iframe) iframe.style.pointerEvents = 'none';
    const onMove = (me: PointerEvent) => {
      setHeight(Math.max(100, Math.min(startH + me.clientY - startY, window.innerHeight * 0.8)));
    };
    const onUp = () => {
      if (iframe) iframe.style.pointerEvents = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const url = () => String(props.data).trim();

  return (
    <div ref={containerRef} class="eval-output-url">
      <div class="eval-output-url-bar">
        <span class="eval-output-url-label">{url()}</span>
      </div>
      <Show when={inView()} fallback={
        <div class="eval-output-url-placeholder" style={{ height: `${height()}px` }}>
          iframe paused (scrolled out of view)
        </div>
      }>
        <iframe
          src={url()}
          style={{ height: `${height()}px` }}
          class="eval-output-url-iframe"
          classList={{ loaded: loaded() }}
          title={url()}
          sandbox="allow-scripts allow-forms"
          onLoad={() => setLoaded(true)}
        />
      </Show>
      <div
        class="eval-output-url-resize"
        onPointerDown={onResizeStart}
        role="separator"
        aria-label="Resize iframe"
      />
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// VIEWER REGISTRY
// ═══════════════════════════════════════════════════════════════

const EVAL_VIEWERS: Record<string, Component<ViewerProps>> = {
  value: ValueViewer,
  json: JsonViewer,
  table: TableViewer,
  error: ErrorViewer,
  url: UrlViewer,
};

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════

interface EvalOutputProps {
  output: EvalResult;
}

export function EvalOutput(props: EvalOutputProps) {
  const viewer = () => EVAL_VIEWERS[props.output.type] ?? EVAL_VIEWERS.value;
  return (
    <div class="eval-output">
      <Dynamic component={viewer()} data={props.output.data} />
    </div>
  );
}
