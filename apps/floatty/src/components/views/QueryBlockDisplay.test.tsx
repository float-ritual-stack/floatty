/**
 * QueryBlockDisplay tests (brief E) — through the WorkspaceProvider mock seam
 * with a REAL backlink index over synthetic, PII-free blocks. The navigation
 * funnel is stubbed so assertions are on WHAT the view hands it.
 */
import { render, fireEvent } from '@solidjs/testing-library';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { QueryBlockDisplay } from './QueryBlockDisplay';

const navMocks = vi.hoisted(() => ({
  navigateToBlock: vi.fn(() => ({ success: true, targetPaneId: 'pane-test' })),
  followWikilinkTarget: vi.fn(() => ({ success: true, targetPaneId: 'pane-test' })),
}));
vi.mock('../../lib/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/navigation')>()),
  navigateToBlock: navMocks.navigateToBlock,
  followWikilinkTarget: navMocks.followWikilinkTarget,
  resolveSameTabLink: (paneId: string) => `${paneId}:linked`,
}));
import { WorkspaceProvider, createMockBlockStore, createMockPaneStore } from '../../context/WorkspaceContext';
import { buildBacklinkIndex } from '../../lib/backlinkIndex';
import type { Block } from '../../lib/blockTypes';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PAGES = id(1);
const PAGE_HOME = id(2);
const PAGE_W33 = id(3);
const BOARD = id(4);
const TODO_A = id(5);
const TODO_B = id(6);
const DONE_C = id(7);
const QUERY = id(8);
const QUERY_CHILD = id(9);

function block(blockId: string, content: string, parentId: string | null, childIds: string[] = [], updatedAt = 0): Block {
  return {
    id: blockId, content, parentId, childIds, type: 'text', collapsed: false, createdAt: 1, updatedAt,
  } as unknown as Block;
}

function fixture(queryContent: string): Record<string, Block> {
  const blocks: Record<string, Block> = {
    [PAGES]: block(PAGES, 'pages::', null, [PAGE_HOME, PAGE_W33]),
    [PAGE_HOME]: block(PAGE_HOME, '# Demo Home', PAGES, [QUERY]),
    [PAGE_W33]: block(PAGE_W33, '# 2026-w33', PAGES, [BOARD]),
    [BOARD]: block(BOARD, '## thursday board', PAGE_W33, [TODO_A, TODO_B, DONE_C]),
    [TODO_A]: block(TODO_A, '[[⬜]] [[PC-236]] Demo Alice ships', BOARD, [id(20)], 30),
    [id(20)]: block(id(20), 'child payload of A', TODO_A, [], 1),
    [TODO_B]: block(TODO_B, '[[⬜]] [[REX-343]] Demo Bob reviews', BOARD, [], 20),
    [DONE_C]: block(DONE_C, '[[✅]] [[⬜]] done', BOARD, [], 10),
    [QUERY]: block(QUERY, queryContent, PAGE_HOME, [QUERY_CHILD]),
    [QUERY_CHILD]: block(QUERY_CHILD, '[[⬜]] added under the query', QUERY, [], 99),
  };
  return blocks;
}

function renderQuery(queryContent: string) {
  const blocks = fixture(queryContent);
  const blockStore = createMockBlockStore({
    blocks,
    rootIds: [PAGES],
    getBlock: (blockId: string) => blocks[blockId],
  });
  const index = buildBacklinkIndex(blocks, [PAGES]);
  return render(() => (
    <WorkspaceProvider blockStore={blockStore} paneStore={createMockPaneStore()} backlinkIndex={() => index}>
      <QueryBlockDisplay blockId={QUERY} paneId="pane-test" />
    </WorkspaceProvider>
  ));
}

const rowIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.blockref-row')).map((row) => row.getAttribute('data-source-block-id'));

