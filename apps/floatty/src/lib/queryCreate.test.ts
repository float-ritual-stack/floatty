/**
 * queryCreate — `[create_block:: [[target]]]` resolution over a synthetic
 * tree (brief F). PII-free fixtures: `Demo …` names,
 * `00000000-0000-4000-8000-0000000000NN` ids.
 */
import { describe, expect, it } from 'vitest';
import { buildBacklinkIndex } from './backlinkIndex';
import {
  findNearestQueryBlock,
  planRedirectReveal,
  resolveCreateBlockTarget,
  resolveCreateTarget,
  type CreateRedirectBlock,
} from './queryCreate';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const PAGES = id(1);
const PAGE_HOME = id(2);
const PAGE_INBOX = id(3);
// distinct leading run so a short hash has a UNIQUE hex prefix
const SECTION = '12345678-0000-4000-8000-000000000010';
const QUERY_PAGE = id(20);
const QUERY_HASH = id(21);
const QUERY_ID = id(22);
const QUERY_MISSING = id(23);
const QUERY_BARE = id(24);
const QUERY_OUTER = id(25);
const QUERY_INNER = id(26);
const CHILD_OF_PAGE_QUERY = id(30);
const GRANDCHILD = id(31);
const CHILD_OF_INNER = id(32);
const CHILD_OF_BARE = id(33);
const PLAIN = id(40);

interface Spec { parentId: string | null; content: string }

function buildBlocks(specs: Record<string, Spec>) {
  const blocks: Record<string, CreateRedirectBlock & { childIds: string[]; createdAt: number }> = {};
  for (const [blockId, spec] of Object.entries(specs)) {
    blocks[blockId] = { id: blockId, parentId: spec.parentId, content: spec.content, childIds: [], createdAt: 1 };
  }
  for (const block of Object.values(blocks)) {
    if (block.parentId && blocks[block.parentId]) blocks[block.parentId].childIds.push(block.id);
  }
  return blocks;
}

const blocks = buildBlocks({
  [PAGES]: { parentId: null, content: 'pages::' },
  [PAGE_HOME]: { parentId: PAGES, content: '# Demo Home' },
  [PAGE_INBOX]: { parentId: PAGES, content: '# Demo Inbox' },
  [SECTION]: { parentId: PAGE_INBOX, content: '## later' },
  [QUERY_PAGE]: { parentId: PAGE_HOME, content: 'query:: link:⬜ [create_block:: [[Demo Inbox]]]' },
  [CHILD_OF_PAGE_QUERY]: { parentId: QUERY_PAGE, content: '[[⬜]] a real child' },
  [GRANDCHILD]: { parentId: CHILD_OF_PAGE_QUERY, content: 'deeper' },
  [QUERY_HASH]: { parentId: PAGE_HOME, content: 'query:: link:🟨 [create_block:: [[12345678]]]' },
  [QUERY_ID]: { parentId: PAGE_HOME, content: `query:: link:✅ [create_block:: ${SECTION}]` },
  [QUERY_MISSING]: { parentId: PAGE_HOME, content: 'query:: link:⬜ [create_block:: [[Demo Nowhere]]]' },
  [QUERY_BARE]: { parentId: PAGE_HOME, content: 'query:: link:⬜' },
  [CHILD_OF_BARE]: { parentId: QUERY_BARE, content: 'home is the query itself' },
  [QUERY_OUTER]: { parentId: PAGE_HOME, content: 'query:: link:⬜ [create_block:: [[Demo Inbox]]]' },
  [QUERY_INNER]: { parentId: QUERY_OUTER, content: 'query:: link:🟨' },
  [CHILD_OF_INNER]: { parentId: QUERY_INNER, content: 'under the inner query' },
  [PLAIN]: { parentId: PAGE_HOME, content: 'no query above me' },
});

const index = buildBacklinkIndex(blocks, [PAGES]);
const deps = {
  getBlock: (blockId: string) => blocks[blockId],
  canonicalTargetKey: (raw: string) => index.canonicalTargetKey(raw),
};

