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

describe('BlockRefList U3c — churn clustering + expand-all', () => {
  const T0 = 1_700_000_000_000;
  const churnBlocks: Record<string, FixtureBlock> = {
    [PAGES]: { id: PAGES, parentId: null, childIds: [], content: 'pages::', createdAt: 0, updatedAt: 0, metadata: null },
    daily: { id: 'daily', parentId: PAGES, childIds: [], content: '# Daily', createdAt: 0, updatedAt: 0, metadata: null },
    'rev-new': {
      id: 'rev-new', parentId: 'daily', childIds: [], createdAt: T0, updatedAt: T0 + 30 * 60_000,
      content: 'Send the Demo Alice ask → drafted, then sent', metadata: null,
    },
    'rev-old': {
      id: 'rev-old', parentId: 'daily', childIds: [], createdAt: T0, updatedAt: T0,
      content: 'Send the Demo Alice ask → drafted', metadata: null,
    },
    event: {
      id: 'event', parentId: 'daily', childIds: [], createdAt: T0, updatedAt: T0 + 10 * 60_000,
      content: 'Gate B green: fmt clippy tests all passing', metadata: null,
    },
  };

  function renderChurn() {
    return render(() => (
      <BlockRefList
        groups={[{ kind: 'page', targetId: 't', sourceIds: ['rev-new', 'rev-old', 'event'] }]}
        getBlock={(id) => churnBlocks[id] ?? null}
        pagesContainerId={PAGES}
        labelFor={(id) => id}
        onNavigate={() => {}}
      />
    ));
  }

  it('folds same-page revisions behind a ⊟ chip fronted by the latest; unstacks on click', () => {
    const { container } = renderChurn();
    // two clusters render as two rows: the revision front + the distinct event
    expect(container.querySelectorAll('.blockref-row')).toHaveLength(2);
    const churn = container.querySelector('.blockref-churn')!;
    expect(churn.textContent).toContain('2 rev');
    const frontRow = churn.closest('.blockref-row')!;
    expect(frontRow.getAttribute('data-source-block-id')).toBe('rev-new');
    // the distinct same-hour event is NOT folded (D10d prose gate)
    expect(container.querySelector('.blockref-row[data-source-block-id="event"]')).not.toBeNull();

    fireEvent.click(churn);
    const stack = container.querySelector('.blockref-churn-stack')!;
    expect(stack).not.toBeNull();
    expect(stack.querySelector('.blockref-row')?.getAttribute('data-source-block-id')).toBe('rev-old');
    expect(container.querySelectorAll('.blockref-row')).toHaveLength(3);
  });

  it('▸ all expands every visible row; ▾ all collapses them', () => {
    const { container } = renderChurn();
    const all = container.querySelector('.blockref-expand-all')!;
    expect(all.textContent).toContain('▸ all');
    fireEvent.click(all);
    expect(container.querySelectorAll('.blockref-slice')).toHaveLength(2);
    expect(all.textContent).toContain('▾ all');
    fireEvent.click(all);
    expect(container.querySelectorAll('.blockref-slice')).toHaveLength(0);
  });
});

describe('BlockRefList FLO-953 — modifier-click navigation + live wikilinks', () => {
  const linkBlocks: Record<string, FixtureBlock> = {
    [PAGES]: { id: PAGES, parentId: null, childIds: [], content: 'pages::', createdAt: 0, updatedAt: 0, metadata: null },
    'page-l': { id: 'page-l', parentId: PAGES, childIds: ['src-l'], content: '# Page L', createdAt: 0, updatedAt: 0, metadata: null },
    'src-l': {
      id: 'src-l', parentId: 'page-l', childIds: ['kid'], content: 'see [[Page B]] for the rest',
      createdAt: 1, updatedAt: 10, metadata: null,
    },
    kid: { id: 'kid', parentId: 'src-l', childIds: [], content: 'the payload', createdAt: 0, updatedAt: 0, metadata: null },
  };

  function renderLinks(over: {
    onNavigate?: (id: string) => void;
    onNavigateWikilink?: (target: string, event: MouseEvent) => void;
  } = {}) {
    return render(() => (
      <BlockRefList
        groups={[{ kind: 'page', targetId: 't', sourceIds: ['src-l'] }]}
        getBlock={(id) => linkBlocks[id] ?? null}
        pagesContainerId={PAGES}
        labelFor={(id) => id}
        onNavigate={over.onNavigate ?? (() => {})}
        onNavigateWikilink={over.onNavigateWikilink}
      />
    ));
  }

  it('⌘/Ctrl-click on the row body navigates to the source; a plain click stays inert', () => {
    const onNavigate = vi.fn();
    const { container } = renderLinks({ onNavigate });
    const content = container.querySelector('.blockref-content')!;
    fireEvent.click(content);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(content, { metaKey: true });
    expect(onNavigate).toHaveBeenCalledWith('src-l');
    fireEvent.click(container.querySelector('.blockref-child-preview')!, { ctrlKey: true });
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it('⌘-click on an expanded slice line navigates to THAT block, not the source', () => {
    const onNavigate = vi.fn();
    const { container } = renderLinks({ onNavigate });
    fireEvent.click(container.querySelector('.blockref-expand')!);
    const childLine = container.querySelector('.blockref-slice-line.slice-child')!;
    expect(childLine.getAttribute('data-slice-block-id')).toBe('kid');
    fireEvent.click(childLine.querySelector('.blockref-slice-text')!, { metaKey: true });
    expect(onNavigate).toHaveBeenCalledWith('kid');
    // the real controls keep their own clicks — ⌘ on ▸ is still just ▸
    fireEvent.click(container.querySelector('.blockref-expand')!, { metaKey: true });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.blockref-slice')).toBeNull();
  });

  it('holding ⌘/Ctrl flags the list so the hovered row can read as a target', () => {
    const { container } = renderLinks();
    const list = container.querySelector('.blockref-list')!;
    expect(list.classList.contains('blockref-modnav')).toBe(false);
    fireEvent.keyDown(window, { key: 'Meta' });
    expect(list.classList.contains('blockref-modnav')).toBe(true);
    fireEvent.keyUp(window, { key: 'Meta' });
    expect(list.classList.contains('blockref-modnav')).toBe(false);
    // pointer moves re-sync from the event's own flags (missed keydown/keyup)
    fireEvent.pointerMove(list, { ctrlKey: true });
    expect(list.classList.contains('blockref-modnav')).toBe(true);
    fireEvent.blur(window);
    expect(list.classList.contains('blockref-modnav')).toBe(false);
  });

  it('a [[wikilink]] inside a row is live and routes to the host, never to the row', () => {
    const onNavigate = vi.fn();
    const onNavigateWikilink = vi.fn();
    const { container } = renderLinks({ onNavigate, onNavigateWikilink });
    const link = container.querySelector('.blockref-content .md-wikilink')!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('data-target')).toBe('Page B');
    fireEvent.click(link);
    expect(onNavigateWikilink).toHaveBeenCalledTimes(1);
    expect(onNavigateWikilink.mock.calls[0][0]).toBe('Page B');
    // a modifier on the link is the LINK's gesture (split), not the row's
    fireEvent.click(link, { metaKey: true });
    expect(onNavigateWikilink).toHaveBeenCalledTimes(2);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
