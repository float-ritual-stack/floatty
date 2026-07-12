/**
 * read:: door — pure logic (no SolidJS, no Tauri)
 *
 * Split from read.tsx so path parsing, command construction and the
 * markdown→HTML transform are unit-testable without a DOM or a running app.
 *
 * Wikilink parsing reuses the canonical bracket-counting parser from
 * @floatty/stdlib (wikilinkUtils) — NOT a regex. That parser is what the
 * outline itself uses, so `[[outer [[inner]]]]` and `[[target|alias]]`
 * behave identically inside a read:: document and inside a block.
 */

import { Marked } from 'marked';
import type { TokenizerAndRendererExtension, Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { findWikilinkEnd, parseWikilinkInner } from '@floatty/stdlib';

/** Attribute the rendered document carries the navigation target on. */
export const WIKILINK_ATTR = 'data-wikilink';

/** Data stored in block.output by read::'s execute(). */
export interface ReadData {
  /** Path as the user typed it (pre shell-expansion) — shown in the toolbar. */
  path: string;
  /** Raw file contents. The view renders this; blocks never materialize it. */
  raw: string;
}

// ═══════════════════════════════════════════════════════════════
// ARGUMENT → SHELL COMMAND
// ═══════════════════════════════════════════════════════════════

/**
 * Extract the path argument from `read:: <path>` block content.
 * Only the first line is considered — a read:: block's argument is its path.
 * Returns '' when no path was given.
 */
export function parseReadPath(content: string): string {
  const firstLine = content.split('\n', 1)[0] ?? '';
  const match = firstLine.match(/^\s*read::\s*(.*)$/i);
  if (!match) return '';
  const arg = match[1].trim();
  // Tolerate a user-quoted path: read:: "~/my notes/a.md"
  const unquoted = arg.replace(/^(['"])(.*)\1$/, '$2');
  return unquoted.trim();
}

/** Single-quote a string for POSIX sh, escaping embedded single quotes. */
function singleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quote a path for the shell while preserving `~` expansion.
 *
 * `'~/notes.md'` inside quotes does NOT expand — the tilde must stay bare,
 * so only the remainder gets quoted: `~/'notes.md'`.
 */
export function shellQuotePath(path: string): string {
  if (path === '~') return '~';
  if (path.startsWith('~/')) return `~/${singleQuote(path.slice(2))}`;
  return singleQuote(path);
}

/**
 * Build the read command. `--` stops option parsing so a path beginning
 * with `-` is treated as a file, not a flag.
 */
export function buildReadCommand(path: string): string {
  return `cat -- ${shellQuotePath(path)}`;
}

// ═══════════════════════════════════════════════════════════════
// MARKDOWN → SANITIZED HTML
// ═══════════════════════════════════════════════════════════════

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface WikilinkToken extends Tokens.Generic {
  type: 'wikilink';
  raw: string;
  target: string;
  text: string;
}

/**
 * Inline marked extension: `[[target]]` / `[[target|alias]]` → an anchor
 * carrying the navigation target on data-wikilink.
 *
 * No href — the document proposes a target, the HOST decides what it means
 * (block-id prefix vs page) and where it lands (pane-link resolution).
 */
const wikilinkExtension: TokenizerAndRendererExtension = {
  name: 'wikilink',
  level: 'inline',
  start(src: string) {
    const idx = src.indexOf('[[');
    return idx === -1 ? undefined : idx;
  },
  tokenizer(src: string): WikilinkToken | undefined {
    if (!src.startsWith('[[')) return undefined;
    const end = findWikilinkEnd(src, 0);
    if (end === -1) return undefined;
    const inner = src.slice(2, end - 2);
    const { target, alias } = parseWikilinkInner(inner);
    if (!target) return undefined;
    return {
      type: 'wikilink',
      raw: src.slice(0, end),
      target,
      text: alias ?? target,
    };
  },
  renderer(token: Tokens.Generic): string {
    const { target, text } = token as WikilinkToken;
    return `<a class="read-wikilink" ${WIKILINK_ATTR}="${escapeHtml(target)}">${escapeHtml(text)}</a>`;
  },
};

const md = new Marked({ gfm: true });
md.use({ extensions: [wikilinkExtension] });

/**
 * Render markdown to sanitized HTML.
 *
 * DOMPurify is mandatory — this HTML is assigned via innerHTML and the source
 * is an arbitrary local file, which may contain raw <script>/<iframe>/onerror.
 */
export function renderMarkdownDoc(raw: string): string {
  const html = md.parse(raw, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: [WIKILINK_ATTR],
  });
}

// ═══════════════════════════════════════════════════════════════
// CLICK → NAVIGATION TARGET
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve a click inside the rendered document to a wikilink target.
 * Returns null when the click didn't land on (or inside) a wikilink.
 */
export function wikilinkTargetFromEvent(node: EventTarget | null): string | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest(`[${WIKILINK_ATTR}]`);
  const target = el?.getAttribute(WIKILINK_ATTR)?.trim();
  return target ? target : null;
}
