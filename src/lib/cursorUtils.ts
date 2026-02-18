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
 * Browser represents newlines as line containers (<div>) and/or <br>.
 * We count:
 * - Root-level line-div boundaries as '\n'
 * - Non-placeholder <br> as '\n'
 *
 * Placeholder <br> inside root-level blank line divs are visual caret anchors,
 * not extra newline characters.
 */
function isRootLineDiv(node: Node, root: HTMLElement): boolean {
  return node.nodeType === Node.ELEMENT_NODE &&
    node.nodeName === 'DIV' &&
    node.parentNode === root;
}

function isPlaceholderBr(node: Node, root: HTMLElement): boolean {
  if (node.nodeName !== 'BR') return false;
  const parent = node.parentNode;
  if (!parent || parent.nodeName !== 'DIV') return false;
  if (parent.parentNode !== root) return false;
  return parent.childNodes.length === 1;
}

/**
 * Convert contentEditable DOM to normalized plain text using the same
 * newline model as cursor offset mapping.
 *
 * Important for trailing blank lines: browser `innerText` can include
 * extra terminal newlines that do not have distinct caret positions.
 */
export function getNormalizedEditableText(root: HTMLElement): string {
  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? '');
      return;
    }

    if (node.nodeName === 'BR') {
      if (!isPlaceholderBr(node, root)) {
        parts.push('\n');
      }
      return;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
    }
  };

  const children = Array.from(root.childNodes);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    // Root-level line boundaries become '\n' separators.
    if (isRootLineDiv(child, root) && i > 0) {
      parts.push('\n');
    }

    walk(child);
  }

  return parts.join('');
}

function getTextOffsetInElement(
  root: HTMLElement,
  targetNode: Node,
  targetOffset: number
): number {
  let offset = 0;
  let found = false;

  function walkChildren(parent: Node): boolean {
    const children = Array.from(parent.childNodes);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      // Root-level line divs map to newline boundaries between sibling lines.
      if (parent === root && isRootLineDiv(child, root) && i > 0) {
        offset += 1;
      }

      if (walkNode(child)) return true;
    }
    return false;
  }

  function walkNode(node: Node): boolean {
    if (found) return true;

    // Found target node - add offset within this node
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        offset += targetOffset;
      } else if (node.nodeType === Node.ELEMENT_NODE && targetOffset > 0) {
        // Element container offsets are child indices.
        const childLimit = Math.min(targetOffset, node.childNodes.length);
        for (let i = 0; i < childLimit; i++) {
          const child = node.childNodes[i];
          if (node === root && isRootLineDiv(child, root) && i > 0) {
            offset += 1;
          }
          if (walkNode(child)) return true;
        }
      } else if (node.nodeName === 'BR' && !isPlaceholderBr(node, root)) {
        offset += Math.min(targetOffset, 1);
      }
      found = true;
      return true;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
      return false;
    }

    if (node.nodeName === 'BR') {
      if (!isPlaceholderBr(node, root)) {
        offset += 1;
      }
      return false;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      return walkChildren(node);
    }

    return false;
  }

  walkChildren(root);
  return offset;
}

/**
 * Set cursor at an absolute character offset within contentEditable element.
 * Handles multi-line content by matching the same newline rules as getAbsoluteCursorOffset.
 */
export function setCursorAtOffset(element: HTMLElement, offset: number): void {
  const selection = window.getSelection();
  if (!selection) return;

  const range = document.createRange();
  const targetOffset = Math.max(0, offset);
  let currentOffset = 0;
  let found = false;

  function placeAtNodeStart(node: Node): boolean {
    if (node.nodeType === Node.ELEMENT_NODE) {
      range.setStart(node, 0);
      range.collapse(true);
      found = true;
      return true;
    }

    const parent = node.parentNode;
    if (!parent) return false;
    const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
    if (index < 0) return false;
    range.setStart(parent, index);
    range.collapse(true);
    found = true;
    return true;
  }

  function walkChildren(parent: Node): boolean {
    const children = Array.from(parent.childNodes);
    for (let i = 0; i < children.length; i++) {
      const child = children[i];

      // Root-level line-div boundaries map to newline chars.
      if (parent === element && isRootLineDiv(child, element) && i > 0) {
        if (currentOffset + 1 >= targetOffset) {
          return placeAtNodeStart(child);
        }
        currentOffset += 1;
      }

      if (walkNode(child)) return true;
    }
    return false;
  }

  // Walk all nodes in document order
  function walkNode(node: Node): boolean {
    if (found) return true;

    if (node.nodeType === Node.TEXT_NODE) {
      const nodeLength = node.textContent?.length || 0;
      if (currentOffset + nodeLength >= targetOffset) {
        // Cursor belongs in this text node
        // Clamp offset to prevent IndexSizeError if DOM changed since offset calculation
        const clampedOffset = Math.min(Math.max(targetOffset - currentOffset, 0), nodeLength);
        range.setStart(node, clampedOffset);
        range.collapse(true);
        found = true;
        return true;
      }
      currentOffset += nodeLength;
      return false;
    }

    if (node.nodeName === 'BR') {
      if (isPlaceholderBr(node, element)) {
        return false;
      }

      // Non-placeholder <br> maps to one newline
      if (currentOffset + 1 >= targetOffset) {
        const parent = node.parentNode;
        if (!parent) return false;
        const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
        if (index < 0) return false;

        // At newline boundary, place before BR. After boundary, place after BR.
        if (targetOffset <= currentOffset) {
          range.setStart(parent, index);
        } else {
          range.setStart(parent, index + 1);
        }
        range.collapse(true);
        found = true;
        return true;
      }

      currentOffset += 1;
      return false;
    }

    if (node.nodeType === Node.ELEMENT_NODE) {
      return walkChildren(node);
    }

    return false;
  }

  walkChildren(element);

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
