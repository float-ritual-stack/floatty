/**
 * blockContext.ts - Explicit discrete state for keyboard behavior
 *
 * FLO-74 Architecture: Make state that affects keyboard behavior explicit.
 * Instead of querying cursor/DOM on demand, we build a context object
 * that captures the discrete states the keyboard handler cares about.
 *
 * Benefits:
 * - Keyboard handler becomes a pure state machine
 * - Easier to test: mock context object, not cursor/DOM
 * - Clear what state affects what behavior
 * - Could visualize state in dev mode
 */

import type { Block } from './blockTypes';
import type { CursorState } from '../hooks/useCursor';

// ═══════════════════════════════════════════════════════════════
// DISCRETE STATE TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Cursor position relative to block content.
 * Discrete, not continuous - keyboard behavior only cares about these positions.
 */
export type CursorPosition = 'start' | 'middle' | 'end';

/**
 * Complete context needed for keyboard handling decisions.
 * All state that affects behavior is captured here.
 */
export interface BlockContext {
  // Block identity
  blockId: string;
  paneId: string;

  // Tree position
  depth: number;
  hasChildren: boolean;
  isCollapsed: boolean;
  isZoomedRoot: boolean;
  parentId: string | null;

  // Content state
  content: string;
  contentLength: number;
  isEmpty: boolean;
  blockType: Block['type'];

  // Cursor state (DISCRETE)
  cursorAt: CursorPosition;
  cursorOffset: number;
  hasTextSelection: boolean;  // Text is selected within the block

  // Multi-select state (FLO-74)
  isSelected: boolean;
  isAnchor: boolean;
  hasMultiSelection: boolean;  // Multiple blocks selected

  // Navigation context
  hasPrevBlock: boolean;
  hasNextBlock: boolean;
}

/**
 * Selection state passed from Outliner to BlockItem
 */
export interface SelectionState {
  selectedBlockIds: Set<string>;
  selectionAnchor: string | null;
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT BUILDERS
// ═══════════════════════════════════════════════════════════════

/**
 * Determine discrete cursor position from offset and content length
 */
export function determineCursorPosition(offset: number, contentLength: number): CursorPosition {
  if (offset === 0) return 'start';
  if (offset >= contentLength) return 'end';
  return 'middle';
}

/**
 * Build BlockContext from component state.
 * Call this before keyboard handling to snapshot all relevant state.
 */
export function buildBlockContext(
  block: Block,
  paneId: string,
  cursor: CursorState,
  options: {
    depth: number;
    isCollapsed: boolean;
    isZoomedRoot: boolean;
    selection: SelectionState;
    hasPrevBlock: boolean;
    hasNextBlock: boolean;
  }
): BlockContext {
  const offset = cursor.getOffset();
  const contentLength = block.content.length;

  return {
    // Block identity
    blockId: block.id,
    paneId,

    // Tree position
    depth: options.depth,
    hasChildren: block.childIds.length > 0,
    isCollapsed: options.isCollapsed,
    isZoomedRoot: options.isZoomedRoot,
    parentId: block.parentId,

    // Content state
    content: block.content,
    contentLength,
    isEmpty: contentLength === 0,
    blockType: block.type,

    // Cursor state (DISCRETE)
    cursorAt: determineCursorPosition(offset, contentLength),
    cursorOffset: offset,
    hasTextSelection: !cursor.isSelectionCollapsed(),

    // Multi-select state
    isSelected: options.selection.selectedBlockIds.has(block.id),
    isAnchor: options.selection.selectionAnchor === block.id,
    hasMultiSelection: options.selection.selectedBlockIds.size > 0,

    // Navigation context
    hasPrevBlock: options.hasPrevBlock,
    hasNextBlock: options.hasNextBlock,
  };
}

/**
 * Build minimal context for testing.
 * Allows testing keyboard behavior without full component setup.
 */
export function createTestBlockContext(overrides: Partial<BlockContext> = {}): BlockContext {
  return {
    blockId: 'test-block',
    paneId: 'test-pane',
    depth: 0,
    hasChildren: false,
    isCollapsed: false,
    isZoomedRoot: false,
    parentId: null,
    content: 'test content',
    contentLength: 12,
    isEmpty: false,
    blockType: 'text',
    cursorAt: 'middle',
    cursorOffset: 5,
    hasTextSelection: false,
    isSelected: false,
    isAnchor: false,
    hasMultiSelection: false,
    hasPrevBlock: true,
    hasNextBlock: true,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// STATE PREDICATES (for readable keyboard logic)
// ═══════════════════════════════════════════════════════════════

/**
 * Can navigate up? Cursor at start OR extending selection
 */
export function canNavigateUp(ctx: BlockContext, shiftKey: boolean): boolean {
  return shiftKey || ctx.cursorAt === 'start';
}

/**
 * Can navigate down? Cursor at end OR extending selection
 */
export function canNavigateDown(ctx: BlockContext, shiftKey: boolean): boolean {
  return shiftKey || ctx.cursorAt === 'end';
}

/**
 * Should Enter create block before? At start with content
 */
export function shouldCreateBefore(ctx: BlockContext): boolean {
  return ctx.cursorAt === 'start' && !ctx.isEmpty;
}

/**
 * Should Enter create first child? At end of expanded parent
 */
export function shouldCreateFirstChild(ctx: BlockContext): boolean {
  return ctx.cursorAt === 'end' && ctx.hasChildren && !ctx.isCollapsed;
}

/**
 * Should Tab indent/outdent structure? Cursor at absolute start
 */
export function isAtStructurePosition(ctx: BlockContext): boolean {
  return ctx.cursorAt === 'start';
}

/**
 * Can merge with previous block on Backspace?
 */
export function canMergeWithPrevious(ctx: BlockContext): boolean {
  return (
    ctx.cursorAt === 'start' &&
    !ctx.hasTextSelection &&
    !ctx.hasChildren &&
    ctx.hasPrevBlock
  );
}
