/**
 * Marker grammar — the TS twin of `floatty-core/src/hooks/parsing.rs`
 * `extract_all_markers` (FLO-954).
 *
 * The server is the sole authority on what a marker IS; the client extracts
 * only so a local edit shows its markers before the round trip. Any drift
 * between the two grammars is data loss: the store re-emits steady-state
 * remote creates to the EventBus, `ctxRouterHook` re-extracts, and a client
 * that recognises fewer shapes than the server writes `markers: []` over the
 * server's result. Parity is asserted by the shared corpus
 * `__fixtures__/marker-grammar.json` — both the Rust and the TS test read it.
 *
 * Three marker kinds, in the server's order:
 *   1. prefix  — content starts with `<prefix>::` (`sh::`, `ctx::`, …) → value null
 *   2. tag     — `[key::value]` anywhere (the `[[wikilink]]` typo unwrapped)
 *   3. standalone — bare `key::value` (code namespaces, prefix markers except
 *      `ctx`, bracketed and `::`-chained matches excluded)
 * then dedupe by (type, value) and sort the same way the server does.
 */

import type { Marker } from '../generated/Marker';

/** Mirror of `PREFIX_MARKERS` in parsing.rs — keep in lockstep. */
export const PREFIX_MARKERS: readonly string[] = [
  'sh', 'term', 'ctx', 'dispatch', 'pages', 'web', 'link', 'img', 'daily',
  'reminder', 'meeting', 'brain-boot', 'door', 'embed', 'file', 'ask', 'media',
];

/** Mirror of `CODE_NAMESPACES` in parsing.rs — `std::`, `tokio::` are code, not markers. */
export const CODE_NAMESPACES: readonly string[] = [
  'std', 'core', 'tauri', 'tokio', 'serde', 'crate', 'self', 'super', 'yrs',
  'log', 'anyhow', 'thiserror', 'fs', 'io', 'env', 'http', 'tracing', 'chrono',
  'regex', 'tantivy', 'async', 'sync', 'collections', 'fmt', 'path', 'result',
  'option', 'vec', 'str', 'string',
];

// Rust regex's Unicode \w includes letters, marks, digits, connectors and join controls.
const RUST_WORD = String.raw`\p{Alphabetic}\p{Join_Control}\p{Mark}\p{Decimal_Number}\p{Connector_Punctuation}`;
/** `TAG_PATTERN`: `[key::value]`. */
const TAG_RE = new RegExp(String.raw`\[([${RUST_WORD}]+)::([^\]]+)\]`, 'gu');
/** `STANDALONE_PATTERN`: bare `key::value`, value optional. */
const STANDALONE_RE = new RegExp(
  String.raw`(?<![${RUST_WORD}])([a-zA-Z_][a-zA-Z0-9_-]*)::(?:([${RUST_WORD}/.@_-]+))?`,
  'gu',
);

export function extractPrefixMarker(content: string): string | null {
  const lower = content.toLowerCase();
  for (const prefix of PREFIX_MARKERS) {
    if (lower.startsWith(`${prefix}::`)) return prefix;
  }
  return null;
}

/** `sanitize_marker_value`: trim, and unwrap the historic `[type::[[link]]]` typo. */
function sanitizeMarkerValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[[')) {
    const afterOpen = trimmed.slice(2);
    const cleaned = afterOpen.endsWith(']]') ? afterOpen.slice(0, -2) : afterOpen;
    return cleaned.trim();
  }
  return trimmed;
}

export function extractTagMarkers(content: string): Marker[] {
  const markers: Marker[] = [];
  for (const match of content.matchAll(TAG_RE)) {
    markers.push({ markerType: match[1], value: sanitizeMarkerValue(match[2]) });
  }
  return markers;
}

export function extractStandaloneMarkers(content: string): Marker[] {
  const markers: Marker[] = [];
  for (const match of content.matchAll(STANDALONE_RE)) {
    const markerType = match[1];
    const lower = markerType.toLowerCase();
    if (CODE_NAMESPACES.includes(lower)) continue;
    // Prefix markers' "values" are command content, not metadata — except
    // ctx::, whose value is the date we want.
    if (PREFIX_MARKERS.includes(lower) && lower !== 'ctx') continue;
    const start = match.index ?? 0;
    const before = start > 0 ? content[start - 1] : '';
    if (before === '[') continue; // bracketed — the tag pass owns it
    if (before === ':') continue; // `::std::` style chain
    markers.push(match[2] !== undefined
      ? { markerType, value: match[2] }
      : { markerType, value: null });
  }
  return markers;
}

/** Server sort: by (marker_type, value) with a missing value ordering first. */
export function compareMarkers(a: Marker, b: Marker): number {
  if (a.markerType !== b.markerType) return a.markerType < b.markerType ? -1 : 1;
  const av = a.value ?? null;
  const bv = b.value ?? null;
  if (av === bv) return 0;
  if (av === null) return -1;
  if (bv === null) return 1;
  return av < bv ? -1 : 1;
}

/** Twin of `extract_all_markers`: prefix + tag + standalone, deduped and sorted. */
export function extractAllMarkers(content: string): Marker[] {
  const markers: Marker[] = [];
  const prefix = extractPrefixMarker(content);
  if (prefix) markers.push({ markerType: prefix, value: null });
  markers.push(...extractTagMarkers(content));
  markers.push(...extractStandaloneMarkers(content));

  markers.sort(compareMarkers);
  const out: Marker[] = [];
  for (const marker of markers) {
    const last = out[out.length - 1];
    if (last && last.markerType === marker.markerType && (last.value ?? null) === (marker.value ?? null)) continue;
    out.push(marker);
  }
  return out;
}
