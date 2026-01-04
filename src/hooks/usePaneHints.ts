import { createEffect, onCleanup } from 'solid-js';
import { layoutStore } from './useLayoutStore';

const HINT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const buildHintLabel = (index: number): string => {
  let result = '';
  let current = index;

  do {
    result = HINT_ALPHABET[current % HINT_ALPHABET.length] + result;
    current = Math.floor(current / HINT_ALPHABET.length) - 1;
  } while (current >= 0);

  return result;
};

export const generateHints = (paneIds: string[]): Record<string, string> => {
  const hints: Record<string, string> = {};
  paneIds.forEach((paneId, index) => {
    hints[paneId] = buildHintLabel(index);
  });
  return hints;
};

export const useHintListener = (onSelect: (paneId: string) => void) => {
  createEffect(() => {
    if (!layoutStore.hintModeActive) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!layoutStore.hintModeActive) return;

      if (event.key === 'Escape') {
        layoutStore.clearHintMode();
        return;
      }

      const key = event.key.toUpperCase();
      const entry = Object.entries(layoutStore.validPaneHints)
        .find(([, hint]) => hint.toUpperCase() === key);

      if (entry) {
        event.preventDefault();
        const [paneId] = entry;
        onSelect(paneId);
        layoutStore.clearHintMode();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => window.removeEventListener('keydown', handleKeyDown));
  });
};
