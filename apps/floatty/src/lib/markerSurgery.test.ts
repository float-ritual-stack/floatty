import { describe, expect, it } from 'vitest';
import corpusRaw from './__fixtures__/marker-surgery.json?raw';
import { currentPropValue, defaultPropTable, setMarkerValue, type PropWrite, type RejectReason } from './markerSurgery';

interface SurgeryCase {
  name: string;
  content: string;
  write: PropWrite;
  table: string;
  expect: { content: string; changed: boolean; rejected?: Record<string, RejectReason> };
}
const corpus = JSON.parse(corpusRaw) as { cases: SurgeryCase[] };

describe('marker surgery shared corpus', () => {
  for (const c of corpus.cases) {
    it(c.name, () => {
      expect(c.table).toBe('default');
      const table = defaultPropTable();
      const result = setMarkerValue(c.content, c.write, table);
      expect(result.content).toBe(c.expect.content);
      expect(result.changed).toBe(c.expect.changed);
      expect(result.rejected).toEqual(c.expect.rejected ?? {});
      const repeated = setMarkerValue(result.content, c.write, table);
      expect(repeated.changed).toBe(false);
      expect(repeated.after).toEqual(result.after);
      for (const key of new Set([...Object.keys(result.before), ...Object.keys(result.after), ...Object.keys(c.write.set), ...c.write.unset])) {
        expect(result.before[key]).toBe(currentPropValue(c.content, key, table));
        expect(result.after[key]).toBe(currentPropValue(result.content, key, table));
      }
    });
  }
});

it('distinguishes absence, no value, empty string, and mapped status', () => {
  const table = defaultPropTable();
  const content = 'ctx:: [project:: ] [[🟨]] card';
  expect(currentPropValue(content, 'missing', table)).toBeUndefined();
  expect(currentPropValue(content, 'ctx', table)).toBeNull();
  expect(currentPropValue(content, 'project', table)).toBe('');
  expect(currentPropValue(content, 'status', table)).toBe('doing');
  expect(currentPropValue('[project::z] [project::a]', 'project', table)).toBe('a');
});

it('supports a caller-supplied surface table and prototype-shaped marker keys', () => {
  const table = [{ key: 'review', surface: 'glyph' as const, glyphs: [['ready', '🔎'] as [string, string]] }];
  const result = setMarkerValue('card [__proto__::old]', { set: { review: 'ready', constructor: 'demo' }, unset: [] }, table);
  expect(result.content).toBe('[[🔎]] card [__proto__::old] [constructor::demo]');
  expect(result.after['__proto__']).toBe('old');
  expect(result.after['constructor']).toBe('demo');
  expect(result.after['review']).toBe('ready');
});

it('reports extractor snapshots including untouched valueless markers', () => {
  const result = setMarkerValue('ctx:: [project::old] [[⬜]] card', {
    set: { status: 'doing', project: 'demo' }, unset: [],
  }, defaultPropTable());
  expect(result.before).toEqual({ ctx: null, project: 'old', status: 'todo' });
  expect(result.after).toEqual({ ctx: null, project: 'demo', status: 'doing' });
});
