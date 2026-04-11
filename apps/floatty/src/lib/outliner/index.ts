/**
 * Outliner - Reusable block-based outliner component
 *
 * Usage:
 *   import { BlockContext, KeyboardAction, OutlinerStore } from './lib/outliner';
 *
 * See README.md for integration guide.
 */

// Core types
export type {
  BlockType,
  OutlinerBlock,
  OutlinerStore,
  KeyboardAction,
  OutlinerProps,
  OutlinerClassNames,
  BlockItemProps,
  SelectionState,
  CursorState,
} from './types';

// BlockContext (discrete state)
export {
  type BlockContext,
  type CursorPosition,
  determineCursorPosition,
  buildBlockContext,
  createTestBlockContext,
  canNavigateUp,
  canNavigateDown,
  shouldCreateBefore,
  shouldCreateFirstChild,
  isAtStructurePosition,
  canMergeWithPrevious,
} from '../blockContext';

// Re-export from existing locations for now
// (will consolidate in future refactor)
export { determineKeyAction } from '../../hooks/useBlockInput';
