/**
 * echoCopy:: handler — FLO-582
 *
 * Materializes rendered content from a door output block as plain
 * markdown blocks in the outline. No LLM, no API call — reads
 * metadata.renderedMarkdown (populated by outputSummaryHook) and
 * falls back to flattenSpecToMarkdown() for blocks that predate
 * the hook.
 *
 * Usage:
 *   echoCopy:: [[c229bfa9]]     → short-hash ref
 *   echoCopy:: [[My Page]]      → page name ref
 *   echoCopy:: c229bfa9de12...  → bare UUID/prefix
 */

import type { BlockHandler, ExecutorActions } from './types';
import { blockStore } from '../../hooks/useBlockStore';
import { resolveBlockIdPrefix } from '../blockTypes';
import { parseMarkdownTree } from '../markdownParser';
import { extractContent, insertParsedBlocks } from './utils';
import { flattenSpecToMarkdown } from './hooks/outputSummaryHook';
import { parseBracketedWikilink } from '../doorStdlib';
import { findPage } from '../../hooks/useBacklinkNavigation';
import { createLogger } from '../logger';

const logger = createLogger('echoCopy');

/**
 * Extract block reference from handler content.
 * Supports [[wikilink]] form and bare hex prefix.
 */
function extractBlockRef(content: string): string | null {
  const after = extractContent(content, ['echoCopy::']);
  if (!after) return null;

  // [[wikilink]] form — bracket-counting parser handles nested [[inner]]
  const wiki = parseBracketedWikilink(after, 0);
  if (wiki) return wiki.target;

  // Bare hex prefix (6+ chars)
  if (/^[0-9a-f]{6,}/i.test(after)) return after.split(/\s/)[0];

  return after;
}

/**
 * Resolve a reference to a block ID.
 * Tries short-hash resolution first, then page name lookup.
 */
function resolveRef(ref: string): string | null {
  // Try as block ID prefix (hex)
  if (/^[0-9a-f]{6,}/i.test(ref)) {
    const blockIds = Object.keys(blockStore.blocks);
    const resolved = resolveBlockIdPrefix(ref, blockIds);
    if (resolved) return resolved;
  }

  // Try full UUID match
  if (blockStore.blocks[ref]) return ref;

  // Try as page name
  const page = findPage(ref);
  if (page) return page.id;

  return null;
}

export const echoCopyHandler: BlockHandler = {
  prefixes: ['echoCopy::'],

  async execute(blockId: string, content: string, actions: ExecutorActions) {
    const ref = extractBlockRef(content);
    if (!ref) {
      actions.updateBlockContent(blockId, 'echoCopy:: error — no block reference');
      return;
    }

    const resolvedId = resolveRef(ref);
    if (!resolvedId) {
      actions.updateBlockContent(blockId, `echoCopy:: error — block not found: ${ref}`);
      return;
    }

    const targetBlock = (actions.getBlock?.(resolvedId) ?? blockStore.blocks[resolvedId]) as {
      metadata?: { renderedMarkdown?: string; summary?: string };
      output?: unknown;
      outputType?: string;
    } | undefined;

    if (!targetBlock) {
      actions.updateBlockContent(blockId, `echoCopy:: error — block not found: ${ref}`);
      return;
    }

    // Get markdown: prefer pre-extracted metadata, fall back to live flattening
    let markdown = targetBlock.metadata?.renderedMarkdown ?? null;
    if (!markdown && targetBlock.output) {
      markdown = flattenSpecToMarkdown(targetBlock.output);
    }

    if (!markdown) {
      actions.updateBlockContent(blockId, `echoCopy:: error — no rendered content on [[${resolvedId.slice(0, 8)}]]`);
      return;
    }

    // Parse markdown → block tree → create as children
    const parsed = parseMarkdownTree(markdown);
    if (parsed.length === 0) {
      actions.updateBlockContent(blockId, `echoCopy:: error — empty rendered content`);
      return;
    }

    insertParsedBlocks(blockId, parsed, actions);

    // Update block to show what was copied
    const lineCount = markdown.split('\n').filter(l => l.trim()).length;
    actions.updateBlockContent(
      blockId,
      `echoCopy:: [[${resolvedId.slice(0, 8)}]] — ${parsed.length} sections, ${lineCount} lines`,
    );

    if (actions.setBlockStatus) actions.setBlockStatus(blockId, 'complete');

    logger.info('Materialized render output', {
      source: resolvedId.slice(0, 8),
      sections: parsed.length,
      lines: lineCount,
    });
  },
};
