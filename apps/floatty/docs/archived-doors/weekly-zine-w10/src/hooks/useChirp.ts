import { useCallback } from 'react';

export function useChirp() {
  const post = useCallback((action: string, payload: Record<string, unknown> = {}) => {
    const msg = {
      source: 'float-zine-door',
      action,
      ...payload,
      timestamp: Date.now(),
    };
    if (window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
    window.postMessage(msg, '*');
  }, []);

  const navigateToBlock = useCallback(
    (blockId: string) => post('navigate', { blockId }),
    [post],
  );

  const navigateToPage = useCallback(
    (pageTitle: string) => post('navigate_page', { pageTitle }),
    [post],
  );

  const search = useCallback(
    (query: string) => post('search', { query }),
    [post],
  );

  return { navigateToBlock, navigateToPage, search, post };
}
