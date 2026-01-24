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
 * Walks DOM tree counting text + implicit newlines from block elements.
 *
 * CRITICAL: Range.toString() doesn't count implicit newlines between <div>
 * elements. innerText normalizes whitespace. Both approaches fail for
 * multi-line content. Must walk DOM and count div boundaries as newlines.
 *
 * This matches the logic in setCursorAtOffset() for bidirectional consistency.
 */
export function getAbsoluteCursorOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return 0;

  const range = selection.getRangeAt(0);
  let targetNode = range.startContainer;
  let targetOffset = range.startOffset;

  // CRITICAL: When startContainer is an element (not text), startOffset is a CHILD INDEX
  // We need to resolve this to a text node for accurate offset calculation
  if (targetNode.nodeType === Node.ELEMENT_NODE && targetNode.childNodes.length > 0) {
    // If offset points to a valid child, find first text descendant of that child
    if (targetOffset < targetNode.childNodes.length) {
      const targetChild = targetNode.childNodes[targetOffset];
      const firstText = findFirstTextNode(targetChild);
      if (firstText) {
        targetNode = firstText;
        targetOffset = 0;
      } else {
        // No text node - target is the child element itself (e.g., <br>)
        // Walk will count everything before this element
        targetNode = targetChild;
        targetOffset = 0;
      }
    } else {
      // Cursor is after all children - find last text position
      const lastChild = targetNode.childNodes[targetNode.childNodes.length - 1];
      if (lastChild) {
        const lastText = findLastTextNode(lastChild);
        if (lastText) {
          targetNode = lastText;
          targetOffset = lastText.textContent?.length ?? 0;
        } else {
          targetNode = lastChild;
          targetOffset = 0;
        }
      }
    }
  }

  return getTextOffsetInElement(element, targetNode, targetOffset);
}

/** Find first text node descendant (depth-first) */
function findFirstTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  for (const child of Array.from(node.childNodes)) {
    const found = findFirstTextNode(child);
    if (found) return found;
  }
  return null;
}

/** Find last text node descendant (depth-first, rightmost) */
function findLastTextNode(node: Node): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  for (let i = node.childNodes.length - 1; i >= 0; i--) {
    const found = findLastTextNode(node.childNodes[i]);
    if (found) return found;
  }
  return null;
}

/**
 * Walk DOM tree counting text + implicit newlines from block elements.
 * Browser represents newlines as <div> or <br>, not \n characters.
 * Must count these structural elements to match stored content offsets.
 */
function getTextOffsetInElement(
  root: HTMLElement,
  targetNode: Node,
  targetOffset: number
): number {
  let offset = 0;
  let found = false;

  function walk(node: Node): boolean {
    if (found) return true;

    // Found target node - add the offset within it
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += targetOffset;
      }
      found = true;
      return true;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
    } else if (node.nodeName === 'BR') {
      // <br> = 1 character (newline)
      offset += 1;
    } else if (node.nodeName === 'DIV' && node !== root) {
      // <div> inside contentEditable = line break (except root)
      // Count newline BEFORE this div's content (matches setCursorAtOffset)
      offset += 1;
      for (const child of Array.from(node.childNodes)) {
        if (walk(child)) return true;
      }
      return false; // Already processed children
    }

    // Recurse into children for other element types
    if (node.nodeType === Node.ELEMENT_NODE) {
      for (const child of Array.from(node.childNodes)) {
        if (walk(child)) return true;
      }
    }

    return false;
  }

  walk(root);
  return offset;
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
        // Clamp offset to prevent IndexSizeError if DOM changed since offset calculation
        const clampedOffset = Math.min(offset - currentOffset, nodeLength);
        range.setStart(node, clampedOffset);
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

  // Must have a range to check position (after undo, rangeCount can be 0)
  if (!selection.rangeCount) return false;

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

  // Must have a range to check position (after undo, rangeCount can be 0)
  if (!selection.rangeCount) return false;

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

  // Container is a non-root element (e.g., cursor in <div><br></div> blank line)
  // Check if there's any text content AFTER this element in the DOM tree
  if (container.nodeType === Node.ELEMENT_NODE && container !== element) {
    // Walk from container to find any text content after it
    const treeWalker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ALL,
      null
    );

    // Navigate to the container element
    treeWalker.currentNode = container;

    // If offset > 0, we're after some children - check from last child
    if (offset > 0 && container.childNodes.length > 0) {
      const lastProcessed = container.childNodes[Math.min(offset, container.childNodes.length) - 1];
      treeWalker.currentNode = lastProcessed;
      // Skip to end of this subtree
      while (treeWalker.lastChild()) { /* descend to deepest node */ }
    }

    // Now check if there's any text content after current position
    let next = treeWalker.nextNode();
    while (next) {
      if (next.nodeType === Node.TEXT_NODE && next.textContent && next.textContent.length > 0) {
        return false; // There's text content after cursor
      }
      next = treeWalker.nextNode();
    }

    // No text content found after cursor position
    return true;
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

