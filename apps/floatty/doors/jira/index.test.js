import { describe, expect, it } from 'vitest';

import {
  ISSUE_RE, KEY_RE, adfToText, bodyToText, inferFromAncestors, parseArgs, safeEmail, safeSite,
} from './index.js';

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

describe('jira:: parseArgs', () => {
  it('accepts a plain key and uppercases it', () => {
    expect(parseArgs('jira:: sfc-42')).toEqual({ key: 'SFC-42', comments: false, invalidArg: null });
  });

  it('accepts digit-bearing project keys (wider than linear grammar)', () => {
    expect(parseArgs('jira:: P2X-9')).toEqual({ key: 'P2X-9', comments: false, invalidArg: null });
  });

  it('parses --comments and -c', () => {
    expect(parseArgs('jira:: SFC-42 --comments').comments).toBe(true);
    expect(parseArgs('jira:: SFC-42 -c').comments).toBe(true);
  });

  it('strips // comments so prose never hijacks the key', () => {
    expect(parseArgs('jira:: // grab ABC-123 later')).toEqual({ key: null, comments: false, invalidArg: null });
    expect(parseArgs('jira:: SFC-42 // the assessment ticket').key).toBe('SFC-42');
  });

  it('rejects malformed tokens as errors, not inference licences', () => {
    expect(parseArgs('jira:: notakey').invalidArg).toBe('notakey');
    expect(parseArgs('jira:: 12-34').invalidArg).toBe('12-34');
  });

  it('bare invocation yields no key and no error', () => {
    expect(parseArgs('jira::')).toEqual({ key: null, comments: false, invalidArg: null });
  });
});

describe('jira:: inferFromAncestors', () => {
  it('nearest ancestor with a key wins', () => {
    const actions = chain(['jira::', 'notes about SFC-42', '# ABC-1 page']);
    expect(inferFromAncestors('b0', actions)).toBe('SFC-42');
  });

  it('inference grammar is letters-only — version-like text does not match', () => {
    expect('Release v1-305 notes'.match(ISSUE_RE)).toBeNull();
    const actions = chain(['jira::', 'Release v1-305 notes']);
    expect(inferFromAncestors('b0', actions)).toBeNull();
  });

  it('explicit-arg grammar is wider than inference grammar', () => {
    expect(KEY_RE.test('P2X-9')).toBe(true);
    expect('something P2X-9 inline'.match(ISSUE_RE)).toBeNull();
  });

  it('returns null when no ancestor matches', () => {
    expect(inferFromAncestors('b0', chain(['jira::', 'plain', 'also plain']))).toBeNull();
  });
});

describe('jira:: adf flattening', () => {
  it('passes strings through', () => {
    expect(bodyToText('plain wiki text')).toBe('plain wiki text');
  });

  it('flattens paragraphs, headings, lists, and code', () => {
    const adf = {
      type: 'doc', content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        ] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] },
      ],
    };
    const out = bodyToText(adf);
    expect(out).toContain('## Title');
    expect(out).toContain('hello world');
    expect(out).toContain('- one');
    expect(out).toContain('```\nx = 1\n```');
  });

  it('unknown node types degrade to their children, never throw', () => {
    expect(adfToText({ type: 'mysteryPanel', content: [{ type: 'text', text: 'inner' }] })).toBe('inner');
  });
});

describe('jira:: settings sanitizers', () => {
  it('safeSite accepts https origins and strips trailing slashes', () => {
    expect(safeSite('https://rangle.atlassian.net/')).toBe('https://rangle.atlassian.net');
    expect(safeSite('http://insecure.example.com')).toBeNull();
    expect(safeSite('https://x.net; rm -rf /')).toBeNull();
  });

  it('safeEmail rejects shell metacharacters', () => {
    expect(safeEmail('evan@example.com')).toBe('evan@example.com');
    expect(safeEmail('evan"$(x)"@example.com')).toBeNull();
    expect(safeEmail('not-an-email')).toBeNull();
  });
});
