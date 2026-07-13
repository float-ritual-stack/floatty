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

/** True when the argument addresses QMD (qmd:// URI or #docid). */
export function isQmdSource(path: string): boolean {
  return path.startsWith('qmd://') || /^#[0-9a-f]{6,}$/i.test(path);
}

/**
 * Build the read command. `--` stops option parsing so a path beginning
 * with `-` is treated as a file, not a flag.
 *
 * qmd:// URIs and #docids route through `qmd get` instead of cat — the
 * corpus is addressable the same way the filesystem is (2026-07-12:
 * "read:: qmd://sysops-log/….md:2" is literally a thing Evan just did
 * via sh:: qmd get). For qmd:// only the first whitespace token is used:
 * pasted qmd search hits carry a trailing " #docid" annotation.
 */
export function buildReadCommand(path: string): string {
  if (path.startsWith('qmd://')) {
    const uri = path.split(/\s+/, 1)[0];
    return `qmd get ${singleQuote(uri)}`;
  }
  if (/^#[0-9a-f]{6,}$/i.test(path)) {
    return `qmd get ${singleQuote(path)}`;
  }
  if (isGlobbable(path)) {
    // Unquoted so the shell expands it. Safe only because isGlobbable() has
    // already rejected every metacharacter that could do anything but match a
    // filename. `--` still stops a leading dash being read as a flag.
    return `cat -- ${path}`;
  }
  return `cat -- ${shellQuotePath(path)}`;
}

/** Glob metacharacters we're willing to hand to the shell. */
const GLOB_CHARS = /[*?[\]]/;

/**
 * Shell metacharacters that can do something OTHER than match a filename:
 * command substitution, chaining, redirection, expansion, quoting, newline.
 *
 * Deliberately a DENY-list of the dangerous, not an allow-list of the safe —
 * filenames legitimately contain spaces, parens, ampersands, unicode, and
 * anything else a human types. An allow-list would break real paths; this
 * blocks the characters with shell semantics and lets the rest through
 * (already quoted, on the non-glob path).
 */
