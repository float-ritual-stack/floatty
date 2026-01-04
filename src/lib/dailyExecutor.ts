/**
 * Daily View Executor
 *
 * Handles `daily::` blocks - extracts structured data from daily notes
 * and stores it in the block's output field for inline rendering.
 *
 * Unlike sh::/ai:: which create child output blocks, daily:: blocks
 * render their structured data INLINE using a custom component.
 */

import { invoke } from '@tauri-apps/api/core';

// ═══════════════════════════════════════════════════════════════
// TYPES (matches Rust DailyNoteData)
// ═══════════════════════════════════════════════════════════════

export interface PrInfo {
  num: number;
  status: 'open' | 'merged' | 'closed';
}

export interface TimelogEntry {
  time: string;
  project: string | null;
  mode: string | null;
  issue: string | null;
  meeting: string | null;
  summary: string;
  details: string[];
  phases: string[];
  prs: PrInfo[];
}

export interface ScatteredThought {
  title: string;
  content: string;
}

export interface DayStats {
  sessions: number;
  hours: string;
  prs: number;
}

export interface DailyNoteData {
  date: string;
  day_of_week: string;
  stats: DayStats;
  timelogs: TimelogEntry[];
  scattered_thoughts: ScatteredThought[];
}

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
  /** Set the output data on a block */
  setBlockOutput: (id: string, output: unknown, outputType: string) => void;
  /** Set the loading status on a block */
  setBlockStatus: (id: string, status: Block['outputStatus']) => void;
}

/**
 * Execute a daily:: block
 *
 * Calls the Rust command to extract structured data from the daily note,
 * then stores it in the block's output field.
 */
export async function executeDailyBlock(
  blockId: string,
  content: string,
  actions: DailyExecutorActions
): Promise<void> {
  const dateArg = extractDateArg(content);

  if (!dateArg) {
    // No date specified - show error inline
    actions.setBlockOutput(blockId, { error: 'No date specified. Use daily::today or daily::2026-01-03' }, 'daily-error');
    return;
  }

  // Show loading indicator
  actions.setBlockStatus(blockId, 'running');

  try {
    // Call Rust command to extract structured data
    const data = await invoke<DailyNoteData>('execute_daily_command', { dateArg });

    // Store structured output in block (automatically sets status to 'complete')
    actions.setBlockOutput(blockId, data, 'daily-view');
  } catch (err) {
    console.error('[dailyExecutor] Error:', err);
    actions.setBlockOutput(blockId, { error: String(err) }, 'daily-error');
  }
}
