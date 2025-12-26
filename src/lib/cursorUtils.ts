/**
 * Cursor position utilities for contentEditable elements
 *
 * Used for cursor-aware navigation: only exit block when cursor
 * is at the absolute start/end, otherwise let browser handle
 * internal multi-line navigation.
 *
 * CRITICAL: In multi-line contentEditable, browsers render newlines as <br> tags
 * and create separate text nodes per line. `selection.anchorOffset` is relative
 * to the CURRENT text node, not the absolute position in the content.
 * Use getAbsoluteCursorOffset() for accurate offset calculation.
 */

/**
 * Get absolute character offset within contentEditable element.
 * Uses Range.cloneContents() + innerText for reliable multi-line handling.
 *
 * CRITICAL: Manual DOM walking can drift on long multi-line content because
 * browsers vary in how they structure <div>/<br> elements. This approach
 * extracts the actual content before cursor and measures its innerText.
 */
export function getAbsoluteCursorOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return 0;

  const selRange = selection.getRangeAt(0);

  // Create a range from start of element to cursor position
  const preRange = document.createRange();
  preRange.setStart(element, 0);
  preRange.setEnd(selRange.startContainer, selRange.startOffset);

  // Clone the contents and measure via innerText (handles <br>/<div> correctly)
  const fragment = preRange.cloneContents();
  const tempDiv = document.createElement('div');
  tempDiv.appendChild(fragment);

  // innerText converts <br> and <div> to \n, matching how we store content
  return tempDiv.innerText.length;
}

/**
 * Set cursor at an absolute character offset within contentEditable element.
 * Handles multi-line content by walking DOM and treating <br> tags as newlines.
 */
export function setCursorAtOffset(element: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  let currentOffset = 0;
  let found = false;

  // Walk all nodes in document order
  function walk(node: Node): boolean {
    if (found) return true;

    if (node.nodeType === Node.TEXT_NODE) {
      const nodeLength = node.textContent?.length || 0;
      if (currentOffset + nodeLength >= offset) {
        // Cursor belongs in this text node
        range.setStart(node, offset - currentOffset);
        range.collapse(true);
        found = true;
        return true;
      }
      currentOffset += nodeLength;
    } else if (node.nodeName === 'BR') {
      // <br> = 1 character (newline)
      if (currentOffset + 1 >= offset) {
        // Cursor goes right after this <br>
        const parent = node.parentNode;
        if (parent) {
          const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
          range.setStart(parent, index + 1);
          range.collapse(true);
          found = true;
          return true;
        }
      }
      currentOffset += 1;
    } else if (node.nodeName === 'DIV' && node !== element) {
      // <div> inside contentEditable = line break
      currentOffset += 1;
      for (let i = 0; i < node.childNodes.length; i++) {
        if (walk(node.childNodes[i])) return true;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Recurse into children
      for (let i = 0; i < node.childNodes.length; i++) {
        if (walk(node.childNodes[i])) return true;
      }
    }

    return false;
  }

  walk(element);

  if (found) {
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    // Fallback: put cursor at end
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/**
 * Check if cursor is at the very start of the contentEditable element.
 * Returns true if:
 * - Selection is collapsed (no range selected)
 * - Cursor is at offset 0 of the first text node
 */
export function isCursorAtContentStart(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;

  // Handle empty element case - cursor is at start (and end)
  if (!element.textContent || element.textContent.length === 0) {
    return true;
  }

  const range = selection.getRangeAt(0);

  // Must be at offset 0
  if (range.startOffset !== 0) return false;

  // If the container is the element itself (empty or at very start)
  if (range.startContainer === element) {
    return true;
  }

  // Walk through text nodes to find the first one
  const treeWalker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null
  );

  const firstTextNode = treeWalker.firstChild();

  // If no text nodes, we're at start
  if (!firstTextNode) return true;

  // If cursor is in first text node at offset 0, we're at start
  return range.startContainer === firstTextNode;
}

/**
 * Check if cursor is at the very end of the contentEditable element.
 * Returns true if:
 * - Selection is collapsed (no range selected)
 * - Cursor is after all content (at end of last text node or element)
 */
export function isCursorAtContentEnd(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;

  // Handle empty element case - cursor is both at start AND end
  if (!element.textContent || element.textContent.length === 0) {
    return true;
  }

  const range = selection.getRangeAt(0);
  const container = range.startContainer;
  const offset = range.startOffset;

  // If container is a text node, check if we're at its end
  if (container.nodeType === Node.TEXT_NODE) {
    const textLength = container.textContent?.length || 0;
    if (offset < textLength) {
      // Not at end of this text node - check if there's more content after
      const treeWalker = document.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
        null
      );

      // Find the last text node
      let lastTextNode: Node | null = null;
      let node = treeWalker.firstChild();
      while (node) {
        if (node.textContent && node.textContent.length > 0) {
          lastTextNode = node;
        }
        node = treeWalker.nextNode();
      }

      // If we're not in the last text node, or not at its end, return false
      if (lastTextNode && container !== lastTextNode) {
        return false;
      }
      if (offset < textLength) {
        return false;
      }
    }

    // At end of a text node - check if there's more content after
    const treeWalker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );

    // Navigate to current position
    treeWalker.currentNode = container;

    // Check if there's any text content after
    let next = treeWalker.nextNode();
    while (next) {
      if (next.textContent && next.textContent.length > 0) {
        return false; // There's content after cursor
      }
      next = treeWalker.nextNode();
    }

    return true;
  }

  // Container is element node
  if (container === element) {
    const childCount = element.childNodes.length;
    // If at end of children, we're at end
    if (offset >= childCount) {
      // But check if there's actual text content
      const textContent = element.textContent || '';
      return textContent.length === 0 || offset >= childCount;
    }
  }

  // Default: check total length approach (simpler fallback)
  const totalLength = element.textContent?.length || 0;

  // For simple text-only content, this works
  if (container.nodeType === Node.TEXT_NODE) {
    // Count characters before this point
    const treeWalker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );

    let charCount = 0;
    let node = treeWalker.firstChild();
    while (node && node !== container) {
      charCount += node.textContent?.length || 0;
      node = treeWalker.nextNode();
    }
    charCount += offset;

    return charCount >= totalLength;
  }

  return false;
}

