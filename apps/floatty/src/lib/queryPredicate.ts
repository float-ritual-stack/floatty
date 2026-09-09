/**
 * `query::` predicate grammar (query-views track, brief E — FLO-947).
 *
 * Pure: string in, `QueryParse` out. Never throws — every malformed piece
 * becomes an entry in `errors` and is dropped, so a half-typed query still
 * renders whatever it CAN evaluate.
 *
 * Shape of a query line:
 *
 *   query:: link:⬜ !link:✅ page~^2026 [display:: titles] [limit:: 50]
 *
 * Terms are whitespace-separated and AND together; a leading `!` negates.
 * Term kinds (v1):
 *
 *   link:<target>          exact — the same canonical identity the backlink
 *                          index uses (`BacklinkIndex.canonicalTargetKey`)
 *   link~<regex>           pattern over the block's raw outlink targets
 *   page:<name>            nearest page (direct child of `pages::`), by
 *                          `getSectionKey`
 *   page~<regex>           pattern over the nearest page's title
 *   under:[[block|page]]   subtree scope (id, short hash, or page name)
 *   since:<N>d             `updatedAt` within the last N days
 *   text~<regex>           pattern over the block's first line
 *   marker:<type>[:<value>] a marker on the block (OWN markers for now —
 *                          see queryEval.ts, the brief-B seam)
 *
 * `~` regexes compile case-insensitively; an invalid pattern is an error.
 * Bracketed spans (`[[…]]`, `[…]`) never split on their inner whitespace, so
 * `under:[[My Page Name]]` and `[stamp:: a=b c=d]` are single tokens.
 *
 * Options are `[key:: value]` pills on the query line, parsed by the marker
 * grammar's `extractTagMarkers` (parity with `parsing.rs TAG_PATTERN`):
 *
 *   [create_block:: [[target]]]   home for blocks added inside the query's
 *                                 subtree — `queryCreate.ts` resolves it,
 *                                 `useBlockInput` redirects the Enter create
 *   [display:: rows|titles]       row shape (default rows)
 *   [stamp:: k=v …]               write-through stamps (carried for brief C)
 *   [limit:: N]                   result cap (default 200)
 *
 * NOTE the underscore in `create_block`: the marker grammar's key class is
 * `\w+` on both sides (`TAG_PATTERN`), so `[create-block:: …]` is not a
 * marker anywhere in floatty. The hyphenated spelling is reported as an error
 * pointing at the legal one rather than silently ignored.
 */

import { setMarkerValue } from './markerSurgery';
import { extractTagMarkers } from './markerGrammar';

export type QueryMatcher =
  | { op: 'exact'; value: string }
  | { op: 'regex'; regex: RegExp };

export type QueryTerm =
  | { kind: 'link'; negate: boolean; match: QueryMatcher }
  | { kind: 'page'; negate: boolean; match: QueryMatcher }
  | { kind: 'under'; negate: boolean; target: string }
  | { kind: 'since'; negate: boolean; days: number }
  | { kind: 'text'; negate: boolean; regex: RegExp }
  | { kind: 'marker'; negate: boolean; markerType: string; value: string | null };

export type QueryDisplay = 'rows' | 'titles' | 'reader';

export const DEFAULT_READER_FLAGS = {
  marks: false, crumbs: false, bullets: false, meta: false, peek: false,
  children: true, headings: true,
};
export type ReaderFlags = typeof DEFAULT_READER_FLAGS;

export interface QueryOptions {
  /** `[create_block:: [[target]]]` — resolved + acted on by `queryCreate.ts`. */
  createBlock: string | null;
  display: QueryDisplay;
  reader: ReaderFlags;
  chrome: 'on' | 'off';
  /** `[stamp:: k=v …]` — carried for the stamping hook (brief C). */
  stamp: Record<string, string>;
  /** Presence matters: an empty explicit stamp disables derivation. */
  hasExplicitStamp: boolean;
  limit: number;
}

export interface QueryParse {
  terms: QueryTerm[];
  options: QueryOptions;
  errors: string[];
  /** True when the content carried the `query::` prefix at all. */
  isQuery: boolean;
}

