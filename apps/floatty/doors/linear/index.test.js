import { describe, expect, it } from 'vitest';

import { ISSUE_RE, inferFromAncestors, parseArgs } from './index.js';

/** Minimal `actions` stub: a linear chain of blocks, child → root. */
function chain(contents) {
  // contents[0] is the door block itself, the rest are ancestors nearest-first.
  const blocks = contents.map((content, i) => ({ id: `b${i}`, content }));
  return {
    getParentId: id => {
      const i = blocks.findIndex(b => b.id === id);
      return i >= 0 && i + 1 < blocks.length ? blocks[i + 1].id : null;
    },
    getBlock: id => blocks.find(b => b.id === id) ?? null,
  };
}

describe('linear:: issue matcher', () => {
  it('matches Linear-style keys', () => {
    expect('FLO-305'.match(ISSUE_RE)?.[1]).toBe('FLO-305');
    expect('# REX-12 — notes'.match(ISSUE_RE)?.[1]).toBe('REX-12');
  });

  it('rejects version-like tokens', () => {
    expect('Release v1-305 notes').not.toMatch(ISSUE_RE);
    expect('v2-1 rollout').not.toMatch(ISSUE_RE);
  });
});

describe('linear:: ancestor inference', () => {
  it('resolves the nearest ancestor issue ref', () => {
    expect(inferFromAncestors('b0', chain(['linear::', '# FLO-305', 'root']))).toBe('FLO-305');
  });

  it('skips version-like ancestors and keeps walking to the real issue', () => {
    const actions = chain(['linear::', '## Release v1-305 notes', '# FLO-305']);
    expect(inferFromAncestors('b0', actions)).toBe('FLO-305');
  });

  it('returns null when no ancestor carries an issue ref', () => {
    expect(inferFromAncestors('b0', chain(['linear::', 'notes', 'root']))).toBeNull();
  });
});

describe('linear:: arg parsing', () => {
  it('takes the explicit ID', () => {
    expect(parseArgs('linear:: FLO-305').id).toBe('FLO-305');
  });

  it('ignores `// …` comment text', () => {
    expect(parseArgs('linear:: // auto populate FLO-305').id).toBeNull();
  });

  it('tolerates and ignores leading-dash tokens', () => {
    expect(parseArgs('linear:: -v FLO-305').id).toBe('FLO-305');
    expect(parseArgs('linear:: --comments').id).toBeNull();
  });
});
