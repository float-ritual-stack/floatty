/**
 * QueryBlockDisplay tests (brief E) — through the WorkspaceProvider mock seam
 * with a REAL backlink index over synthetic, PII-free blocks. The navigation
 * funnel is stubbed so assertions are on WHAT the view hands it.
 */
import { createMemo, createSignal } from 'solid-js';
import { useContentSync } from '../../hooks/useContentSync';
import { useBlockInput } from '../../hooks/useBlockInput';
import { createMockCursor } from '../../hooks/useCursor';
import { registerHandlers } from '../../lib/handlers';
import { createStore } from 'solid-js/store';
import { paneStore } from '../../hooks/usePaneStore';
import { render, fireEvent } from '@solidjs/testing-library';
import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { QueryBlockDisplay, type QueryRowFocus } from './QueryBlockDisplay';

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

function renderQuery(queryContent: string, callbacks: {
  onRegisterRowFocus?: (focus: QueryRowFocus) => void;
  onReturnToLine?: () => void;
  onFocusNext?: () => void;
  onBeforeContentWrite?: () => void;
} = {}) {
  const [blocks, setBlocks] = createStore(fixture(queryContent));
  const blockStore = createMockBlockStore({
    blocks,
    updateBlockContent: (id, content) => setBlocks(id, 'content', content),
    rootIds: [PAGES],
    getBlock: (blockId: string) => blocks[blockId],
  });
  const index = buildBacklinkIndex(blocks, [PAGES]);
  return render(() => (
    <WorkspaceProvider blockStore={blockStore} paneStore={createMockPaneStore({ isCollapsed: paneStore.isCollapsed, toggleCollapsed: paneStore.toggleCollapsed })} backlinkIndex={() => index}>
      <QueryBlockDisplay blockId={QUERY} paneId="pane-test" {...callbacks} />
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

  it('walks rows in the output wrapper, navigates, expands, returns to line and exits downward', () => {
    let focus!: QueryRowFocus;
    const onReturnToLine = vi.fn();
    const onFocusNext = vi.fn();
    const { container } = renderQuery('query:: link:⬜ !link:✅', {
      onRegisterRowFocus: (value) => { focus = value; }, onReturnToLine, onFocusNext,
    });
    const wrapper = container.querySelector<HTMLElement>('.query-block-display')!;
    const focused = () => container.querySelector('.blockref-row-focused')?.getAttribute('data-source-block-id');
    expect(focus.enter('first')).toBe(true);
    expect(document.activeElement).toBe(wrapper);
    expect(focused()).toBe(TODO_A);
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
    expect(focused()).toBe(TODO_B);
    fireEvent.keyDown(wrapper, { key: 'Enter' });
    expect(navMocks.navigateToBlock).toHaveBeenCalledWith(TODO_B, { paneId: 'pane-test:linked', highlight: true });
    fireEvent.keyDown(wrapper, { key: 'ArrowUp' });
    expect(focused()).toBe(TODO_A);
    fireEvent.keyDown(wrapper, { key: ' ' });
    expect(container.querySelector('.blockref-slice')).not.toBeNull();
    fireEvent.keyDown(wrapper, { key: ' ' });
    expect(container.querySelector('.blockref-slice')).toBeNull();
    fireEvent.keyDown(wrapper, { key: 'Escape' });
    expect(onReturnToLine).toHaveBeenCalledOnce();
    expect(focused()).toBeUndefined();
    focus.enter('first');
    fireEvent.keyDown(wrapper, { key: 'ArrowUp' });
    expect(onReturnToLine).toHaveBeenCalledTimes(2);
    focus.enter('last');
    expect(focused()).toBe(TODO_B);
    fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
    expect(onFocusNext).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('.blockref-drag-handle')).toHaveLength(2);
    expect(container.querySelector('.blockref-row[tabindex]')).toBeNull();
  });

  it.each(['rows', 'reader'])('opens a keyboard board picker in %s, cancels with Escape, and restamps without navigating', async (display) => {
    const targetId = id(30);
    const blocks = fixture(`query:: link:⬜ !link:✅ [display:: ${display}] [reader:: meta]`);
    blocks[targetId] = block(targetId, 'query:: marker:project:demo', null);
    const updateBlockContent = vi.fn();
    const moveBlock = vi.fn();
    const blockStore = createMockBlockStore({
      blocks, getBlock: (id) => blocks[id], rootIds: [PAGES, targetId], updateBlockContent, moveBlock,
    });
    const { container, getByRole } = render(() => (
      <WorkspaceProvider blockStore={blockStore} paneStore={createMockPaneStore()} backlinkIndex={() => buildBacklinkIndex(blocks, [PAGES, targetId])}>
        <QueryBlockDisplay blockId={QUERY} paneId="pane-test" />
      </WorkspaceProvider>
    ));
    const handle = container.querySelector<HTMLButtonElement>('.blockref-drag-handle')!;
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute('aria-label')).toBe('Move row to another board');
    handle.focus();
    fireEvent.click(handle, { detail: 1 });
    expect(container.querySelector('.query-move-picker')).toBeNull();
    // Native buttons emit a zero-detail click for Enter/Space activation.
    fireEvent.click(handle, { detail: 0 });
    await Promise.resolve();
    let select = getByRole('combobox', { name: 'Destination board' });
    expect(document.activeElement).toBe(select);
    fireEvent.keyDown(select, { key: 'Escape' });
    await Promise.resolve();
    expect(document.activeElement).toBe(handle);
    expect(container.querySelector('.query-move-picker')).toBeNull();
    expect(updateBlockContent).not.toHaveBeenCalled();
    fireEvent.click(handle, { detail: 0 });
    await Promise.resolve();
    select = getByRole('combobox', { name: 'Destination board' });
    fireEvent.change(select, { target: { value: targetId } });
    fireEvent.click(getByRole('button', { name: 'Move', exact: true }));
    await Promise.resolve();
    expect(updateBlockContent).toHaveBeenCalledWith(TODO_A, `${blocks[TODO_A].content} [project::demo]`);
    expect(moveBlock).not.toHaveBeenCalled();
    expect(navMocks.navigateToBlock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(handle);
  });

  it('walks filtered and sorted visible rows and leaves control keys to controls', () => {
    let focus!: QueryRowFocus;
    const { container } = renderQuery('query:: link:⬜ !link:✅', {
      onRegisterRowFocus: (value) => { focus = value; },
    });
    const search = container.querySelector<HTMLInputElement>('.blockref-search')!;
    fireEvent.input(search, { target: { value: 'reviews' } });
    focus.enter('first');
    expect(container.querySelector('.blockref-row-focused')?.getAttribute('data-source-block-id')).toBe(TODO_B);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(navMocks.navigateToBlock).not.toHaveBeenCalled();
    fireEvent.input(search, { target: { value: 'no such result' } });
    expect(focus.enter('first')).toBe(false);
    expect(container.querySelector('.blockref-row-focused')).toBeNull();
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
    expect(errors).toEqual(['⚠ unknown term "foo"', '⚠ display expects rows|titles|reader ("grid")']);
    expect(rowIds(container)).toHaveLength(3);
  });

  it('enforces the cap before render and says so', () => {
    const { container } = renderQuery('query:: link:⬜ [limit:: 1]');
    expect(rowIds(container)).toEqual([TODO_A]);
    expect(container.querySelector('.query-block-count')?.textContent).toBe('1 of 3');
    expect(container.querySelector('.blockref-count')?.textContent).toBe('1 of 3');
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

beforeAll(() => { Element.prototype.scrollIntoView = vi.fn(); });

it('header buttons keep focus on the query line and flush it before writing an option', () => {
  // A real mousedown on a header button would move focus to the view container
  // and race the editor's blur flush against the option write. The header
  // cancels mousedown; every option write flushes the line first.
  const writes: string[] = [];
  const onBeforeContentWrite = vi.fn(() => writes.push('flush'));
  const { container } = renderQuery('query:: link:⬜', { onBeforeContentWrite });
  const header = container.querySelector<HTMLElement>('.query-block-header')!;
  const reader = container.querySelector<HTMLElement>('[aria-label="Reader view"]')!;
  const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  reader.dispatchEvent(mousedown);
  expect(mousedown.defaultPrevented).toBe(true);
  expect(header.contains(reader)).toBe(true);
  const original = container.querySelector('[data-query-drop]');
  fireEvent.click(reader);
  writes.push('write');
  expect(onBeforeContentWrite).toHaveBeenCalledTimes(1);
  expect(writes).toEqual(['flush', 'write']);
  expect(container.querySelector('.query-reader-view')).not.toBeNull();
  expect(container.querySelector('[aria-label="Row view"]')).not.toBeNull();
  expect(container.querySelector('[data-query-drop]')).toBe(original);
  fireEvent.click(container.querySelector('[aria-label="Row view"]')!);
  expect(onBeforeContentWrite).toHaveBeenCalledTimes(2);
  expect(container.querySelector('.query-reader-view')).toBeNull();
  fireEvent.click(container.querySelector('[aria-label="Show plain query list"]')!);
  expect(onBeforeContentWrite).toHaveBeenCalledTimes(3);
});

it.each([true, false])('defers option writes through compositionend with prior input=%s', async (priorInput) => {
  const initial = 'query:: text~initial';
  const [blocks, setBlocks] = createStore(fixture(initial));
  const updateBlockContent = vi.fn((id: string, content: string) => setBlocks(id, 'content', content));
  const blockStore = createMockBlockStore({
    blocks, getBlock: (id) => blocks[id], rootIds: [PAGES], updateBlockContent,
  });
  let editor!: HTMLDivElement;
  function Harness() {
    const [contentRef, setContentRef] = createSignal<HTMLDivElement>();
    const sync = useContentSync({
      getBlockId: () => QUERY, getBlock: () => blocks[QUERY],
      getContentRef: contentRef, store: blockStore,
    });
    return <WorkspaceProvider blockStore={blockStore} paneStore={createMockPaneStore()}
      backlinkIndex={() => buildBacklinkIndex(blocks, [PAGES])}>
      <div ref={(el) => { editor = el; setContentRef(el); }} contenteditable="true" tabIndex={0}
        onInput={sync.handleInput} onBlur={sync.handleBlurSync}
        onCompositionStart={() => sync.setIsComposing(true)}
        onCompositionEnd={(event) => {
          sync.setIsComposing(false);
          sync.updateContentFromDom(event.currentTarget);
        }} />
      <QueryBlockDisplay blockId={QUERY} paneId="pane-test"
        isComposing={sync.isComposing()} onBeforeContentWrite={sync.flushContentUpdate} />
    </WorkspaceProvider>;
  }
  const { container, unmount } = render(() => <Harness />);
  editor.focus();
  fireEvent.compositionStart(editor);
  editor.innerText = 'query:: text~に';
  if (priorInput) fireEvent.input(editor);
  fireEvent.click(container.querySelector('[aria-label="Reader view"]')!);
  fireEvent.click(container.querySelector('[aria-label="Show plain query list"]')!);
  await Promise.resolve();
  expect(updateBlockContent).not.toHaveBeenCalled();
  expect(blocks[QUERY].content).toBe(initial);
  editor.innerText = 'query:: text~日本語';
  fireEvent.compositionEnd(editor);
  await Promise.resolve();
  expect(blocks[QUERY].content).toContain('text~日本語');
  expect(blocks[QUERY].content).toMatch(/\[display::\s*reader\]/);
  expect(blocks[QUERY].content).toMatch(/\[chrome::\s*off\]/);
  expect(updateBlockContent).toHaveBeenCalledTimes(2);
  const committed = blocks[QUERY].content;
  fireEvent.blur(editor);
  expect(blocks[QUERY].content).toBe(committed);

  // A queued write must not survive the view that requested it.
  editor.focus();
  fireEvent.compositionStart(editor);
  fireEvent.click(container.querySelector('[aria-label="Row view"]')!);
  unmount();
  await Promise.resolve();
  expect(blocks[QUERY].content).toBe(committed);
});

it('chrome off renders a plain list, and header toggle edits the option pill', () => {
  const { container } = renderQuery('query:: link:⬜ [chrome:: off]');
  expect(container.querySelector('.blockref-controls')).toBeNull();
  expect(container.querySelector('.blockref-facets')).toBeNull();
  expect(container.querySelector('.backlink-drawer-group-header')).toBeNull();
  expect(rowIds(container)).toHaveLength(3);
  expect(container.querySelector('.query-block-count')?.textContent).toBe('3 of 3');
  fireEvent.click(container.querySelector('[aria-label="Configure query"]')!);
  expect(container.querySelector('.blockref-controls')).not.toBeNull();
  fireEvent.click(container.querySelector('[aria-label="Show plain query list"]')!);
  expect(container.querySelector('.blockref-controls')).toBeNull();
});

it('collapse uses the pane map, keeps the header, and refuses row entry', () => {
  paneStore.setCollapsed('pane-test', QUERY, false);
  let focus!: QueryRowFocus;
  const { container } = renderQuery('query:: link:⬜', { onRegisterRowFocus: (value) => { focus = value; } });
  fireEvent.click(container.querySelector('[aria-label="Collapse query results"]')!);
  expect(paneStore.isCollapsed('pane-test', QUERY, false)).toBe(true);
  expect(rowIds(container)).toHaveLength(0);
  expect(container.querySelector('.query-block-count')?.textContent).toBe('3 of 3');
  expect(focus.enter('first')).toBe(false);
  fireEvent.click(container.querySelector('[aria-label="Expand query results"]')!);
  expect(rowIds(container)).toHaveLength(3);
});

it('Cmd/Ctrl+. toggles the highlighted row slice through the output walk', () => {
  let focus!: QueryRowFocus;
  const { container } = renderQuery('query:: link:⬜', { onRegisterRowFocus: (value) => { focus = value; } });
  focus.enter('first');
  const wrapper = container.querySelector('.query-block-display')!;
  fireEvent.keyDown(wrapper, { key: '.', metaKey: true });
  expect(container.querySelector('.blockref-slice')).not.toBeNull();
  fireEvent.keyDown(wrapper, { key: '.', ctrlKey: true });
  expect(container.querySelector('.blockref-slice')).toBeNull();
});

it('Enter redirect appears in the projection on the server stamp without another blur', () => {
  registerHandlers();
  const [blocks, setBlocks] = createStore(fixture('query:: link:⬜ [create_block:: [[2026-w33]]]'));
  const created = id(30);
  let editor!: HTMLDivElement;
  const blockStore = createMockBlockStore({
    blocks, rootIds: [PAGES], getBlock: (key) => blocks[key],
    createBlockInside: (parentId) => {
      setBlocks(created, block(created, '', parentId));
      setBlocks(parentId, 'childIds', (ids) => [...ids, created]);
      return created;
    },
  });
  function Harness() {
    const index = createMemo(() => buildBacklinkIndex(blocks, [PAGES]));
    const input = useBlockInput({
      getBlockId: () => QUERY, paneId: 'pane-test', getBlock: () => blocks[QUERY],
      isCollapsed: () => false, blockStore, paneStore: createMockPaneStore(),
      cursor: createMockCursor({ atEnd: true, offset: blocks[QUERY].content.length }),
      findNextVisibleBlock: () => null, findPrevVisibleBlock: () => null, findFocusAfterDelete: () => null,
      onFocus: () => {}, flushContentUpdate: () => {}, getContentRef: () => editor, getBacklinks: index,
    });
    return <WorkspaceProvider blockStore={blockStore} paneStore={createMockPaneStore()} backlinkIndex={index}>
      <div ref={editor} contenteditable="true" tabindex="0" onKeyDown={input.handleKeyDown} />
      <QueryBlockDisplay blockId={QUERY} paneId="pane-test" />
    </WorkspaceProvider>;
  }
  const { container } = render(() => <Harness />);
  editor.focus();
  fireEvent.keyDown(editor, { key: 'Enter' });
  expect(blocks[created].parentId).toBe(PAGE_W33);
  expect(rowIds(container)).not.toContain(created);
  // The server hook's resulting content arrives through the store/index.
  setBlocks(created, 'content', '[[⬜]] Demo created card');
  expect(document.activeElement).toBe(editor);
  expect(rowIds(container)).toContain(created);
  expect(container.querySelector('.query-block-count')?.textContent).toBe('4 of 4');
});


it('mounts reader, publishes article/child keyboard order, and keeps chrome and collapse wired', () => {
  paneStore.setCollapsed('pane-test', QUERY, false);
  let focus!: QueryRowFocus;
  const { container } = renderQuery('query:: link:⬜ !link:✅ [display:: reader]', {
    onRegisterRowFocus: (value) => { focus = value; },
  });
  const wrapper = container.querySelector('.query-block-display')!;
  const focused = () => container.querySelector('.blockref-row-focused')?.getAttribute('data-source-block-id');
  expect(container.querySelector('.query-reader-view')).not.toBeNull();
  expect(container.querySelector('.blockref-list')).toBeNull();
  expect(container.querySelector('.query-block-mode')?.textContent).toBe('reader');
  expect(container.querySelector('.query-reader-controls')).toBeNull();
  expect(wrapper.getAttribute('data-query-drop')).toBe(QUERY);
  expect(focus.enter('first')).toBe(true);
  expect(focused()).toBe(TODO_A);
  fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
  expect(focused()).toBe(id(20));
  fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
  expect(focused()).toBe(TODO_B);
  fireEvent.keyDown(wrapper, { key: 'Enter' });
  expect(navMocks.navigateToBlock).toHaveBeenCalledWith(TODO_B, { paneId: 'pane-test:linked', highlight: true });
  focus.enter('first');
  fireEvent.keyDown(wrapper, { key: ' ' });
  expect(container.querySelector('.query-reader-children .query-reader-row')).toBeNull();
  fireEvent.click(container.querySelector('[aria-label="Configure query"]')!);
  expect(container.querySelector('.query-reader-controls')).not.toBeNull();
  fireEvent.click(container.querySelector('[aria-label="Collapse query results"]')!);
  expect(container.querySelector('.query-reader-view')).toBeNull();
  expect(focus.enter('first')).toBe(false);
  fireEvent.click(container.querySelector('[aria-label="Expand query results"]')!);
  expect(container.querySelector('.query-reader-view')).not.toBeNull();
});
