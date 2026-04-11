/**
 * useCursor - Abstraction layer for cursor utilities
 *
 * This hook wraps DOM-dependent cursor utilities, enabling tests to mock
 * cursor state without fighting JSDOM's contentEditable quirks.
 *
 * In production: delegates to real cursorUtils
 * In tests: can be mocked with vi.mock() to return predetermined state
 *
 * Usage:
 *   const cursor = useCursor(contentRef);
 *   if (cursor.isAtStart()) { ... }
 */

import {
  isCursorAtContentStart,
  isCursorAtContentEnd,
  getAbsoluteCursorOffset,
  setCursorAtOffset,
} from '../lib/cursorUtils';

export interface CursorState {
  /** Check if cursor is at the very start of element */
  isAtStart: () => boolean;
  /** Check if cursor is at the very end of element */
  isAtEnd: () => boolean;
  /** Get absolute character offset from start of element */
  getOffset: () => number;
  /** Set cursor to specific offset within element */
  setOffset: (offset: number) => void;
  /** Check if selection is collapsed (no text selected) */
  isSelectionCollapsed: () => boolean;
}

/**
 * Create cursor state helpers bound to an element ref
 *
 * @param getElement - Function that returns the element (or undefined if not mounted)
 * @returns CursorState with methods for querying/setting cursor position
 */
export function useCursor(getElement: () => HTMLElement | undefined): CursorState {
  return {
    isAtStart: () => {
      const el = getElement();
      if (!el) return false;
      return isCursorAtContentStart(el);
    },

    isAtEnd: () => {
      const el = getElement();
      if (!el) return false;
      return isCursorAtContentEnd(el);
    },

    getOffset: () => {
      const el = getElement();
      if (!el) return 0;
      return getAbsoluteCursorOffset(el);
    },

    setOffset: (offset: number) => {
      const el = getElement();
      if (!el) return;
      setCursorAtOffset(el, offset);
    },

    isSelectionCollapsed: () => {
      const selection = window.getSelection();
      return selection?.isCollapsed ?? true;
    },
  };
}

/**
 * Create a mock cursor state for testing
 *
 * Usage in tests:
 *   vi.mock('../hooks/useCursor', () => ({
 *     useCursor: () => createMockCursor({ atStart: true })
 *   }));
 */
export function createMockCursor(overrides: {
  atStart?: boolean;
  atEnd?: boolean;
  offset?: number;
  collapsed?: boolean;
} = {}): CursorState {
  return {
    isAtStart: () => overrides.atStart ?? false,
    isAtEnd: () => overrides.atEnd ?? false,
    getOffset: () => overrides.offset ?? 0,
    setOffset: () => {},
    isSelectionCollapsed: () => overrides.collapsed ?? true,
  };
}
