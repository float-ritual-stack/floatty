---
paths:
  - "src/**/*.{ts,tsx}"
---

# contentEditable Patterns (CRITICAL)

These patterns apply to cursor positioning and text manipulation in contentEditable elements.

## 1. Newlines Are Block Elements, Not Characters

**The trap**: Browser contentEditable represents newlines as `<div>` or `<br>` elements, NOT `\n` characters in text nodes.

```html
<!-- What user types -->
line 1
line 2
line 3

<!-- What browser creates -->
<div contenteditable>
  line 1
  <div>line 2</div>
  <div>line 3</div>
</div>
```

**Why it matters**: Any character offset calculation must count block element boundaries as 1 character each.

## 2. Range.toString() Lies About Offsets

**The trap**: `Range.toString()` concatenates text without inserting newlines for `<div>` boundaries.

```typescript
// ❌ BROKEN - missing newlines in count
const offset = range.cloneContents().textContent?.length ?? 0;
// For "line1\nline2\nline3" stored as 3 divs, returns 15 instead of 17

// ❌ ALSO BROKEN - same problem
const offset = range.toString().length;

// ❌ ALSO BROKEN - normalizes whitespace differently
const offset = element.innerText.length;

// ✅ CORRECT - walk DOM, count block boundaries
function getTextOffsetInElement(root, targetNode, targetOffset) {
  let offset = 0;
  function walk(node) {
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) offset += targetOffset;
      return true; // found
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
    } else if (node.nodeName === 'BR') {
      offset += 1; // <br> = 1 newline character
    } else if (node.nodeName === 'DIV' && node !== root) {
      offset += 1; // <div> boundary = 1 newline character
      for (const child of node.childNodes) {
        if (walk(child)) return true;
      }
      return false;
    }
    // Recurse other elements
    if (node.nodeType === Node.ELEMENT_NODE) {
      for (const child of node.childNodes) {
        if (walk(child)) return true;
      }
    }
    return false;
  }
  walk(root);
  return offset;
}
```

**Rule**: For multi-line contentEditable, always walk the DOM tree and count `<div>` and `<br>` as 1 character each.

## 3. Bidirectional Consistency

If you have `setCursorAtOffset()` and `getAbsoluteCursorOffset()`, they MUST use the same counting logic.

```typescript
// ✅ CORRECT - both count divs the same way
setCursorAtOffset(element, 15);  // positions at character 15
getAbsoluteCursorOffset(element);  // returns 15

// ❌ BROKEN - different counting = split corruption
setCursorAtOffset(element, 15);  // counts divs
getAbsoluteCursorOffset(element);  // uses Range.toString() = returns 12
```

**Symptom of mismatch**: Block splits at wrong position. Typing "test" + Enter creates "t" + "est" instead of "test" + "".

## 4. The Debugging Pattern

When cursor offset bugs appear:

1. Log both the DOM representation AND stored content
2. Count characters manually including newlines
3. Compare `getAbsoluteCursorOffset()` result with content.length
4. If offset < content.length by N, you're missing N newlines

```typescript
console.log('[CURSOR DEBUG]', {
  domInnerText: contentRef?.innerText,
  storedContent: block.content,
  cursorOffset: cursor.getOffset(),
  contentLength: block.content.length,
  // If offset !== length when at end, counting is wrong
});
```

## 5. Selection on Element Nodes (Child Index, Not Character Offset)

**The trap**: When cursor is on a blank line or element boundary, browser sets `startContainer` to an ELEMENT (not text node), and `startOffset` is a **child index**, not a character offset.

```typescript
// User clicks on blank line in multi-line block
// DOM: <div contenteditable>text<div><br></div>more</div>

range.startContainer;  // The root DIV element!
range.startOffset;     // 2 (meaning "before child index 2")

// ❌ BROKEN - treats child index as character offset
const offset = getTextOffsetInElement(root, range.startContainer, range.startOffset);
// Returns 0 because targetNode === root, found immediately

// ✅ CORRECT - resolve element position to text node first
if (startContainer.nodeType === Node.ELEMENT_NODE) {
  const targetChild = startContainer.childNodes[startOffset];
  const firstText = findFirstTextNode(targetChild);
  if (firstText) {
    targetNode = firstText;
    targetOffset = 0;
  }
}
```

**Symptom**: Enter on blank line creates block ABOVE instead of splitting. Offset returns 0 when it shouldn't.

**Rule**: Before walking DOM for offset, check if `startContainer` is an element. If so, resolve to the actual text node at that child index position.

## 6. Blank Line Split Semantics

**The trap**: When splitting at a newline boundary, which block gets the trailing whitespace?

```typescript
// Content: "blob of text\n\nmore text"
// Cursor at blank line (offset ~13)

// ❌ FEELS WRONG - blank line goes with new block
content.slice(0, 13);  // "blob of text\n"
content.slice(13);     // "\nmore text"

// ✅ FEELS RIGHT - blank line stays with top block
// Consume consecutive newlines when splitting
let end = offset;
while (end < content.length && content[end] === '\n') {
  end++;
}
content.slice(0, end);  // "blob of text\n\n"
content.slice(end);     // "more text"
```

