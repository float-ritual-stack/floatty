/**
 * Cursor position utilities for contentEditable elements
 *
 * Used for cursor-aware navigation: only exit block when cursor
 * is at the absolute start/end, otherwise let browser handle
 * internal multi-line navigation.
 */

/**
 * Check if cursor is at the very start of the contentEditable element.
 * Returns true if:
 * - Selection is collapsed (no range selected)
 * - Cursor is at offset 0 of the first text node
 */
export function isCursorAtContentStart(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;

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

