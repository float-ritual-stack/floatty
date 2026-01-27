/**
 * navigationHistory.test.ts - Pure state machine tests (FLO-180)
 *
 * Tests the navigation history functions in isolation.
 * No framework, no DOM, no mocking - just pure functions.
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
    // Build history: A → B → C
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = pushNavigation(state, createEntry('page-c'));

    // Go back twice (to A)
    state = goBack(state).state;
    state = goBack(state).state;

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

  it('returns entry and decrements currentIndex', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));

    const result = goBack(state);

    expect(result.entry?.zoomedRootId).toBe('page-b');
    expect(result.state.currentIndex).toBe(0);
  });

  it('works consecutively until start', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = pushNavigation(state, createEntry('page-b'));
    state = pushNavigation(state, createEntry('page-c'));

    // First goBack
    let result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-c');
    expect(result.state.currentIndex).toBe(1);

    // Second goBack
    result = goBack(result.state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
    expect(result.state.currentIndex).toBe(0);

    // Third goBack
    result = goBack(result.state);
    expect(result.entry?.zoomedRootId).toBe('page-a');
    expect(result.state.currentIndex).toBe(-1);

    // Fourth goBack - at boundary
    result = goBack(result.state);
    expect(result.entry).toBeNull();
    expect(result.state.currentIndex).toBe(-1);
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

    // Go back
    state = goBack(state).state;
    expect(state.currentIndex).toBe(0);

    // Go forward
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

  it('returns true with history entries', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    expect(canGoBack(state)).toBe(true);
  });

  it('returns false after exhausting back history', () => {
    let state = createNavigationState();
    state = pushNavigation(state, createEntry('page-a'));
    state = goBack(state).state;
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

  it('goBack returns null entry (roots view) correctly', () => {
    // Mental model: push BEFORE navigating, so push captures where I WAS
    // Journey: roots (null) → page-a
    // Push "I was at roots" before zooming to page-a
    let state = createNavigationState();
    state = pushNavigation(state, createEntry(null));  // Push: was at roots
    // Now user is viewing page-a, history = [null], index = 0

    const result = goBack(state);

    // Should return null (roots) - where I was before current view
    expect(result.entry?.zoomedRootId).toBeNull();
  });

  it('correctly navigates through mixed null and string zoomedRootIds', () => {
    let state = createNavigationState();

    // User starts at roots, navigates around
    state = pushNavigation(state, createEntry(null));  // At roots
    state = pushNavigation(state, createEntry('page-a'));  // To page-a
    state = pushNavigation(state, createEntry(null));  // Back to roots (via click)
    state = pushNavigation(state, createEntry('page-b'));  // To page-b

    expect(state.entries).toHaveLength(4);

    // Go back should get us: page-b (current), then null, then page-a, then null
    let result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
    state = result.state;

    result = goBack(state);
    expect(result.entry?.zoomedRootId).toBeNull();
    state = result.state;

    result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-a');
    state = result.state;

    result = goBack(state);
    expect(result.entry?.zoomedRootId).toBeNull();
  });
});

describe('complex navigation scenarios', () => {
  it('simulates real user navigation session', () => {
    // Mental model: history entries are "where I was BEFORE each navigation"
    // Push happens BEFORE the zoom changes, capturing current location
    let state = createNavigationState();

    // User starts at roots (null), clicks [[PageA]]
    // Push current (null) before zooming to PageA
    state = pushNavigation(state, createEntry(null));
    // Now viewing PageA, history = [null], index = 0
    expect(state.entries[0].zoomedRootId).toBeNull();

    // User clicks [[PageB]] while viewing PageA
    // Push current (PageA) before zooming to PageB
    state = pushNavigation(state, createEntry('page-a'));
    // Now viewing PageB, history = [null, page-a], index = 1
    expect(state.entries).toHaveLength(2);

    // User clicks [[PageC]] while viewing PageB
    // Push current (PageB) before zooming to PageC
    state = pushNavigation(state, createEntry('page-b'));
    // Now viewing PageC, history = [null, page-a, page-b], index = 2
    expect(state.entries).toHaveLength(3);

    // User hits back (while viewing PageC)
    // Returns page-b (where they were before PageC)
    let result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
    state = result.state;
    // Now viewing PageB, index = 1

    // User hits back again (while viewing PageB)
    // Returns page-a (where they were before PageB)
    result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-a');
    state = result.state;
    // Now viewing PageA, index = 0

    // User hits forward (while viewing PageA)
    // Returns page-a (where we go forward TO is actually index+1 = page-a)
    // Wait, this is confusing. Let me re-read goForward...
    // goForward increments index then returns that entry
    // index was 0, becomes 1, returns entries[1] = page-a
    result = goForward(state);
    expect(result.entry?.zoomedRootId).toBe('page-a');
    state = result.state;
    // Now viewing PageB (because forward went to the page-a entry), index = 1

    // User clicks [[PageD]] while viewing PageB
    // Push current (PageB) before zooming to PageD
    // This should discard entries after currentIndex
    state = pushNavigation(state, createEntry('page-b'));
    // history = [null, page-a, page-b], index = 2

    // Forward should be gone (we're at end of history)
    expect(canGoForward(state)).toBe(false);
  });

  it('handles mixed null and string zoomedRootIds', () => {
    // Journey: roots → page-a → roots → page-b → page-c (current)
    // Push at each step: null, page-a, null, page-b
    let state = createNavigationState();

    state = pushNavigation(state, createEntry(null));      // Before going to page-a
    state = pushNavigation(state, createEntry('page-a'));  // Before going back to roots
    state = pushNavigation(state, createEntry(null));      // Before going to page-b
    state = pushNavigation(state, createEntry('page-b'));  // Before going to page-c

    expect(state.entries).toHaveLength(4);
    // entries = [null, page-a, null, page-b], index = 3
    // User is now at page-c

    // Go back should give us page-b (where we were before page-c)
    const result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
  });

  it('preserves focusedBlockId through navigation', () => {
    let state = createNavigationState();

    state = pushNavigation(state, createEntry('page-a', 'block-1'));
    state = pushNavigation(state, createEntry('page-b', 'block-2'));

    const result = goBack(state);
    expect(result.entry?.zoomedRootId).toBe('page-b');
    expect(result.entry?.focusedBlockId).toBe('block-2');
  });
});
