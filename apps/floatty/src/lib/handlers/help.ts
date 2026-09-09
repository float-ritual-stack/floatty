/**
 * Help Handler - cats documentation into the outliner
 *
 * Usage: help:: <topic>
 *
 * Topics: keyboard, handlers, hooks, events, backup,
 *         full-width, eval, func, doors, echocopy, kanban, query, props
 */

import type { BlockHandler, ExecutorActions } from './types';
import { parseMarkdownTree } from '../markdownParser';
import { insertParsedBlocksAtTop } from './utils';

// The guides are bundled into the frontend at build time. The previous
// `read_help_file` Tauri command resolved `docs/` from CARGO_MANIFEST_DIR —
// the build machine's checkout path baked into the release binary — so
// `help::` only worked on the machine that built the app. Vite inlines
// every `docs/**/*.md` here; the key is the path from the app root.
const HELP_DOCS = import.meta.glob<string>('/docs/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Map of help topics to their doc file paths (relative to the app root)
const HELP_TOPICS: Record<string, string> = {
  keyboard: '/docs/KEYBOARD.md',
  handlers: '/docs/guides/ADDING_HANDLERS.md',
  hooks: '/docs/guides/HOOK_PATTERNS.md',
  events: '/docs/guides/EVENT_SYSTEM.md',
  backup: '/docs/guides/BACKUP.md',
  'full-width': '/docs/guides/FULL_WIDTH.md',
  fullwidth: '/docs/guides/FULL_WIDTH.md',
  eval: '/docs/guides/EVAL.md',
  func: '/docs/guides/FUNC.md',
  doors: '/docs/guides/DOORS.md',
  echocopy: '/docs/guides/ECHOCOPY.md',
  kanban: '/docs/guides/KANBAN.md',
  'render-kanban': '/docs/guides/KANBAN.md',
  // query-views track (ADR-009): standing query:: blocks + authored props
  query: '/docs/guides/QUERY.md',
  queries: '/docs/guides/QUERY.md',
  'query-views': '/docs/guides/QUERY.md',
  props: '/docs/guides/PROPS.md',
  properties: '/docs/guides/PROPS.md',
};

/** The bundled guide for a topic, or undefined when the map points at a file the build did not include. */
export function helpDocFor(topic: string): string | undefined {
  const docPath = HELP_TOPICS[topic];
  return docPath ? HELP_DOCS[docPath] : undefined;
}

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
      const markdown = HELP_DOCS[docPath];
      if (markdown === undefined) {
        throw new Error(`guide not bundled: ${docPath} — add it to the build (docs/**/*.md is inlined by Vite)`);
      }

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
