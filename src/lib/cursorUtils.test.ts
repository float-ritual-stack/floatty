/**
 * Tests for cursorUtils — offset calculation and boundary detection
 * against real DOM structures matching floatty's contentEditable behavior.
 *
 * DOM MODEL: floatty sets content via innerText, which creates bare <br>
 * at root level. No <div><br></div> wrapping. Each <br> = 1 newline.
 *
 * NOTE: jsdom doesn't implement innerText setter, so we build DOM manually
 * to match what real browsers create.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAbsoluteCursorOffset,
  setCursorAtOffset,
  isCursorAtContentStart,
  isCursorAtContentEnd,
} from './cursorUtils';

/**
 * Build a contentEditable div with the same DOM structure browsers create
 * when setting innerText. Newlines become bare <br> at root level.
 *
 * "hello"     → [text"hello"]
 * "a\nb"      → [text"a", <br>, text"b"]
 * "a\n\nb"    → [text"a", <br>, <br>, text"b"]
 * "\n\n"      → [<br>, <br>]
 * "\nf\n \n"  → [<br>, text"f", <br>, text" ", <br>]
 */
function buildContentEditable(content: string): HTMLDivElement {
  const el = document.createElement('div');
  el.contentEditable = 'true';
  document.body.appendChild(el);

  if (content === '') return el;

  const parts = content.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      el.appendChild(document.createElement('br'));
    }
    if (parts[i].length > 0) {
      el.appendChild(document.createTextNode(parts[i]));
    }
  }

  return el;
}

