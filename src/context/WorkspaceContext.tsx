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
import { createContext, useContext, createMemo, onMount, onCleanup } from 'solid-js';
import type { JSX, Accessor } from 'solid-js';
import { blockStore as realBlockStore, setAutoExecuteHandler, type BatchBlockOp } from '../hooks/useBlockStore';
export type { BatchBlockOp } from '../hooks/useBlockStore';
import { paneStore as realPaneStore, type NavigationEntry } from '../hooks/usePaneStore';
import type { Block } from '../lib/blockTypes';
import { registry, executeHandler, createHookBlockStore } from '../lib/handlers';
import { sortPageNames, getPageNamesWithTimestamps } from '../hooks/useWikilinkAutocomplete';

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
  moveBlock: (
    blockId: string,
    targetParentId: string | null,
    targetIndex: number,
    opts?: {
      position?: 'above' | 'below' | 'inside';
      targetId?: string | null;
      sourcePaneId?: string;
      targetPaneId?: string;
      origin?: 'user-drag' | 'user';
    }
  ) => boolean;
  moveBlockUp: (id: string) => boolean;
  moveBlockDown: (id: string) => boolean;
  deleteBlock: (id: string) => boolean;
  indentBlock: (id: string) => void;
  outdentBlock: (id: string) => void;
  liftChildrenToSiblings: (blockId: string, afterId: string) => void;
  toggleCollapsed: (id: string) => void;
  // FLO-322: Batch block creation (single Y.Doc transaction)
  batchCreateBlocksAfter: (afterId: string, ops: BatchBlockOp[], origin?: string) => string[];
  batchCreateBlocksInside: (parentId: string, ops: BatchBlockOp[], origin?: string) => string[];
  batchCreateBlocksInsideAtTop: (parentId: string, ops: BatchBlockOp[], origin?: string) => string[];
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
  // FLO-77: Focused block tracking
  getFocusedBlockId: (paneId: string) => string | null;
  setFocusedBlockId: (paneId: string, blockId: string | null) => void;
  // Ephemeral cursor hints for navigation direction
  setFocusCursorHint: (paneId: string, hint: 'start' | 'end') => void;
  consumeFocusCursorHint: (paneId: string) => 'start' | 'end' | null;
  // FLO-180: Navigation history
  pushNavigation: (paneId: string, zoomedRootId: string | null, focusedBlockId?: string) => void;
  goBack: (paneId: string, blockExists: (blockId: string) => boolean) => NavigationEntry | null;
  goForward: (paneId: string, blockExists: (blockId: string) => boolean) => NavigationEntry | null;
  canGoBack: (paneId: string) => boolean;
  canGoForward: (paneId: string) => boolean;
  // FLO-211: Unified navigation API
  zoomTo: (paneId: string, targetBlockId: string | null, options?: { skipHistory?: boolean; skipAutoExpand?: boolean; originBlockId?: string }) => void;
  consumeHistoryNavigation: (paneId: string) => boolean;
  // Unit 12.0: Full-width block mode
  toggleFullWidth: (paneId: string, blockId: string) => void;
  isFullWidth: (paneId: string, blockId: string) => boolean;
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════════════

export interface WorkspaceContextValue {
  blockStore: BlockStoreInterface;
  paneStore: PaneStoreInterface;
  /** Singleton pageNames memo — sorted page names from pages:: container (FLO-322). */
  pageNames: Accessor<string[]>;
  /** Lowercase page name Set for O(1) stub detection in wikilink rendering. */
  pageNameSet: Accessor<Set<string>>;
  /** Short-hash index: 8-char prefix → full UUID (empty string = ambiguous). */
  shortHashIndex: Accessor<Map<string, string>>;
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

  // FLO-322: Singleton pageNames memo — one computation instead of N per BlockItem.
  // Previously each useWikilinkAutocomplete() created its own identical memo,
  // causing N×M recomputation on every block change (N blocks × M page lookups).
  const pageNames = createMemo(() =>
    sortPageNames(getPageNamesWithTimestamps(store))
  );

  const pageNameSet = createMemo(() =>
    new Set(pageNames().map(n => n.toLowerCase()))
  );

  // Short-hash index: 8-char prefix → full UUID. Empty string marks ambiguous prefixes.
  const shortHashIndex = createMemo(() => {
    const ids = Object.keys(store.blocks);
    const index = new Map<string, string>();
    for (const id of ids) {
      const prefix = id.slice(0, 8);
      if (index.has(prefix)) {
        index.set(prefix, ''); // Ambiguous
      } else {
        index.set(prefix, id);
      }
    }
    return index;
  });

  const value: WorkspaceContextValue = {
    blockStore: store,
    paneStore: props.paneStore ?? realPaneStore,
    pageNames,
    pageNameSet,
    shortHashIndex,
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
          // FLO-322: Batch block creation for bulk output
          batchCreateBlocksAfter: store.batchCreateBlocksAfter,
          batchCreateBlocksInside: store.batchCreateBlocksInside,
          batchCreateBlocksInsideAtTop: store.batchCreateBlocksInsideAtTop,
          moveBlock: (blockId, targetParentId, targetIndex) =>
            store.moveBlock(blockId, targetParentId, targetIndex, { origin: 'user' }),
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
    lastUpdateOrigin: null,
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
    moveBlock: () => false,
    moveBlockUp: () => false,
    moveBlockDown: () => false,
    deleteBlock: () => false,
    indentBlock: () => {},
    outdentBlock: () => {},
    liftChildrenToSiblings: () => {},
    toggleCollapsed: () => {},
    batchCreateBlocksAfter: () => [],
    batchCreateBlocksInside: () => [],
    batchCreateBlocksInsideAtTop: () => [],
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
    // FLO-77: Focused block tracking
    getFocusedBlockId: () => null,
    setFocusedBlockId: () => {},
    // Ephemeral cursor hints
    setFocusCursorHint: () => {},
    consumeFocusCursorHint: () => null,
    // FLO-180: Navigation history
    pushNavigation: () => {},
    goBack: () => null,
    goForward: () => null,
    canGoBack: () => false,
    canGoForward: () => false,
    // FLO-211: Unified navigation API
    zoomTo: () => {},
    consumeHistoryNavigation: () => false,
    // Unit 12.0: Full-width
    toggleFullWidth: () => {},
    isFullWidth: () => false,
    ...overrides,
  };
}
