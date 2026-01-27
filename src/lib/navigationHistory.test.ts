/**
 * navigationHistory.test.ts - Pure state machine tests (FLO-180)
 *
 * Tests the navigation history functions in isolation.
 * No framework, no DOM, no mocking - just pure functions.
 *
 * Standard Browser Model:
 * - entries contain actual visited locations (where you ARE, not where you came FROM)
 * - currentIndex points to current location
 * - Push happens AFTER navigating (stores destination)
 */
import { describe, it, expect } from 'vitest';
import {
  createNavigationState,
  pushNavigation,
  goBack,
  goForward,
  canGoBack,
  canGoForward,
  isSameLocation,
  getHistoryLength,
  clearHistory,
  DEFAULT_MAX_HISTORY_SIZE,
  type NavigationEntry,
} from './navigationHistory';

// --- Test Helpers ---

function createEntry(zoomedRootId: string | null, focusedBlockId?: string): NavigationEntry {
  return {
    zoomedRootId,
    focusedBlockId,
    timestamp: Date.now(),
  };
}

function createEntryWithTimestamp(
  zoomedRootId: string | null,
  timestamp: number,
  focusedBlockId?: string
): NavigationEntry {
  return {
    zoomedRootId,
    focusedBlockId,
    timestamp,
  };
}

// --- Tests ---

describe('createNavigationState', () => {
  it('creates empty state with no entries', () => {
    const state = createNavigationState();
    expect(state.entries).toEqual([]);
    expect(state.currentIndex).toBe(-1);
  });
});

describe('isSameLocation', () => {
  it('returns true for same zoomedRootId', () => {
    const a = createEntry('block-1', 'focus-a');
    const b = createEntry('block-1', 'focus-b');
    expect(isSameLocation(a, b)).toBe(true);
  });

  it('returns true for both null zoomedRootId', () => {
    const a = createEntry(null);
    const b = createEntry(null);
    expect(isSameLocation(a, b)).toBe(true);
  });

  it('returns false for different zoomedRootId', () => {
    const a = createEntry('block-1');
    const b = createEntry('block-2');
    expect(isSameLocation(a, b)).toBe(false);
  });

  it('returns false when one is null and one is not', () => {
    const a = createEntry(null);
    const b = createEntry('block-1');
    expect(isSameLocation(a, b)).toBe(false);
  });
});

describe('pushNavigation', () => {
  it('adds entry to empty history', () => {
    const state = createNavigationState();
    const entry = createEntry('page-a');

    const newState = pushNavigation(state, entry);

    expect(newState.entries).toHaveLength(1);
    expect(newState.entries[0].zoomedRootId).toBe('page-a');
    expect(newState.currentIndex).toBe(0);
  });

  it('adds entry to existing history', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));

    expect(state.entries).toHaveLength(2);
    expect(state.entries[0].zoomedRootId).toBe('page-a');
    expect(state.entries[1].zoomedRootId).toBe('page-b');
    expect(state.currentIndex).toBe(1);
  });

  it('discards forward entries when navigating after goBack', () => {
    // Build history: A → B → C (user at C)
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = pushNavigation(state, createEntry('page-c'));

    // Go back twice (to A)
    state = goBack(state).state;  // Now at B
    state = goBack(state).state;  // Now at A

    // Now push D - should discard B and C
    state = pushNavigation(state, createEntry('page-d'));

    expect(state.entries).toHaveLength(2);
    expect(state.entries[0].zoomedRootId).toBe('page-a');
    expect(state.entries[1].zoomedRootId).toBe('page-d');
    expect(state.currentIndex).toBe(1);
  });

  it('deduplicates consecutive same-location entries', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-a'));

    expect(state.entries).toHaveLength(1);
    expect(state.currentIndex).toBe(0);
  });

  it('updates focusedBlockId on same-location push', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a', 'focus-1'));
    state = pushNavigation(state, createEntry('page-a', 'focus-2'));

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].focusedBlockId).toBe('focus-2');
  });

  it('allows same location with different intermediate locations', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = pushNavigation(state, createEntry('page-a'));

    expect(state.entries).toHaveLength(3);
  });

  it('respects maxSize limit', () => {
    let state = createNavigationState();

    // Push 60 entries with maxSize 50
    for (let i = 0; i < 60; i++) {
      state = pushNavigation(state, createEntry(`page-${i}`), 50);
    }

    expect(state.entries).toHaveLength(50);
    // Oldest entries (0-9) should be trimmed
    expect(state.entries[0].zoomedRootId).toBe('page-10');
    expect(state.entries[49].zoomedRootId).toBe('page-59');
  });

  it('handles null zoomedRootId (roots view)', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry(null));

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].zoomedRootId).toBeNull();
  });

  it('preserves timestamp from entry', () => {
    const state = createNavigationState();
    const entry = createEntryWithTimestamp('page-a', 1234567890);

    const newState = pushNavigation(state, entry);

    expect(newState.entries[0].timestamp).toBe(1234567890);
  });

  it('uses default maxSize when not specified', () => {
    expect(DEFAULT_MAX_HISTORY_SIZE).toBe(50);
  });

  it('returns same state when pushing duplicate at empty history', () => {
    const state = createNavigationState();
    const entry = createEntry('page-a');
    const state1 = pushNavigation(state, entry);
    const state2 = pushNavigation(state1, entry);

    // Should be same reference (no change)
    expect(state2).toBe(state1);
  });
});

