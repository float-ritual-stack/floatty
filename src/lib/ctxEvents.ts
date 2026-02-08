const CTX_MARKERS_CHANGED_EVENT = 'ctx:markers-changed';

export type CtxMarkersChangedReason =
  | 'terminal'
  | 'focus'
  | 'visibility'
  | 'manual'
  | 'external';

const ctxEventsTarget = new EventTarget();

/** Emit when ctx marker data may have changed and sidebar should refresh. */
export function emitCtxMarkersChanged(reason: CtxMarkersChangedReason = 'external'): void {
  ctxEventsTarget.dispatchEvent(
    new CustomEvent<CtxMarkersChangedReason>(CTX_MARKERS_CHANGED_EVENT, { detail: reason })
  );
}

/** Subscribe to ctx marker refresh events. Returns cleanup function. */
export function onCtxMarkersChanged(
  handler: (reason: CtxMarkersChangedReason) => void
): () => void {
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<CtxMarkersChangedReason>;
    handler(customEvent.detail ?? 'external');
  };

  ctxEventsTarget.addEventListener(CTX_MARKERS_CHANGED_EVENT, listener);
  return () => ctxEventsTarget.removeEventListener(CTX_MARKERS_CHANGED_EVENT, listener);
}
