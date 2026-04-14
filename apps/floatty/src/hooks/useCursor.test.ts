/**
 * Tests for useCursor snapshot cache (FLO-387).
 *
 * Cache behavior:
 * - First snapshot() call computes fresh
 * - Second snapshot() call in same generation returns cached value
 * - selectionchange / input / compositionupdate events bump generation
 * - Explicit invalidate() bumps generation
 * - createMockCursor exposes a consistent snapshot
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as cursorUtils from '../lib/cursorUtils';
import {
  useCursor,
  createMockCursor,
  __resetCursorSnapshotCacheForTests,
} from './useCursor';

/** Build a contentEditable div with bare <br> per newline (matches floatty DOM). */
function buildEditable(content: string): HTMLDivElement {
  const el = document.createElement('div');
  el.contentEditable = 'true';
  document.body.appendChild(el);
  if (content === '') return el;
  const parts = content.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) el.appendChild(document.createElement('br'));
    if (parts[i].length > 0) el.appendChild(document.createTextNode(parts[i]));
  }
  return el;
}

/** Place cursor inside the first text node at a given offset. */
function placeCursorInFirstText(el: HTMLElement, offset: number): void {
  const textNode = Array.from(el.childNodes).find(
    (n) => n.nodeType === Node.TEXT_NODE,
  ) as Text | undefined;
  if (!textNode) return;
  const range = document.createRange();
  range.setStart(textNode, Math.min(offset, textNode.textContent?.length ?? 0));
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

beforeEach(() => {
  document.body.innerHTML = '';
  __resetCursorSnapshotCacheForTests();
  vi.restoreAllMocks();
});

describe('useCursor.snapshot()', () => {
  it('returns all four fields in one call', () => {
    const el = buildEditable('hello world');
    placeCursorInFirstText(el, 5);

    const cursor = useCursor(() => el);
    const snap = cursor.snapshot();

    expect(snap).not.toBeNull();
    expect(snap).toMatchObject({
      offset: 5,
      atStart: false,
      atEnd: false,
    });
    expect(snap!.contentLength).toBeGreaterThanOrEqual(5);
  });

  it('returns null when bound element is unavailable', () => {
    let el: HTMLElement | undefined;
    const cursor = useCursor(() => el);
    expect(cursor.snapshot()).toBeNull();
  });

  it('treats empty element as atStart AND atEnd', () => {
    const el = buildEditable('');
    const cursor = useCursor(() => el);
    const snap = cursor.snapshot();
    expect(snap).toMatchObject({
      offset: 0,
      atStart: true,
      atEnd: true,
      contentLength: 0,
    });
  });

  it('caches subsequent reads in the same generation', () => {
    const el = buildEditable('abcdef');
    placeCursorInFirstText(el, 3);
    const cursor = useCursor(() => el);

    const spy = vi.spyOn(cursorUtils, 'getAbsoluteCursorOffset');

    cursor.snapshot(); // miss → 1 walk
    const beforeSecond = spy.mock.calls.length;
    cursor.snapshot(); // hit → no walk
    cursor.snapshot(); // hit → no walk

    expect(spy.mock.calls.length).toBe(beforeSecond);
  });

  it('recomputes after explicit invalidate()', () => {
    const el = buildEditable('abcdef');
    placeCursorInFirstText(el, 2);
    const cursor = useCursor(() => el);

    cursor.snapshot();
    const spy = vi.spyOn(cursorUtils, 'getAbsoluteCursorOffset');
    cursor.snapshot(); // should be cached
    expect(spy.mock.calls.length).toBe(0);

    cursor.invalidate();
    cursor.snapshot(); // now fresh
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it('recomputes after document selectionchange event', () => {
    const el = buildEditable('abcdef');
    placeCursorInFirstText(el, 2);
    const cursor = useCursor(() => el);
    cursor.snapshot();

    const spy = vi.spyOn(cursorUtils, 'getAbsoluteCursorOffset');
    cursor.snapshot();
    expect(spy.mock.calls.length).toBe(0);

    document.dispatchEvent(new Event('selectionchange'));
    cursor.snapshot();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it('recomputes after document input event', () => {
    const el = buildEditable('abcdef');
    placeCursorInFirstText(el, 2);
    const cursor = useCursor(() => el);
    cursor.snapshot();

    const spy = vi.spyOn(cursorUtils, 'getAbsoluteCursorOffset');
    cursor.snapshot();
    expect(spy.mock.calls.length).toBe(0);

    // Dispatch on element so capture-phase listener fires
    el.dispatchEvent(new Event('input', { bubbles: true }));
    cursor.snapshot();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it('recomputes after document compositionupdate event', () => {
    const el = buildEditable('abcdef');
    placeCursorInFirstText(el, 2);
    const cursor = useCursor(() => el);
    cursor.snapshot();

    const spy = vi.spyOn(cursorUtils, 'getAbsoluteCursorOffset');
    cursor.snapshot();
    expect(spy.mock.calls.length).toBe(0);

    el.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true }));
    cursor.snapshot();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });

  it('isAtStart/isAtEnd/getOffset shims delegate to snapshot', () => {
    const el = buildEditable('hello');
    placeCursorInFirstText(el, 0);
    const cursor = useCursor(() => el);

    // First call computes; subsequent shims reuse the cache.
    const spy = vi.spyOn(cursorUtils, 'getAbsoluteCursorOffset');
    expect(cursor.isAtStart()).toBe(true);
    const afterFirst = spy.mock.calls.length;
    cursor.isAtEnd();
    cursor.getOffset();
    expect(spy.mock.calls.length).toBe(afterFirst);
  });

  it('setOffset() bumps generation so next read is fresh', () => {
    const el = buildEditable('hello world');
    placeCursorInFirstText(el, 2);
    const cursor = useCursor(() => el);
    cursor.snapshot();

    const spy = vi.spyOn(cursorUtils, 'getAbsoluteCursorOffset');
    cursor.snapshot();
    expect(spy.mock.calls.length).toBe(0);

    cursor.setOffset(4);
    cursor.snapshot();
    expect(spy.mock.calls.length).toBeGreaterThan(0);
  });
});

describe('createMockCursor', () => {
  it('exposes snapshot() with overrides', () => {
    const mock = createMockCursor({
      atStart: false,
      atEnd: true,
      offset: 12,
      contentLength: 12,
    });
    const snap = mock.snapshot();
    expect(snap).toEqual({
      offset: 12,
      atStart: false,
      atEnd: true,
      contentLength: 12,
    });
  });

  it('keeps shim methods in sync with snapshot', () => {
    const mock = createMockCursor({ atStart: true, offset: 0, contentLength: 0 });
    expect(mock.isAtStart()).toBe(true);
    expect(mock.getOffset()).toBe(0);
    expect(mock.snapshot()?.atStart).toBe(true);
    expect(mock.snapshot()?.offset).toBe(0);
  });

  it('invalidate() is a no-op on mocks', () => {
    const mock = createMockCursor({ offset: 5 });
    mock.invalidate();
    expect(mock.snapshot()?.offset).toBe(5);
  });
});
