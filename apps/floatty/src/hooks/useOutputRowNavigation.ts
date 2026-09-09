import { createMemo, createSignal } from 'solid-js';

/** Shared display-only row walk for output wrappers. Rows never own focus. */
export function useOutputRowNavigation<T>(options: {
  rows: () => readonly T[];
  onNavigate: (row: T) => void;
  onExitDown: () => void;
  onExitUp: () => void;
  onEscape: () => void;
  onToggle?: (row: T) => void;
}) {
  const [requestedIndex, setIndex] = createSignal(-1);
  const index = createMemo(() => Math.min(requestedIndex(), options.rows().length - 1));
  const enter = (edge: 'first' | 'last') => {
    if (!options.rows().length) return false;
    setIndex(edge === 'first' ? 0 : options.rows().length - 1);
    return true;
  };
  const handleKeyDown = (event: KeyboardEvent): boolean => {
    const idx = index();
    if (idx < 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
    const row = options.rows()[idx];
    switch (event.key) {
      case 'ArrowDown':
        if (idx < options.rows().length - 1) setIndex(idx + 1);
        else options.onExitDown();
        break;
      case 'ArrowUp':
        if (idx > 0) setIndex(idx - 1);
        else options.onExitUp();
        break;
      case 'Enter': options.onNavigate(row); break;
      case 'Escape': options.onEscape(); break;
      case ' ':
        if (!options.onToggle) return false;
        options.onToggle(row);
        break;
      default: return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  return { index, setIndex, enter, handleKeyDown };
}
