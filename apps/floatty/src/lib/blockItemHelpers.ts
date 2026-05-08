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

/** Max length / leading-char filter that defines a "clean, scannable" title.
 *  Shared between content / output.data.title / spec.title resolution arms. */
function isCleanTitle(s: string | undefined | null): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  return trimmed.length > 0
    && trimmed.length <= 120
    && !trimmed.startsWith('{')
    && !trimmed.startsWith('[');
}

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
 * Derive a clean title for a door block to display in title-mode (instead of
 * the raw contentEditable). Returns null for non-door blocks, blocks without
 * output, and blocks where no resolution arm produces a clean title.
 *
 * Resolution order (first clean wins):
 *   1. Block content, if it's NOT a legacy `render:: ...` shape — projection-
 *      contract path: agents write `content` = semantic title directly.
 *   2. `output.data.title` — async-generated title from `setOutputWithTitle`
 *      (legacy render:: blocks once title-gen lands).
 *   3. `output.data.spec.title` — synchronously available on most legacy
 *      render:: blocks even before async title-gen completes.
 *
 * Fixes the v0.14.3 cohabitation symptom: contentEditable showing
 * `render:: {full JSON}` overlapping the rendered Callout. With this title
 * derivation, all door blocks land in title-mode and contentEditable hides
 * by default; user toggles to source-edit mode explicitly.
 */
export function deriveDoorTitle(block: Block | undefined): string | null {
  if (!block || block.outputType !== 'door' || !block.output) return null;

  const content = block.content ?? '';
  const isLegacyRenderShape = content.toLowerCase().startsWith('render::');

  // (1) Projection-contract path — content is the title.
  if (!isLegacyRenderShape && isCleanTitle(content)) {
    return content.trim();
  }

  // (2) output.data.title — preferred for legacy render:: blocks.
  const data = (block.output as { data?: { title?: string; spec?: { title?: string } } })?.data;
  if (isCleanTitle(data?.title)) {
    return data!.title!.trim();
  }

  // (3) output.data.spec.title — fallback when async title-gen hasn't landed.
  if (isCleanTitle(data?.spec?.title)) {
    return data!.spec!.title!.trim();
  }

  return null;
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
