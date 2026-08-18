import { describe, expect, it } from 'vitest';

import { inferFromAncestors, parseArgs, refShort, safeOrg, safeProject } from './index.js';

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

describe('az-pr:: parseArgs', () => {
  it('accepts bare, #-prefixed, and ADO !-prefixed numbers', () => {
    expect(parseArgs('az-pr:: 943').number).toBe('943');
    expect(parseArgs('az-pr:: #943').number).toBe('943');
    expect(parseArgs('az-pr:: !943').number).toBe('943');
  });

  it('accepts "PR 943" two-token form', () => {
    expect(parseArgs('az-pr:: PR !943').number).toBe('943');
  });

  it('parses --comments and -c without eating the number', () => {
    expect(parseArgs('az-pr:: 943 --comments')).toEqual({ number: '943', comments: true });
    expect(parseArgs('az-pr:: -c !943')).toEqual({ number: '943', comments: true });
  });

  it('strips // comments so prose digits never hijack the number', () => {
    expect(parseArgs('az-pr:: // grab 943 later').number).toBeNull();
    expect(parseArgs('az-pr:: 943 // the rollout fix').number).toBe('943');
  });

  it('bare invocation yields no number', () => {
    expect(parseArgs('az-pr::')).toEqual({ number: null, comments: false });
  });
});

describe('az-pr:: inferFromAncestors', () => {
  it('matches "PR #NNN" and bare "!NNN", nearest ancestor wins', () => {
    expect(inferFromAncestors('b0', chain(['az-pr::', 'shipping !942 today', '# PR #900 page']))).toBe('942');
    expect(inferFromAncestors('b0', chain(['az-pr::', 'no refs here', '# PR #900 page']))).toBe('900');
  });

  it('a stray issue-style "#386" in prose does not match', () => {
    expect(inferFromAncestors('b0', chain(['az-pr::', 'see #386 for context']))).toBeNull();
  });

  it('returns null when no ancestor matches', () => {
    expect(inferFromAncestors('b0', chain(['az-pr::', 'plain', 'also plain']))).toBeNull();
  });
});

describe('az-pr:: sanitizers + helpers', () => {
  it('safeOrg accepts dev.azure.com orgs only, strips trailing slash', () => {
    expect(safeOrg('https://dev.azure.com/RexallCatalyst/')).toBe('https://dev.azure.com/RexallCatalyst');
    expect(safeOrg('https://evil.example.com/RexallCatalyst')).toBeNull();
    expect(safeOrg('https://dev.azure.com/x; rm -rf /')).toBeNull();
  });

  it('safeProject allows spaces but rejects shell metacharacters', () => {
    expect(safeProject('Catalyst')).toBe('Catalyst');
    expect(safeProject('My Project 2')).toBe('My Project 2');
    expect(safeProject('x"$(boom)"')).toBeNull();
  });

  it('refShort strips refs/heads/', () => {
    expect(refShort('refs/heads/fix/config-rollout-triggers')).toBe('fix/config-rollout-triggers');
    expect(refShort('dev')).toBe('dev');
  });
});
