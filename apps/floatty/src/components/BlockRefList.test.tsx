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
    const chip = Array.from(container.querySelectorAll('.blockref-facet-chip'))
      .find((c) => c.textContent?.includes('Page A'))!;
    expect(chip.querySelector('.facet-count')?.textContent).toBe('1');

    fireEvent.click(chip);
    expect(container.querySelectorAll('.blockref-row')).toHaveLength(1);
    expect(container.querySelector('.blockref-row')?.getAttribute('data-source-block-id')).toBe('src-1');
    expect(container.querySelector('.backlink-drawer-group-count')?.textContent).toBe('1/2');

    fireEvent.click(chip, { shiftKey: true });
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
