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
  hasLiveTextSelection,
  isShiftClickTextGesture,
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

// ─── hasLiveTextSelection (quirk-audit cluster B) ─────────────────────
// The predicate both Cmd+C and shift+click consult before block-selecting:
// a non-collapsed selection inside a focused contentEditable means the user
// is working with TEXT, and block-level gestures must stand down.

describe('hasLiveTextSelection', () => {
  function buildFocusableCE(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'true');
    el.tabIndex = 0; // jsdom focuses elements with tabIndex
    el.appendChild(document.createTextNode(text));
    document.body.appendChild(el);
    return el;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  it('true: focused contentEditable with a non-collapsed selection', () => {
    const el = buildFocusableCE('hello world');
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, 5); // "hello"
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(hasLiveTextSelection()).toBe(true);
  });

  it('false: focused contentEditable but the selection is collapsed (caret only)', () => {
    const el = buildFocusableCE('hello world');
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 3);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(hasLiveTextSelection()).toBe(false);
  });

  it('false: selection exists but focus is NOT in a contentEditable', () => {
    const el = document.createElement('div');
    el.appendChild(document.createTextNode('plain text'));
    document.body.appendChild(el);
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    (document.activeElement as HTMLElement | null)?.blur?.();

    expect(hasLiveTextSelection()).toBe(false);
  });

  it('false: no selection at all', () => {
    const el = buildFocusableCE('hello');
    el.focus();
    window.getSelection()?.removeAllRanges();

    expect(hasLiveTextSelection()).toBe(false);
  });

  it('false: selection lives in a DIFFERENT editor than the focused one', () => {
    // CodeRabbit round-1: a stale selection left in editor A must not
    // suppress block gestures while the user is focused in editor B.
    const editorA = buildFocusableCE('editor a text');
    const editorB = buildFocusableCE('editor b text');
    const range = document.createRange();
    range.setStart(editorA.firstChild!, 0);
    range.setEnd(editorA.firstChild!, 6);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    editorB.focus(); // focus moves; jsdom keeps the selection on editorA

    expect(document.activeElement).toBe(editorB);
    expect(hasLiveTextSelection()).toBe(false);
  });
});

// ─── isShiftClickTextGesture (cluster B live-test round 2) ────────────
// Click places a caret; shift+click extends. The selection is COLLAPSED
// during the click event, so the guard keys on target containment within
// the focused editor — not on selection state.

describe('isShiftClickTextGesture', () => {
  function buildFocusableCE2(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'true');
    el.tabIndex = 0;
    el.appendChild(document.createTextNode(text));
    document.body.appendChild(el);
    return el;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  it('true: shift+click target inside the FOCUSED editor, even with a collapsed caret', () => {
    const el = buildFocusableCE2('click here then shift-click there');
    el.focus();
    // caret placed (collapsed) — the exact state during a click→shift+click
    const range = document.createRange();
    range.setStart(el.firstChild!, 3);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(isShiftClickTextGesture(el.firstChild)).toBe(true);
  });

  it('false: shift+click on a DIFFERENT block (block-range selection)', () => {
    const editorA = buildFocusableCE2('block a');
    const blockB = document.createElement('div');
    blockB.appendChild(document.createTextNode('block b'));
    document.body.appendChild(blockB);
    editorA.focus();
    window.getSelection()?.removeAllRanges();

    expect(isShiftClickTextGesture(blockB.firstChild)).toBe(false);
  });

  it('true: target outside the focused editor but a live selection exists (drag case)', () => {
    const el = buildFocusableCE2('dragged selection');
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, 7);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);

    expect(isShiftClickTextGesture(elsewhere)).toBe(true);
  });

  it('false: nothing focused, no selection', () => {
    const el = buildFocusableCE2('inert');
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.getSelection()?.removeAllRanges();

    expect(isShiftClickTextGesture(el.firstChild)).toBe(false);
  });
});

// Round 3 (live-test): overlay tokens and row whitespace produce click
// targets OUTSIDE the CE while the user extends within the same block.
describe('isShiftClickTextGesture — same-row targets outside the CE', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  it('true: target in the display overlay of the SAME block-item as the focused CE', () => {
    const row = document.createElement('div');
    row.className = 'block-item';
    const ce = document.createElement('div');
    ce.setAttribute('contenteditable', 'true');
    ce.tabIndex = 0;
    ce.appendChild(document.createTextNode('text with [[pill]]'));
    const overlay = document.createElement('span');
    overlay.className = 'md-wikilink';
    overlay.appendChild(document.createTextNode('pill'));
    row.appendChild(ce);
    row.appendChild(overlay);
    document.body.appendChild(row);
    ce.focus();

    expect(isShiftClickTextGesture(overlay.firstChild)).toBe(true);
  });

  it('false: target in a DIFFERENT block-item row', () => {
    const rowA = document.createElement('div');
    rowA.className = 'block-item';
    const ceA = document.createElement('div');
    ceA.setAttribute('contenteditable', 'true');
    ceA.tabIndex = 0;
    rowA.appendChild(ceA);
    const rowB = document.createElement('div');
    rowB.className = 'block-item';
    rowB.appendChild(document.createTextNode('other block'));
    document.body.append(rowA, rowB);
    ceA.focus();
    window.getSelection()?.removeAllRanges();

    expect(isShiftClickTextGesture(rowB.firstChild)).toBe(false);
  });
});

// ─── PRODUCTION DOM SHAPE (shift-click RCA, 2026-07-10) ───────────────
// SolidJS renders the contentEditable prop as contenteditable="" (empty
// string). getAttribute-based checks comparing === 'true' have never
// matched in production; only hand-built test DOMs made them pass. These
// tests use the REAL rendered shape, verified against the running app:
//   <div contenteditable="" class="block-content block-edit" ...>
describe('editable detection matches the Solid-rendered DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  function buildProdShapeCE(text: string): HTMLDivElement {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', ''); // ← what Solid actually renders
    el.tabIndex = 0;
    el.appendChild(document.createTextNode(text));
    document.body.appendChild(el);
    return el;
  }

  it('hasLiveTextSelection: true for a selection in a contenteditable="" editor', () => {
    const el = buildProdShapeCE('production shaped');
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, 10);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(hasLiveTextSelection()).toBe(true);
  });

  it('isShiftClickTextGesture: true for a caret + same-editor target with contenteditable=""', () => {
    const el = buildProdShapeCE('click then shift click');
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 2);
    range.collapse(true);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(isShiftClickTextGesture(el.firstChild)).toBe(true);
  });

  it('contenteditable="false" is NOT editable', () => {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'false');
    el.tabIndex = 0;
    el.appendChild(document.createTextNode('not editable'));
    document.body.appendChild(el);
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 0);
    range.setEnd(el.firstChild!, 3);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    expect(hasLiveTextSelection()).toBe(false);
  });
});
