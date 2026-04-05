/**
 * Pure display-mode decision functions for BlockItem.
 *
 * Contract: isOutputBlock and hasCollapsibleOutput are mutually exclusive.
 * - isOutputBlock: block REPLACES contentEditable with output-only display
 * - hasCollapsibleOutput: block KEEPS contentEditable, renders output below
 *
 * See blockItemHelpers.test.ts for the contract test.
 */
import type { Block } from './blockTypes';

/** Recognized media/document extensions for img:: blocks. */
const IMG_EXTENSION_RE = /\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|pdf|html|htm)$/i;

/**
 * Should this block replace contentEditable with output-only display?
 *
 * For door blocks, depends on block.content (empty = adapter child that replaces,
 * non-empty = selfRender that keeps contentEditable). Wrap in createMemo for reactivity.
 */
export function isOutputBlock(block: Block | undefined): boolean {
  const ot = block?.outputType;
  if (ot?.startsWith('search-') || ot === 'img-view') return true;
  if (ot === 'door' && block?.content === '') return true;
  return false;
}

/** Does this block have collapsible inline output (rendered BELOW contentEditable)? */
export function hasCollapsibleOutput(block: Block | undefined): boolean {
  if (!block?.output) return false;
  return block.outputType === 'eval-result' || (block.outputType === 'door' && block.content !== '');
}

/**
 * Extract and validate filename from img:: block content.
 * Returns null if content is not img:: or filename has no recognized extension.
 */
export function resolveImgFilename(content: string): string | null {
  if (!content.toLowerCase().startsWith('img::')) return null;
  const rawPath = content.slice(5).trim();
  if (!rawPath) return null;
  const filename = rawPath.replace(/.*[/\\]/g, '');
  if (!filename) return null;
  if (!IMG_EXTENSION_RE.test(filename)) return null;
  return filename;
}
