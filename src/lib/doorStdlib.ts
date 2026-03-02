/**
 * Door Standard Library — Shared utilities exposed to door plugins
 *
 * Doors are blob-imported and can't import from app source directly.
 * This module is exposed via `window.__DOOR_STDLIB__` and accessed
 * through a shim URL that rewrites `from '@floatty/stdlib'`.
 *
 * Same pattern as the solid-js shims in doorLoader.ts.
 */

// ═══════════════════════════════════════════════════════════════
// WIKILINK PARSING (from wikilinkUtils.ts)
// ═══════════════════════════════════════════════════════════════

export { findWikilinkEnd, parseWikilinkInner, extractAllWikilinkTargets } from './wikilinkUtils';

/**
 * Bracket-counting wikilink parser. Returns target + end index.
 * Handles nested [[inner]] correctly.
 *
 * @param input - Full string to parse
 * @param start - Index where `[[` begins
 * @returns { target, end } or null if not a valid wikilink at start
 */
export function parseBracketedWikilink(input: string, start: number): { target: string; end: number } | null {
  if (input.slice(start, start + 2) !== '[[') return null;
  let i = start + 2;
  let depth = 1;
  const begin = i;
  while (i < input.length) {
    if (input.slice(i, i + 2) === '[[') { depth++; i += 2; continue; }
    if (input.slice(i, i + 2) === ']]') {
      depth--;
      if (depth === 0) return { target: input.slice(begin, i), end: i + 2 };
      i += 2;
      continue;
    }
    i++;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// PAGE HELPERS
// ═══════════════════════════════════════════════════════════════

/** Minimal interface for block tree access — matches ScopedActions subset */
interface BlockTreeAccess {
  rootIds(): readonly string[];
  getBlock(id: string): { content?: string } | undefined;
  getChildren(id: string): string[];
}

/** Find the `pages::` container block among root blocks */
export function findPagesContainer(actions: BlockTreeAccess): string | null {
  const roots = actions.rootIds();
  for (const id of roots) {
    const block = actions.getBlock(id);
    if (block?.content?.trim() === 'pages::') return id;
  }
  return null;
}

/** Find existing page under pages:: by name (case-insensitive, strips `# ` prefix) */
export function findPageBlock(actions: BlockTreeAccess, pagesId: string, pageName: string): string | null {
  const children = actions.getChildren(pagesId);
  const target = pageName.toLowerCase();
  for (const childId of children) {
    const block = actions.getBlock(childId);
    const content = block?.content?.trim() ?? '';
    const stripped = content.startsWith('# ') ? content.slice(2).trim() : content;
    if (stripped.toLowerCase() === target) return childId;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════════

/** Format a Date as YYYY-MM-DD using local time (not UTC) */
export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Resolve date argument: 'today', 'yesterday', 'tomorrow', or pass through YYYY-MM-DD */
export function resolveDate(arg: string): string {
  if (!arg || arg === 'today') return localDateStr(new Date());
  if (arg === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return localDateStr(d);
  }
  if (arg === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return localDateStr(d);
  }
  return arg;
}
