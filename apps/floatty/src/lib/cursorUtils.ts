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
 *
 * DOM MODEL (floatty): Content set via innerText creates bare <br> at root level.
 * Each <br> = 1 newline in content. No <div><br></div> wrapping occurs.
 * Browser navigates through (root, N) positions where N is a child index.
 *
 * BOUNDARY DETECTION: Offset-based comparison.
 * isCursorAtContentEnd: getAbsoluteCursorOffset() >= getContentLength()
 * isCursorAtContentStart: getAbsoluteCursorOffset() === 0
 */

import { createLogger } from './logger';

const logger = createLogger('cursorUtils');

/**
 * Detect presentational <br> that browsers insert to prevent empty <div> from collapsing.
 * These are NOT content characters — the div boundary already counts as 1 newline.
 */
function isPlaceholderBr(node: Node, root: HTMLElement): boolean {
  if (node.nodeName !== 'BR') return false;
  const parent = node.parentNode;
  if (!parent || parent.nodeName !== 'DIV') return false;
  if (parent.parentNode !== root) return false;
  // Sole child of a direct-child div = presentational placeholder
  return parent.childNodes.length === 1;
}

/**
 * Get total content length by walking DOM — same counting as getTextOffsetInElement.
 * Uses innerText when available (real browsers), falls back to DOM walk (jsdom).
 */
export function getContentLength(root: HTMLElement): number {
  if (typeof root.innerText === 'string') {
    return root.innerText.length;
  }
  // Fallback: walk DOM with same counting logic as offset functions
  let len = 0;
  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      len += node.textContent?.length ?? 0;
    } else if (node.nodeName === 'BR') {
      if (!isPlaceholderBr(node, root)) len += 1;
    } else if (node.nodeName === 'DIV' && node !== root) {
      len += 1;
      for (const child of Array.from(node.childNodes)) walk(child);
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      for (const child of Array.from(node.childNodes)) walk(child);
    }
  }
  walk(root);
  return len;
}

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
    // Special case: cursor after ALL children = total content length
    // This happens at (root, childCount) and can't be resolved to a child node.
    // The walk would land on the last <br> and miss counting it.
    if (targetNode === element && targetOffset >= element.childNodes.length) {
      return getContentLength(element);
    }

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
 *
 * Placeholder <br> inside empty divs are SKIPPED — the div boundary already
 * counts as 1 character, matching innerText behavior (1 per blank line).
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
      } else if (node.nodeName === 'DIV' && node !== root) {
        // Target is a non-root div (e.g., cursor at (div, 0) on blank line)
        // The div boundary is the position
        offset += 1;
      }
      found = true;
      return true;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
    } else if (node.nodeName === 'BR') {
      // Skip placeholder <br> in empty divs — div boundary already counted
      if (!isPlaceholderBr(node, root)) {
        offset += 1; // Real <br> (e.g., Shift+Enter) = 1 newline
      }
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
 * Placeholder <br> in empty divs are skipped (div boundary handles positioning).
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
      // Skip placeholder <br> in empty divs — div boundary handles positioning
      if (isPlaceholderBr(node, element)) {
        return false;
      }
      // Target is right before this <br> (e.g., offset 0 with leading newlines)
      if (currentOffset >= offset) {
        const parent = node.parentNode;
        if (parent) {
          const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
          range.setStart(parent, index);
          range.collapse(true);
          found = true;
          return true;
        }
      }
      currentOffset += 1;
    } else if (node.nodeName === 'DIV' && node !== element) {
      // <div> inside contentEditable = line break
      currentOffset += 1;
      if (currentOffset >= offset) {
        // Target is this blank line — place cursor at start of div
        range.setStart(node, 0);
        range.collapse(true);
        found = true;
        return true;
      }
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
    // Fallback: put cursor at end — offset walk failed to find position
    logger.debug(`Walk failed for offset ${offset} in element with ${element.childNodes.length} children. Falling back to end.`);
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/**
 * Check if cursor is at the very start of the contentEditable element.
 * Offset-based: compares getAbsoluteCursorOffset() against 0.
 */
export function isCursorAtContentStart(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;
  if (!selection.rangeCount) return false;

  if (getContentLength(element) === 0) return true;

  return getAbsoluteCursorOffset(element) === 0;
}

/**
 * Check if cursor is at the very end of the contentEditable element.
 * Offset-based: compares getAbsoluteCursorOffset() against innerText.length.
 */
export function isCursorAtContentEnd(element: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || !selection.isCollapsed) return false;
  if (!selection.rangeCount) return false;

  const contentLength = getContentLength(element);
  if (contentLength === 0) return true;

  return getAbsoluteCursorOffset(element) >= contentLength;
}

