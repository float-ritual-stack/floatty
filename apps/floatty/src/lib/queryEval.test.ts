/**
 * queryEval — evaluation over a synthetic tree (brief E). PII-free fixtures:
 * `Demo …` names, `00000000-0000-4000-8000-0000000000NN` ids.
 */
import { describe, expect, it } from 'vitest';
import { buildBacklinkIndex } from './backlinkIndex';
import { collectDescendants, evaluateQuery, type QueryBlock, type QueryEvalDeps } from './queryEval';
import { parseQuery } from './queryPredicate';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const PAGES = id(1);
const PAGE_W33 = id(2);
const PAGE_HOME = id(3);
const PAGE_TODO_GLYPH = id(4); // page literally named ⬜
// a distinct leading run so `under:<short hash>` has a UNIQUE hex prefix
const BOARD = '12345678-0000-4000-8000-000000000010';
const TODO_A = id(11);
const TODO_B = id(12);
const DONE_C = id(13);
const HOME_TODO = id(14);
const QUERY = id(20);
const QUERY_CHILD = id(21);
const QUERY_GRANDCHILD = id(22);
const STRAY = id(30);

interface Spec {
  parentId: string | null;
  content: string;
  updatedAt?: number;
  createdAt?: number;
  markers?: Array<{ markerType: string; value: string | null }>;
}

function buildBlocks(specs: Record<string, Spec>): Record<string, QueryBlock> {
  const blocks: Record<string, QueryBlock> = {};
  for (const [blockId, spec] of Object.entries(specs)) {
    blocks[blockId] = {
      id: blockId,
      parentId: spec.parentId,
      childIds: [],
      content: spec.content,
      createdAt: spec.createdAt ?? NOW - 40 * DAY,
      updatedAt: spec.updatedAt ?? NOW - 40 * DAY,
      metadata: spec.markers ? { markers: spec.markers } : null,
    };
  }
  for (const block of Object.values(blocks)) {
    if (block.parentId && blocks[block.parentId]) blocks[block.parentId].childIds.push(block.id);
  }
  return blocks;
}

const blocks = buildBlocks({
  [PAGES]: { parentId: null, content: 'pages::' },
  [PAGE_W33]: { parentId: PAGES, content: '# 2026-w33' },
  [PAGE_HOME]: { parentId: PAGES, content: '# Demo Home' },
  [PAGE_TODO_GLYPH]: { parentId: PAGES, content: '# ⬜' },
  [BOARD]: { parentId: PAGE_W33, content: '**thursday board** [project::demo/catalyst]', markers: [{ markerType: 'project', value: 'demo/catalyst' }] },
  [TODO_A]: { parentId: BOARD, content: '[[⬜]] [[PC-236]] Demo Alice ships the thing', updatedAt: NOW - 2 * DAY },
  [TODO_B]: { parentId: BOARD, content: '[[⬜]] [[REX-343]] Demo Bob reviews', updatedAt: NOW - 10 * DAY, markers: [{ markerType: 'status', value: 'doing' }] },
  [DONE_C]: { parentId: BOARD, content: '[[✅]] [[⬜]] [[PC-100]] done and dusted', updatedAt: NOW - 1 * DAY },
  [HOME_TODO]: { parentId: PAGE_HOME, content: '[[⬜]] water the plants', updatedAt: NOW - 3 * DAY },
  [QUERY]: { parentId: PAGE_HOME, content: 'query:: link:⬜' },
  [QUERY_CHILD]: { parentId: QUERY, content: '[[⬜]] added under the query', updatedAt: NOW },
  [QUERY_GRANDCHILD]: { parentId: QUERY_CHILD, content: '[[⬜]] nested under the child', updatedAt: NOW },
  [STRAY]: { parentId: null, content: '[[⬜]] a root-level stray', updatedAt: NOW - 5 * DAY },
});

const backlinks = buildBacklinkIndex(blocks, [PAGES, STRAY]);

const deps: QueryEvalDeps = {
  getBlock: (blockId) => blocks[blockId],
  blocks,
  backlinks,
  pagesContainerId: PAGES,
  now: NOW,
  queryBlockId: QUERY,
};

const run = (line: string, over: Partial<QueryEvalDeps> = {}) =>
  evaluateQuery(parseQuery(line), { ...deps, ...over });

describe('collectDescendants', () => {
  it('walks the subtree, root excluded, cycle-guarded', () => {
    expect([...collectDescendants(QUERY, deps.getBlock)].sort()).toEqual([QUERY_CHILD, QUERY_GRANDCHILD].sort());
    const cyclic: Record<string, QueryBlock> = {
      a: { id: 'a', parentId: 'b', childIds: ['b'], content: '', createdAt: 0, updatedAt: 0, metadata: null },
      b: { id: 'b', parentId: 'a', childIds: ['a'], content: '', createdAt: 0, updatedAt: 0, metadata: null },
    };
    expect([...collectDescendants('a', (x) => cyclic[x])]).toEqual(['b']);
  });
});

