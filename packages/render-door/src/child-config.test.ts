/**
 * Child-block config — `prefix:: value` parser + spec.state merge.
 *
 * Pattern: render:: spec at top, `key:: value` children at depth 1
 * become the spec's `state` (override defaults). Audio components bind
 * via `{ "$state": "/key" }`. Same shape as func:: / kanban — this is
 * the canonical "blocks-as-config" primitive applied to render::.
 *
 * See packages/render-door/src/render.tsx for the implementation, the
 * "CHILD-CONFIG" header docstring, and the live wiring inside the
 * raw-json execute branch (subscribeBlockChanges → buildAndSetOutput).
 */
import { describe, it, expect } from 'vitest';
import {
  parseChildConfigValue,
  readChildConfig,
  applyChildConfig,
  type BlockActions,
  type LooseSpec,
} from './render';

interface FixtureBlock { id: string; content: string; childIds: string[]; parentId?: string | null }

function makeActions(blocks: Record<string, FixtureBlock>): BlockActions {
  return {
    getBlock: (id) => blocks[id] as unknown as ReturnType<BlockActions['getBlock']>,
    getChildren: (id) => blocks[id]?.childIds ?? [],
    rootIds: () => [],
  };
}

// ─── parseChildConfigValue ──────────────────────────────────────

describe('parseChildConfigValue', () => {
  it('parses numbers', () => {
    expect(parseChildConfigValue('124')).toBe(124);
    expect(parseChildConfigValue('0.5')).toBe(0.5);
    expect(parseChildConfigValue('-5')).toBe(-5);
  });

  it('parses booleans', () => {
    expect(parseChildConfigValue('true')).toBe(true);
    expect(parseChildConfigValue('false')).toBe(false);
  });

  it('parses null', () => {
    expect(parseChildConfigValue('null')).toBe(null);
  });

  it('parses arrays', () => {
    expect(parseChildConfigValue('[true, false, true, false]')).toEqual([true, false, true, false]);
    expect(parseChildConfigValue('[0, null, 12, 7]')).toEqual([0, null, 12, 7]);
  });

  it('parses objects', () => {
    expect(parseChildConfigValue('{"delay": 0.4, "reverb": 0.2}')).toEqual({ delay: 0.4, reverb: 0.2 });
  });

  it('parses quoted strings', () => {
    expect(parseChildConfigValue('"main"')).toBe('main');
  });

  it('falls back to raw string for unquoted values (so "clock:: main" works)', () => {
    expect(parseChildConfigValue('main')).toBe('main');
    expect(parseChildConfigValue('something with spaces')).toBe('something with spaces');
  });

  it('trims whitespace', () => {
    expect(parseChildConfigValue('  124  ')).toBe(124);
    expect(parseChildConfigValue('\nmain\n')).toBe('main');
  });

  it('empty string returns empty string', () => {
    expect(parseChildConfigValue('')).toBe('');
    expect(parseChildConfigValue('   ')).toBe('');
  });
});

// ─── readChildConfig ────────────────────────────────────────────

