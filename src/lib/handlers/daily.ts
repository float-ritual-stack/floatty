/**
 * Daily View Handler (daily::)
 * 
 * Extracts structured data from daily notes and renders in calendar view.
 * Uses child-output pattern (output renders in a child block).
 */

import { invoke } from '../tauriTypes';
import type { BlockHandler, ExecutorActions } from './types';

// Re-export types for component use
export type {
  PrInfo,
  TimelogEntry,
  ScatteredThought,
  DayStats,
  DailyNoteData
} from '../tauriTypes';

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

const DAILY_PREFIX = 'daily::';

/**
 * Extract date argument from daily:: block content
 */
function extractDateArg(content: string): string {
  const trimmed = content.trim();
  const prefixEnd = trimmed.toLowerCase().indexOf(DAILY_PREFIX) + DAILY_PREFIX.length;
  return trimmed.slice(prefixEnd).trim();
}

/**
 * Find existing output child block (for re-run replacement)
 */
function findOutputChild(parentId: string, actions: ExecutorActions): string | null {
  if (!actions.getBlock) return null;
  
  const parent = actions.getBlock(parentId) as any;
  if (!parent) return null;

  for (const childId of parent.childIds) {
    const child = actions.getBlock(childId) as any;
    if (child?.outputType === 'daily-view' || child?.outputType === 'daily-error') {
      return childId;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// HANDLER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

export const dailyHandler: BlockHandler = {
  prefixes: ['daily::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const dateArg = extractDateArg(content);

    // Find or create output child
    let outputId = findOutputChild(blockId, actions);
    if (!outputId) {
      outputId = actions.createBlockInside(blockId);
    }

    if (!dateArg) {
      // No date specified - show error in child
      actions.updateBlockContent(outputId, 'error::No date specified. Use daily::today or daily::2026-01-03');
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(outputId, { error: 'No date specified' }, 'daily-error');
        actions.setBlockStatus(outputId, 'error');
      }
      return;
    }

    // Show loading indicator in child
    actions.updateBlockContent(outputId, 'output::Extracting...');
    if (actions.setBlockStatus) {
      actions.setBlockStatus(outputId, 'running');
    }

    try {
      console.log('[daily] Executing:', { dateArg });
      const data = await invoke('execute_daily_command', { dateArg });
      const duration = performance.now() - startTime;
      console.log('[daily] Complete:', { duration: `${duration.toFixed(1)}ms`, dataKeys: Object.keys(data as object) });

      // Store structured output in child block
      actions.updateBlockContent(outputId, ''); // Clear loading text, view renders from output
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(outputId, data, 'daily-view');
        actions.setBlockStatus(outputId, 'complete');
      }
    } catch (err) {
      console.error('[daily] Error:', err);
      actions.updateBlockContent(outputId, `error::${String(err)}`);
      if (actions.setBlockOutput && actions.setBlockStatus) {
        actions.setBlockOutput(outputId, { error: String(err) }, 'daily-error');
        actions.setBlockStatus(outputId, 'error');
      }
    }
  }
};
