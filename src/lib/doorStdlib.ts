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

// ═══════════════════════════════════════════════════════════════
// SHELL PRIMITIVES
// ═══════════════════════════════════════════════════════════════

/** Strip OSC escape sequences injected by shell hooks (.zshrc) */
export function stripOSC(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

/** Invoke a shell command via Tauri and return trimmed stdout */
export async function exec(command: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tauri = (window as any).__TAURI__;
  if (!tauri) throw new Error('No __TAURI__ global');
  return stripOSC(await tauri.core.invoke('execute_shell_command', { command })).trim();
}

/** Run a shell command, find the first `[` or `{`, and JSON.parse from there */
export async function execJSON(command: string): Promise<unknown> {
  const raw = await exec(command);
  const start = raw.search(/[\[{]/);
  if (start < 0) throw new Error(`No JSON in output: ${raw.slice(0, 120)}`);
  return JSON.parse(raw.slice(start));
}

/** Find the first `{` and JSON.parse; returns null on failure */
export function parseJSON(raw: string): unknown | null {
  const start = raw.search(/\{/);
  if (start < 0) return null;
  try { return JSON.parse(raw.slice(start)); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// CHILD MANAGEMENT
// ═══════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BlockActions = any;

/**
 * Add children to a block, skipping any whose content already exists.
 * Flat variant — strips nested children from each op before inserting.
 */
export function addNewChildren(
  blockId: string,
  children: Array<{ content: string; key?: string }>,
  actions: BlockActions,
): void {
  const existingKeys = new Set<string>();
  const block = actions.getBlock?.(blockId);
  if (block?.childIds) {
    for (const cid of block.childIds) {
      const child = actions.getBlock?.(cid);
      if (child?.content) existingKeys.add(child.content.trim());
    }
  }
  const newChildren = children.filter(c => !existingKeys.has(c.content.trim()));
  if (newChildren.length > 0) {
    actions.batchCreateBlocksInside(blockId, newChildren.map(c => ({ content: c.content })));
  }
}

/**
 * Add a block tree to a block, skipping top-level nodes whose content already exists.
 * Tree-aware: preserves nested children in each op.
 */
export function addNewChildrenTree(
  blockId: string,
  tree: Array<{ content: string; children?: unknown[] }>,
  actions: BlockActions,
): void {
  const existingKeys = new Set<string>();
  const block = actions.getBlock?.(blockId);
  if (block?.childIds) {
    for (const cid of block.childIds) {
      const child = actions.getBlock?.(cid);
      if (child?.content) existingKeys.add(child.content.trim());
    }
  }
  const newNodes = tree.filter(n => !existingKeys.has(n.content.trim()));
  if (newNodes.length > 0) {
    actions.batchCreateBlocksInside(blockId, newNodes);
  }
}

// ═══════════════════════════════════════════════════════════════
// FP PRIMITIVES
// ═══════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pipe = (...fns: Array<(x: any) => any>) => (x: any) =>
  fns.reduce((v, f) => f(v), x);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sortByDesc = (fn: (x: any) => number) => (arr: any[]) =>
  [...arr].sort((a, b) => fn(b) - fn(a));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const filterBy = (pred: (x: any) => boolean) => (arr: any[]) =>
  arr.filter(pred);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const take = (n: number) => (arr: any[]) =>
  arr.slice(0, n);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const groupBy = <T>(fn: (item: T) => string) => (arr: T[]): Map<string, T[]> =>
  arr.reduce((map, item) => {
    const key = fn(item);
    return map.set(key, [...(map.get(key) ?? []), item]);
  }, new Map<string, T[]>());

// ═══════════════════════════════════════════════════════════════
// MARKDOWN → BLOCK TREE
// ═══════════════════════════════════════════════════════════════

export interface BatchBlockOp {
  content: string;
  children: BatchBlockOp[];
}

/**
 * Parse markdown into a BatchBlockOp tree.
 * Headings become parents, list items become children,
 * prose accumulates as multiline blocks.
 *
 * Note: list nesting is 2-space indent based.
 */
export function parseMarkdownToOps(content: string): BatchBlockOp[] {
  // Strip YAML frontmatter
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines = stripped.split('\n');
  const root: BatchBlockOp = { content: '', children: [] };

  const stack: Array<{ level: number; node: BatchBlockOp }> = [{ level: 0, node: root }];
  let pending: string[] = [];

  function flushPending() {
    if (pending.length === 0) return;
    const text = pending.join('\n').trim();
    if (!text) { pending = []; return; }
    stack[stack.length - 1].node.children.push({ content: text, children: [] });
    pending = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { if (pending.length > 0) flushPending(); continue; }

    const hMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      flushPending();
      const level = hMatch[1].length;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const node: BatchBlockOp = { content: trimmed, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ level, node });
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      flushPending();
      const indent = Math.floor(listMatch[1].length / 2);
      const listLevel = 8 + indent;
      const itemContent = listMatch[3];
      while (stack.length > 1 && stack[stack.length - 1].level >= listLevel) stack.pop();
      const node: BatchBlockOp = { content: itemContent, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ level: listLevel, node });
      continue;
    }

    pending.push(line);
  }
  flushPending();
  return root.children;
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
