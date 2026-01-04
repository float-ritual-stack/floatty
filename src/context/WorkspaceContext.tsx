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
import { createContext, useContext } from 'solid-js';
import type { JSX } from 'solid-js';
import { blockStore as realBlockStore } from '../hooks/useBlockStore';
import { paneStore as realPaneStore } from '../hooks/usePaneStore';
import type { Block } from '../lib/blockTypes';

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
  getBlock: (id: string) => Block | undefined;
  updateBlockContent: (id: string, content: string) => void;
  createBlockBefore: (beforeId: string) => string;
  createBlockAfter: (afterId: string) => string;
  createBlockInside: (parentId: string) => string;
  createBlockInsideAtTop: (parentId: string) => string;
  createRootBlock: (content: string) => string;
  splitBlock: (id: string, offset: number) => string | null;
  splitBlockToFirstChild: (id: string, offset: number) => string | null;
  deleteBlock: (id: string) => boolean;
  indentBlock: (id: string) => void;
  outdentBlock: (id: string) => void;
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
  const value: WorkspaceContextValue = {
    blockStore: props.blockStore ?? realBlockStore,
    paneStore: props.paneStore ?? realPaneStore,
  };

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
    createBlockBefore: () => '',
    createBlockAfter: () => '',
    createBlockInside: () => '',
    createBlockInsideAtTop: () => '',
    createRootBlock: () => '',
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
