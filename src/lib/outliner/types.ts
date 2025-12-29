/**
 * types.ts - Core types for the outliner component
 *
 * These types define the contract between the outliner and your app.
 * Implement OutlinerStore with your preferred state management.
 */

// ═══════════════════════════════════════════════════════════════
// BLOCK TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Block types supported by the outliner.
 * 'text' is the default; others are detected from content prefixes.
 */
export type BlockType =
  | 'text'
  | 'h1' | 'h2' | 'h3'
  | 'bullet' | 'todo' | 'quote'
  | 'sh' | 'ai' | 'ctx' | 'dispatch' | 'web'
  | 'output' | 'error';

/**
 * Minimal block structure for the outliner.
 * Your app can extend this with additional fields.
 */
export interface OutlinerBlock {
  id: string;
  content: string;
  type: BlockType;
  parentId: string | null;
  childIds: string[];
  collapsed: boolean;
}

// ═══════════════════════════════════════════════════════════════
// STORE INTERFACE
// ═══════════════════════════════════════════════════════════════

/**
 * Store interface required by the outliner.
 * Implement this with your preferred state management (CRDT, Redux, etc.)
 */
export interface OutlinerStore<TBlock extends OutlinerBlock = OutlinerBlock> {
  // Read operations
  blocks: Record<string, TBlock>;
  rootIds: string[];
  getBlock(id: string): TBlock | undefined;

  // Write operations
  createBlockAfter(id: string): string | null;
  createBlockBefore(id: string): string | null;
  createBlockInside(parentId: string): string | null;
  createBlockInsideAtTop(parentId: string): string | null;
  splitBlock(id: string, offset: number): string | null;
  splitBlockToFirstChild(id: string, offset: number): string | null;
  updateBlockContent(id: string, content: string): void;
  deleteBlock(id: string): void;
  indentBlock(id: string): void;
  outdentBlock(id: string): void;
}

// ═══════════════════════════════════════════════════════════════
// KEYBOARD ACTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Actions returned by keyboard handlers.
 * Pure functions return these; the component executes them.
 */
export type KeyboardAction =
  | { type: 'none' }
  | { type: 'preventDefault' }
  | { type: 'zoom_out' }
  | { type: 'zoom_in' }
  | { type: 'toggle_collapse' }
  | { type: 'delete_block'; prevId: string | null }
  | { type: 'navigate_up'; prevId: string | null }
  | { type: 'navigate_down'; nextId: string | null }
  | { type: 'navigate_up_with_selection'; prevId: string | null }
  | { type: 'navigate_down_with_selection'; nextId: string | null }
  | { type: 'create_trailing_block'; parentId: string | null }
  | { type: 'execute_block' }
  | { type: 'create_block_before'; newId: string }
  | { type: 'create_block_inside'; newId: string }
  | { type: 'split_block'; newId: string | null; offset: number }
  | { type: 'split_to_child'; newId: string | null; offset: number }
  | { type: 'indent' }
  | { type: 'outdent' }
  | { type: 'insert_spaces' }
  | { type: 'remove_spaces'; count: number }
  | { type: 'merge_with_previous'; prevId: string };

// ═══════════════════════════════════════════════════════════════
// COMPONENT PROPS
// ═══════════════════════════════════════════════════════════════

/**
 * Props for the Outliner component.
 * Customization hooks for execution, styling, etc.
 */
export interface OutlinerProps {
  paneId: string;

  // Optional: execution callback (for sh::, ai::, etc.)
  onExecute?: (blockId: string, content: string) => void;
  isExecutable?: (content: string) => boolean;

  // Optional: class name customization
  classNames?: OutlinerClassNames;
}

/**
 * Customizable class names for styling.
 */
export interface OutlinerClassNames {
  container?: string;
  item?: string;
  focused?: string;
  selected?: string;
  bullet?: string;
  content?: string;
  children?: string;
}

/**
 * Props for BlockItem component.
 */
export interface BlockItemProps {
  id: string;
  paneId: string;
  depth: number;
  focusedBlockId: string | null;
  onFocus: (id: string) => void;

  // Multi-select (FLO-74)
  isBlockSelected?: (id: string) => boolean;
  onSelect?: (id: string, mode: 'set' | 'toggle' | 'range') => void;
  selectionAnchor?: string | null;
  getVisibleBlockIds?: () => string[];

  // Optional: class name customization
  classNames?: OutlinerClassNames;
}

// ═══════════════════════════════════════════════════════════════
// SELECTION STATE
// ═══════════════════════════════════════════════════════════════

/**
 * Multi-select state managed by Outliner.
 */
export interface SelectionState {
  selectedBlockIds: Set<string>;
  selectionAnchor: string | null;
}

// ═══════════════════════════════════════════════════════════════
// CURSOR STATE
// ═══════════════════════════════════════════════════════════════

/**
 * Cursor abstraction for testability.
 * Implement with DOM selection APIs in production.
 */
export interface CursorState {
  isAtStart(): boolean;
  isAtEnd(): boolean;
  getOffset(): number;
  setOffset(offset: number): void;
  isSelectionCollapsed(): boolean;
}
