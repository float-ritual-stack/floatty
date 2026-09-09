/**
 * Marker-grammar parity (FLO-954). The corpus is the contract: the Rust side
 * (`parsing.rs` `extract_all_markers_corpus`) asserts the same file.
 */
import { describe, it, expect } from 'vitest';
import corpusRaw from './__fixtures__/marker-grammar.json?raw';
import { extractAllMarkers, extractPrefixMarker, extractStandaloneMarkers, extractTagMarkers } from './markerGrammar';

interface MarkerCase {
  name: string;
  content: string;
  markers: Array<{ type: string; value: string | null }>;
}

const corpus = JSON.parse(corpusRaw) as { markers: MarkerCase[] };

describe('markerGrammar — shared corpus parity', () => {
  for (const c of corpus.markers) {
    it(c.name, () => {
      expect(extractAllMarkers(c.content).map((m) => ({ type: m.markerType, value: m.value ?? null })))
        .toEqual(c.markers);
    });
  }
});

describe('markerGrammar — unit', () => {
  it('prefix detection is case-insensitive and anchored at the start', () => {
    expect(extractPrefixMarker('SH:: ls')).toBe('sh');
    expect(extractPrefixMarker('brain-boot:: go')).toBe('brain-boot');
    expect(extractPrefixMarker(' sh:: ls')).toBeNull();
    expect(extractPrefixMarker('run sh:: ls')).toBeNull();
  });

  it('tag pass never returns null values; standalone pass does for bare keys', () => {
    expect(extractTagMarkers('[a::b] [c::d]')).toEqual([
      { markerType: 'a', value: 'b' },
      { markerType: 'c', value: 'd' },
    ]);
    expect(extractStandaloneMarkers('x:: and y::z')).toEqual([
      { markerType: 'x', value: null },
      { markerType: 'y', value: 'z' },
    ]);
  });

  it('bracketed matches are left to the tag pass (no double count)', () => {
    expect(extractStandaloneMarkers('[project::floatty]')).toEqual([]);
  });
});
