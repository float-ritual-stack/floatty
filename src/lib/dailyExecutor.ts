/**
 * Daily View Executor
 *
 * Handles `daily::` blocks - extracts structured data from daily notes.
 * Uses child-output pattern (like sh::, ai::) - output renders in a child block.
 *
 * See docs/BLOCK_TYPE_PATTERNS.md for pattern details.
 */

import { invoke } from './tauriTypes';

// Re-export types for component use
export type {
  PrInfo,
  TimelogEntry,
  ScatteredThought,
  DayStats,
  DailyNoteData
} from './tauriTypes';

// ═══════════════════════════════════════════════════════════════
// DETECTION
// ═══════════════════════════════════════════════════════════════

const DAILY_PREFIX = 'daily::';

/**
 * Check if content is a daily:: block
 */
export function isDailyBlock(content: string): boolean {
  return content.trim().toLowerCase().startsWith(DAILY_PREFIX);
}

/**
 * Extract date argument from daily:: block content
 */
export function extractDateArg(content: string): string {
  const trimmed = content.trim();
  const prefixEnd = trimmed.toLowerCase().indexOf(DAILY_PREFIX) + DAILY_PREFIX.length;
  return trimmed.slice(prefixEnd).trim();
}

// ═══════════════════════════════════════════════════════════════
// EXECUTION
// ═══════════════════════════════════════════════════════════════

import type { Block } from './blockTypes';

export interface DailyExecutorActions {
  /** Create a child block inside parent */
  createBlockInside: (parentId: string) => string;
  /** Update block content */
  updateContent: (id: string, content: string) => void;
  /** Set the output data on a block */
  setBlockOutput: (id: string, output: unknown, outputType: string) => void;
  /** Set the loading status on a block */
  setBlockStatus: (id: string, status: Block['outputStatus']) => void;
  /** Delete a block */
  deleteBlock: (id: string) => void;
  /** Get block by ID */
  getBlock: (id: string) => Block | undefined;
}

/**
 * Find existing output child block (for re-run replacement)
 */
function findOutputChild(parentId: string, actions: DailyExecutorActions): string | null {
  const parent = actions.getBlock(parentId);
  if (!parent) return null;

  for (const childId of parent.childIds) {
    const child = actions.getBlock(childId);
    if (child?.outputType === 'daily-view' || child?.outputType === 'daily-error') {
      return childId;
    }
  }
  return null;
}

/**
 * Execute a daily:: block
 *
 * Creates a child block for output (child-output pattern).
 * Re-running replaces existing output child.
 */
export async function executeDailyBlock(
  blockId: string,
  content: string,
  actions: DailyExecutorActions
): Promise<void> {
  const dateArg = extractDateArg(content);

  // Find or create output child
  let outputId = findOutputChild(blockId, actions);
  if (!outputId) {
    outputId = actions.createBlockInside(blockId);
  }

  if (!dateArg) {
    // No date specified - show error in child
    actions.updateContent(outputId, 'error::No date specified. Use daily::today or daily::2026-01-03');
    actions.setBlockOutput(outputId, { error: 'No date specified' }, 'daily-error');
    actions.setBlockStatus(outputId, 'error');
    return;
  }

  // Show loading indicator in child
  actions.updateContent(outputId, 'output::Extracting...');
  actions.setBlockStatus(outputId, 'running');

  try {
    // Call Rust command to extract structured data
    const data = await invoke<DailyNoteData>('execute_daily_command', { dateArg });

    // Store structured output in child block
    actions.updateContent(outputId, ''); // Clear loading text, view renders from output
    actions.setBlockOutput(outputId, data, 'daily-view');
    actions.setBlockStatus(outputId, 'complete');
  } catch (err) {
    console.error('[dailyExecutor] Error:', err);
    actions.updateContent(outputId, `error::${String(err)}`);
    actions.setBlockOutput(outputId, { error: String(err) }, 'daily-error');
    actions.setBlockStatus(outputId, 'error');
  }
}
