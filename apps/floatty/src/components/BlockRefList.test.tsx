/**
 * BlockRefList (U3a) component tests — synthetic PII-free fixtures.
 * Pure row/facet/sort logic lives in backlinkRows.test.ts; these cover the
 * component wiring: facet click filtering, navigate affordance, empty
 * states, and the always-present zero-source group.
 */
import { render, fireEvent } from '@solidjs/testing-library';
import { describe, it, expect, vi } from 'vitest';
import { BlockRefList } from './BlockRefList';
import type { BacklinkGroup } from '../lib/backlinkScope';
import type { RowDeps } from '../lib/backlinkRows';

type FixtureBlock = NonNullable<ReturnType<RowDeps['getBlock']>>;

const PAGES = 'pages-root';
const blocks: Record<string, FixtureBlock> = {
  [PAGES]: { id: PAGES, parentId: null, childIds: [], content: 'pages::', createdAt: 0, updatedAt: 0, metadata: null },
  'page-a': { id: 'page-a', parentId: PAGES, childIds: [], content: '# Page A', createdAt: 0, updatedAt: 0, metadata: null },
  'page-b': { id: 'page-b', parentId: PAGES, childIds: [], content: '# Page B', createdAt: 0, updatedAt: 0, metadata: null },
  'src-1': {
    id: 'src-1', parentId: 'page-a', childIds: [], content: 'first ref from A', createdAt: 1, updatedAt: 10,
    metadata: { markers: [{ markerType: 'project', value: 'x' }] },
  },
  'src-2': {
    id: 'src-2', parentId: 'page-b', childIds: [], content: 'second ref from B', createdAt: 2, updatedAt: 20,
    metadata: null,
  },
};

const groups: BacklinkGroup[] = [
  { kind: 'page', targetId: 'target', sourceIds: ['src-1', 'src-2'] },
];

function renderList(over: { groups?: BacklinkGroup[]; onNavigate?: (id: string) => void } = {}) {
  return render(() => (
    <BlockRefList
      groups={over.groups ?? groups}
      getBlock={(id) => blocks[id] ?? null}
      pagesContainerId={PAGES}
      labelFor={(id) => id}
      onNavigate={over.onNavigate ?? (() => {})}
    />
  ));
}

describe('BlockRefList (U3a)', () => {
  it('renders rows with kind dot, crumb, content, age, and nav button', () => {
    const { container } = renderList();
    const rows = container.querySelectorAll('.blockref-row');
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('.blockref-crumb')?.textContent).toBe('Page A');
    expect(rows[1].querySelector('.blockref-content')?.textContent).toBe('first ref from A');
    expect(rows[1].querySelector('.blockref-nav')).not.toBeNull();
    // default sort: updated desc → src-2 (20) before src-1 (10)
    expect(rows[0].getAttribute('data-source-block-id')).toBe('src-2');
  });

  it('facet chip click includes; shift+click excludes; counts shown', () => {
    const { container } = renderList();
    // Contextual chips re-render on every filter change — re-query by text,
    // the way a real pointer hits the freshly rendered chip.
    const findChip = (text: string) => Array.from(container.querySelectorAll('.blockref-facet-chip'))
      .find((c) => c.textContent?.includes(text))!;
    expect(findChip('Page A').querySelector('.facet-count')?.textContent).toBe('1');

    fireEvent.click(findChip('Page A'));
    expect(container.querySelectorAll('.blockref-row')).toHaveLength(1);
    expect(container.querySelector('.blockref-row')?.getAttribute('data-source-block-id')).toBe('src-1');
    expect(container.querySelector('.backlink-drawer-group-count')?.textContent).toBe('1/2');
    // contextual narrowing: Page B would return 0 alongside Page A → omitted
    expect(Array.from(container.querySelectorAll('.blockref-facet-chip'))
      .some((c) => c.textContent?.includes('Page B'))).toBe(false);

    fireEvent.click(findChip('Page A'), { shiftKey: true });
    expect(container.querySelectorAll('.blockref-row')).toHaveLength(1);
    expect(container.querySelector('.blockref-row')?.getAttribute('data-source-block-id')).toBe('src-2');
  });

  it('free-text filter narrows rows; filtered-empty shows without hiding groups', () => {
    const { container } = renderList();
    const search = container.querySelector('.blockref-search') as HTMLInputElement;
    fireEvent.input(search, { target: { value: 'zzz-no-match' } });
    expect(container.querySelectorAll('.blockref-row')).toHaveLength(0);
    expect(container.querySelector('.blockref-filtered-empty')?.textContent).toContain('no refs match filter');
    // group header still visible (always-present identity)
    expect(container.querySelector('.backlink-drawer-group-header')).not.toBeNull();
  });

  it('zero-source group renders its header with "no references yet"', () => {
    const { container } = renderList({
      groups: [{ kind: 'page', targetId: 'empty-target', sourceIds: [] }],
    });
    expect(container.querySelector('.backlink-drawer-group-header')?.textContent).toContain('empty-target');
    expect(container.querySelector('.blockref-row-none')?.textContent).toBe('no references yet');
  });

  it('navigate button calls the host callback with the source id', () => {
    const onNavigate = vi.fn();
    const { container } = renderList({ onNavigate });
    const firstNav = container.querySelector('.blockref-nav') as HTMLElement;
    fireEvent.click(firstNav);
    expect(onNavigate).toHaveBeenCalledWith('src-2');
  });

  it('row bodies stay inert (D3) — no handlers, roles, or tabindex', () => {
    const { container } = renderList();
    container.querySelectorAll('.blockref-row').forEach((rowEl) => {
      expect(rowEl.getAttribute('tabindex')).toBeNull();
      expect(rowEl.getAttribute('role')).toBeNull();
    });
    container.querySelectorAll('.blockref-content').forEach((el) => {
      expect(el.getAttribute('tabindex')).toBeNull();
    });
  });
});

