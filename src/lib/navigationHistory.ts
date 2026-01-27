/**
 * navigationHistory.ts - Pure Navigation State Machine (FLO-180)
 *
 * Framework-agnostic navigation history management.
 * All functions are pure - return new state, no mutations.
 * This follows the same pattern as useBlockInput's determineKeyAction().
 *
 * History Model (Standard Browser Model):
 * - entries contain actual visited locations
 * - currentIndex points to the CURRENT location in the stack
 * - Push DESTINATION after navigating (stores where you ARE now)
 * - Back = decrement index, return that entry
 * - Forward = increment index, return that entry
 *
 * Example:
 *   Start at roots (null), push(null) → entries=[null], index=0
 *   Click [[PageA]], push(PageA) → entries=[null, PageA], index=1
 *   Click [[PageB]], push(PageB) → entries=[null, PageA, PageB], index=2
 *   Cmd+[ → goBack → index=1, return PageA
 *   Cmd+] → goForward → index=2, return PageB
 */

// Default max entries (browser uses ~50)
export const DEFAULT_MAX_HISTORY_SIZE = 50;

/**
 * A single navigation entry in history
 */
export interface NavigationEntry {
  /** Block ID we were zoomed into (null = roots view) */
  zoomedRootId: string | null;
  /** Optional: block that was focused (best-effort restoration) */
  focusedBlockId?: string;
  /** When this entry was created */
  timestamp: number;
}

/**
 * Complete navigation state for a pane
 */
export interface NavigationState {
  /** Stack of navigation entries (oldest first) */
  entries: NavigationEntry[];
  /**
   * Current position in history stack (points to current location)
   * -1 = no history yet
   * 0..length-1 = valid position
   *
   * After pushNavigation: currentIndex = entries.length - 1 (at new entry)
   * After goBack: currentIndex decremented, return entries[newIndex]
   * After goForward: currentIndex incremented, return entries[newIndex]
   */
  currentIndex: number;
}

/**
 * Create empty navigation state
 */
export function createNavigationState(): NavigationState {
  return {
    entries: [],
    currentIndex: -1,
  };
}

/**
 * Check if two entries represent the same location
 * Only compares zoomedRootId (focusedBlockId is optional hint, timestamp always differs)
 */
export function isSameLocation(a: NavigationEntry, b: NavigationEntry): boolean {
  return a.zoomedRootId === b.zoomedRootId;
}

/**
 * Push a new navigation entry (the destination you just navigated TO)
 *
 * Behavior:
 * - Discards any forward history (entries after currentIndex)
 * - Deduplicates consecutive same-location entries
 * - Trims to maxSize (oldest entries removed first)
 *
 * @param state Current navigation state
 * @param entry Entry to push (the DESTINATION location you just arrived at)
 * @param maxSize Maximum entries to keep (default: 50)
 * @returns New state with entry added
 */
export function pushNavigation(
  state: NavigationState,
  entry: NavigationEntry,
  maxSize: number = DEFAULT_MAX_HISTORY_SIZE
): NavigationState {
  // Start with entries up to and including currentIndex (discard forward history)
  // If currentIndex is -1 (empty), this gives us empty array
  const baseEntries = state.currentIndex >= 0
    ? state.entries.slice(0, state.currentIndex + 1)
    : [];

  // Deduplicate: don't push if same location as current entry
  const currentEntry = baseEntries[baseEntries.length - 1];
  if (currentEntry && isSameLocation(currentEntry, entry)) {
    // Same location - don't add duplicate, but update focused block if provided
    if (entry.focusedBlockId && entry.focusedBlockId !== currentEntry.focusedBlockId) {
      const updatedEntries = [...baseEntries];
      updatedEntries[updatedEntries.length - 1] = {
        ...currentEntry,
        focusedBlockId: entry.focusedBlockId,
        timestamp: entry.timestamp,
      };
      return {
        entries: updatedEntries,
        currentIndex: updatedEntries.length - 1,
      };
    }
    // Truly duplicate - no change
    return state;
  }

  // Add new entry
  const newEntries = [...baseEntries, entry];

  // Trim to maxSize (remove oldest)
  const trimmedEntries = newEntries.length > maxSize
    ? newEntries.slice(newEntries.length - maxSize)
    : newEntries;

  return {
    entries: trimmedEntries,
    currentIndex: trimmedEntries.length - 1,
  };
}

/**
 * Result of a navigation operation (goBack/goForward)
 */
export interface NavigationResult {
  /** Updated state */
  state: NavigationState;
  /** Entry to navigate to (null if at boundary) */
  entry: NavigationEntry | null;
}

/**
 * Go back in history
 *
 * @param state Current navigation state
 * @returns New state and entry to restore (null if at start of history)
 */
export function goBack(state: NavigationState): NavigationResult {
  // Can't go back if no history or already at start (index 0 is first entry)
  if (state.currentIndex <= 0 || state.entries.length === 0) {
    return { state, entry: null };
  }

  const newIndex = state.currentIndex - 1;
  const entry = state.entries[newIndex];

  return {
    state: {
      entries: state.entries,
      currentIndex: newIndex,
    },
    entry,
  };
}

/**
 * Go forward in history
 *
 * @param state Current navigation state
 * @returns New state and entry to restore (null if at end of history)
 */
export function goForward(state: NavigationState): NavigationResult {
  // Can't go forward if at or past the end
  if (state.currentIndex >= state.entries.length - 1) {
    return { state, entry: null };
  }

  const newIndex = state.currentIndex + 1;
  const entry = state.entries[newIndex];

  return {
    state: {
      entries: state.entries,
      currentIndex: newIndex,
    },
    entry,
  };
}

/**
 * Check if we can go back (have history before current position)
 */
export function canGoBack(state: NavigationState): boolean {
  return state.currentIndex > 0 && state.entries.length > 1;
}

/**
 * Check if we can go forward (have history after current position)
 */
export function canGoForward(state: NavigationState): boolean {
  return state.currentIndex < state.entries.length - 1 && state.currentIndex >= 0;
}

/**
 * Get the current entry count (for debugging/display)
 */
export function getHistoryLength(state: NavigationState): number {
  return state.entries.length;
}

/**
 * Clear all history (returns fresh state)
 */
export function clearHistory(): NavigationState {
  return createNavigationState();
}
