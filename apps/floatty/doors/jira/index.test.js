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
    expect(parseArgs('jira:: sfc-42')).toEqual({ keys: ['SFC-42'], comments: false, invalidArg: null });
  });

  it('accepts MULTIPLE keys, deduped in order', () => {
    expect(parseArgs('jira:: PC-333 PC-444 pc-333').keys).toEqual(['PC-333', 'PC-444']);
  });

  it('accepts digit-bearing project keys (wider than linear grammar)', () => {
    expect(parseArgs('jira:: P2X-9')).toEqual({ keys: ['P2X-9'], comments: false, invalidArg: null });
  });

  it('parses --comments and -c', () => {
    expect(parseArgs('jira:: SFC-42 --comments').comments).toBe(true);
    expect(parseArgs('jira:: SFC-42 -c').comments).toBe(true);
  });

  it('strips // comments so prose never hijacks the key', () => {
    expect(parseArgs('jira:: // grab ABC-123 later')).toEqual({ keys: [], comments: false, invalidArg: null });
    expect(parseArgs('jira:: SFC-42 // the assessment ticket').keys).toEqual(['SFC-42']);
  });

  it('rejects malformed tokens as errors, not inference licences', () => {
    expect(parseArgs('jira:: notakey').invalidArg).toBe('notakey');
    expect(parseArgs('jira:: 12-34').invalidArg).toBe('12-34');
  });

  it('bare invocation yields no keys and no error', () => {
    expect(parseArgs('jira::')).toEqual({ keys: [], comments: false, invalidArg: null });
  });
});

describe('jira:: inferFromAncestors', () => {
  it('nearest ancestor with a key wins', () => {
    const actions = chain(['jira::', 'notes about SFC-42', '# ABC-1 page']);
    expect(inferFromAncestors('b0', actions)).toEqual(['SFC-42']);
  });

  it('a multi-ref ancestor contributes ALL its keys, deduped', () => {
    const actions = chain(['jira::', 'see [[PC-333]] and [[PC-444]] (PC-333 again)', '# other']);
    expect(inferFromAncestors('b0', actions)).toEqual(['PC-333', 'PC-444']);
  });

  it('inference grammar is letters-only — version-like text does not match', () => {
    expect('Release v1-305 notes'.match(ISSUE_RE)).toBeNull();
    const actions = chain(['jira::', 'Release v1-305 notes']);
    expect(inferFromAncestors('b0', actions)).toEqual([]);
  });

  it('explicit-arg grammar is wider than inference grammar', () => {
    expect(KEY_RE.test('P2X-9')).toBe(true);
    expect('something P2X-9 inline'.match(ISSUE_RE)).toBeNull();
  });

  it('returns empty when no ancestor matches', () => {
    expect(inferFromAncestors('b0', chain(['jira::', 'plain', 'also plain']))).toEqual([]);
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

describe('jira:: header cards', () => {
  it('statusVisual maps jira statusCategory keys', async () => {
    const { statusVisual } = await import('./index.js');
    expect(statusVisual('done', 'Done').color).toBe('green');
    expect(statusVisual('indeterminate', 'In Progress').color).toBe('amber');
    expect(statusVisual('new', 'To Do').color).toBe('cyan');
    expect(statusVisual(undefined, 'Resolved').color).toBe('green');
  });

  it('buildHeaderSpec emits a valid Card+Row+Chip+WikilinkChip shape', async () => {
    const { buildHeaderSpec } = await import('./index.js');
    const spec = buildHeaderSpec({ key: 'PC-510', summary: 'fix triggers', status: 'In Progress', color: 'amber', kind: 'Story', assignee: 'Sumit', prio: 'High', updated: '2026-08-18 12:00' });
    expect(spec.root).toBe('r');
    expect(spec.elements.r.type).toBe('Card');
    expect(spec.elements.st).toEqual({ type: 'Chip', props: { label: 'In Progress', color: 'amber', icon: 'circle-dot' } });
    expect(spec.elements.lnk.props.target).toBe('PC-510');
    expect(spec.elements.row.children).toContain('prio');
  });

  it('findExistingHeader locates a header child by key', async () => {
    const { findExistingHeader } = await import('./index.js');
    const actions = {
      getChildren: () => ['c1', 'c2'],
      getBlock: id => (id === 'c2' ? { id, content: '🟡 [[PC-510]] — fix' } : { id, content: 'other' }),
    };
    expect(findExistingHeader('root', 'PC-510', actions)).toBe('c2');
    expect(findExistingHeader('root', 'PC-999', actions)).toBeNull();
  });
});

describe('jira:: review-round hardening', () => {
  it('inference excludes PR-NNN (sibling doors own that grammar)', async () => {
    const { inferFromAncestors } = await import('./index.js');
    const actions = chain(['jira::', 'shipped [[PR-397]] against [[PC-510]]']);
    expect(inferFromAncestors('b0', actions)).toEqual(['PC-510']);
  });

  it('inference survives cyclic parent data and >20-deep chains', async () => {
    const { inferFromAncestors } = await import('./index.js');
    const cyclic = {
      getParentId: id => (id === 'b0' ? 'b1' : 'b0'),
      getBlock: () => ({ content: 'no keys here' }),
    };
    expect(inferFromAncestors('b0', cyclic)).toEqual([]);
    const deep = chain(['jira::', ...Array(24).fill('plain'), 'the [[PC-42]] page']);
    expect(inferFromAncestors('b0', deep)).toEqual(['PC-42']);
  });
});

describe('jira:: findExistingHeader clobber guard', () => {
  it('matches only door-output headers, never user notes mentioning the key', async () => {
    const { findExistingHeader } = await import('./index.js');
    const actions = {
      getChildren: () => ['note', 'hdr'],
      getBlock: id => id === 'note'
        ? { id, content: 'my notes on [[PC-510]] — do not clobber', outputType: undefined }
        : { id, content: '🟡 [[PC-510]] — fix', outputType: 'door' },
    };
    expect(findExistingHeader('root', 'PC-510', actions)).toBe('hdr');
    const onlyNote = { getChildren: () => ['note'], getBlock: () => ({ content: 'about [[PC-510]]' }) };
    expect(findExistingHeader('root', 'PC-510', onlyNote)).toBeNull();
  });
});