export const DEFAULT_QUERY_LIMIT = 200;
export const MAX_QUERY_LIMIT = 2000;

const TERM_KINDS = new Set(['link', 'page', 'under', 'since', 'text', 'marker']);
const OPTION_KEYS = new Set(['create_block', 'display', 'stamp', 'limit', 'chrome', 'reader']);
const SINCE_RE = /^(\d+)d$/i;

function defaultOptions(): QueryOptions {
  return { createBlock: null, display: 'rows', reader: { ...DEFAULT_READER_FLAGS }, chrome: 'on', stamp: {}, hasExplicitStamp: false, limit: DEFAULT_QUERY_LIMIT };
}

/**
 * Split on whitespace at bracket depth zero. `[[a b]]` and `[k:: a b]` stay
 * whole; an unbalanced `[` runs to end of line (the pill/wikilink is then
 * reported by whoever consumes it, never a throw).
 */
export function tokenizeQueryLine(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of line) {
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function compileRegex(source: string, errors: string[], label: string): RegExp | null {
  try {
    return new RegExp(source, 'i');
  } catch (error) {
    errors.push(`invalid regex in ${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function stripWikilink(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) return trimmed.slice(2, -2).trim();
  return trimmed;
}

function parseTerm(token: string, errors: string[]): QueryTerm | null {
  let negate = false;
  let body = token;
  if (body.startsWith('!')) {
    negate = true;
    body = body.slice(1);
  }
  if (!body) {
    errors.push('empty term after "!"');
    return null;
  }

  // Split on the first `:` or `~` — whichever comes first is the operator.
  const opIndex = body.search(/[:~]/);
  if (opIndex <= 0) {
    errors.push(`unknown term "${token}"`);
    return null;
  }
  const kind = body.slice(0, opIndex).toLowerCase();
  const op = body[opIndex] === '~' ? 'regex' : 'exact';
  const value = body.slice(opIndex + 1);

  if (!TERM_KINDS.has(kind)) {
    errors.push(`unknown term "${token}"`);
    return null;
  }
  if (!value) {
    errors.push(`empty value in "${token}"`);
    return null;
  }

  switch (kind) {
    case 'link':
    case 'page': {
      if (op === 'regex') {
        const regex = compileRegex(value, errors, `${kind}~`);
        return regex ? { kind, negate, match: { op: 'regex', regex } } : null;
      }
      return { kind, negate, match: { op: 'exact', value: stripWikilink(value) } };
    }
    case 'under': {
      if (op === 'regex') {
        errors.push(`under: takes a [[target]], not a regex ("${token}")`);
        return null;
      }
      const target = stripWikilink(value);
      if (!target) {
        errors.push(`empty value in "${token}"`);
        return null;
      }
      return { kind, negate, target };
    }
    case 'since': {
      const match = SINCE_RE.exec(value);
      if (op === 'regex' || !match) {
        errors.push(`since: expects <N>d ("${token}")`);
        return null;
      }
      const days = Number(match[1]);
      if (!Number.isFinite(days) || days <= 0) {
        errors.push(`since: expects a positive day count ("${token}")`);
        return null;
      }
      return { kind, negate, days };
    }
    case 'text': {
      if (op === 'exact') {
        errors.push(`text: takes a regex — use text~ ("${token}")`);
        return null;
      }
      const regex = compileRegex(value, errors, 'text~');
      return regex ? { kind, negate, regex } : null;
    }
    case 'marker': {
      if (op === 'regex') {
        errors.push(`marker: takes <type>[:<value>], not a regex ("${token}")`);
        return null;
      }
      const sep = value.indexOf(':');
      const markerType = (sep === -1 ? value : value.slice(0, sep)).trim();
      const markerValue = sep === -1 ? null : value.slice(sep + 1).trim();
      if (!markerType) {
        errors.push(`empty marker type in "${token}"`);
        return null;
      }
      return { kind, negate, markerType, value: markerValue === '' ? null : markerValue };
    }
    default:
      return null;
  }
}

function parseStamp(raw: string, errors: string[]): Record<string, string> {
  const stamp: Record<string, string> = Object.create(null);
  for (const pair of raw.split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0 || eq === pair.length - 1) {
      errors.push(`stamp expects key=value ("${pair}")`);
      continue;
    }
    stamp[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return stamp;
}

function applyOption(
  options: QueryOptions,
  markerType: string,
  value: string,
  errors: string[],
): void {
  const key = markerType.toLowerCase();
  switch (key) {
    case 'create_block':
      options.createBlock = stripWikilink(value) || null;
      return;
    case 'display': {
      const mode = value.trim().toLowerCase();
      if (mode === 'rows' || mode === 'titles' || mode === 'reader') options.display = mode;
      else errors.push(`display expects rows|titles|reader ("${value.trim()}")`);
      return;
    }
    case 'reader':
      for (const flag of value.trim().split(/\s+/).filter(Boolean)) {
        const name = flag.startsWith('!') ? flag.slice(1) : flag;
        if (Object.hasOwn(DEFAULT_READER_FLAGS, name)) {
          options.reader[name as keyof ReaderFlags] = !flag.startsWith('!');
        } else errors.push(`unknown reader flag "${flag}"`);
      }
      return;
    case 'chrome': {
      const mode = value.trim().toLowerCase();
      if (mode === 'on' || mode === 'off') options.chrome = mode;
      else errors.push(`chrome expects on|off ("${value.trim()}")`);
      return;
    }
    case 'stamp':
      options.hasExplicitStamp = true;
      options.stamp = { ...options.stamp, ...parseStamp(value, errors) };
      return;
    case 'limit': {
      const limit = Number(value.trim());
      if (!Number.isInteger(limit) || limit <= 0) {
        errors.push(`limit expects a positive integer ("${value.trim()}")`);
        return;
      }
      options.limit = Math.min(limit, MAX_QUERY_LIMIT);
      return;
    }
    default:
      errors.push(`unknown option "${markerType}"`);
  }
}

function parsePill(token: string, options: QueryOptions, errors: string[]): void {
  const markers = extractTagMarkers(token);
  if (markers.length === 0) {
    if (/^\[create-block::/i.test(token)) {
      errors.push('option "create-block" is not a marker key — use [create_block:: [[target]]]');
    } else {
      errors.push(`unrecognised option "${token}"`);
    }
    return;
  }
  for (const marker of markers) {
    if (!OPTION_KEYS.has(marker.markerType.toLowerCase())) {
      errors.push(`unknown option "${marker.markerType}"`);
      continue;
    }
    applyOption(options, marker.markerType, marker.value ?? '', errors);
  }
}

/** Parse a block's content as a `query::` line. Only the first line is read. */
export function parseQuery(content: string): QueryParse {
  const firstLine = content.split('\n')[0] ?? '';
  const trimmed = firstLine.trim();
  const errors: string[] = [];
  const options = defaultOptions();
  if (!/^query::/i.test(trimmed)) {
    return { terms: [], options, errors: ['not a query:: block'], isQuery: false };
  }
  const body = trimmed.slice('query::'.length);
  const terms: QueryTerm[] = [];
  for (const token of tokenizeQueryLine(body)) {
    if (token.startsWith('[') && !token.startsWith('[[')) {
      parsePill(token, options, errors);
      continue;
    }
    const term = parseTerm(token, errors);
    if (term) terms.push(term);
  }
  // Reader is quiet by default; an explicit chrome pill wins in either order.
  const explicitChrome = extractTagMarkers(body).some((marker) => marker.markerType.toLowerCase() === 'chrome');
  if (options.display === 'reader' && !explicitChrome) options.chrome = 'off';
  return { terms, options, errors, isQuery: true };
}

/** Authorial options live on line one; marker surgery owns pill syntax. */
export function setQueryOption(content: string, key: string, value: string): string {
  const newline = content.indexOf('\n');
  const line = newline < 0 ? content : content.slice(0, newline);
  const tail = newline < 0 ? '' : content.slice(newline);
  const change = setMarkerValue(line, { set: { [key]: value }, unset: [] }, [
    { key, surface: 'pill', glyphs: [] },
  ]);
  return change.content + tail;
}
