# Keyboard Navigation Spec for float-pty Outliner

**Date**: 2025-12-23
**Status**: Draft
**Source**: Analysis of float-liner PlateBlock.tsx patterns + user feedback

## Problem Statement

Current float-pty outliner has several keyboard navigation issues:

### 1. Arrow Keys Always Exit Block
**Current**: ArrowUp/ArrowDown immediately navigate to adjacent block
**Expected**: When inside multi-line content, arrows should navigate between lines within the block. Only exit block when cursor reaches absolute start (ArrowUp) or absolute end (ArrowDown).

```
// Current (BROKEN):
if (e.key === 'ArrowUp') {
  e.preventDefault();  // <-- Always prevents default, can't move up in multi-line
  const prev = findPrevVisibleBlock(props.id, props.paneId);
  if (prev) props.onFocus(prev);
}
```

### 2. Cmd+Left Behavior in Multi-line
**Current**: Unknown/browser default
**Expected**: Should move to end of current visual line, or if at line start, move to end of previous line within same block.

### 3. Tab Conflict with Inline Lists
**Current**: Tab always intercepts for indent/outdent block
**Expected**: User sometimes wants inline lists within a block:
```
some text
- x
- y
- z
```
Where Tab would indent the `- x` list item within the block, not indent the entire block.

**Trade-off**: This is complex. May need a mode switch or different trigger. float-liner also intercepts Tab always.

## Solution: Cursor-Aware Navigation

### From float-liner's PlateBlock.tsx (prior art)

float-liner uses Plate/Slate which provides `Editor.start()` and `Editor.end()`:

```typescript
function isCursorAtEditorStart(editor: any): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;
  const editorStart = Editor.start(editor, []);
  return Point.equals(selection.anchor, editorStart);
}

function isCursorAtEditorEnd(editor: any): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;
  const editorEnd = Editor.end(editor, []);
  return Point.equals(selection.anchor, editorEnd);
}
```

Then used in navigation:
```typescript
if (e.key === 'ArrowUp') {
  if (isCursorAtEditorStart(editor)) {
    e.preventDefault();
    onNavigateUp();
  }
  // Otherwise let Slate handle moving up within multi-line content
  return;
}
```

### For contentEditable (float-pty)

We don't have Slate, but we can check cursor position in contentEditable:

```typescript
function isCursorAtContentStart(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;

  // Check if we're at offset 0 of the first text node
  const range = selection.getRangeAt(0);
  if (range.startOffset !== 0) return false;

  // Walk backwards from cursor position to see if there's any content before
  const treeWalker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  let firstTextNode = treeWalker.firstChild();
  return range.startContainer === firstTextNode ||
         (range.startContainer === element && range.startOffset === 0);
}

function isCursorAtContentEnd(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;

  const range = selection.getRangeAt(0);
  const container = range.startContainer;

  // If in text node, check if at end of that node
  if (container.nodeType === Node.TEXT_NODE) {
    if (range.startOffset < (container.textContent?.length || 0)) {
      return false;
    }
  }

  // Walk forward to see if there's any content after
  const treeWalker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  // Find current node
  treeWalker.currentNode = container;

  // Check if there's a next text node with content
  let next = treeWalker.nextNode();
  while (next) {
    if (next.textContent && next.textContent.length > 0) {
      return false; // There's content after cursor
    }
    next = treeWalker.nextNode();
  }

  return true;
}
```

### Simpler Approach for Single-Line Perception

Since contentEditable with plain text usually has just one text node:

```typescript
function isCursorAtStart(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;
  return selection.anchorOffset === 0;
}

function isCursorAtEnd(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;
  const content = element.textContent || '';
  return selection.anchorOffset >= content.length;
}
```

**Note**: This simpler version works for single-line blocks but may fail for multi-line. The tree walker version is more robust.

## Implementation Plan

### Phase 1: Fix Arrow Navigation (High Priority)

Update `handleKeyDown` in BlockItem.tsx:

```typescript
} else if (e.key === 'ArrowUp') {
  // Only exit block if cursor is at absolute start
  if (isCursorAtContentStart(contentRef!)) {
    e.preventDefault();
    const prev = findPrevVisibleBlock(props.id, props.paneId);
    if (prev) props.onFocus(prev);
  }
  // Otherwise let browser handle multi-line navigation
} else if (e.key === 'ArrowDown') {
  // Only exit block if cursor is at absolute end
  if (isCursorAtContentEnd(contentRef!)) {
    e.preventDefault();
    const next = findNextVisibleBlock(props.id, props.paneId);
    if (next) props.onFocus(next);
  }
  // Otherwise let browser handle multi-line navigation
}
```

### Phase 2: Tab Behavior (Medium Priority, Needs Design Decision)

Options:
1. **Keep current**: Tab always indents/outdents block (float-liner's approach)
2. **Detection mode**: If content starts with `- ` or `* `, Tab indents within block
3. **Modifier switch**: Opt+Tab for block indent, Tab for inline (or vice versa)
4. **Soft tabs**: Tab inserts actual tab/spaces within block (like a normal editor)

**Recommendation**: Start with option 1 (status quo), document it clearly. Consider option 2 if inline lists become common use case.

### Phase 3: Cmd+Left/Right Behavior (Low Priority)

Let browser handle line-aware navigation within contentEditable. Focus on not breaking it by intercepting too early.

## Testing Checklist

- [ ] Multi-line block: ArrowUp moves up within block
- [ ] Multi-line block: ArrowDown moves down within block
- [ ] Multi-line block: ArrowUp at line 1 col 0 exits to previous block
- [ ] Multi-line block: ArrowDown at last line end exits to next block
- [ ] Single-line block: ArrowUp exits to previous block
- [ ] Single-line block: ArrowDown exits to next block
- [ ] Tab indents block (not cursor)
- [ ] Shift+Tab outdents block
- [ ] Cmd+Left moves to line start (within block)
- [ ] Cmd+Right moves to line end (within block)

## Files to Modify

1. `src/components/BlockItem.tsx` - Main keyboard handling
2. Consider extracting helpers to `src/lib/cursorUtils.ts`

## References

- float-liner PlateBlock.tsx: `/Users/evan/projects/float-substrate/float-liner/src/components/PlateBlock.tsx`
- float-liner cursor helpers: lines 38-62 (isCursorAtEditorStart, isCursorAtEditorEnd)
- float-liner navigation handling: lines 497-514