describe('goBack', () => {
  it('returns null entry on empty history', () => {
    const state = createNavigationState();
    const result = goBack(state);

    expect(result.entry).toBeNull();
    expect(result.state).toBe(state);
  });

  it('returns null entry when at first entry (nowhere to go back)', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));

    const result = goBack(state);

    expect(result.entry).toBeNull();
    expect(result.state).toBe(state);
  });

  it('returns previous entry and decrements currentIndex', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    // entries=[page-a, page-b], index=1 (at page-b)

    const result = goBack(state);

    expect(result.entry?.zoomedRootId).toBe('page-a');
    expect(result.state.currentIndex).toBe(0);
  });

  it('works consecutively until start', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = pushNavigation(state, createEntry('page-c'));
    // entries=[page-a, page-b, page-c], index=2 (at page-c)

    // First goBack: page-c → page-b
    let result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
    expect(result.state.currentIndex).toBe(1);

    // Second goBack: page-b → page-a
    result = goBack(result.state);
    expect(result.entry?.zoomedRootId).toBe('page-a');
    expect(result.state.currentIndex).toBe(0);

    // Third goBack: at start, can't go back
    result = goBack(result.state);
    expect(result.entry).toBeNull();
    expect(result.state.currentIndex).toBe(0);
  });

  it('does not mutate entries array', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));

    const entriesBefore = state.entries;
    const result = goBack(state);

    // Same array reference (no mutation)
    expect(result.state.entries).toBe(entriesBefore);
  });
});

describe('goForward', () => {
  it('returns null entry when no forward history', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));

    const result = goForward(state);

    expect(result.entry).toBeNull();
    expect(result.state).toBe(state);
  });

  it('returns entry and increments currentIndex after goBack', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    // entries=[page-a, page-b], index=1 (at page-b)

    // Go back to page-a
    state = goBack(state).state;
    expect(state.currentIndex).toBe(0);

    // Go forward to page-b
    const result = goForward(state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
    expect(result.state.currentIndex).toBe(1);
  });

  it('stops at end of history', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));

    // Go back then forward
    state = goBack(state).state;
    const result1 = goForward(state);
    expect(result1.entry?.zoomedRootId).toBe('page-b');

    // Try to go forward again - should be at end
    const result2 = goForward(result1.state);
    expect(result2.entry).toBeNull();
  });

  it('does not mutate entries array', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = goBack(state).state;

    const entriesBefore = state.entries;
    const result = goForward(state);

    expect(result.state.entries).toBe(entriesBefore);
  });
});

describe('canGoBack', () => {
  it('returns false on empty history', () => {
    const state = createNavigationState();
    expect(canGoBack(state)).toBe(false);
  });

  it('returns false with only one entry (at first location)', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    expect(canGoBack(state)).toBe(false);
  });

  it('returns true with two or more entries', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    expect(canGoBack(state)).toBe(true);
  });

  it('returns false after exhausting back history', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = goBack(state).state;  // Now at page-a (index 0)
    expect(canGoBack(state)).toBe(false);
  });

  it('returns true after goForward', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = goBack(state).state;
    state = goForward(state).state;
    expect(canGoBack(state)).toBe(true);
  });
});

describe('canGoForward', () => {
  it('returns false on empty history', () => {
    const state = createNavigationState();
    expect(canGoForward(state)).toBe(false);
  });

  it('returns false when at end of history', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    expect(canGoForward(state)).toBe(false);
  });

  it('returns true after goBack', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = goBack(state).state;
    expect(canGoForward(state)).toBe(true);
  });

  it('returns false after exhausting forward history', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = goBack(state).state;
    state = goForward(state).state;
    expect(canGoForward(state)).toBe(false);
  });

  it('returns false after pushing new entry (discards forward)', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = goBack(state).state;
    state = pushNavigation(state, createEntry('page-c'));
    expect(canGoForward(state)).toBe(false);
  });
});

describe('getHistoryLength', () => {
  it('returns 0 for empty history', () => {
    const state = createNavigationState();
    expect(getHistoryLength(state)).toBe(0);
  });

  it('returns correct count after pushes', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    expect(getHistoryLength(state)).toBe(1);

    state = pushNavigation(state, createEntry('page-b'));
    expect(getHistoryLength(state)).toBe(2);
  });

  it('decreases when forward history is discarded', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = pushNavigation(state, createEntry('page-c'));
    expect(getHistoryLength(state)).toBe(3);

    state = goBack(state).state;
    state = goBack(state).state;
    state = pushNavigation(state, createEntry('page-d'));
    expect(getHistoryLength(state)).toBe(2);
  });
});

describe('clearHistory', () => {
  it('returns fresh empty state', () => {
    const state = clearHistory();
    expect(state.entries).toEqual([]);
    expect(state.currentIndex).toBe(-1);
  });
});

