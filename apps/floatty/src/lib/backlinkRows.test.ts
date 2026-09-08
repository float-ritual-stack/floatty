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
  DEFAULT_RING,
  applyRefFilter,
  buildFacetChips,
  buildRowModel,
  buildSlice,
  clearFacets,
  crumbEntries,
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

  it('keeps canonical ancestor labels for facet identity and search', () => {
    const longPage = 'A very long shared page name with unique ending alpha';
    const longSection = 'A very long section name with searchable omega in the middle and a unique ending';
    const longFixture: Record<string, FixtureBlock> = {
      root: { id: 'root', parentId: null, childIds: ['page'], content: 'pages::', createdAt: 1, updatedAt: 1, metadata: null },
      page: { id: 'page', parentId: 'root', childIds: ['section'], content: `# ${longPage}`, createdAt: 2, updatedAt: 2, metadata: null },
      section: { id: 'section', parentId: 'page', childIds: ['source'], content: longSection, createdAt: 3, updatedAt: 3, metadata: null },
      source: { id: 'source', parentId: 'section', childIds: [], content: 'source', createdAt: 4, updatedAt: 4, metadata: null },
    };
    const row = buildRowModel('source', {
      pagesContainerId: 'root',
      getBlock: (id) => longFixture[id] ?? null,
    });

    expect(row!.pageName).toBe(longPage);
    expect(row!.facetKeys.has(`page::${longPage}`)).toBe(true);
    expect(row!.crumb[1]).not.toContain('omega');
    expect(applyRefFilter([row!], { ...DEFAULT_REF_FILTER, search: 'omega' })).toEqual([row]);
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
    chain: [],
    childPreview: null,
    childCount: 0,
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

describe('U3b — slice + crumb entries + child preview', () => {
  const sliceFixture: Record<string, FixtureBlock> = {
    root: { id: 'root', parentId: null, childIds: ['mid'], content: '# Root Page', createdAt: 0, updatedAt: 0, metadata: null },
    mid: { id: 'mid', parentId: 'root', childIds: ['leaf'], content: '## Mid Section', createdAt: 0, updatedAt: 0, metadata: null },
    leaf: {
      id: 'leaf', parentId: 'mid', childIds: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'],
      content: 'the source block\nsecond line', createdAt: 0, updatedAt: 0, metadata: null,
    },
    k1: { id: 'k1', parentId: 'leaf', childIds: [], content: 'child one payload', createdAt: 0, updatedAt: 0, metadata: null },
    k2: { id: 'k2', parentId: 'leaf', childIds: [], content: 'child two', createdAt: 0, updatedAt: 0, metadata: null },
    k3: { id: 'k3', parentId: 'leaf', childIds: [], content: 'child three', createdAt: 0, updatedAt: 0, metadata: null },
    k4: { id: 'k4', parentId: 'leaf', childIds: [], content: 'child four', createdAt: 0, updatedAt: 0, metadata: null },
    k5: { id: 'k5', parentId: 'leaf', childIds: [], content: 'child five', createdAt: 0, updatedAt: 0, metadata: null },
    k6: { id: 'k6', parentId: 'leaf', childIds: [], content: 'child six', createdAt: 0, updatedAt: 0, metadata: null },
  };
  const sliceDeps: RowDeps = { getBlock: (id) => sliceFixture[id] ?? null, pagesContainerId: null };
  const chain = [
    { id: 'root', label: 'Root Page' },
    { id: 'mid', label: 'Mid Section' },
  ];

  it('row model carries the full chain, first-child preview, and child count', () => {
    const row = buildRowModel('leaf', sliceDeps);
    expect(row!.chain).toEqual(chain);
    expect(row!.childPreview).toBe('child one payload');
    expect(row!.childCount).toBe(6);
  });

  it('DEFAULT_RING slice = immediate parent + source + capped children (D4)', () => {
    const slice = buildSlice({ id: 'leaf', chain }, DEFAULT_RING, sliceDeps);
    expect(slice.rootLabel).toBe('Mid Section');
    expect(slice.lines.map((l) => l.role)).toEqual([
      'ancestor', 'source', 'child', 'child', 'child', 'child',
    ]);
    expect(slice.lines[1].text).toContain('the source block');
    expect(slice.lines[1].depth).toBe(1);
    expect(slice.moreChildren).toBe(2); // 6 children, cap 4
  });

  it('ring re-roots the slice at that ancestor index (D8)', () => {
    const slice = buildSlice({ id: 'leaf', chain }, 0, sliceDeps);
    expect(slice.rootLabel).toBe('Root Page');
    expect(slice.lines.filter((l) => l.role === 'ancestor')).toHaveLength(2);
    expect(slice.lines[0].text).toBe('# Root Page');
  });

  it('crumbEntries preserves ring indices through elision', () => {
    const longChain = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, label: id.toUpperCase() }));
    const entries = crumbEntries(longChain);
    expect(entries).toHaveLength(5); // root + gap + last 3
    expect(entries[0]).toMatchObject({ index: 0 });
    expect(entries[1]).toMatchObject({ gap: true });
    expect(entries[2]).toMatchObject({ index: 3 });
    expect(entries[4]).toMatchObject({ index: 5 });
    // short chains pass through untouched
    expect(crumbEntries(chain)).toHaveLength(2);
  });
});
