/**
 * Linear Door — fetch Linear issue details into outline
 *
 * Usage:
 *   linear:: FLO-305     → fetch issue title, status, description
 *   linear:: FLO-305 -v  → verbose (include comments)
 */

import { exec, addNewChildren, addNewChildrenTree, parseMarkdownToOps } from '@floatty/stdlib';

const safeArg = s => /^[a-zA-Z0-9_-]+$/.test(s) ? s : null;

function parseArgs(content) {
  const match = content.match(/^linear::\s*(.*)/i);
  if (!match) return { id: null, verbose: false };
  const parts = match[1].trim().split(/\s+/);
  const id = parts[0] || null;
  const verbose = parts.includes('-v');
  return { id, verbose };
}

export const door = {
  kind: 'block',
  prefixes: ['linear::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const { id, verbose } = parseArgs(content);

    if (!id) {
      actions.setBlockOutput(blockId, { type: 'text', data: 'Usage: linear:: FLO-305' }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      return;
    }

    const issueId = safeArg(id);
    if (!issueId) {
      actions.setBlockOutput(blockId, { type: 'error', data: `Invalid issue ID: ${id}` }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    try {
      actions.setBlockStatus(blockId, 'running');
      const output = await exec(`floatctl script run linear ${issueId}`);
      const lines = output.trim();

      if (!lines) {
        actions.setBlockOutput(blockId, { type: 'text', data: `(no data for ${issueId})` }, 'eval-result');
        actions.setBlockStatus(blockId, 'complete');
        return;
      }

      // Unescape Linear's bracket escaping (\[\[ → [[, \]\] → ]])
      const unescaped = lines.replace(/\\\[/g, '[').replace(/\\\]/g, ']');

      // Parse markdown output into block tree
      const tree = parseMarkdownToOps(unescaped);
      if (tree.length > 0) {
        addNewChildrenTree(blockId, tree, actions);
      } else {
        // Fallback: raw text as children
        const children = unescaped.split('\n')
          .filter(l => l.trim())
          .map(l => ({ content: l }));
        addNewChildren(blockId, children, actions);
      }

      // Extract title from first line for compact output
      const firstLine = unescaped.split('\n')[0] || issueId;
      actions.setBlockOutput(blockId, { type: 'text', data: firstLine }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      log(`Fetched ${issueId}: ${firstLine}`);
    } catch (err) {
      actions.setBlockOutput(blockId, { type: 'error', data: String(err) }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
    }
  },
};

export const meta = {
  id: 'linear',
  name: 'Linear',
  version: '0.1.0',
  selfRender: true,
};
