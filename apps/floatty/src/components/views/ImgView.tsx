import { createSignal, createEffect, Show } from 'solid-js';
import { getAttachment } from '../../lib/attachmentCache';

export interface ImgViewProps {
  filename: string;
  serverUrl: string;
  apiKey: string;
}

// File types rendered via iframe (browser handles natively)
const IFRAME_RE = /\.(pdf|html|htm)$/i;

/**
 * Renders a local attachment from {data_dir}/__attachments/.
 * Resolves to a blob URL via the module-level LRU cache (see attachmentCache.ts)
 * so reopening a block reuses the cached blob instead of re-downloading — and
 * the img src never exposes the API key.
 * Images: full-bleed via CSS, resizable by dragging right edge.
 * PDFs: iframe with browser native renderer, height resizable via bottom edge.
 *
 * The blob URL is owned by the cache, NOT this component — so there is NO
 * revoke-on-unmount. The cache revokes only on LRU eviction.
 */
export function ImgView(props: ImgViewProps) {
  const isIframe = () => IFRAME_RE.test(props.filename);
  const [blobUrl, setBlobUrl] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);

  // maxWidth: null = full-bleed (CSS controls width), number = user has dragged to constrain.
  // Drag handle sets max-width, not width, so the CSS full-bleed base remains intact.
  const [maxWidth, setMaxWidth] = createSignal<number | null>(null);
  // PDF height: default 700px, resizable by dragging bottom edge.
  const [pdfHeight, setPdfHeight] = createSignal(700);

  createEffect(() => {
    const filename = props.filename;
    const serverUrl = props.serverUrl;
    const apiKey = props.apiKey;
    if (!filename || !serverUrl) return;

    setLoading(true);
    setError(null);

    getAttachment(serverUrl, filename, apiKey)
      .then((url) => {
        // Snapshot guard: if props.filename changed while the cache resolved,
        // a newer effect run owns the UI — ignore this stale result.
        if (props.filename !== filename) return;
        setBlobUrl(url);
        setLoading(false);
      })
      .catch((err: Error) => {
        if (props.filename !== filename) return;
        setError(err.message);
        setLoading(false);
      });
  });

  // Right-edge drag: constrain width from full-bleed
  let dragStartX = 0;
  let dragStartWidth = 0;

  const handleResizeMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    dragStartX = e.clientX;
    const wrapper = (e.currentTarget as HTMLElement).closest('.img-view-wrapper') as HTMLElement | null;
    dragStartWidth = wrapper ? wrapper.getBoundingClientRect().width : 400;

    const onMove = (ev: MouseEvent) => {
      setMaxWidth(Math.max(80, dragStartWidth + (ev.clientX - dragStartX)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Bottom-edge drag: resize PDF iframe height
  let dragStartY = 0;
  let dragStartHeight = 0;

  const handleHeightResizeMouseDown = (e: MouseEvent) => {
    e.preventDefault();
    dragStartY = e.clientY;
    dragStartHeight = pdfHeight();

    const onMove = (ev: MouseEvent) => {
      setPdfHeight(Math.max(200, dragStartHeight + (ev.clientY - dragStartY)));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  return (
    <div class="img-view-wrapper" style={maxWidth() !== null ? { 'max-width': `${maxWidth()}px` } : {}}>
      <Show when={loading()}>
        <div class="img-view-loading">⋯ {props.filename}</div>
      </Show>
      <Show when={error()}>
        <div class="img-view-error">⚠ {props.filename}: {error()}</div>
      </Show>
      <Show when={!loading() && !error() && blobUrl()}>
        <Show when={isIframe()}
          fallback={
            <>
              <img class="img-view-img" src={blobUrl()!} alt={props.filename} draggable={false} />
              <div class="img-view-caption">{props.filename}</div>
            </>
          }
        >
          <iframe
            class="img-view-pdf"
            src={blobUrl()!}
            style={{ height: `${pdfHeight()}px` }}
            title={props.filename}
          />
          <div class="img-view-caption">{props.filename}</div>
          {/* Bottom-edge drag handle for PDF height */}
          <div class="img-view-height-handle" onMouseDown={handleHeightResizeMouseDown} />
        </Show>
      </Show>
      {/* Right-edge drag handle for width */}
      <div class="img-view-resize-handle" onMouseDown={handleResizeMouseDown} />
    </div>
  );
}
