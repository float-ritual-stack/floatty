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

### Phase 1: Fix Arrow Navigation (IMPLEMENTED)

Update `handleKeyDown` in BlockItem.tsx:

### Phase 1.5: Enter Key Behavior (IMPLEMENTED)

**Problem**: Enter at position 0 would split block, creating empty parent that "steals" children.

**Solution**: Position-aware Enter:
- **Enter at position 0** (with content): Create sibling BEFORE, focus new block
- **Enter at end with children**: Create first child (continue under heading)
- **Enter elsewhere**: Split block at cursor position

```typescript
const atStart = offset === 0;

// At START of block with content → create sibling BEFORE (not split)
if (atStart && currentContent.length > 0) {
  const newId = store.createBlockBefore(props.id);
  if (newId) props.onFocus(newId);
  return;
}
```

New store function: `createBlockBefore(id)` - creates empty sibling before target block.

### Phase 1 (original): Fix Arrow Navigation (IMPLEMENTED)

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

### Phase 2: Tab Behavior (IMPLEMENTED - Position-Aware)

**Solution**: Tab behavior depends on cursor position:
- **Tab at position 0**: Indent block in tree (original behavior)
- **Tab elsewhere**: Insert 2 spaces at cursor
- **Shift+Tab**: Always outdent block (original behavior)

This preserves muscle memory for tree operations while enabling inline indentation.

### Phase 3: Cmd+Left/Right Behavior (Low Priority)

Let browser handle line-aware navigation within contentEditable. Focus on not breaking it by intercepting too early.

## Testing Checklist

### Arrow Keys (IMPLEMENTED)
- [ ] Multi-line block: ArrowUp moves up within block
- [ ] Multi-line block: ArrowDown moves down within block
- [ ] Multi-line block: ArrowUp at line 1 col 0 exits to previous block
- [ ] Multi-line block: ArrowDown at last line end exits to next block
- [ ] Single-line block: ArrowUp exits to previous block
- [ ] Single-line block: ArrowDown exits to next block

### Enter Key (IMPLEMENTED)
- [ ] Enter at start of block with content → creates sibling before
- [ ] Enter at start of collapsed parent → creates sibling before, children stay under original
- [ ] Enter at end of parent with children → creates first child
- [ ] Enter in middle → splits block
- [ ] Enter on empty block → creates sibling after (split behavior)

### Tab Key (IMPLEMENTED - Position-Aware)
- [ ] Tab at position 0 → indents block in tree
- [ ] Tab elsewhere → inserts 2 spaces
- [ ] Shift+Tab → outdents block

### Browser Defaults (Not Intercepted)
- [ ] Cmd+Left moves to line start (within block)
- [ ] Cmd+Right moves to line end (within block)
- [ ] Option+arrows move by word

## Files to Modify

1. `src/components/BlockItem.tsx` - Main keyboard handling
2. Consider extracting helpers to `src/lib/cursorUtils.ts`

## References

- float-liner PlateBlock.tsx: `/Users/evan/projects/float-substrate/float-liner/src/components/PlateBlock.tsx`
- float-liner cursor helpers: lines 38-62 (isCursorAtEditorStart, isCursorAtEditorEnd)
- float-liner navigation handling: lines 497-514