const SHELL_METACHARS = /[$`;|&<>(){}!#'"\\\n\r]/;

/**
 * True when `path` should be handed to the shell UNQUOTED so its glob expands.
 *
 * `sh:: cat /opt/float/bbs/**\/x.md` works because the raw command reaches zsh.
 * `read::` quotes its argument for injection safety — and quotes are exactly
 * what stop globbing, so the same path errored (2026-07-13, live). Globbing is
 * how paths actually get typed here, so it has to work.
 *
 * The compromise: a path may go unquoted ONLY if it contains a glob character
 * AND contains no shell metacharacter. `/opt/**\/x.md` expands;
 * `/tmp/$(whoami).md` and `/tmp/a.md; rm -rf ~` still get quoted into
 * inertness. A path with both (`/tmp/*; rm -rf ~`) is NOT globbable — the
 * metacharacter check wins, and it gets quoted.
 */
export function isGlobbable(path: string): boolean {
  return GLOB_CHARS.test(path) && !SHELL_METACHARS.test(path);
}

/**
 * Strip `qmd get`'s "Folder Context:" preamble (context lines ending at the
 * first standalone ---) so the document's own frontmatter lands at position
 * 0 where splitFrontmatter can lift it.
 */
export function stripQmdPreamble(raw: string): string {
  if (!raw.startsWith('Folder Context:')) return raw;
  const end = raw.indexOf('\n---\n');
  if (end === -1) return raw;
  return raw.slice(end + 5).replace(/^\s+/, '');
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


interface PillToken extends Tokens.Generic {
  type: 'floatPill';
  raw: string;
  key: string;
  value: string;
}

/** Deterministic hue from a pill's key+value — mirrors the outline parser's
 *  value-hashed pill colors (capture-format Layer 0: pills ARE hierarchy). */
export function pillHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/**
 * Inline extension: [key::value] → color-hashed pill span.
 * BlockDown primitive (RFC 2026-04-27): pills are first-class inline
 * metadata, not bracket noise. Keys are word-ish; values stay short.
 */
const pillExtension: TokenizerAndRendererExtension = {
  name: 'floatPill',
  level: 'inline',
  start(src: string) {
    const idx = src.indexOf('[');
    return idx === -1 ? undefined : idx;
  },
  tokenizer(src: string): PillToken | undefined {
    const m = src.match(/^\[([a-zA-Z][\w-]*)::([^\]\n]{0,80})\]/);
    if (!m) return undefined;
    return { type: 'floatPill', raw: m[0], key: m[1], value: m[2].trim() };
  },
  renderer(token: Tokens.Generic): string {
    const { key, value } = token as PillToken;
    const hue = pillHue(key + '::' + value);
    return `<span class="read-pill" style="--pill-h:${hue}">` +
      `<span class="read-pill-k">${escapeHtml(key)}</span>` +
      (value ? `<span class="read-pill-v">${escapeHtml(value)}</span>` : '') +
      `</span>`;
  },
};


interface TimelogEntry {
  time: string;
  proj: string;
  tokens: Tokens.Generic[];
}

interface TimelogToken extends Tokens.Generic {
  type: 'floatTimelog';
  raw: string;
  entries: TimelogEntry[];
}

const TL_LINE = /^(~?\d{1,2}:\d{2}\s?(?:am|pm))\s+(.*)$/i;

/**
 * Block extension: consecutive timelog lines (`~01:35pm project text…`)
 * render as hanging-indent entries with a cyan timestamp — the daily-note
 * timelog idiom (BlockDown; capture-format Layer 0: timestamps are cyan).
 * Without this, wrapped entries re-flow to column 0 and the log is mush
 * (2026-07-12 screenshot round 2). am/pm required — bare H:MM in prose
 * must not get hijacked.
 */
const timelogExtension: TokenizerAndRendererExtension = {
  name: 'floatTimelog',
  level: 'block',
  start(src: string) {
    const i = src.search(/^~?\d{1,2}:\d{2}\s?(?:am|pm)\s/im);
    return i === -1 ? undefined : i;
  },
  tokenizer(src: string): TimelogToken | undefined {
    const block = /^(?:~?\d{1,2}:\d{2}\s?(?:am|pm)\s+[^\n]*(?:\n|$))+/i.exec(src);
    if (!block) return undefined;
    const entries: TimelogEntry[] = [];
    for (const line of block[0].split('\n')) {
      const m = line.match(TL_LINE);
      if (!m) continue;
      // Timelog convention is `time  project  text` (2+ space separators).
      // Only peel a project slug when that separator shape is present.
      let proj = '';
      let rest = m[2];
      const pm = rest.match(/^([\w./-]+)\s{2,}(.*)$/);
      if (pm) {
        proj = pm[1];
        rest = pm[2];
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tokens = (this as any).lexer.inlineTokens(rest);
      entries.push({ time: m[1], proj, tokens });
    }
    if (!entries.length) return undefined;
    return { type: 'floatTimelog', raw: block[0], entries };
  },
  renderer(token: Tokens.Generic): string {
    const { entries } = token as TimelogToken;
    const rows = entries
      .map((e) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (this as any).parser.parseInline(e.tokens);
        const proj = e.proj
          ? `<span class="read-tl-proj">${escapeHtml(e.proj)}</span> `
          : '';
        return `<div class="read-tl"><span class="read-tl-time">${escapeHtml(e.time)}</span> ${proj}${body}</div>`;
      })
      .join('');
    return `<div class="read-tl-block">${rows}</div>`;
  },
};

// breaks: true — Obsidian-convention line breaks. The corpus (daily notes,
// timelogs, BBS posts) is authored line-per-entry with single newlines;
// CommonMark's fold-into-paragraph turns a timelog into an unreadable
// run-on (2026-07-12 screenshot). Newline = <br>, like Obsidian renders it.
const md = new Marked({ gfm: true, breaks: true });
md.use({
  extensions: [wikilinkExtension, pillExtension, timelogExtension],
  // BlockDown (RFC 2026-04-27): "2-space indent = child-block, NOT
  // code-fence trigger". CommonMark's indented-code rule turns indented
  // note hierarchy into <pre> garbage — fenced code only in the reader.
  tokenizer: {
    code() {
      return undefined;
    },
  },
});

/**
 * Split leading YAML frontmatter from a document (display-only — no YAML
 * parsing beyond `key: value` lines; nested values render as their raw text).
 * marked has no frontmatter concept and mashes the block into body
 * paragraphs (2026-07-12 live-test screenshot), so we lift it out and let
 * the view render a compact metadata strip instead.
 */
export function splitFrontmatter(raw: string): {
  front: Array<[string, string]> | null;
  body: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { front: null, body: raw };
  const pairs: Array<[string, string]> = [];
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) pairs.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return { front: pairs.length ? pairs : null, body: raw.slice(m[0].length) };
}

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
