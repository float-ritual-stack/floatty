/**
 * BlockItem.test.tsx - Phase 1 Verification
 *
 * Proves the Context Bridge works:
 * - BlockItem renders with mock stores
 * - No singleton imports crash the test
 * - Basic props flow correctly
 */
import { render, screen } from '@solidjs/testing-library';
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
