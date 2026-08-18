import { describe, expect, it } from 'vitest';

import { inferFromAncestors, parseArgs } from './index.js';

/** Minimal `actions` stub: a linear chain of blocks, child → root. */
function chain(contents) {
  const blocks = contents.map((content, i) => ({ id: `b${i}`, content }));
  return {
    getParentId: id => {
      const i = blocks.findIndex(b => b.id === id);
      return i >= 0 && i + 1 < blocks.length ? blocks[i + 1].id : null;
    },
    getBlock: id => blocks.find(b => b.id === id) ?? null,
  };
}

describe('floatty-pr:: parseArgs', () => {
  it('accepts bare, #-prefixed, PR-dash, and two-token forms', () => {
    expect(parseArgs('floatty-pr:: 387').numbers).toEqual(['387']);
    expect(parseArgs('floatty-pr:: #387').numbers).toEqual(['387']);
    expect(parseArgs('floatty-pr:: PR-387').numbers).toEqual(['387']);
    expect(parseArgs('floatty-pr:: PR #387').numbers).toEqual(['387']);
  });

  it('accepts MULTIPLE numbers, deduped in order', () => {
    expect(parseArgs('floatty-pr:: 387 392 PR-395 #387').numbers).toEqual(['387', '392', '395']);
  });

  it('parses --comments and -c', () => {
    expect(parseArgs('floatty-pr:: 387 --comments')).toEqual({ numbers: ['387'], comments: true });
    expect(parseArgs('floatty-pr:: -c PR-387')).toEqual({ numbers: ['387'], comments: true });
  });

  it('strips // comments so prose digits never hijack the number', () => {
    expect(parseArgs('floatty-pr:: // auto populate 387?').numbers).toEqual([]);
    expect(parseArgs('floatty-pr:: 387 // the probe PR').numbers).toEqual(['387']);
  });
});

describe('floatty-pr:: inferFromAncestors', () => {
  it('matches "PR #NNN" and "PR-NNN", nearest ancestor wins', () => {
    expect(inferFromAncestors('b0', chain(['floatty-pr::', 'notes on PR-395', '# PR #387 page']))).toEqual(['395']);
    expect(inferFromAncestors('b0', chain(['floatty-pr::', 'plain', '# PR #387 page']))).toEqual(['387']);
  });

  it('a multi-ref ancestor contributes ALL its numbers', () => {
    expect(inferFromAncestors('b0', chain(['floatty-pr::', 'shipped [[PR-123]] and [[PR #5555]] today']))).toEqual(['123', '5555']);
  });

  it('stays strict — bare "PR 12" and stray "#386" do not match', () => {
    expect(inferFromAncestors('b0', chain(['floatty-pr::', 'PR 12 things to review']))).toEqual([]);
    expect(inferFromAncestors('b0', chain(['floatty-pr::', 'see #386 for context']))).toEqual([]);
  });

  it('returns empty when no ancestor matches', () => {
    expect(inferFromAncestors('b0', chain(['floatty-pr::', 'plain', 'also plain']))).toEqual([]);
  });
});
