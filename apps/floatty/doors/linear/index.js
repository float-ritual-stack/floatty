/**
 * Linear Door — fetch Linear issue details into outline
 *
 * Usage:
 *   linear:: FLO-305     → fetch issue title, status, description
 *   linear::             → infer the issue ID from the nearest ancestor whose
 *                          content matches FLO-NNN / REX-NNN (e.g. a block on
 *                          the "# FLO-305" page) — no more retyping the ID
 *                          you're already standing on
 *   linear:: // comment  → `// …` is comment text, ignored by the parser
 *
 * Flags: none. `floatctl script run linear <id>` decides what it returns, so
 * unlike floatty-pr:: there is no comments flag to forward — leading-dash
 * tokens are tolerated and ignored rather than silently promising verbosity.
 */

import { exec, addNewChildren, addNewChildrenTree, parseMarkdownToOps } from '@floatty/stdlib';

const safeArg = s => /^[a-zA-Z0-9_-]+$/.test(s) ? s : null;

// Linear team keys are letters only — anchoring on that rejects version-like
// ancestor text ("Release v1-305 notes" must not infer V1-305) while still
// matching FLO-305 / REX-12.
export const ISSUE_RE = /\b([A-Za-z]{2,6}-\d{1,6})\b/;

export function parseArgs(content) {
  const match = content.match(/^linear::\s*(.*)/i);
  if (!match) return { id: null };
  // Strip `// …` comment text (same convention as floatty-pr::) so an
  // annotated block never has its prose parsed as an issue ID.
  const rest = match[1].replace(/\/\/.*$/s, '').trim();
  const parts = rest.split(/\s+/).filter(Boolean);
  // Leading-dash tokens are tolerated (and ignored) — the floatctl script
  // takes only the issue ID, so there is no flag to forward.
  const positional = parts.filter(p => !p.startsWith('-'));
  const id = positional[0] || null;
  return { id };
}

/**
 * Walk up the parent chain for the nearest FLO-NNN / REX-NNN style ref —
 * so `linear::` on (or under) the "# FLO-305" page resolves FLO-305 without
 * retyping it. Nearest ancestor wins. Mirrors floatty-pr::'s inference.
 */
export function inferFromAncestors(blockId, actions) {
  let id = blockId;
  for (let hops = 0; hops < 20; hops++) {
    const parentId = actions.getParentId(id);
    if (!parentId) return null;
    const parent = actions.getBlock(parentId);
    const m = parent?.content?.match(ISSUE_RE);
    if (m) return m[1].toUpperCase();
    id = parentId;
  }
  return null;
}

export const door = {
  kind: 'block',
  prefixes: ['linear::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const { id: parsedId } = parseArgs(content);

    const id = parsedId ?? inferFromAncestors(blockId, actions);
    if (!id) {
      actions.setBlockOutput(blockId, { type: 'text', data: 'Usage: linear:: FLO-305 — or run it under a "FLO-NNN" page' }, 'eval-result');
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
