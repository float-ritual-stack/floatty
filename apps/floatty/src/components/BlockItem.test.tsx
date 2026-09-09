/**
 * BlockItem.test.tsx - Phase 1 Verification
 *
 * Proves the Context Bridge works:
 * - BlockItem renders with mock stores
 * - No singleton imports crash the test
 * - Basic props flow correctly
 */
import { render, screen, fireEvent } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { describe, it, expect, vi } from 'vitest';
import { paneStore } from '../hooks/usePaneStore';
import { buildBacklinkIndex } from '../lib/backlinkIndex';
import { BlockItem } from './BlockItem';
import {
  WorkspaceProvider,
  createMockBlockStore,
  createMockPaneStore,
} from '../context/WorkspaceContext';
import { ConfigProvider } from '../context/ConfigContext';
import type { AggregatorConfig } from '../lib/tauriTypes';
import type { Block } from '../lib/blockTypes';

const mockConfig = { child_render_limit: 0 } as AggregatorConfig;

// Helper: create a minimal test block
function createTestBlock(id: string, content: string, overrides: Partial<Block> = {}): Block {
  return {
    id,
    content,
    type: 'text',
    parentId: null,
    childIds: [],
    collapsed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('BlockItem', () => {
  it('renders with mock stores (Context Bridge works)', () => {
    const testBlock = createTestBlock('block-1', 'Hello World');

    const mockBlockStore = createMockBlockStore({
      blocks: { 'block-1': testBlock },
      rootIds: ['block-1'],
    });

    const mockPaneStore = createMockPaneStore();

    render(() => (
      <ConfigProvider config={mockConfig}><WorkspaceProvider blockStore={mockBlockStore} paneStore={mockPaneStore}>
        <BlockItem
          id="block-1"
          paneId="pane-1"
          depth={0}
          focusedBlockId={null}
          onFocus={() => {}}
        />
      </WorkspaceProvider></ConfigProvider>
    ));

    // The block content should appear in the DOM
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('calls onFocus when block is clicked', async () => {
    const testBlock = createTestBlock('block-2', 'Clickable');
    const onFocus = vi.fn();

    const mockBlockStore = createMockBlockStore({
      blocks: { 'block-2': testBlock },
      rootIds: ['block-2'],
    });

    render(() => (
      <ConfigProvider config={mockConfig}><WorkspaceProvider blockStore={mockBlockStore} paneStore={createMockPaneStore()}>
        <BlockItem
          id="block-2"
          paneId="pane-1"
          depth={0}
          focusedBlockId={null}
          onFocus={onFocus}
        />
      </WorkspaceProvider></ConfigProvider>
    ));

    // Click the block
    screen.getByText('Clickable').click();

    // onFocus should be called with the block ID
    expect(onFocus).toHaveBeenCalledWith('block-2');
  });

  it('shows collapse arrow when block has children', () => {
    const parentBlock = createTestBlock('parent', 'Parent', {
      childIds: ['child-1'],
    });
    const childBlock = createTestBlock('child-1', 'Child', {
      parentId: 'parent',
    });

    const mockBlockStore = createMockBlockStore({
      blocks: {
        'parent': parentBlock,
        'child-1': childBlock,
      },
      rootIds: ['parent'],
    });

    render(() => (
      <ConfigProvider config={mockConfig}><WorkspaceProvider blockStore={mockBlockStore} paneStore={createMockPaneStore()}>
        <BlockItem
          id="parent"
          paneId="pane-1"
          depth={0}
          focusedBlockId={null}
          onFocus={() => {}}
        />
      </WorkspaceProvider></ConfigProvider>
    ));

    // Should show expand arrow (▾) for parent with children
    expect(screen.getByText('▾')).toBeInTheDocument();
  });
});

// ─── Paste handling (quirk-audit cluster C) ───────────────────────────

describe('BlockItem paste handling (cluster C)', () => {
  function renderWithPasteMocks(initialContent: string) {
    // Reactive store, not a plain object: BlockItem's block() memo and the
    // useContentSync sync effect both track store.blocks reactively. A plain
    // object leaves the memo permanently stale, and the sync effect then
    // clobbers the paste repair with pre-paste content — an artifact the
    // real Y.Doc-backed store doesn't have.
    const [blocks, setBlocks] = createStore<Record<string, Block>>({
      'p1': createTestBlock('p1', initialContent),
    });
    const updateBlockContent = vi.fn((id: string, content: string) => {
      setBlocks(id, 'content', content);
    });
    const batchCreateBlocksInside = vi.fn(() => ['c1']);
    const batchCreateBlocksAfter = vi.fn(() => []);

    const mockBlockStore = createMockBlockStore({
      blocks,
      rootIds: ['p1'],
      getBlock: (id: string) => blocks[id],
      updateBlockContent,
      batchCreateBlocksInside,
      batchCreateBlocksAfter,
    });

    const { container } = render(() => (
      <ConfigProvider config={mockConfig}><WorkspaceProvider blockStore={mockBlockStore} paneStore={createMockPaneStore()}>
        <BlockItem
          id="p1"
          paneId="pane-1"
          depth={0}
          focusedBlockId={null}
          onFocus={() => {}}
        />
      </WorkspaceProvider></ConfigProvider>
    ));

    const ce = container.querySelector('.block-edit') as HTMLDivElement;
    expect(ce).toBeTruthy();
    return { ce, updateBlockContent, batchCreateBlocksInside };
  }

  function dispatchPaste(target: HTMLElement, text: string) {
    const evt = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(evt, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? text : '') },
    });
    target.dispatchEvent(evt);
    return evt;
  }

  it('repairs the focused CE after structured paste into an empty block (C1)', () => {
    const { ce, updateBlockContent } = renderWithPasteMocks('');

    // Structured markdown: heading + child → handleStructuredPaste rewrites
    // the empty anchor block in the STORE. Without the repair, the DOM would
    // stay empty and the next keystroke would overwrite the pasted content.
    dispatchPaste(ce, '# Section\n- item under it');

    expect(updateBlockContent).toHaveBeenCalledWith('p1', '# Section');
    // THE fix: the focused CE's DOM now shows the store content.
    expect(ce.innerText).toBe('# Section');
  });

  it('inserts unhandled paste as plain text via execCommand, never browser default (C2)', () => {
    const { ce, updateBlockContent } = renderWithPasteMocks('existing');

    const execSpy = vi.fn();
    (document as Document & { execCommand: typeof execSpy }).execCommand = execSpy;

    // Single flat line → handleStructuredPaste returns handled:false.
    const evt = dispatchPaste(ce, 'just plain text');

    // Browser default must be suppressed (it would insert rich HTML that
    // defeats the transparent-text overlay) and replaced with insertText.
    expect(evt.defaultPrevented).toBe(true);
    expect(execSpy).toHaveBeenCalledWith('insertText', false, 'just plain text');
    expect(updateBlockContent).not.toHaveBeenCalledWith('p1', 'just plain text');
  });
});

describe('BlockItem ⟲n inbound chip (FLO-440 U5)', () => {
  it('renders the count from the injected backlink index and opens the drawer on click', () => {
    const testBlock = createTestBlock('block-linked', 'A block with inbound');
    const mockBlockStore = createMockBlockStore({
      blocks: { 'block-linked': testBlock },
      rootIds: ['block-linked'],
    });
    const setDrawerOpen = vi.fn();
    const setFocusedBlockId = vi.fn();
    const mockPaneStore = createMockPaneStore({ setDrawerOpen, setFocusedBlockId });
    const index = {
      referencing: (id: string) => (id === 'block-linked' ? ['src-a', 'src-b', 'src-c'] : []),
      canonicalTargetKey: () => null,
      ambiguousTargets: [] as string[],
    };

    const { container } = render(() => (
      <ConfigProvider config={mockConfig}>
        <WorkspaceProvider blockStore={mockBlockStore} paneStore={mockPaneStore} backlinkIndex={() => index}>
          <BlockItem id="block-linked" paneId="pane-1" depth={0} focusedBlockId={null} onFocus={() => {}} />
        </WorkspaceProvider>
      </ConfigProvider>
    ));

    const chip = container.querySelector('.block-inbound-chip') as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toBe('⟲3');
    // not a tab stop — the drawer's own controls carry the keyboard path
    expect(chip.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(chip);
    expect(setFocusedBlockId).toHaveBeenCalledWith('pane-1', 'block-linked');
    expect(setDrawerOpen).toHaveBeenCalledWith('pane-1', true);
  });

  it('renders no chip for a block with zero inbound', () => {
    const testBlock = createTestBlock('block-lonely', 'No links here');
    const mockBlockStore = createMockBlockStore({
      blocks: { 'block-lonely': testBlock },
      rootIds: ['block-lonely'],
    });
    const { container } = render(() => (
      <ConfigProvider config={mockConfig}>
        <WorkspaceProvider blockStore={mockBlockStore} paneStore={createMockPaneStore()}>
          <BlockItem id="block-lonely" paneId="pane-1" depth={0} focusedBlockId={null} onFocus={() => {}} />
        </WorkspaceProvider>
      </ConfigProvider>
    ));
    expect(container.querySelector('.block-inbound-chip')).toBeNull();
  });
});


describe('query output focus routing', () => {
  it('enters rows from its line and from below, and Escape restores the editable line', () => {
    vi.useFakeTimers();
    const originalScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      const queryId = '00000000-0000-4000-8000-000000000001';
      const afterId = '00000000-0000-4000-8000-000000000002';
      const firstId = '00000000-0000-4000-8000-000000000003';
      const lastId = '00000000-0000-4000-8000-000000000004';
      const blocks = {
        [queryId]: createTestBlock(queryId, 'query:: text~Demo', { type: 'query' }),
        [afterId]: createTestBlock(afterId, 'after'),
        [firstId]: createTestBlock(firstId, 'Demo Alice', { updatedAt: 20 }),
        [lastId]: createTestBlock(lastId, 'Demo Bob', { updatedAt: 10 }),
      };
      const [focused, setFocused] = createSignal<string | null>(queryId);
      let hint: 'start' | 'end' | null = null;
      const paneStore = createMockPaneStore({
        getFocusedBlockId: () => focused(),
        setFocusCursorHint: (_pane, value) => { hint = value; },
        consumeFocusCursorHint: () => { const value = hint; hint = null; return value; },
      });
      const blockStore = createMockBlockStore({ blocks, rootIds: [queryId, afterId, firstId, lastId], getBlock: (id) => blocks[id] });
      const { container, unmount } = render(() => (
        <ConfigProvider config={mockConfig}><WorkspaceProvider blockStore={blockStore} paneStore={paneStore}>
          <BlockItem id={queryId} paneId="pane-test" depth={0} focusedBlockId={focused()} onFocus={setFocused} />
          <BlockItem id={afterId} paneId="pane-test" depth={0} focusedBlockId={focused()} onFocus={setFocused} />
        </WorkspaceProvider></ConfigProvider>
      ));
      const line = container.querySelector<HTMLElement>(`[data-block-id="${queryId}"] [contenteditable]`)!;
      const after = container.querySelector<HTMLElement>(`[data-block-id="${afterId}"] [contenteditable]`)!;
      const wrapper = container.querySelector<HTMLElement>('.query-block-display')!;
      const highlight = () => container.querySelector('.blockref-row-focused')?.getAttribute('data-source-block-id');
      const place = (element: HTMLElement, atEnd: boolean) => {
        element.focus();
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(!atEnd);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      };
      vi.runOnlyPendingTimers();
      // jsdom stores innerText without creating the browser's text nodes.
      line.textContent = blocks[queryId].content;
      after.textContent = blocks[afterId].content;
      place(line, true);
      fireEvent.keyDown(line, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(wrapper);
      expect(highlight()).toBe(firstId);
      fireEvent.keyDown(wrapper, { key: 'Escape' });
      expect(document.activeElement).toBe(line);
      expect(window.getSelection()?.isCollapsed).toBe(true);
      setFocused(afterId);
      vi.runOnlyPendingTimers();
      place(after, false);
      fireEvent.keyDown(after, { key: 'ArrowUp' });
      vi.runOnlyPendingTimers();
      expect(document.activeElement).toBe(wrapper);
      expect(highlight()).toBe(lastId);
      fireEvent.keyDown(wrapper, { key: 'ArrowDown' });
      expect(focused()).toBe(afterId);
      unmount();
    } finally {
      Element.prototype.scrollIntoView = originalScroll;
      vi.useRealTimers();
    }
  });
});

it('the query bullet collapses real children and projected rows together', () => {
  const query = '00000000-0000-4000-8000-000000000081';
  const child = '00000000-0000-4000-8000-000000000082';
  const card = '00000000-0000-4000-8000-000000000083';
  const blocks: Record<string, Block> = {
    [query]: createTestBlock(query, 'query:: link:⬜', { type: 'query', childIds: [child] }),
    [child]: createTestBlock(child, 'Demo real child', { parentId: query }),
    [card]: createTestBlock(card, '[[⬜]] Demo projected card'),
  };
  paneStore.setCollapsed('pane-collapse', query, false);
  const { container } = render(() => <ConfigProvider config={mockConfig}>
    <WorkspaceProvider blockStore={createMockBlockStore({ blocks, rootIds: [query, card], getBlock: (id) => blocks[id] })}
      paneStore={paneStore} backlinkIndex={() => buildBacklinkIndex(blocks, [query, card])}>
      <BlockItem id={query} paneId="pane-collapse" depth={0} onFocus={() => {}} />
    </WorkspaceProvider>
  </ConfigProvider>);
  const bullet = container.querySelector('.block-bullet')!;
  expect(container.querySelector('.blockref-row')).not.toBeNull();
  expect(container.querySelector(`[data-block-id="${child}"]`)).not.toBeNull();
  fireEvent.pointerDown(bullet);
  expect(bullet.textContent).toBe('▸');
  expect(container.querySelector('.blockref-row')).toBeNull();
  expect(container.querySelector(`[data-block-id="${child}"]`)).toBeNull();
  expect(container.querySelector('.query-block-count')?.textContent).toBe('1 of 1');
  fireEvent.pointerDown(bullet);
  expect(container.querySelector('.blockref-row')).not.toBeNull();
  expect(container.querySelector(`[data-block-id="${child}"]`)).not.toBeNull();
});
