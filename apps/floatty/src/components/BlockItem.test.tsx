/**
 * BlockItem.test.tsx - Phase 1 Verification
 *
 * Proves the Context Bridge works:
 * - BlockItem renders with mock stores
 * - No singleton imports crash the test
 * - Basic props flow correctly
 */
import { render, screen } from '@solidjs/testing-library';
import { createStore } from 'solid-js/store';
import { describe, it, expect, vi } from 'vitest';
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
