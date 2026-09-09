/** Twin of prop_stamp.rs query_stamp; pinned by the shared query-stamp corpus. */
import type { QueryParse } from './queryPredicate';
import type { PropSpec } from './markerSurgery';

export function stampForQuery(parse: QueryParse, table: PropSpec[]): Record<string, string> {
  if (!parse.isQuery) return {};
  if (parse.options.hasExplicitStamp) return { ...parse.options.stamp };
  const stamp: Record<string, string> = Object.create(null);
  for (const term of parse.terms) {
    if (term.negate) continue;
    if (term.kind === 'marker' && term.value !== null) {
      stamp[term.markerType] = term.value;
    } else if (term.kind === 'link' && term.match.op === 'exact') {
      const target = term.match.value;
      for (const spec of table) {
        if (spec.surface !== 'glyph') continue;
        const pair = spec.glyphs.find(([, glyph]) => glyph !== '' && glyph === target);
        if (pair) {
          stamp[spec.key] = pair[0];
          break;
        }
      }
    }
  }
  return stamp;
}
