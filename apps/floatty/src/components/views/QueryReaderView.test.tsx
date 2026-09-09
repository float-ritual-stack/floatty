import { createSignal } from 'solid-js';
import { render, fireEvent } from '@solidjs/testing-library';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryReaderView } from './QueryReaderView';
import { DEFAULT_READER_FLAGS } from '../../lib/queryPredicate';
import type { Block } from '../../lib/blockTypes';
import type { RefListRows } from '../BlockRefList';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function block(n: number, content: string, parentId: string | null, childIds: string[] = []): Block {
  return { id: id(n), content, parentId, childIds, createdAt: 1, updatedAt: 2, collapsed: false, type: 'text' };
}
function setup() {
  const [blocks, setBlocks] = createSignal<Record<string, Block>>({
    [id(1)]: block(1, '# Demo page', null, [id(2), id(5)]),
    [id(2)]: block(2, '## [[⬜]] [[DEMO-107|big item]] — **the** payload\nSecond *line*', id(1), [id(3)]),
    [id(3)]: block(3, '**Child** paragraph\nHidden second line', id(2), [id(4)]),
    [id(4)]: block(4, 'Hidden grandchild', id(3)),
    [id(5)]: block(5, 'Demo second article', id(1)),
  });
  const [ids, setIds] = createSignal([id(2), id(5)]);
  const [flags, setFlags] = createSignal({ ...DEFAULT_READER_FLAGS });
  const [highlight, setHighlight] = createSignal<string>();
  const navigate = vi.fn();
  const wikilink = vi.fn();
  const drag = vi.fn();
  let rows!: RefListRows;
  const result = render(() => <QueryReaderView ids={ids()} flags={flags()} chrome
    onFlagsChange={setFlags} getBlock={(key) => blocks()[key]} pagesContainerId={null}
    paneId="demo-pane" highlightedRowId={highlight()} onVisibleRows={(value) => { rows = value; }}
    onNavigate={navigate} onNavigateWikilink={wikilink} onDragHandlePointerDown={drag} />);
  return { ...result, blocks, setBlocks, setIds, flags, setFlags, setHighlight, navigate, wikilink, drag, rows: () => rows };
}

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

describe('QueryReaderView', () => {
  it('the header-level fold hides the children and flips the glyph', () => {
    const view = setup();
    const article = view.container.querySelector('article')!;
    const fold = article.querySelector('.query-reader-fold') as HTMLButtonElement;
    expect(article.querySelectorAll('.query-reader-children .query-reader-row').length).toBeGreaterThan(0);
    fold.click();
    expect(article.classList.contains('query-reader-article-folded')).toBe(true);
    expect(fold.textContent).toBe('▸');
    fold.click();
    expect(article.classList.contains('query-reader-article-folded')).toBe(false);
  });

  it('renders full pretty articles, depth-one child summaries and the visible order', () => {
    const view = setup();
    const article = view.container.querySelector('article')!;
    // the header-level fold glyph is chrome, not content — assert the rows' text
    expect(article.querySelector('.query-reader-fold')?.textContent).toBe('▾');
    expect(Array.from(article.querySelectorAll('.query-reader-row')).map((r) => r.textContent).join(''))
      .toBe('## ⬜ big item — the payload\nSecond lineChild paragraph+1 more');
    expect(article.querySelector('[role="heading"]')?.getAttribute('aria-level')).toBe('3');
    expect(article.querySelector('.md-bold')?.textContent).toBe('the');
    expect(article.textContent).not.toContain('Hidden');
    expect(view.container.querySelector('.blockref-crumb')).toBeNull();
    expect(view.container.querySelector('.blockref-age')).toBeNull();
    expect(view.container.querySelector('.blockref-child-preview')).toBeNull();
    expect(view.rows().ids).toEqual([id(2), id(3), id(5)]);
    view.rows().toggleExpanded(id(2));
    expect(view.rows().ids).toEqual([id(2), id(5)]);
    view.rows().toggleExpanded(id(2));
    expect(view.rows().ids).toEqual([id(2), id(3), id(5)]);
  });

  it('toggles flags, preserving raw marks on request, and uses the row drag contract', () => {
    const view = setup();
    view.setFlags({ marks: true, crumbs: true, bullets: true, meta: true, peek: true, children: false, headings: false });
    expect(view.container.querySelector('.query-reader-content')?.textContent).toBe('[[⬜]] [[DEMO-107|big item]] — **the** payload\nSecond *line*');
    expect(view.container.querySelector('.blockref-crumb')?.textContent).toContain('Demo page');
    expect(view.container.querySelectorAll('.blockref-kind')).toHaveLength(2);
    expect(view.container.querySelectorAll('.blockref-age')).toHaveLength(2);
    expect(view.container.querySelectorAll('.query-reader-bullet')).toHaveLength(2);
    expect(view.container.querySelector('.blockref-child-preview')?.textContent).toContain('**Child**');
    expect(view.rows().ids).toEqual([id(2), id(5)]);
    fireEvent.pointerDown(view.container.querySelector('.blockref-drag-handle')!);
    expect(view.drag).toHaveBeenCalledWith(expect.any(Event), id(2), 'demo-pane');
    fireEvent.click(view.getByRole('button', { name: '✓ meta' }));
    expect(view.flags().meta).toBe(false);
    expect(view.container.querySelector('.blockref-age')).toBeNull();
  });

  it('highlights rows and routes plain/modifier/child clicks and live links to host callbacks', () => {
    const view = setup();
    view.setHighlight(id(3));
    expect(view.container.querySelector('.blockref-row-focused')?.getAttribute('data-source-block-id')).toBe(id(3));
    expect(view.container.querySelector('.query-reader-row[tabindex]')).toBeNull();
    fireEvent.click(view.container.querySelector('.query-reader-content')!);
    expect(view.navigate).toHaveBeenLastCalledWith(id(2));
    fireEvent.click(view.container.querySelector('.query-reader-children .query-reader-content')!, { metaKey: true });
    expect(view.navigate).toHaveBeenLastCalledWith(id(3));
    fireEvent.click(view.container.querySelector('[data-target="DEMO-107"]')!, { metaKey: true });
    expect(view.wikilink).toHaveBeenCalledWith('DEMO-107', expect.objectContaining({ metaKey: true }));
    expect(view.navigate).toHaveBeenCalledTimes(2);
  });

  it('keeps article and child DOM identity across rebuilt objects and reordered ids', () => {
    const view = setup();
    const article = view.container.querySelector('article')!;
    const child = view.container.querySelector('.query-reader-children .query-reader-row')!;
    view.setBlocks(Object.fromEntries(Object.entries(view.blocks()).map(([key, value]) => [key, { ...value,
      content: key === id(3) ? 'Updated child' : value.content,
    }])));
    view.setIds([id(5), id(2)]);
    expect(view.container.querySelectorAll('article')[1]).toBe(article);
    expect(view.container.querySelector('.query-reader-children .query-reader-row')).toBe(child);
    expect(child.textContent).toBe('Updated child+1 more');
    expect(view.rows().ids).toEqual([id(5), id(2), id(3)]);
  });
});
