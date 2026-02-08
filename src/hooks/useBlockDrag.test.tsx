import { render } from '@solidjs/testing-library';
import { describe, expect, it, vi } from 'vitest';
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
