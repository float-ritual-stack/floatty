/**
 * Help Handler - cats documentation into the outliner
 *
 * Usage: help:: <topic>
 *
 * Topics: filter, keyboard, handlers, hooks, events, send, backup,
 *         full-width, eval, func, doors, echocopy, kanban
 */

import type { BlockHandler, ExecutorActions } from './types';
import { invoke } from '@tauri-apps/api/core';
import { parseMarkdownTree } from '../markdownParser';
import { insertParsedBlocksAtTop } from './utils';

// Map of help topics to their doc file paths (relative to project root)
const HELP_TOPICS: Record<string, string> = {
  filter: 'docs/guides/FILTER.md',
  keyboard: 'docs/KEYBOARD.md',
  handlers: 'docs/guides/ADDING_HANDLERS.md',
  hooks: 'docs/guides/HOOK_PATTERNS.md',
  events: 'docs/guides/EVENT_SYSTEM.md',
  send: 'docs/guides/SEND.md',
  backup: 'docs/guides/BACKUP.md',
  'full-width': 'docs/guides/FULL_WIDTH.md',
  fullwidth: 'docs/guides/FULL_WIDTH.md',
  eval: 'docs/guides/EVAL.md',
  func: 'docs/guides/FUNC.md',
  doors: 'docs/guides/DOORS.md',
  echocopy: 'docs/guides/ECHOCOPY.md',
  kanban: 'docs/guides/KANBAN.md',
  'render-kanban': 'docs/guides/KANBAN.md',
};

export const helpHandler: BlockHandler = {
  prefixes: ['help::'],

  async execute(blockId: string, content: string, actions: ExecutorActions) {
    // Extract topic from content
    const topic = content.replace(/^help::\s*/i, '').trim().toLowerCase();

    actions.setBlockStatus?.(blockId, 'running');

    // No topic provided - list available topics
    if (!topic) {
      const topics = Object.keys(HELP_TOPICS);
      const listBlock = actions.createBlockInside(blockId);
      actions.updateBlockContent(
        listBlock,
        `Available topics: ${topics.join(', ')}\n\nUsage: help:: <topic>`
      );
      actions.setBlockStatus?.(blockId, 'complete');
      return;
    }

    // Look up the doc file
    const docPath = HELP_TOPICS[topic];
    if (!docPath) {
      const outputId = actions.createBlockInside(blockId);
      actions.updateBlockContent(
        outputId,
        `Unknown topic: "${topic}"\n\nAvailable: ${Object.keys(HELP_TOPICS).join(', ')}`
      );
      actions.setBlockStatus?.(blockId, 'error');
      return;
    }

    try {
      // Read the doc file via Tauri command
      const markdown = await invoke<string>('read_help_file', { relativePath: docPath });

      // Parse markdown into hierarchical blocks and insert at top
      const parsed = parseMarkdownTree(markdown);
      insertParsedBlocksAtTop(blockId, parsed, actions);

      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      const errorId = actions.createBlockInsideAtTop?.(blockId) ?? actions.createBlockInside(blockId);
      actions.updateBlockContent(errorId, `Error loading help: ${err}`);
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};
