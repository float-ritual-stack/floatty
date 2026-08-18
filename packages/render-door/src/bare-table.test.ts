/**
 * FLO — accept a bare element table as a `render::` spec.
 *
 * `~/.floatty/doors/render/agent/patterns.html` documents 21 layout patterns.
 * Every one is a bare element table — no `{root, elements}` envelope — so not
 * one of them could be pasted into a render:: block. All 21 failed with
 * "JSON must have root + elements" at render.tsx's entry guard, while
 * normalizeSpec twenty lines away already auto-fixed a WRONG root and pruned
 * dangling child refs. Strict at the door, lenient inside.
 */
import { describe, it, expect } from 'vitest';
import { coerceBareElementTable } from './render';

/** The exact fragment from patterns.html § "TuiPanel + Stats". */
const PATTERNS_FRAGMENT = {
  panel: { type: 'TuiPanel', props: { title: 'Sprint Status', titleColor: '#00e5ff' }, children: ['stats-row'] },
  'stats-row': { type: 'Stack', props: { gap: 6, direction: 'horizontal' }, children: ['stat-a', 'stat-b', 'stat-c'] },
  'stat-a': { type: 'TuiStat', props: { label: 'Merged', value: '2 PRs', color: '#98c379' } },
  'stat-b': { type: 'TuiStat', props: { label: 'Open', value: '3 PRs', color: '#ffb300' } },
  'stat-c': { type: 'TuiStat', props: { label: 'Blocked', value: '1', color: '#ff4444' } },
};

describe('coerceBareElementTable', () => {
  it('wraps the patterns.html fragment and infers the true root', () => {
    const spec = coerceBareElementTable(PATTERNS_FRAGMENT);
    expect(spec).not.toBeNull();
    // `panel` is the only element nothing else claims as a child.
    expect(spec!.root).toBe('panel');
    expect(spec!.elements).toBe(PATTERNS_FRAGMENT);
  });

  it('infers root by unreferenced-ness, NOT key order', () => {
    // Root declared LAST — key order would pick the wrong one.
    const table = {
      leaf: { type: 'Text', props: { content: 'hi' } },
      mid: { type: 'Stack', props: {}, children: ['leaf'] },
      top: { type: 'TuiPanel', props: {}, children: ['mid'] },
    };
    expect(coerceBareElementTable(table)!.root).toBe('top');
  });

  it('leaves a real spec alone', () => {
    const spec = { root: 'r', elements: { r: { type: 'Text', props: {} } } };
    expect(coerceBareElementTable(spec)).toBeNull();
  });

  it('falls back to the first key when several elements are unreferenced', () => {
    const table = {
      a: { type: 'Text', props: {} },
      b: { type: 'Text', props: {} },
    };
    expect(coerceBareElementTable(table)!.root).toBe('a');
  });

  it('handles a single element with no children key', () => {
    const table = { solo: { type: 'Divider', props: {} } };
    const spec = coerceBareElementTable(table);
    expect(spec!.root).toBe('solo');
  });

  it('rejects things that are not element tables', () => {
    expect(coerceBareElementTable(null)).toBeNull();
    expect(coerceBareElementTable([1, 2, 3])).toBeNull();
    expect(coerceBareElementTable({})).toBeNull();
    expect(coerceBareElementTable('a string')).toBeNull();
    // values without a string `type` are not elements
    expect(coerceBareElementTable({ bpm: 130, key: 'Am' })).toBeNull();
    expect(coerceBareElementTable({ a: { props: {} } })).toBeNull();
  });

  it('rejects a partial table (one bad value disqualifies the whole thing)', () => {
    expect(coerceBareElementTable({
      good: { type: 'Text', props: {} },
      bad: 'not an element',
    })).toBeNull();
  });
});