describe('null zoomedRootId handling (roots view)', () => {
  it('treats null as a valid distinct location', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry(null));
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry(null));

    expect(state.entries).toHaveLength(3);
    expect(state.entries[0].zoomedRootId).toBeNull();
    expect(state.entries[1].zoomedRootId).toBe('page-a');
    expect(state.entries[2].zoomedRootId).toBeNull();
  });

  it('deduplicates consecutive null entries', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry(null));
    state = pushNavigation(state, createEntry(null));

    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].zoomedRootId).toBeNull();
  });

  it('goBack returns previous entry correctly for roots', () => {
    // Journey: roots → page-a
    let state = createNavigationState();
    state = pushNavigation(state, createEntry(null));     // At roots
    state = pushNavigation(state, createEntry('page-a')); // Navigate to page-a
    // entries=[null, page-a], index=1 (at page-a)

    const result = goBack(state);

    expect(result.entry?.zoomedRootId).toBeNull();  // Back to roots
    expect(result.state.currentIndex).toBe(0);
  });

  it('correctly navigates through mixed null and string zoomedRootIds', () => {
    let state = createNavigationState();

    // User navigates: roots → page-a → roots → page-b
    state = pushNavigation(state, createEntry(null));      // At roots
    state = pushNavigation(state, createEntry('page-a'));  // To page-a
    state = pushNavigation(state, createEntry(null));      // Back to roots
    state = pushNavigation(state, createEntry('page-b'));  // To page-b
    // entries=[null, page-a, null, page-b], index=3

    expect(state.entries).toHaveLength(4);

    // Go back: page-b → roots
    let result = goBack(state);
    expect(result.entry?.zoomedRootId).toBeNull();
    state = result.state;

    // Go back: roots → page-a
    result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-a');
    state = result.state;

    // Go back: page-a → roots
    result = goBack(state);
    expect(result.entry?.zoomedRootId).toBeNull();
    state = result.state;

    // Go back: at start, can't go further
    result = goBack(state);
    expect(result.entry).toBeNull();
  });
});

describe('complex navigation scenarios', () => {
  it('simulates real user navigation session', () => {
    // Standard browser model: push AFTER navigating (stores destination)
    let state = createNavigationState();

    // User starts at roots, push roots as initial location
    state = pushNavigation(state, createEntry(null));
    // entries=[null], index=0

    // User clicks [[PageA]] → navigate to PageA, push PageA
    state = pushNavigation(state, createEntry('page-a'));
    // entries=[null, page-a], index=1
    expect(state.entries).toHaveLength(2);

    // User clicks [[PageB]] → navigate to PageB, push PageB
    state = pushNavigation(state, createEntry('page-b'));
    // entries=[null, page-a, page-b], index=2
    expect(state.entries).toHaveLength(3);

    // User clicks [[PageC]] → navigate to PageC, push PageC
    state = pushNavigation(state, createEntry('page-c'));
    // entries=[null, page-a, page-b, page-c], index=3
    expect(state.entries).toHaveLength(4);

    // User hits back (at PageC)
    let result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
    state = result.state;
    // Now at page-b, index=2

    // User hits back (at PageB)
    result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-a');
    state = result.state;
    // Now at page-a, index=1

    // User hits forward (at PageA)
    result = goForward(state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
    state = result.state;
    // Now at page-b, index=2

    // User hits forward (at PageB)
    result = goForward(state);
    expect(result.entry?.zoomedRootId).toBe('page-c');
    state = result.state;
    // Now at page-c, index=3

    // User clicks [[PageD]] → discards forward (none), push PageD
    state = pushNavigation(state, createEntry('page-d'));
    // entries=[null, page-a, page-b, page-c, page-d], index=4

    // Forward should be gone (we're at end of history)
    expect(canGoForward(state)).toBe(false);
  });

  it('discards forward history when navigating from middle', () => {
    let state = createNavigationState();

    // Build: roots → A → B → C
    state = pushNavigation(state, createEntry(null));
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = pushNavigation(state, createEntry('page-c'));
    // entries=[null, a, b, c], index=3

    // Go back to A (index=1)
    state = goBack(state).state;  // at b, index=2
    state = goBack(state).state;  // at a, index=1

    // Now push D - should discard B and C
    state = pushNavigation(state, createEntry('page-d'));
    // entries=[null, a, d], index=2

    expect(state.entries).toHaveLength(3);
    expect(state.entries[0].zoomedRootId).toBeNull();
    expect(state.entries[1].zoomedRootId).toBe('page-a');
    expect(state.entries[2].zoomedRootId).toBe('page-d');

    // Can go back but not forward
    expect(canGoBack(state)).toBe(true);
    expect(canGoForward(state)).toBe(false);
  });

  it('preserves focusedBlockId through navigation', () => {
    let state = createNavigationState();

    state = pushNavigation(state, createEntry('page-a', 'block-1'));
    state = pushNavigation(state, createEntry('page-b', 'block-2'));

    const result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-a');
    expect(result.entry?.focusedBlockId).toBe('block-1');
  });
});