describe('QueryBlockDisplay', () => {
  beforeEach(() => {
    navMocks.navigateToBlock.mockClear();
    navMocks.followWikilinkTarget.mockClear();
  });

  it('renders matching rows through BlockRefList as a query group, with the count header', () => {
    const { container } = renderQuery('query:: link:⬜ !link:✅');
    expect(container.querySelector('.query-block-count')?.textContent).toBe('2 of 2');
    expect(container.querySelector('.query-block-truncated')).toBeNull();
    expect(container.querySelector('.backlink-drawer-group-kind')?.textContent).toBe('query');
    expect(container.querySelector('.backlink-drawer-group-label')?.textContent).toBe('link:⬜ !link:✅');
    // newest first; the query's own real child is NOT pulled in (shown in place)
    expect(rowIds(container)).toEqual([TODO_A, TODO_B]);
    expect(container.querySelector('.query-block-errors')).toBeNull();
    // default rows mode keeps crumb + child peek
    expect(container.querySelector('.blockref-crumb')?.textContent).toContain('2026-w33');
    expect(container.querySelector('.blockref-child-preview')?.textContent).toContain('child payload of A');
  });

  it('a PLAIN click on a row navigates through the host callback in the caller-resolved pane', () => {
    const { container } = renderQuery('query:: link:⬜ !link:✅');
    fireEvent.click(container.querySelector('.blockref-content')!);
    expect(navMocks.navigateToBlock).toHaveBeenCalledWith(TODO_A, { paneId: 'pane-test:linked', highlight: true });
    expect(container.querySelector('.blockref-list')?.classList.contains('blockref-plainnav')).toBe(true);
  });

  it('a [[wikilink]] inside a row follows the shared ladder, not the row', () => {
    const { container } = renderQuery('query:: link:⬜ !link:✅');
    const link = container.querySelector('.blockref-content .md-wikilink[data-target="PC-236"]')!;
    fireEvent.click(link);
    expect(navMocks.followWikilinkTarget).toHaveBeenCalledWith(
      'PC-236',
      expect.objectContaining({ paneId: 'pane-test:linked', highlight: true, splitDirection: undefined }),
    );
    expect(navMocks.navigateToBlock).not.toHaveBeenCalled();
  });

  it('[display:: titles] hides crumb and child peek and flags the mode', () => {
    const { container } = renderQuery('query:: link:⬜ [display:: titles]');
    expect(rowIds(container)).toHaveLength(3);
    expect(container.querySelector('.blockref-crumb')).toBeNull();
    expect(container.querySelector('.blockref-child-preview')).toBeNull();
    expect(container.querySelector('.query-block-mode')?.textContent).toBe('titles');
    expect(container.querySelector('.blockref-content')?.textContent).toContain('Demo Alice ships');
  });

  it('renders parse errors inline, never throws, and still shows what it could evaluate', () => {
    const { container } = renderQuery('query:: foo link:⬜ [display:: grid]');
    const errors = Array.from(container.querySelectorAll('.query-block-error')).map((el) => el.textContent);
    expect(errors).toEqual(['⚠ unknown term "foo"', '⚠ display expects rows|titles ("grid")']);
    expect(rowIds(container)).toHaveLength(3);
  });

  it('enforces the cap before render and says so', () => {
    const { container } = renderQuery('query:: link:⬜ [limit:: 1]');
    expect(rowIds(container)).toEqual([TODO_A]);
    expect(container.querySelector('.query-block-count')?.textContent).toBe('1 of 3');
    expect(container.querySelector('.query-block-truncated')?.textContent).toBe('· truncated at 1');
  });

  it('[create_block:: …] that resolves says nothing; an unresolvable target warns inline (brief F)', () => {
    const resolved = renderQuery('query:: link:⬜ [create_block:: [[Demo Home]]]');
    expect(resolved.container.querySelector('.query-block-errors')).toBeNull();

    const missing = renderQuery('query:: link:⬜ [create_block:: [[Demo Nowhere]]]');
    const errors = Array.from(missing.container.querySelectorAll('.query-block-error')).map((el) => el.textContent);
    expect(errors).toEqual(['⚠ create_block target not found ("Demo Nowhere") — new blocks are created in place']);
    // the query itself still evaluates — the fallback is create-in-place, not a dead view
    expect(rowIds(missing.container)).toHaveLength(3);
  });

  it('an empty result renders the query-flavoured empty row', () => {
    const { container } = renderQuery('query:: text~nothing-matches-this');
    expect(rowIds(container)).toEqual([]);
    expect(container.querySelector('.blockref-row-none')?.textContent).toBe('no matches');
    expect(container.querySelector('.query-block-count')?.textContent).toBe('0 of 0');
  });
});
