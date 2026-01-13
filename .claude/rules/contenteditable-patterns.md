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

## 5. Reference Implementation

See `src/lib/cursorUtils.ts`:
- `getAbsoluteCursorOffset()` - correct DOM-walking offset calculation
- `setCursorAtOffset()` - matching cursor positioning
- `isCursorAtContentStart()` / `isCursorAtContentEnd()` - boundary detection