describe('readChildConfig', () => {
  it('extracts simple key:: value pairs from children', () => {
    const blocks: Record<string, FixtureBlock> = {
      parent: { id: 'parent', content: 'render:: ...', childIds: ['c1', 'c2', 'c3'] },
      c1: { id: 'c1', content: 'bpm:: 130', childIds: [] },
      c2: { id: 'c2', content: 'cutoff:: 850', childIds: [] },
      c3: { id: 'c3', content: 'clock:: main', childIds: [] },
    };
    expect(readChildConfig('parent', makeActions(blocks))).toEqual({
      bpm: 130,
      cutoff: 850,
      clock: 'main',
    });
  });

  it('parses array values for boolean grids', () => {
    const blocks: Record<string, FixtureBlock> = {
      parent: { id: 'parent', content: 'render::', childIds: ['c1'] },
      c1: { id: 'c1', content: 'init:: [true, false, true, false]', childIds: [] },
    };
    expect(readChildConfig('parent', makeActions(blocks))).toEqual({
      init: [true, false, true, false],
    });
  });

  it('skips reserved prefixes (render::, ctx::, sh::, etc.)', () => {
    const blocks: Record<string, FixtureBlock> = {
      parent: { id: 'parent', content: 'render::', childIds: ['c1', 'c2', 'c3', 'c4'] },
      c1: { id: 'c1', content: 'render:: nested', childIds: [] },
      c2: { id: 'c2', content: 'ctx:: 2026-04-29', childIds: [] },
      c3: { id: 'c3', content: 'sh:: ls', childIds: [] },
      c4: { id: 'c4', content: 'bpm:: 130', childIds: [] },
    };
    expect(readChildConfig('parent', makeActions(blocks))).toEqual({ bpm: 130 });
  });

  it('skips children that don\'t match the prefix:: value pattern', () => {
    const blocks: Record<string, FixtureBlock> = {
      parent: { id: 'parent', content: 'render::', childIds: ['c1', 'c2', 'c3'] },
      c1: { id: 'c1', content: 'bpm:: 130', childIds: [] },
      c2: { id: 'c2', content: 'just a comment block', childIds: [] },
      c3: { id: 'c3', content: '', childIds: [] },
    };
    expect(readChildConfig('parent', makeActions(blocks))).toEqual({ bpm: 130 });
  });

  it('handles tolerant whitespace (key  ::   value)', () => {
    const blocks: Record<string, FixtureBlock> = {
      parent: { id: 'parent', content: 'render::', childIds: ['c1'] },
      c1: { id: 'c1', content: 'bpm  ::  130', childIds: [] },
    };
    expect(readChildConfig('parent', makeActions(blocks))).toEqual({ bpm: 130 });
  });

  it('parses object values for sends config', () => {
    const blocks: Record<string, FixtureBlock> = {
      parent: { id: 'parent', content: 'render::', childIds: ['c1'] },
      c1: { id: 'c1', content: 'sends:: {"delay": 0.4, "reverb": 0.2}', childIds: [] },
    };
    expect(readChildConfig('parent', makeActions(blocks))).toEqual({
      sends: { delay: 0.4, reverb: 0.2 },
    });
  });
});

// ─── applyChildConfig ───────────────────────────────────────────

describe('applyChildConfig', () => {
  it('merges config into spec.state, preserving spec defaults', () => {
    const spec: LooseSpec = {
      root: 'r',
      state: { bpm: 120, cutoff: 600 },
      elements: { r: { type: 'AcidBass' } },
    };
    const merged = applyChildConfig(spec, { bpm: 130 });
    expect(merged.state).toEqual({ bpm: 130, cutoff: 600 });
  });

  it('initializes state if spec has none', () => {
    const spec: LooseSpec = {
      root: 'r',
      elements: { r: { type: 'AcidBass' } },
    };
    const merged = applyChildConfig(spec, { bpm: 130 });
    expect(merged.state).toEqual({ bpm: 130 });
  });

  it('returns same spec when config is empty (no allocation)', () => {
    const spec: LooseSpec = { root: 'r', state: { x: 1 }, elements: {} };
    expect(applyChildConfig(spec, {})).toBe(spec);
  });

  it('does not mutate input spec', () => {
    const spec: LooseSpec = { root: 'r', state: { bpm: 120 }, elements: {} };
    const merged = applyChildConfig(spec, { bpm: 130 });
    expect(spec.state).toEqual({ bpm: 120 });
    expect(merged.state).toEqual({ bpm: 130 });
  });

  it('child config wins over spec defaults', () => {
    const spec: LooseSpec = { root: 'r', state: { bpm: 120, cutoff: 600 }, elements: {} };
    const merged = applyChildConfig(spec, { bpm: 130, cutoff: 850 });
    expect(merged.state).toEqual({ bpm: 130, cutoff: 850 });
  });
});
