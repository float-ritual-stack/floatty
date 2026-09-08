/**
 * U3a row-model/facet/filter/sort tests — synthetic PII-free fixtures.
 * Fixture outline:
 *   pages-root (`pages::`)
 *     └── page-w37 ("# Demo Week")
 *           └── section-a ("## standup notes")
 *                 └── src-deep ("touched [[Demo Hub]] again [project::demo]")
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_REF_FILTER,
  applyRefFilter,
  buildFacetChips,
  buildRowModel,
  clearFacets,
  crumbLabel,
  elideChain,
  formatAge,
  midTruncate,
  sortRows,
  stripWikilinkBrackets,
  toggleFacet,
  type BacklinkRowModel,
  type RowDeps,
} from './backlinkRows';

const PAGES = 'pages-root';

type FixtureBlock = NonNullable<ReturnType<RowDeps['getBlock']>>;

const fixture: Record<string, FixtureBlock> = {
  [PAGES]: { id: PAGES, parentId: null, childIds: ['page-w37'], content: 'pages::', createdAt: 1, updatedAt: 1, metadata: null },
  'page-w37': { id: 'page-w37', parentId: PAGES, childIds: ['section-a'], content: '# Demo Week', createdAt: 2, updatedAt: 2, metadata: null },
  'section-a': { id: 'section-a', parentId: 'page-w37', childIds: ['src-deep'], content: '## standup notes', createdAt: 3, updatedAt: 3, metadata: null },
  'src-deep': {
    id: 'src-deep', parentId: 'section-a', childIds: [], createdAt: 10, updatedAt: 100,
    content: 'touched [[Demo Hub]] again [project::demo]',
    metadata: {
      markers: [{ markerType: 'project', value: 'demo' }],
      outlinks: ['Demo Hub'],
    },
  },
};

const deps: RowDeps = {
  getBlock: (id) => fixture[id] ?? null,
  pagesContainerId: PAGES,
};

describe('label helpers (D9)', () => {
  it('strips wikilink brackets at the label layer, alias keeps alias text', () => {
    expect(stripWikilinkBrackets('see [[Demo Hub]] and [[Long Page|short]]')).toBe('see Demo Hub and short');
    expect(stripWikilinkBrackets('[[outer [[inner]]]]')).toBe('outer inner');
  });

  it('middle-truncates prose keeping identity front', () => {
    const out = midTruncate('a-very-long-identity-with-disambiguating-tail-end', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toContain('…');
    expect(out.startsWith('a-very-long-')).toBe(true);
    expect(out.endsWith('end')).toBe(true);
  });

  it('hashes are exempt from truncation', () => {
    const hash = 'c78a47bb-baa6-426d-b062-5101faa1060b';
    expect(midTruncate(hash, 12)).toBe(hash);
  });

  it('crumbLabel strips heading markers and brackets before truncating', () => {
    expect(crumbLabel('## ok evan, what was I doing on [[2026-09-08]]')).toBe(
      midTruncate('ok evan, what was I doing on 2026-09-08', 28),
    );
  });

  it('elideChain drops INTERIOR levels, keeping root and leaf-adjacent tail', () => {
    expect(elideChain(['a', 'b', 'c', 'd', 'e'], 3)).toEqual(['a', '⋯', 'd', 'e']);
    expect(elideChain(['a', 'b'], 3)).toEqual(['a', 'b']);
  });
});

describe('formatAge', () => {
  it('buckets compactly', () => {
    expect(formatAge(10_000)).toBe('now');
    expect(formatAge(5 * 60_000)).toBe('5m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(2 * 86_400_000)).toBe('2d');
    expect(formatAge(400 * 86_400_000)).toBe('1y');
  });
});

describe('buildRowModel', () => {
  it('builds crumb rootmost-first, resolves page name, extracts facets', () => {
    const row = buildRowModel('src-deep', deps, 1_000_100);
    expect(row).not.toBeNull();
    expect(row!.crumb).toEqual(['Demo Week', 'standup notes']);
    expect(row!.pageName).toBe('Demo Week');
    expect(row!.kind).toBe('content_block');
    expect([...row!.facetKeys].sort()).toEqual([
      'link::Demo Hub',
      'marker::project::demo',
      'page::Demo Week',
    ]);
  });

  it('returns null for a missing source', () => {
    expect(buildRowModel('ghost', deps)).toBeNull();
  });

  it('survives a parent cycle', () => {
    const cyclic: RowDeps = {
      pagesContainerId: null,
      getBlock: (id) => ({
        a: { id: 'a', parentId: 'b', childIds: [], content: 'a', createdAt: 0, updatedAt: 0, metadata: null },
        b: { id: 'b', parentId: 'a', childIds: [], content: 'b', createdAt: 0, updatedAt: 0, metadata: null },
      } as Record<string, FixtureBlock>)[id] ?? null,
    };
    expect(buildRowModel('a', cyclic)).not.toBeNull();
  });
});

function row(id: string, over: Partial<BacklinkRowModel> = {}): BacklinkRowModel {
  return {
    id,
    kind: 'content_block',
    contentLine: `content of ${id}`,
    crumb: [],
    age: 'now',
    updatedAt: 0,
    createdAt: 0,
    pageName: null,
    facetKeys: new Set<string>(),
    ...over,
  };
}

describe('facets (D7 — ported semantics)', () => {
  const rows = [
    row('r1', { facetKeys: new Set(['page::A', 'marker::project::x']) }),
    row('r2', { facetKeys: new Set(['page::A', 'link::T']) }),
    row('r3', { facetKeys: new Set(['page::B']) }),
  ];

  it('counts over the unfiltered set, sorted count-desc then label', () => {
    const chips = buildFacetChips(rows);
    expect(chips[0]).toMatchObject({ key: 'page::A', kind: 'page', count: 2 });
    expect(chips.map((c) => c.key)).toContain('marker::project::x');
    expect(chips.find((c) => c.key === 'marker::project::x')?.label).toBe('project::x');
  });

  it('includes AND together; excludes subtract', () => {
    let filter = toggleFacet(DEFAULT_REF_FILTER, 'page::A', false);
    expect(applyRefFilter(rows, filter).map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    filter = toggleFacet(filter, 'link::T', false);
    expect(applyRefFilter(rows, filter).map((r) => r.id)).toEqual(['r2']);
    filter = toggleFacet(clearFacets(filter), 'page::A', true);
    expect(applyRefFilter(rows, filter).map((r) => r.id)).toEqual(['r3']);
  });

  it('toggle interplay: include clears exclude on the same key, and vice versa', () => {
    let filter = toggleFacet(DEFAULT_REF_FILTER, 'page::A', true);
    expect(filter.removes.has('page::A')).toBe(true);
    filter = toggleFacet(filter, 'page::A', false);
    expect(filter.includes.has('page::A')).toBe(true);
    expect(filter.removes.has('page::A')).toBe(false);
    // clicking an active include clears it
    filter = toggleFacet(filter, 'page::A', false);
    expect(filter.includes.size).toBe(0);
  });
});

describe('search + sorts (D10c)', () => {
  const rows = [
    row('old', { contentLine: 'alpha thing', updatedAt: 100, createdAt: 300, pageName: 'B' }),
    row('new', { contentLine: 'beta thing', updatedAt: 300, createdAt: 100, pageName: 'A' }),
    row('mid', { contentLine: 'gamma thing', updatedAt: 200, createdAt: 200, pageName: 'A' }),
  ];

  it('free-text search matches content, page, and crumb', () => {
    const byContent = applyRefFilter(rows, { ...DEFAULT_REF_FILTER, search: 'beta' });
    expect(byContent.map((r) => r.id)).toEqual(['new']);
    const byPage = applyRefFilter(rows, { ...DEFAULT_REF_FILTER, search: 'b' });
    expect(byPage.map((r) => r.id)).toContain('old');
  });

  it('updated sort defaults newest-first; asc flips it', () => {
    expect(sortRows([...rows], 'updated', false).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect(sortRows([...rows], 'updated', true).map((r) => r.id)).toEqual(['old', 'mid', 'new']);
  });

  it('created sort flips the primary only — updatedAt tiebreak never flips', () => {
    const tied = [
      row('t1', { createdAt: 50, updatedAt: 10 }),
      row('t2', { createdAt: 50, updatedAt: 90 }),
      row('t3', { createdAt: 70, updatedAt: 5 }),
    ];
    // desc: t3 (created 70) first; tie between t1/t2 broken by updatedAt DESC
    expect(sortRows([...tied], 'created', false).map((r) => r.id)).toEqual(['t3', 't2', 't1']);
    // asc: primary flips (t1/t2 tie first), tiebreak STILL updatedAt desc
    expect(sortRows([...tied], 'created', true).map((r) => r.id)).toEqual(['t2', 't1', 't3']);
  });

  it('page sort groups alphabetically with recency tiebreak', () => {
    expect(sortRows([...rows], 'page', true).map((r) => r.pageName)).toEqual(['A', 'A', 'B']);
    expect(sortRows([...rows], 'page', true).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });
});