describe('findNearestQueryBlock', () => {
  it('returns the block itself when it is the query', () => {
    expect(findNearestQueryBlock(QUERY_PAGE, deps.getBlock)?.id).toBe(QUERY_PAGE);
  });

  it('walks up from a grandchild to the query', () => {
    expect(findNearestQueryBlock(GRANDCHILD, deps.getBlock)?.id).toBe(QUERY_PAGE);
  });

  it('is null without a query ancestor, and on a broken chain', () => {
    expect(findNearestQueryBlock(PLAIN, deps.getBlock)).toBeNull();
    expect(findNearestQueryBlock('missing-id', deps.getBlock)).toBeNull();
  });

  it('survives a parent cycle', () => {
    const cyclic: Record<string, CreateRedirectBlock> = {
      a: { id: 'a', parentId: 'b', content: 'a' },
      b: { id: 'b', parentId: 'a', content: 'b' },
    };
    expect(findNearestQueryBlock('a', (blockId) => cyclic[blockId])).toBeNull();
  });
});

describe('resolveCreateBlockTarget', () => {
  it('resolves a page name, a short hash, and a full id to existing blocks', () => {
    expect(resolveCreateBlockTarget('Demo Inbox', deps)).toBe(PAGE_INBOX);
    expect(resolveCreateBlockTarget('12345678', deps)).toBe(SECTION);
    expect(resolveCreateBlockTarget(SECTION, deps)).toBe(SECTION);
  });

  it('never resolves an unknown page name — nothing is created from a read', () => {
    expect(resolveCreateBlockTarget('Demo Nowhere', deps)).toBeNull();
    expect(resolveCreateBlockTarget('', deps)).toBeNull();
    expect(resolveCreateBlockTarget('   ', deps)).toBeNull();
  });

  it('rejects an ambiguous hex prefix', () => {
    // every synthetic id shares the 00000000 run → ambiguous
    expect(resolveCreateBlockTarget('00000000', deps)).toBeNull();
  });
});

describe('resolveCreateTarget', () => {
  it('resolves through the page-name ladder from the query line itself', () => {
    expect(resolveCreateTarget(QUERY_PAGE, deps)).toEqual({
      queryBlockId: QUERY_PAGE, target: 'Demo Inbox', targetId: PAGE_INBOX,
    });
  });

  it('resolves from a real child (and grandchild) of the query', () => {
    expect(resolveCreateTarget(CHILD_OF_PAGE_QUERY, deps)?.targetId).toBe(PAGE_INBOX);
    expect(resolveCreateTarget(GRANDCHILD, deps)?.targetId).toBe(PAGE_INBOX);
  });

  it('resolves a short hash and a bare id target', () => {
    expect(resolveCreateTarget(QUERY_HASH, deps)?.targetId).toBe(SECTION);
    expect(resolveCreateTarget(QUERY_ID, deps)?.targetId).toBe(SECTION);
  });

  it('unresolvable target → redirect with null targetId (caller creates in place)', () => {
    expect(resolveCreateTarget(QUERY_MISSING, deps)).toEqual({
      queryBlockId: QUERY_MISSING, target: 'Demo Nowhere', targetId: null,
    });
  });

  it('no query ancestor → null; query without create_block → null', () => {
    expect(resolveCreateTarget(PLAIN, deps)).toBeNull();
    expect(resolveCreateTarget(QUERY_BARE, deps)).toBeNull();
    expect(resolveCreateTarget(CHILD_OF_BARE, deps)).toBeNull();
  });

  it('nested query blocks → the NEAREST wins, even without its own create_block', () => {
    expect(resolveCreateTarget(CHILD_OF_INNER, deps)).toBeNull();
    expect(resolveCreateTarget(QUERY_INNER, deps)).toBeNull();
    expect(resolveCreateTarget(QUERY_OUTER, deps)?.targetId).toBe(PAGE_INBOX);
  });
});

describe('planRedirectReveal', () => {
  it('inside the zoom scope: expand the chain (target-first, stops before the root)', () => {
    expect(planRedirectReveal(GRANDCHILD, PAGE_HOME, deps.getBlock)).toEqual({
      kind: 'expand', ancestors: [CHILD_OF_PAGE_QUERY, QUERY_PAGE],
    });
  });

  it('no zoom at all: expand the whole chain', () => {
    expect(planRedirectReveal(GRANDCHILD, null, deps.getBlock)).toEqual({
      kind: 'expand', ancestors: [CHILD_OF_PAGE_QUERY, QUERY_PAGE, PAGE_HOME, PAGES],
    });
  });

  it('outside the zoom scope: hand off to the navigation funnel', () => {
    expect(planRedirectReveal(SECTION, PAGE_HOME, deps.getBlock)).toEqual({ kind: 'navigate' });
  });

  it('a direct child of the zoom root needs no expansion', () => {
    expect(planRedirectReveal(SECTION, PAGE_INBOX, deps.getBlock)).toEqual({ kind: 'expand', ancestors: [] });
  });
});
