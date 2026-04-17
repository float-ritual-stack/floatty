import React from 'react';
import type { Door } from '../data/w10';

interface DoorButtonProps {
  door: Door;
}

export const DoorButton: React.FC<DoorButtonProps> = ({ door }) => {
  const handleClick = () => {
    const navType = door.type === 'outline-block' ? 'block' : 'page';

    // Try window.chirp first (inline eval:: blocks get this injected)
    const chirp = (window as any).chirp;
    if (typeof chirp === 'function') {
      chirp('navigate', { target: door.target, type: navType });
      return;
    }

    // URL-loaded iframes: postMessage to parent
    // Format: { type: 'chirp', message: string, data: unknown }
    // See floatty EvalOutput.tsx UrlViewer line 80
    window.parent.postMessage({
      type: 'chirp',
      message: 'navigate',
      data: { target: door.target, type: navType },
    }, '*');
  };

  return (
    <button
      onClick={handleClick}
      className="text-zinc-500 hover:text-zinc-200 transition-colors cursor-pointer font-mono text-xs"
      aria-label={`Navigate to ${door.label}`}
      title={`Navigate outline to ${door.label}`}
    >
      [{door.label}]
    </button>
  );
};