/** Place cursor at (element, childIndex) */
function placeCursorAt(el: HTMLElement, index: number): void {
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.setStart(el, Math.min(index, el.childNodes.length));
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Place cursor in a text node at a character offset */
function placeCursorInText(textNode: Text, offset: number): void {
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.setStart(textNode, offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Find Nth text node in element (0-indexed) */
function findTextNode(el: HTMLElement, n: number): Text {
  let count = 0;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (count === n) return child as Text;
      count++;
    }
  }
  throw new Error(`Text node ${n} not found (only ${count} text nodes)`);
}

describe('cursorUtils', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // ═══════════════════════════════════════════════════════════════
  // getAbsoluteCursorOffset
  // ═══════════════════════════════════════════════════════════════

  describe('getAbsoluteCursorOffset', () => {
    it('returns 0 for empty element', () => {
      const el = buildContentEditable('');
      placeCursorAt(el, 0);
      expect(getAbsoluteCursorOffset(el)).toBe(0);
    });

    it('returns correct offset in single-line text', () => {
      const el = buildContentEditable('hello');
      // DOM: [text"hello"]
      placeCursorInText(findTextNode(el, 0), 3);
      expect(getAbsoluteCursorOffset(el)).toBe(3);
    });

    it('returns content length at end of single-line text', () => {
      const el = buildContentEditable('hello');
      placeCursorInText(findTextNode(el, 0), 5);
      expect(getAbsoluteCursorOffset(el)).toBe(5);
    });

    it('counts bare <br> as 1 character', () => {
      const el = buildContentEditable('a\nb\nc');
      // DOM: [text"a", <br>, text"b", <br>, text"c"]
      // Cursor before "b" text node = after "a" + <br> = offset 2
      placeCursorInText(findTextNode(el, 1), 0);
      expect(getAbsoluteCursorOffset(el)).toBe(2);
    });

    it('handles (root, childCount) — after all children', () => {
      const el = buildContentEditable('a\nb');
      // DOM: [text"a", <br>, text"b"] — 3 children
      placeCursorAt(el, 3);
      // "a" + \n + "b" = 3
      expect(getAbsoluteCursorOffset(el)).toBe(3);
    });

    it('handles trailing <br> — cursor after all children', () => {
      const el = buildContentEditable('test\n\n\n');
      // DOM: [text"test", <br>, <br>, <br>] — 4 children
      placeCursorAt(el, 4);
      // "test" + 3 newlines = 7
      expect(getAbsoluteCursorOffset(el)).toBe(7);
    });

    it('handles cursor before last <br> in trailing sequence', () => {
      const el = buildContentEditable('test\n\n\n');
      // Cursor before last <br> (child 3)
      placeCursorAt(el, 3);
      // "test" + 2 newlines = 6
      expect(getAbsoluteCursorOffset(el)).toBe(6);
    });

    it('handles all-newlines content at each position', () => {
      const el = buildContentEditable('\n\n\n');
      // DOM: [<br>, <br>, <br>]
      expect(el.childNodes.length).toBe(3);

      placeCursorAt(el, 0);
      expect(getAbsoluteCursorOffset(el)).toBe(0);

      placeCursorAt(el, 1);
      expect(getAbsoluteCursorOffset(el)).toBe(1);

      placeCursorAt(el, 2);
      expect(getAbsoluteCursorOffset(el)).toBe(2);

      // After all children
      placeCursorAt(el, 3);
      expect(getAbsoluteCursorOffset(el)).toBe(3);
    });

    it('offsets increase monotonically through bug-report content', () => {
      const el = buildContentEditable('\nf\n \n\nt\nf\n\n\n\n\n');
      // Walk every child index and verify monotonic increase
      let prev = -1;
      for (let i = 0; i <= el.childNodes.length; i++) {
        placeCursorAt(el, i);
        const offset = getAbsoluteCursorOffset(el);
        expect(offset).toBeGreaterThan(prev);
        prev = offset;
      }

      // Last position = content length
      placeCursorAt(el, el.childNodes.length);
      // Content: \nf\n \n\nt\nf\n\n\n\n\n = 14 chars
      expect(getAbsoluteCursorOffset(el)).toBe(14);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // isCursorAtContentEnd
  // ═══════════════════════════════════════════════════════════════

  describe('isCursorAtContentEnd', () => {
    it('true for empty element', () => {
      const el = buildContentEditable('');
      placeCursorAt(el, 0);
      expect(isCursorAtContentEnd(el)).toBe(true);
    });

    it('true at end of single-line text', () => {
      const el = buildContentEditable('hello');
      placeCursorInText(findTextNode(el, 0), 5);
      expect(isCursorAtContentEnd(el)).toBe(true);
    });

    it('false in middle of single-line text', () => {
      const el = buildContentEditable('hello');
      placeCursorInText(findTextNode(el, 0), 3);
      expect(isCursorAtContentEnd(el)).toBe(false);
    });

    it('true at (root, childCount) with trailing newlines', () => {
      const el = buildContentEditable('test\n\n\n');
      placeCursorAt(el, el.childNodes.length);
      expect(isCursorAtContentEnd(el)).toBe(true);
    });

    it('false before last <br> — the bug that trapped cursor', () => {
      const el = buildContentEditable('test\n\n\n');
      // Cursor at second-to-last position — NOT at end
      placeCursorAt(el, el.childNodes.length - 1);
      expect(isCursorAtContentEnd(el)).toBe(false);
    });

    it('false at start of content with trailing newlines', () => {
      const el = buildContentEditable('test\n\n\n');
      placeCursorAt(el, 0);
      expect(isCursorAtContentEnd(el)).toBe(false);
    });

    it('true for all-newlines at end', () => {
      const el = buildContentEditable('\n\n\n');
      placeCursorAt(el, el.childNodes.length);
      expect(isCursorAtContentEnd(el)).toBe(true);
    });

    it('false for all-newlines not at end', () => {
      const el = buildContentEditable('\n\n\n');
      placeCursorAt(el, 1);
      expect(isCursorAtContentEnd(el)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // isCursorAtContentStart
  // ═══════════════════════════════════════════════════════════════

  describe('isCursorAtContentStart', () => {
    it('true for empty element', () => {
      const el = buildContentEditable('');
      placeCursorAt(el, 0);
      expect(isCursorAtContentStart(el)).toBe(true);
    });

    it('true at offset 0 in text', () => {
      const el = buildContentEditable('hello');
      placeCursorInText(findTextNode(el, 0), 0);
      expect(isCursorAtContentStart(el)).toBe(true);
    });

    it('false in middle of text', () => {
      const el = buildContentEditable('hello');
      placeCursorInText(findTextNode(el, 0), 3);
      expect(isCursorAtContentStart(el)).toBe(false);
    });

    it('true at (root, 0) with leading newlines', () => {
      const el = buildContentEditable('\n\ntest');
      placeCursorAt(el, 0);
      expect(isCursorAtContentStart(el)).toBe(true);
    });

    it('false at (root, 1) with leading newlines', () => {
      const el = buildContentEditable('\n\ntest');
      placeCursorAt(el, 1);
      expect(isCursorAtContentStart(el)).toBe(false);
    });

    it('true for all-newlines at start', () => {
      const el = buildContentEditable('\n\n\n');
      placeCursorAt(el, 0);
      expect(isCursorAtContentStart(el)).toBe(true);
    });

    it('false for all-newlines not at start', () => {
      const el = buildContentEditable('\n\n\n');
      placeCursorAt(el, 2);
      expect(isCursorAtContentStart(el)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // setCursorAtOffset + getAbsoluteCursorOffset roundtrip
  // ═══════════════════════════════════════════════════════════════

  describe('setCursorAtOffset / getAbsoluteCursorOffset roundtrip', () => {
    it('roundtrips for single-line text', () => {
      const el = buildContentEditable('hello');
      for (let i = 0; i <= 5; i++) {
        setCursorAtOffset(el, i);
        expect(getAbsoluteCursorOffset(el)).toBe(i);
      }
    });

    it('roundtrips for multi-line text', () => {
      const el = buildContentEditable('a\nb\nc');
      // "a\nb\nc" = 5 chars
      for (let i = 0; i <= 5; i++) {
        setCursorAtOffset(el, i);
        expect(getAbsoluteCursorOffset(el)).toBe(i);
      }
    });

    it('roundtrips for trailing newlines', () => {
      const el = buildContentEditable('test\n\n\n');
      // "test\n\n\n" = 7 chars
      for (let i = 0; i <= 7; i++) {
        setCursorAtOffset(el, i);
        expect(getAbsoluteCursorOffset(el)).toBe(i);
      }
    });

    it('roundtrips for all-newlines content', () => {
      const el = buildContentEditable('\n\n\n');
      for (let i = 0; i <= 3; i++) {
        setCursorAtOffset(el, i);
        expect(getAbsoluteCursorOffset(el)).toBe(i);
      }
    });

    it('roundtrips for the actual bug-report content', () => {
      const el = buildContentEditable('\nf\n \n\nt\nf\n\n\n\n\n');
      // 14 chars
      for (let i = 0; i <= 14; i++) {
        setCursorAtOffset(el, i);
        expect(getAbsoluteCursorOffset(el)).toBe(i);
      }
    });
  });
});