describe('evaluateQuery — seeding + terms', () => {
  it('link: seeds from the backlink index with the index\'s own canonical key', () => {
    const result = run('query:: link:⬜');
    // newest first; the query block's own subtree is excluded
    expect(result.ids).toEqual([DONE_C, TODO_A, HOME_TODO, STRAY, TODO_B]);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('link: matches page-name targets case-insensitively via getSectionKey', () => {
    // "[[⬜]]" resolves to the page block id; querying by the page id is equivalent
    expect(run(`query:: link:${PAGE_TODO_GLYPH}`).ids).toEqual(run('query:: link:⬜').ids);
  });

  it('negated link: filters', () => {
    expect(run('query:: link:⬜ !link:✅').ids).toEqual([TODO_A, HOME_TODO, STRAY, TODO_B]);
  });

  it('link~ regex over raw outlink targets', () => {
    expect(run('query:: link~^(PC|REX)-\\d+$').ids).toEqual([DONE_C, TODO_A, TODO_B]);
    expect(run('query:: link:⬜ link~^PC-').ids).toEqual([DONE_C, TODO_A]);
  });

  it('page: exact and page~ regex resolve the nearest page', () => {
    expect(run('query:: link:⬜ page:2026-W33').ids).toEqual([DONE_C, TODO_A, TODO_B]);
    expect(run('query:: link:⬜ page~home').ids).toEqual([HOME_TODO]);
    // a root-level stray has no page → never matches a page term
    expect(run('query:: link:⬜ page~.').ids).not.toContain(STRAY);
    expect(run('query:: link:⬜ !page~.').ids).toEqual([STRAY]);
  });

  it('under: seeds from the subtree (page name, full id, or short hash)', () => {
    expect(run('query:: under:[[2026-w33]]').ids).toEqual([DONE_C, TODO_A, TODO_B, BOARD]);
    expect(run(`query:: under:${BOARD}`).ids).toEqual([DONE_C, TODO_A, TODO_B]);
    expect(run('query:: under:12345678').ids).toEqual([DONE_C, TODO_A, TODO_B]);
    expect(run('query:: link:⬜ !under:[[2026-w33]]').ids).toEqual([HOME_TODO, STRAY]);
  });

  it('under: with an unknown target is an error, not a throw', () => {
    const result = run('query:: under:[[No Such Page]]');
    expect(result.ids).toEqual([]);
    expect(result.errors).toEqual(['under: target "No Such Page" not found']);
  });

  it('since: uses updatedAt against the injected now', () => {
    expect(run('query:: link:⬜ since:4d').ids).toEqual([DONE_C, TODO_A, HOME_TODO]);
    expect(run('query:: link:⬜ !since:4d').ids).toEqual([STRAY, TODO_B]);
  });

  it('text~ tests the first line', () => {
    // whitespace splits terms — a regex spells a space as \s
    expect(run('query:: text~demo\\s(alice|bob)').ids).toEqual([TODO_A, TODO_B]);
  });

  it('marker: evaluates EFFECTIVE markers — inherited by type from the nearest ancestor', () => {
    expect(run('query:: marker:status').ids).toEqual([TODO_B]);
    expect(run('query:: marker:status:doing').ids).toEqual([TODO_B]);
    expect(run('query:: marker:status:done').ids).toEqual([]);
    // the board's [project::demo/catalyst] reaches every card beneath it
    expect(new Set(run('query:: marker:project:demo/catalyst').ids))
      .toEqual(new Set([BOARD, TODO_A, TODO_B, DONE_C]));
    // a project-scoped todo board is the composition that makes this useful
    expect(new Set(run('query:: link:⬜ marker:project:demo/catalyst').ids))
      .toEqual(new Set([TODO_A, TODO_B, DONE_C]));
  });

  it('scan fallback covers every block when no link:/under: seed exists', () => {
    expect(run('query:: text~stray').ids).toEqual([STRAY]);
  });
});

describe('evaluateQuery — exclusion, cap, degenerate input', () => {
  it('never pulls in the query block or its subtree (shown once, in place)', () => {
    const ids = run('query:: link:⬜');
    expect(ids.ids).not.toContain(QUERY);
    expect(ids.ids).not.toContain(QUERY_CHILD);
    expect(ids.ids).not.toContain(QUERY_GRANDCHILD);
    // a different query block sees this one's children as ordinary matches
    expect(run('query:: link:⬜', { queryBlockId: STRAY }).ids).toContain(QUERY_CHILD);
  });

  it('caps at limit, newest first, reporting total + truncated', () => {
    const result = run('query:: link:⬜ [limit:: 2]');
    expect(result.ids).toEqual([DONE_C, TODO_A]);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it('empty query → no rows plus a hint; non-query content → nothing', () => {
    const empty = run('query::');
    expect(empty.ids).toEqual([]);
    expect(empty.errors).toEqual(['empty query — add a term such as link:⬜']);
    expect(run('plain block')).toEqual({ ids: [], total: 0, truncated: false, errors: [] });
  });

  it('an ambiguous short-hash link: target is an error and matches nothing', () => {
    const twins = buildBlocks({
      'abcdef12-0000-4000-8000-000000000001': { parentId: null, content: 'x' },
      'abcdef12-0000-4000-8000-000000000002': { parentId: null, content: 'y' },
      src: { parentId: null, content: 'see [[abcdef12]]' },
    });
    const result = evaluateQuery(parseQuery('query:: link:abcdef12'), {
      ...deps,
      blocks: twins,
      getBlock: (blockId) => twins[blockId],
      backlinks: buildBacklinkIndex(twins),
      queryBlockId: 'q',
    });
    expect(result.ids).toEqual([]);
    expect(result.errors).toEqual(['link: target "abcdef12" is empty or ambiguous']);
  });
});
