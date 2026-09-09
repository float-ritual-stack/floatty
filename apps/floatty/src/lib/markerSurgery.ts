/** Content surgery twin of floatty-core/hooks/parsing.rs. Shared corpus pins parity. */
import { extractAllMarkers, extractTagMarkers, TAG_RE } from './markerGrammar';
import type { Marker } from '../generated/Marker';

export type PropSurface = 'pill' | 'glyph';
export interface PropSpec {
  key: string;
  surface: PropSurface;
  /** (value name, glyph) pairs. */
  glyphs: Array<[string, string]>;
}
export interface PropWrite {
  set: Record<string, string>;
  unset: string[];
}
export interface PropChange {
  content: string;
  changed: boolean;
  /** All extracted keys; absent keys omitted, present valueless keys null. */
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

export function defaultPropTable(): PropSpec[] {
  return [{ key: 'status', surface: 'glyph', glyphs: [
    ['todo', '⬜'], ['doing', '🟨'], ['done', '✅'], ['waiting', '👀'],
  ] }];
}

// Horizontal whitespace only. Bold is title content, not a prefix.
const PROP_PREFIX = /^[ \t]*(?:(?:#{1,6}|[-+*>]|[0-9]+[.)]|[①-⑳㉑-㉟㊱-㊿])[ \t]+)*/u;
function propHead(line: string): number { return PROP_PREFIX.exec(line)?.[0].length ?? 0; }

type Span = { start: number; end: number };
function glyphSpans(content: string, spec: PropSpec): Array<Span & { value: string }> {
  const line = content.split('\n', 1)[0];
  const spans: Array<Span & { value: string }> = [];
  for (const [value, glyph] of spec.glyphs) {
    if (!glyph) continue;
    const link = `[[${glyph}]]`;
    let start = line.indexOf(link);
    while (start >= 0) {
      spans.push({ start, end: start + link.length, value });
      start = line.indexOf(link, start + link.length);
    }
  }
  const head = propHead(line);
  for (const [value, glyph] of spec.glyphs) {
    const end = head + glyph.length;
    if (glyph && line.slice(head).startsWith(glyph) && (end === line.length || /^[ \t\r]/.test(line.slice(end)))) {
      spans.push({ start: head, end, value });
      break;
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans.filter((span, i) => i === 0 || span.start !== spans[i - 1].start);
}

function propValues(content: string, table: PropSpec[]): Record<string, string | null> {
  const values: Record<string, string | null> = Object.create(null);
  const markers: Marker[] = extractAllMarkers(content);
  for (const marker of markers) {
    if (!Object.hasOwn(values, marker.markerType)) values[marker.markerType] = marker.value ?? null;
  }
  for (const spec of table) {
    if (spec.surface === 'glyph') {
      const first = glyphSpans(content, spec)[0];
      if (first) values[spec.key] = first.value;
    }
  }
  return values;
}

/** undefined = absent, null = present without a value. Uses the extractor's
 * first sorted value; a mapped first-line glyph takes precedence for its key. */
export function currentPropValue(content: string, key: string, table: PropSpec[]): string | null | undefined {
  return propValues(content, table)[key];
}

function removePropSpan(content: string, start: number, end: number): string {
  const lineStart = start === 0 || content[start - 1] === '\n';
  const lineEnd = end === content.length || content[end] === '\n' || content[end] === '\r';
  if (content[end] === ' ' && (lineStart || content[start - 1] === ' ')) end++;
  else if (lineEnd && start > 0 && content[start - 1] === ' ') start--;
  return content.slice(0, start) + content.slice(end);
}

function writeProp(content: string, key: string, value: string | undefined, table: PropSpec[]): string {
  const spec = table.find((spec) => spec.key === key && spec.surface === 'glyph');
  let replacement: string | undefined;
  let spans: Span[];
  if (spec) {
    if (value !== undefined) {
      const pair = spec.glyphs.find(([name, glyph]) => name === value && glyph !== '');
      if (!pair) return content;
      replacement = `[[${pair[1]}]]`;
    }
    spans = glyphSpans(content, spec);
  } else {
    if (value !== undefined) {
      replacement = `[${key}::${value === '' ? ' ' : value}]`;
      const markers = extractTagMarkers(replacement);
      const whole = Array.from(replacement.matchAll(TAG_RE))[0]?.[0];
      if (/[\r\n]/.test(value) || markers.length !== 1 || markers[0].markerType !== key
        || markers[0].value !== value || whole !== replacement) return content;
    }
    spans = Array.from(content.matchAll(TAG_RE)).filter((m) => m[1] === key)
      .map((m) => ({ start: m.index, end: m.index + m[0].length }));
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end } = spans[i];
    if (i === 0 && replacement !== undefined) content = content.slice(0, start) + replacement + content.slice(end);
    else content = removePropSpan(content, start, end);
  }
  if (spans.length === 0 && replacement !== undefined) {
    if (spec) {
      const head = propHead(content.split('\n', 1)[0]);
      content = content.slice(0, head) + replacement + ' ' + content.slice(head);
    } else {
      const newline = content.indexOf('\n');
      let end = newline < 0 ? content.length : newline;
      if (newline >= 0 && Array.from(content.slice(newline + 1).matchAll(TAG_RE))[0]?.index === 0) {
        const secondEnd = content.indexOf('\n', newline + 1);
        end = secondEnd < 0 ? content.length : secondEnd;
      }
      if (end > 0 && content[end - 1] === '\r') end--;
      const separator = end === 0 || /[ \t\n]/.test(content[end - 1]) ? '' : ' ';
      content = content.slice(0, end) + separator + replacement + content.slice(end);
    }
  }
  return content;
}

/** Sets in key order, then unsets (unset wins overlap). Unrepresentable
 * pill values and unknown glyph values leave that key untouched. An empty string
 * uses `[key:: ]`: the existing grammar does not recognize `[key::]`.
 * Never writes metadata; snapshots are re-extracted from the resulting text. */
export function setMarkerValue(content: string, write: PropWrite, table: PropSpec[]): PropChange {
  const before = propValues(content, table);
  let result = content;
  for (const [key, value] of Object.entries(write.set).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) result = writeProp(result, key, value, table);
  for (const key of write.unset) result = writeProp(result, key, undefined, table);
  return { content: result, changed: result !== content, before, after: propValues(result, table) };
}
