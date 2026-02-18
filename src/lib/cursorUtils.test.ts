import { describe, it, expect } from 'vitest';
import { getAbsoluteCursorOffset, getNormalizedEditableText, setCursorAtOffset } from './cursorUtils';

function setSelection(node: Node, offset: number): void {
  const selection = window.getSelection();
  if (!selection) throw new Error('Selection API unavailable');
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

describe('cursorUtils multiline blank-line mapping', () => {
  it('normalizes trailing blank line without phantom terminal newline', () => {
    const root = document.createElement('div');
    root.contentEditable = 'true';
    root.innerHTML = '<div>a</div><div><br></div>';
    document.body.appendChild(root);

    expect(getNormalizedEditableText(root)).toBe('a\n');

    root.remove();
  });

  it('maps offsets correctly for div/br blank lines', () => {
    // Simulates Chromium contentEditable multiline shape:
    // "a\n\nb" => <div>a</div><div><br></div><div>b</div>
    const root = document.createElement('div');
    root.contentEditable = 'true';
    root.innerHTML = '<div>a</div><div><br></div><div>b</div>';
    document.body.appendChild(root);

    const firstLineText = root.firstChild?.firstChild;
    expect(firstLineText).toBeTruthy();

    // End of "a" should be plain-text offset 1
    setSelection(firstLineText as Node, 1);
    expect(getAbsoluteCursorOffset(root)).toBe(1);

    // Move to blank line start (offset 2)
    setCursorAtOffset(root, 2);
    expect(getAbsoluteCursorOffset(root)).toBe(2);

    // Move to "b" start (offset 3)
    setCursorAtOffset(root, 3);
    expect(getAbsoluteCursorOffset(root)).toBe(3);

    root.remove();
  });
});
