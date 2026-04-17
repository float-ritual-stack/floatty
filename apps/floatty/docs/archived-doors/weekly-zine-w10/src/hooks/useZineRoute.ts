import { useState, useCallback } from 'react';
import { useIncomingChirp } from './useIncomingChirp';

export function useZineRoute() {
  const [params, setParams] = useState(
    () => new URLSearchParams(window.location.search),
  );

  const navigate = useCallback((newParams: Record<string, string>) => {
    const p = new URLSearchParams(newParams);
    window.history.replaceState({}, '', `?${p}`);
    setParams(p);
  }, []);

  useIncomingChirp(setParams);

  return {
    section: params.get('section'),
    item: params.get('item'),
    view: params.get('view'),
    week: params.get('week') || 'W10',
    navigate,
  };
}
