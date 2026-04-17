import { useEffect } from 'react';

export function useIncomingChirp(onNavigate: (params: URLSearchParams) => void) {
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'chirp' && e.data?.action === 'navigate') {
        const target = e.data.target as string;
        if (target.startsWith('?')) {
          const params = new URLSearchParams(target);
          window.history.replaceState({}, '', target);
          onNavigate(params);
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onNavigate]);
}
