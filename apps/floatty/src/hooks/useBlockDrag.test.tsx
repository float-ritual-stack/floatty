import { render, fireEvent, cleanup } from '@solidjs/testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { useContentSync } from './useContentSync';
import { useBlockDrag } from './useBlockDrag';
import {
  WorkspaceProvider,
  createMockBlockStore,
  createMockPaneStore,
} from '../context/WorkspaceContext';
import type { Block } from '../lib/blockTypes';

function createTestBlock(id: string, overrides: Partial<Block> = {}): Block {
  return {
    id,
    content: id,
    type: 'text',
    parentId: null,
    childIds: [],
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('useBlockDrag', () => {
  it('resolves cross-pane whitespace drop into zoom root and commits move', () => {
    const moveBlock = vi.fn().mockReturnValue(true);
    const blocks: Record<string, Block> = {
      source: createTestBlock('source'),
      zoom: createTestBlock('zoom', { childIds: [] }),
    };

    const blockStore = createMockBlockStore({
      blocks,
      rootIds: ['source', 'zoom'],
      getBlock: (id: string) => blocks[id],
      moveBlock,
    });

    const paneStore = createMockPaneStore({
      getZoomedRootId: (paneId: string) => (paneId === 'pane-b' ? 'zoom' : null),
    });

    let dragApi: ReturnType<typeof useBlockDrag> | null = null;
    const Harness = () => {
      dragApi = useBlockDrag();
      return <div data-testid="harness" />;
    };

    const container = document.createElement('div');
    container.className = 'outliner-container';
    container.setAttribute('data-pane-id', 'pane-b');
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 300,
        bottom: 300,
        width: 300,
        height: 300,
        toJSON: () => ({}),
      }),
    });
    document.body.appendChild(container);

    const originalElementFromPoint = document.elementFromPoint;
    const elementFromPointMock = vi.fn().mockReturnValue(null);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      writable: true,
      value: elementFromPointMock,
    });

    try {
      render(() => (
        <WorkspaceProvider blockStore={blockStore} paneStore={paneStore}>
          <Harness />
        </WorkspaceProvider>
      ));

      expect(dragApi).not.toBeNull();

      const handle = document.createElement('div');
      dragApi!.onHandlePointerDown(
        {
          button: 0,
          clientX: 20,
          clientY: 20,
          pointerId: 1,
          currentTarget: handle,
          preventDefault: () => {},
          stopPropagation: () => {},
        } as unknown as PointerEvent,
        'source',
        'pane-a'
      );

      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 120, clientY: 120, bubbles: true }));

      expect(moveBlock).toHaveBeenCalledWith(
        'source',
        'zoom',
        0,
        expect.objectContaining({
          position: 'inside',
          targetId: 'zoom',
          sourcePaneId: 'pane-a',
          targetPaneId: 'pane-b',
          origin: 'user-drag',
        })
      );
    } finally {
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        writable: true,
        value: originalElementFromPoint,
      });
      container.remove();
      document.body.classList.remove('block-dragging');
    }
  });
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SOURCE = id(1), FROM = id(2), TO = id(3), HOME = id(4);
function fixture(sourceId = SOURCE, content = '[[⬜]] Demo card', target = 'query:: link:🟨 marker:project:demo/qv') {
  const block = (blockId: string, text: string, parentId: string | null, childIds: string[] = []): Block => ({
    id: blockId, content: text, parentId, childIds, type: 'text', collapsed: false, createdAt: 1, updatedAt: 1,
  });
  const blocks: Record<string, Block> = {
    [SOURCE]: block(SOURCE, content, HOME),
    [HOME]: block(HOME, 'backlog', null, [SOURCE]),
    [FROM]: block(FROM, 'query:: link:⬜', null),
    [TO]: block(TO, target, null),
  };
  const updateBlockContent = vi.fn();
  const moveBlock = vi.fn();
  const blockStore = createMockBlockStore({ blocks, getBlock: (key) => blocks[key], rootIds: [HOME, FROM, TO], updateBlockContent, moveBlock });
  let drag!: ReturnType<typeof useBlockDrag>;
  function Harness() {
    drag = useBlockDrag();
    return <>
      <div data-query-drop={FROM} data-pane-id="pane-test">
        <span data-handle onPointerDown={(event) => drag.onHandlePointerDown(event, sourceId, 'pane-test')}>⋮⋮</span>
      </div>
      <div data-block-id={TO} data-pane-id="pane-test">
        <div data-query-drop={TO}><span data-hit>target rows</span></div>
      </div>
    </>;
  }
  const result = render(() => <WorkspaceProvider blockStore={blockStore} paneStore={createMockPaneStore()}><Harness /></WorkspaceProvider>);
  let hit: Element | null = result.container.querySelector('[data-hit]');
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => hit) });
  const start = () => {
    fireEvent.pointerDown(result.container.querySelector('[data-handle]')!, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    vi.runOnlyPendingTimers();
  };
  const drop = () => fireEvent.pointerUp(window, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
  return { ...result, blocks, drag, start, drop, updateBlockContent, moveBlock, setHit: (element: Element | null) => { hit = element; } };
}

afterEach(() => {
  fireEvent.pointerCancel(window);
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('query-stamp in the existing pointer drag runtime', () => {
  it('resolves query area before outline container and restamps without moving', () => {
    vi.useFakeTimers();
    const f = fixture();
    f.start();
    expect(f.drag.isQueryDropTarget(TO, 'pane-test')).toBe(true);
    expect(f.drag.dropTargetId()).toBeNull();
    f.drop();
    expect(f.updateBlockContent).toHaveBeenCalledWith(SOURCE, '[[🟨]] Demo card [project::demo/qv]');
    expect(f.moveBlock).not.toHaveBeenCalled();
    expect(f.blocks[SOURCE].parentId).toBe(HOME);
    expect(f.drag.activeDragId()).toBeNull();
  });
  it.each(['self', 'ancestor', 'same-query'] as const)('rejects %s', (mode) => {
    vi.useFakeTimers();
    const f = fixture(mode === 'self' ? TO : SOURCE);
    if (mode === 'ancestor') f.blocks[SOURCE].childIds = [TO];
    if (mode === 'same-query') f.setHit(f.container.querySelector('[data-handle]'));
    f.start();
    expect(f.drag.isValidDrop()).toBe(false);
    f.drop();
    expect(f.updateBlockContent).not.toHaveBeenCalled();
    expect(f.moveBlock).not.toHaveBeenCalled();
  });
  it('rejects query sources for pointer and keyboard board moves', () => {
    vi.useFakeTimers();
    const content = 'query:: link:⬜';
    const f = fixture(SOURCE, content);
    f.start();
    expect(f.drag.isValidDrop()).toBe(false);
    f.drop();
    f.drag.moveToQuery(SOURCE, FROM, TO, 'pane-test');
    expect(f.updateBlockContent).not.toHaveBeenCalled();
    expect(f.moveBlock).not.toHaveBeenCalled();
    expect(f.blocks[SOURCE].content).toBe(content);
  });
  it('uses the same stamp and validation for keyboard board moves', () => {
    const f = fixture();
    f.drag.moveToQuery(SOURCE, FROM, FROM, 'pane-test');
    expect(f.updateBlockContent).not.toHaveBeenCalled();
    f.drag.moveToQuery(SOURCE, FROM, TO, 'pane-test');
    expect(f.updateBlockContent).toHaveBeenCalledWith(SOURCE, '[[🟨]] Demo card [project::demo/qv]');
    expect(f.moveBlock).not.toHaveBeenCalled();
    expect(f.drag.activeDragId()).toBeNull();
  });
  it('rejects the whole stamp without a partial content write', () => {
    vi.useFakeTimers();
    const f = fixture(SOURCE, '[[⬜]] card [project::a] [project::b]');
    f.start(); f.drop();
    expect(f.updateBlockContent).not.toHaveBeenCalled();
    expect(f.moveBlock).not.toHaveBeenCalled();
  });
  it('an explicit empty stamp is a no-op and cancellation writes nothing', () => {
    vi.useFakeTimers();
    const f = fixture(SOURCE, '[[⬜]] card', 'query:: link:🟨 [stamp:: ]');
    f.start(); f.drop();
    f.start(); fireEvent.keyDown(window, { key: 'Escape' });
    expect(f.updateBlockContent).not.toHaveBeenCalled();
    expect(f.moveBlock).not.toHaveBeenCalled();
  });
  it('real outline positions still use moveBlock', () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setHit(f.container.querySelector('[data-block-id]'));
    f.start(); f.drop();
    expect(f.moveBlock).toHaveBeenCalledWith(SOURCE, null, 3, expect.objectContaining({ origin: 'user-drag' }));
    expect(f.updateBlockContent).not.toHaveBeenCalled();
  });
});

// Real drag commit + real content sync: a user-origin stamp must cross the
// edit boundary even when the dragged editor is focused but clean.
it.each([false, true])('stamps the focused editor immediately (dirty=%s)', (dirty) => {
  vi.useFakeTimers();
  const [blocks, setBlocks] = createStore<Record<string, Block>>({
    [SOURCE]: createTestBlock(SOURCE, { content: '[[⬜]] Demo card' }),
    [TO]: createTestBlock(TO, { content: 'query:: link:🟨' }),
  });
  const blockStore = createMockBlockStore({
    blocks, getBlock: (key) => blocks[key], rootIds: [SOURCE, TO],
    lastUpdateOrigin: 'user',
    updateBlockContent: (key, content) => setBlocks(key, 'content', content),
  });
  let sync!: ReturnType<typeof useContentSync>;
  let editor!: HTMLDivElement;
  let drag!: ReturnType<typeof useBlockDrag>;
  function Harness() {
    const [ref, setRef] = createSignal<HTMLDivElement>();
    sync = useContentSync({ getBlockId: () => SOURCE, getBlock: () => blocks[SOURCE], getContentRef: ref, store: blockStore });
    drag = useBlockDrag();
    return <div class="outliner-container" data-pane-id="pane-test" tabindex="0">
      <div data-block-id={SOURCE}><div ref={(el) => { editor = el; setRef(el); }} contenteditable="true" tabindex="0" onBlur={sync.handleBlurSync} /></div>
      <div data-query-drop={TO} data-hit />
    </div>;
  }
  const paneStore = createMockPaneStore({ setFocusedBlockId: vi.fn() });
  const f = render(() => <WorkspaceProvider blockStore={blockStore} paneStore={paneStore}><Harness /></WorkspaceProvider>);
  editor.focus();
  expect(document.activeElement).toBe(editor);
  expect(sync.hasLocalChanges()).toBe(false);
  if (dirty) {
    editor.innerText = '[[⬜]] Demo edited card';
    sync.updateContentFromDom(editor);
  }
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => f.container.querySelector('[data-hit]') });
  drag.onHandlePointerDown({ button: 0, pointerId: 1, clientX: 20, clientY: 20, currentTarget: editor, preventDefault() {}, stopPropagation() {} } as unknown as PointerEvent, SOURCE, 'pane-test');
  fireEvent.pointerUp(window, { clientX: 20, clientY: 20 });
  const expected = dirty ? '[[🟨]] Demo edited card' : '[[🟨]] Demo card';
  expect(blocks[SOURCE].content).toBe(expected);
  expect(editor.innerText).toBe(expected);
  expect(sync.displayContent()).toBe(expected);
  expect(paneStore.setFocusedBlockId).toHaveBeenLastCalledWith('pane-test', SOURCE);
});