**Why**: Semantically, blank lines "belong to" the paragraph above them. When you hit Enter on a blank line, you expect the blank to stay above, not come with your new content.

**Rule**: In `splitBlock()`, when offset is at/near newlines, adjust to consume all trailing newlines into the "before" portion.

## 7. isAtStart() vs getOffset() === 0 (CRITICAL)

**The trap**: `cursor.isAtStart()` checks if cursor is at the first TEXT node at offset 0. This can be TRUE at the start of ANY line in multi-line content!

```typescript
// Content: "\n\nworld" (two blank lines, then "world")
// Cursor at start of "world" (visually first visible character)

// ❌ WRONG - isAtStart() may return TRUE
// Because blank lines are <br> elements, "world" is in the first TEXT node
cursor.isAtStart();  // TRUE! But offset is ~2 (after the \n\n)

// ✅ CORRECT - use absolute offset for block-level decisions
cursor.getOffset() === 0;  // FALSE - we're not at absolute start
```

**When to use which**:
- `isAtStart()` - for DOM position checks within current text node
- `getOffset() === 0` - for block-level decisions (merge, backspace behavior)

**Symptom**: Backspace at start of "world" in `\n\nworld` incorrectly triggers block merge because `isAtStart()` returns true.

## 8. Blank Line Navigation (Offset-Based Boundary Detection)

**DOM reality**: floatty sets content via `innerText`, which creates bare `<br>` at root level. NO `<div><br></div>` wrapping occurs. Each `<br>` = 1 newline in content.

**The fix**: `isCursorAtContentStart/End()` use offset comparison:
```typescript
isCursorAtContentEnd = getAbsoluteCursorOffset(element) >= element.innerText.length
isCursorAtContentStart = getAbsoluteCursorOffset(element) === 0
```

**Critical edge case**: Cursor at `(root, childCount)` — after all children. `getAbsoluteCursorOffset` has an early return for this: `return element.innerText.length`. Without this, the code resolves to the last `<br>` child and misses counting it (returns N-1 instead of N).

**Browser navigation**: The browser CAN navigate through `(root, N)` → `(root, N+1)` positions via ArrowDown/Up. Each `<br>` creates a visual blank line. No manual cursor stepping needed.

**No regex overrides in useBlockInput**: With correct offset-based boundary detection, ArrowDown/Up just check `cursorAtEnd`/`cursorAtStart` directly.

## 9. IndexSizeError Guards

**The trap**: Selection/Range APIs throw `IndexSizeError` when offsets exceed bounds.

```typescript
// ❌ BROKEN - no rangeCount check
const range = selection.getRangeAt(0);  // Throws if rangeCount is 0 (after undo)

// ❌ BROKEN - offset may exceed node length (DOM changed between calculation and use)
range.setStart(textNode, calculatedOffset);  // Throws if offset > textNode.length

// ✅ CORRECT
if (!selection.rangeCount) return false;
const range = selection.getRangeAt(0);

const clampedOffset = Math.min(calculatedOffset, textNode.textContent?.length ?? 0);
range.setStart(textNode, clampedOffset);
```

**When this happens**: After undo operations, during fast typing, when DOM mutates between offset calculation and cursor positioning.

## 10. Collapsed Children Protection for Merge

**The trap**: Blocking ALL merges when block has children is too restrictive.

```typescript
// ❌ WRONG - always block merge if has children
if (block.childIds.length > 0) return;  // User can't merge expanded blocks!

// ✅ CORRECT - only protect HIDDEN children
const hasHiddenChildren = block.childIds.length > 0 && isCollapsed;
if (hasHiddenChildren) return;  // Protect hidden subtree
// If children are visible (expanded), allow merge and lift them to siblings
```

**Why**: If children are visible, user knows they exist. Merge should lift them to siblings, not block the operation. Only protect when children are COLLAPSED (hidden).

**Behaviors**:
- Backspace at start, children expanded → merge, lift children to siblings
- Backspace at start, children collapsed → do nothing (protect hidden subtree)
- Cmd+Backspace → delete block AND all children (explicit destructive action)

## 11. Reference Implementation

See `src/lib/cursorUtils.ts`:
- `getAbsoluteCursorOffset()` - correct DOM-walking offset calculation with element node resolution
- `setCursorAtOffset()` - matching cursor positioning with offset clamping
- `findFirstTextNode()` / `findLastTextNode()` - resolve element positions to text nodes
- `isCursorAtContentStart()` / `isCursorAtContentEnd()` - boundary detection with rangeCount guards

See `src/hooks/useBlockStore.ts`:
- `splitBlock()` - includes newline consumption logic for natural blank line behavior
- `liftChildrenToSiblings()` - reparent children when merging expanded blocks

See `src/hooks/useBlockInput.ts`:
- `determineKeyAction()` - blank line navigation fixes, collapsed children check
