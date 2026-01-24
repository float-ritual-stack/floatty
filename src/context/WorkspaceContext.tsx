/**
 * WorkspaceContext - Dependency Injection for Block Stores
 *
 * This context enables testing by allowing mock stores to be injected.
 * Production code uses the real singletons; tests inject mocks.
 *
 * Usage in components:
 *   const { blockStore, paneStore } = useWorkspace();
 *
 * Usage in tests:
 *   render(() => (
 *     <WorkspaceProvider blockStore={mockBlockStore} paneStore={mockPaneStore}>
 *       <BlockItem {...props} />
 *     </WorkspaceProvider>
 *   ));
 */
import { createContext, useContext, onMount, onCleanup } from 'solid-js';
import type { JSX } from 'solid-js';
import { blockStore as realBlockStore, setAutoExecuteHandler } from '../hooks/useBlockStore';
import { paneStore as realPaneStore } from '../hooks/usePaneStore';
import type { Block } from '../lib/blockTypes';
import { registry, executeHandler, createHookBlockStore } from '../lib/handlers';

// ═══════════════════════════════════════════════════════════════
// STORE TYPE INTERFACES
// ═══════════════════════════════════════════════════════════════

/**
 * BlockStore interface - what components need from blockStore
 * This is the contract that mock stores must implement.
 */
export interface BlockStoreInterface {
  readonly blocks: Record<string, Block>;
  readonly rootIds: string[];
  readonly isInitialized: boolean;
  /** Origin of last Y.Doc transaction - 'user' for typing, UndoManager for undo/redo */
  readonly lastUpdateOrigin: unknown;
  getBlock: (id: string) => Block | undefined;
  updateBlockContent: (id: string, content: string) => void;
  updateBlockContentFromExecutor: (id: string, content: string) => void;
  setBlockOutput: (id: string, output: unknown, outputType: string, status?: Block['outputStatus']) => void;
  setBlockStatus: (id: string, status: Block['outputStatus']) => void;
  createBlockBefore: (beforeId: string) => string;
  createBlockAfter: (afterId: string) => string;
  createBlockInside: (parentId: string) => string;
  createBlockInsideAtTop: (parentId: string) => string;
  splitBlock: (id: string, offset: number) => string | null;
  splitBlockToFirstChild: (id: string, offset: number) => string | null;
  deleteBlock: (id: string) => boolean;
  indentBlock: (id: string) => void;
  outdentBlock: (id: string) => void;
  liftChildrenToSiblings: (blockId: string, afterId: string) => void;
  toggleCollapsed: (id: string) => void;
}

/**
 * PaneStore interface - what components need from paneStore
 */
export interface PaneStoreInterface {
  toggleCollapsed: (paneId: string, blockId: string) => void;
  isCollapsed: (paneId: string, blockId: string, defaultCollapsed: boolean) => boolean;
  setCollapsed: (paneId: string, blockId: string, collapsed: boolean) => void;
  getZoomedRootId: (paneId: string) => string | null;
  setZoomedRoot: (paneId: string, blockId: string | null) => void;
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════════════

export interface WorkspaceContextValue {
  blockStore: BlockStoreInterface;
  paneStore: PaneStoreInterface;
}

const WorkspaceContext = createContext<WorkspaceContextValue>();

// ═══════════════════════════════════════════════════════════════
// PROVIDER
// ═══════════════════════════════════════════════════════════════

interface WorkspaceProviderProps {
  children: JSX.Element;
  blockStore?: BlockStoreInterface;
  paneStore?: PaneStoreInterface;
}

/**
 * WorkspaceProvider - Wraps app to provide store access
 *
 * In production: uses real singletons (default)
 * In tests: accepts mock stores via props
 */
export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const store = props.blockStore ?? realBlockStore;
  const value: WorkspaceContextValue = {
    blockStore: store,
    paneStore: props.paneStore ?? realPaneStore,
  };

  // Wire up auto-execute handler for externally-created blocks (API/CRDT sync)
  onMount(() => {
    setAutoExecuteHandler((blockId: string, content: string) => {
      console.log('[AutoExecute] External block detected:', blockId, content);

      const handler = registry.findHandler(content);
      if (handler) {
        // Create hook-compatible block store adapter
        // Note: No zoomedRootId for auto-execute - external blocks see full document
        // (no pane context exists for CRDT sync-triggered execution)
        const hookStore = createHookBlockStore(
          store.getBlock,
          store.blocks,
          store.rootIds,
          undefined  // No zoom scope for external execution
        );

        // Execute through hook-aware executor
        executeHandler(handler, blockId, content, {
          createBlockInside: store.createBlockInside,
          createBlockInsideAtTop: store.createBlockInsideAtTop,
          createBlockAfter: store.createBlockAfter,
          updateBlockContent: store.updateBlockContent,
          updateBlockContentFromExecutor: store.updateBlockContentFromExecutor,
          deleteBlock: store.deleteBlock,
          setBlockOutput: store.setBlockOutput,
          setBlockStatus: store.setBlockStatus,
          getBlock: store.getBlock,
          getParentId: (id: string) => store.getBlock(id)?.parentId ?? undefined,
          getChildren: (id: string) => store.getBlock(id)?.childIds ?? [],
          rootIds: store.rootIds,
        }, hookStore).catch(err => {
          console.error('[AutoExecute] Handler execution failed:', err);
        });
      }
      // Future: handle other auto-executable types (web::, query::, etc.)
    });
  });

  onCleanup(() => {
    setAutoExecuteHandler(null);
  });

  return (
    <WorkspaceContext.Provider value={value}>
      {props.children}
    </WorkspaceContext.Provider>
  );
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

/**
 * useWorkspace - Access block and pane stores
 *
 * Must be called within WorkspaceProvider.
 * Throws if context is missing (dev error, not runtime).
 */
export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used within a WorkspaceProvider');
  }
  return context;
}

// ═══════════════════════════════════════════════════════════════
// TEST UTILITIES
// ═══════════════════════════════════════════════════════════════

/**
 * Create a minimal mock block store for tests
 * Override specific methods as needed.
 */
export function createMockBlockStore(overrides: Partial<BlockStoreInterface> = {}): BlockStoreInterface {
  return {
    blocks: {},
    rootIds: [],
    isInitialized: true,
    getBlock: () => undefined,
    updateBlockContent: () => {},
    updateBlockContentFromExecutor: () => {},
    setBlockOutput: () => {},
    setBlockStatus: () => {},
    createBlockBefore: () => '',
    createBlockAfter: () => '',
    createBlockInside: () => '',
    createBlockInsideAtTop: () => '',
    splitBlock: () => null,
    splitBlockToFirstChild: () => null,
    deleteBlock: () => false,
    indentBlock: () => {},
    outdentBlock: () => {},
    toggleCollapsed: () => {},
    ...overrides,
  };
}

/**
 * Create a minimal mock pane store for tests
 */
export function createMockPaneStore(overrides: Partial<PaneStoreInterface> = {}): PaneStoreInterface {
  return {
    toggleCollapsed: () => {},
    isCollapsed: () => false,
    setCollapsed: () => {},
    getZoomedRootId: () => null,
    setZoomedRoot: () => {},
    ...overrides,
  };
}