describe('BlockRefList U3b — expand-in-place + child preview', () => {
  const deepBlocks: Record<string, FixtureBlock> = {
    [PAGES]: { id: PAGES, parentId: null, childIds: [], content: 'pages::', createdAt: 0, updatedAt: 0, metadata: null },
    'page-x': { id: 'page-x', parentId: PAGES, childIds: ['sec'], content: '# Page X', createdAt: 0, updatedAt: 0, metadata: null },
    sec: { id: 'sec', parentId: 'page-x', childIds: ['parent-ref'], content: '## section', createdAt: 0, updatedAt: 0, metadata: null },
    'parent-ref': {
      id: 'parent-ref', parentId: 'sec', childIds: ['payload'], content: '[[2026-09-08]]',
      createdAt: 0, updatedAt: 0, metadata: null,
    },
    payload: { id: 'payload', parentId: 'parent-ref', childIds: [], content: 'loaded up the demo outline after the long weekend', createdAt: 0, updatedAt: 0, metadata: null },
  };

  function renderDeep(onNavigate?: (id: string) => void) {
    return render(() => (
      <BlockRefList
        groups={[{ kind: 'page', targetId: 't', sourceIds: ['parent-ref'] }]}
        getBlock={(id) => deepBlocks[id] ?? null}
        pagesContainerId={PAGES}
        labelFor={(id) => id}
        onNavigate={onNavigate ?? (() => {})}
      />
    ));
  }

  it('unexpanded row shows the first-child preview', () => {
    const { container } = renderDeep();
    expect(container.querySelector('.blockref-child-preview')?.textContent)
      .toContain('loaded up the demo outline after the long weekend');
  });

  it('▸ expands the D4 slice: ancestor + highlighted source + children', () => {
    const { container } = renderDeep();
    fireEvent.click(container.querySelector('.blockref-expand')!);
    const slice = container.querySelector('.blockref-slice')!;
    expect(slice).not.toBeNull();
    expect(slice.querySelector('.blockref-slice-note')?.textContent).toContain('section');
    const roles = Array.from(slice.querySelectorAll('.blockref-slice-line')).map((l) => l.className);
    expect(roles[0]).toContain('slice-ancestor');
    expect(roles[1]).toContain('slice-source');
    expect(roles[2]).toContain('slice-child');
    // child preview hides while expanded (the slice shows children for real)
    expect(container.querySelector('.blockref-child-preview')).toBeNull();
    // collapse restores
    fireEvent.click(container.querySelector('.blockref-expand')!);
    expect(container.querySelector('.blockref-slice')).toBeNull();
  });

  it('crumb segment re-roots the slice at that ancestor (D8)', () => {
    const { container } = renderDeep();
    const segs = container.querySelectorAll('.blockref-crumb-seg');
    expect(segs.length).toBe(2); // Page X › section
    fireEvent.click(segs[0]); // re-root at Page X
    const note = container.querySelector('.blockref-slice-note');
    expect(note?.textContent).toContain('Page X');
    expect(container.querySelectorAll('.blockref-slice-line.slice-ancestor')).toHaveLength(2);
    expect(segs[0].classList.contains('crumb-live')).toBe(true);
  });
});
