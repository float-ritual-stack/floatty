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

/**
 * Element props that can carry a human-readable label, in preference order.
 *
 * Deliberately permissive rather than an exhaustive union of catalog component
 * props: the json-render catalog is extensible — every door may declare new
 * component types — so this narrows at the use site instead of enumerating a
 * space that grows. (`lint-discipline.md` §7.)
 */
const LABEL_PROP_KEYS = ['title', 'content', 'text', 'label', 'heading'] as const;

/** Collapse whitespace and clamp to the clean-title budget. */
function toCleanTitle(raw: string): string | null {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (!t || t.startsWith('{') || t.startsWith('[')) return null;
  return t.length <= 120 ? t : `${t.slice(0, 119)}…`;
}

/**
 * Best human label found in a spec's elements, or null.
 *
 * Walks the ROOT's declared child order first — that's reading order, so the
 * header element wins over a mid-document section. Falls back to any element
 * so a malformed/absent root still yields something.
 */
function deriveLabelFromSpec(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object') return null;
  const elements = (spec as { elements?: unknown }).elements;
  if (!elements || typeof elements !== 'object') return null;
  const table = elements as Record<string, unknown>;

  const rootKey = (spec as { root?: unknown }).root;
  const rootEl = typeof rootKey === 'string' ? table[rootKey] : undefined;
  const rootChildren = (rootEl as { children?: unknown })?.children;
  const ordered = Array.isArray(rootChildren) ? rootChildren.filter((c): c is string => typeof c === 'string') : [];

  // Reading order first, then everything else (deduped by the Set).
  for (const key of new Set([...ordered, ...Object.keys(table)])) {
    const props = (table[key] as { props?: unknown })?.props;
    if (!props || typeof props !== 'object') continue;
    for (const propKey of LABEL_PROP_KEYS) {
      const value = (props as Record<string, unknown>)[propKey];
      if (typeof value !== 'string') continue;
      const clean = toCleanTitle(value);
      if (clean) return clean;
    }
  }
  return null;
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
  // Normalize leading whitespace before the legacy-shape check so values like
  // "  render:: {...}" route through the legacy fallback arms (output.data.title
  // / spec.title) rather than getting returned as a "raw" title via arm (1).
  const isLegacyRenderShape = content.trimStart().toLowerCase().startsWith('render::');

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

  // (4/5) Nobody DECLARED a title — derive one rather than falling through to
  // raw-JSON display.
  //
  // Why this matters: `PATCH /blocks/:id` accepts only content/parentId/
  // collapsed, so an agent writing through REST can never set `output`. Arms 1
  // and 2 are therefore reachable only from inside the app (the render:: agent
  // path sets them); arm 3 needs the writer to know an undocumented
  // convention. Every other writer landed here and got 2KB of spec JSON in the
  // editor — the reported "it randomly shows the schema instead of the render".
  // Returning null is the worst available default, so this never does.
  const spec = data?.spec as { elements?: unknown } | undefined;
  const elementCount =
    spec?.elements && typeof spec.elements === 'object' ? Object.keys(spec.elements).length : 0;

  // No elements = nothing renders below, so contentEditable IS the right
  // display and the (necessarily short) content is harmless. Stay null.
  if (elementCount === 0) return null;

  const derived = deriveLabelFromSpec(spec);
  if (derived) return derived;

  // Guaranteed backstop: generic, but scannable — and never the raw spec.
  return `${elementCount} element${elementCount === 1 ? '' : 's'}`;
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
