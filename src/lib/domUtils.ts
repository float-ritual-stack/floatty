/**
 * DOM utilities for SolidJS + Y.Doc reactivity patterns
 */

/**
 * Execute callback after SolidJS reactivity and DOM updates settle.
 *
 * Uses double-rAF pattern:
 * - First rAF: Waits for current JS execution + SolidJS batch to flush
 * - Second rAF: Waits for browser layout/paint
 *
 * Common use: Focus element after Y.Doc update triggers SolidJS re-render
 *
 * @param callback - Function to execute after DOM settles
 * @returns Cleanup function to cancel pending callback
 */
export function afterDOMSettle(callback: () => void): () => void {
  let cancelled = false;
  let rafId2: number | undefined;

  const rafId1 = requestAnimationFrame(() => {
    if (cancelled) return;
    rafId2 = requestAnimationFrame(() => {
      if (cancelled) return;
      callback();
    });
  });

  return () => {
    cancelled = true;
    cancelAnimationFrame(rafId1);
    if (rafId2 !== undefined) cancelAnimationFrame(rafId2);
  };
}

/**
 * Focus an element after DOM settles, with mount guard.
 *
 * @param getElement - Function returning the element (or undefined if unmounted)
 * @param isMounted - Ref to mounted state (prevents focus after cleanup)
 */
export function focusAfterSettle(
  getElement: () => HTMLElement | undefined,
  isMounted?: { current: boolean }
): () => void {
  return afterDOMSettle(() => {
    if (isMounted && !isMounted.current) return;
    getElement()?.focus();
  });
}
