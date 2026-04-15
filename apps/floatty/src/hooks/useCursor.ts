/**
 * useCursor - Abstraction layer for cursor utilities
 *
 * Wraps DOM-dependent cursor utilities with a per-element snapshot cache.
 * A single DOM walk produces all four boundary values (offset, atStart,
 * atEnd, contentLength) and caches them until the selection actually
 * changes. This eliminates redundant walks when callers read multiple
 * fields in the same event frame — the common case in determineKeyAction,
 * which previously did three consecutive DOM walks per keystroke.
 *
 * Cache invalidation: document-level listeners on `selectionchange`,
 * `input`, and `compositionupdate` bump a monotonic generation counter.
 * Any cached entry with a stale generation is treated as a cache miss
 * and recomputed on next read. Programmatic DOM mutations (e.g., setting
 * `innerText` directly) do NOT fire these events — callers must call
 * `cursor.invalidate()` explicitly after such a mutation.
 *
 * Tests: see useCursor.test.ts for cache behavior; existing cursorUtils
 * tests continue to validate the underlying DOM walk math.
 */

import {
  getAbsoluteCursorOffset,
  setCursorAtOffset,
  getContentLength,
} from '../lib/cursorUtils';

export interface CursorSnapshot {
  /** Absolute character offset from start of element */
  offset: number;
  /** True when offset === 0 */
  atStart: boolean;
  /** True when offset >= contentLength */
  atEnd: boolean;
  /** Total content length (innerText.length) */
  contentLength: number;
}

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
  /**
   * Compute all four cursor boundary values in a single DOM walk.
   * Cached per element until the next selectionchange/input/composition
   * event (or explicit invalidate()). Returns null only if the bound
   * element is not mounted.
   */
  snapshot: () => CursorSnapshot | null;
  /**
   * Force cache invalidation. Call before/after a programmatic mutation
   * that moves the cursor without firing input/selectionchange — e.g.,
   * assigning `contentRef.innerText = ...` during remote DOM sync.
   */
  invalidate: () => void;
}

// ─── Module-level cache ─────────────────────────────────────────────
// WeakMap lets cached entries drop when their contentEditable element
// is garbage-collected (block unmount). No manual cleanup per element.
interface CacheEntry {
  snapshot: CursorSnapshot;
  generation: number;
}

const snapshotCache = new WeakMap<HTMLElement, CacheEntry>();
let cacheGeneration = 0;

/**
 * Bump generation → all cached entries now stale. Next read recomputes.
 * Cheap: single integer increment. Safe for hot paths.
 */
function bumpGeneration(): void {
  // Number.MAX_SAFE_INTEGER at one bump per input event is ~285 years
  // of continuous typing. Not a real concern.
  cacheGeneration++;
}

/**
 * Compute a fresh snapshot with a SINGLE DOM walk for the offset, then
 * derive atStart/atEnd from the already-computed offset + contentLength.
 *
 * Earlier revision called isCursorAtContentStart + isCursorAtContentEnd,
 * each of which re-invokes getAbsoluteCursorOffset internally — that was
 * 3 walks per cache miss, directly contradicting the PR's "one walk" goal
 * (caught in review, Greptile P2 on PR #233).
 *
 * Semantics match cursorUtils.ts:298-321 exactly: atStart/atEnd are only
 * meaningful for a collapsed selection with a live range.
 */
function computeSnapshot(element: HTMLElement): CursorSnapshot {
  const contentLength = getContentLength(element);

  // Empty element → cursor is trivially at both ends.
  if (contentLength === 0) {
    return { offset: 0, atStart: true, atEnd: true, contentLength: 0 };
  }

  // Single DOM walk.
  const offset = getAbsoluteCursorOffset(element);

  // atStart/atEnd only defined for a collapsed selection with a range —
  // mirrors isCursorAtContentStart/End's guard ladder without the extra walks.
  const selection = window.getSelection();
  const isCollapsed =
    !!selection && selection.isCollapsed && selection.rangeCount > 0;

  return {
    offset,
    atStart: isCollapsed && offset === 0,
    atEnd: isCollapsed && offset >= contentLength,
    contentLength,
  };
}

// ─── Document-level invalidation listeners ──────────────────────────
// One listener each, attached at module load. All three events bump
// the same generation counter, invalidating every cached entry globally.
// Per-element listeners would leak on unmount without tracking; the
// single global pattern is both simpler and cheaper.
//
// `selectionchange` covers arrow/home/end navigation (and mouse clicks).
// `input` covers character insertion (fires synchronously after keystroke).
// `compositionupdate` covers IME composition (cursor moves without
// necessarily firing selectionchange during active composition).
//
// Guarded against test environments where `document` may be missing or
// where SSR-adjacent tooling runs this module without a DOM.
const hasDocument = typeof document !== 'undefined';

if (hasDocument) {
  document.addEventListener('selectionchange', bumpGeneration);
  document.addEventListener('input', bumpGeneration, true);
  document.addEventListener('compositionupdate', bumpGeneration, true);
}

// ─── HMR cleanup ─────────────────────────────────────────────────────
// Without dispose, hot reload accumulates listeners per edit → memory
// leak + duplicate invalidation. See .claude/rules/do-not.md HMR section.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (hasDocument) {
      document.removeEventListener('selectionchange', bumpGeneration);
      document.removeEventListener('input', bumpGeneration, true);
      document.removeEventListener('compositionupdate', bumpGeneration, true);
    }
    // WeakMap has no .clear() before ES2023 and we can't enumerate keys;
    // relying on GC is correct here — the old module's closure dies with
    // the reload, and the fresh module starts with a new empty WeakMap.
  });
}

// ─── Test-only cache reset ──────────────────────────────────────────
// Exported for tests so they can reset state between cases. Do not
// import from production code.
export function __resetCursorSnapshotCacheForTests(): void {
  cacheGeneration++;
}

/**
 * Create cursor state helpers bound to an element ref
 *
 * @param getElement - Function that returns the element (or undefined if not mounted)
 * @returns CursorState with methods for querying/setting cursor position
 */
export function useCursor(getElement: () => HTMLElement | undefined): CursorState {
  const readSnapshot = (): CursorSnapshot | null => {
    const el = getElement();
    if (!el) return null;

    const cached = snapshotCache.get(el);
    if (cached && cached.generation === cacheGeneration) {
      return cached.snapshot;
    }

    const snapshot = computeSnapshot(el);
    snapshotCache.set(el, { snapshot, generation: cacheGeneration });
    return snapshot;
  };

  return {
    // Existing shim methods — delegate to snapshot so repeated reads in
    // the same generation share one DOM walk. Preserves the old API so
    // non-hot-path callers need no changes.
    isAtStart: () => readSnapshot()?.atStart ?? false,
    isAtEnd: () => readSnapshot()?.atEnd ?? false,
    getOffset: () => readSnapshot()?.offset ?? 0,

    setOffset: (offset: number) => {
      const el = getElement();
      if (!el) return;
      setCursorAtOffset(el, offset);
      // Cursor moved programmatically; invalidate so the next read
      // recomputes instead of returning the pre-mutation snapshot.
      bumpGeneration();
    },

    isSelectionCollapsed: () => {
      const selection = window.getSelection();
      return selection?.isCollapsed ?? true;
    },

    snapshot: readSnapshot,

    invalidate: () => {
      bumpGeneration();
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
  contentLength?: number;
} = {}): CursorState {
  // Derive all fields from a single internal state object so callers
  // using isAtStart() vs snapshot().atStart observe the same values.
  const atStart = overrides.atStart ?? false;
  const atEnd = overrides.atEnd ?? false;
  const offset = overrides.offset ?? 0;
  const contentLength = overrides.contentLength ?? offset;
  const collapsed = overrides.collapsed ?? true;

  const buildSnapshot = (): CursorSnapshot => ({
    offset,
    atStart,
    atEnd,
    contentLength,
  });

  return {
    isAtStart: () => atStart,
    isAtEnd: () => atEnd,
    getOffset: () => offset,
    setOffset: () => {},
    isSelectionCollapsed: () => collapsed,
    snapshot: () => buildSnapshot(),
    invalidate: () => {},
  };
}
