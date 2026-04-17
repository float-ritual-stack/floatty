/**
 * Portless Door — resolve .localhost subdomain URLs to direct IP:PORT
 *
 * Commands:
 *   portless::              → list running portless apps
 *   portless:: list         → same
 *   portless:: <name>       → inline iframe via setBlockOutput (selfRender)
 *
 * Why: Tauri's WKWebView in release mode can't resolve .localhost
 * subdomains inside iframes. This door reads portless routing state
 * and rewrites to direct 127.0.0.1:PORT URLs that always work.
 *
 * Uses selfRender: true — bypasses doorAdapter, calls setBlockOutput
 * directly on the portless:: block. Same render path as func::/eval::.
 */

import { execJSON } from '@floatty/stdlib';

const ROUTES_FILE = '~/.portless/routes.json';

/**
 * Read routes from ~/.portless/routes.json via Tauri shell command.
 * Returns array of { name, port, pid } or null if portless isn't running.
 */
async function fetchRoutes() {
  try {
    const parsed = await execJSON(`cat ${ROUTES_FILE}`);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(r => ({
      name: (r.hostname || '').replace(/\.localhost$/, ''),
      port: r.port,
      pid: r.pid,
    }));
  } catch (_) {
    // routes.json missing or portless not installed
    return null;
  }
}

function parseCommand(content) {
  const match = content.match(/^portless::\s*(.*)/i);
  if (!match) return { cmd: 'list', target: '' };
  const arg = match[1].trim().toLowerCase();
  if (!arg || arg === 'list') return { cmd: 'list', target: '' };
  return { cmd: 'view', target: arg };
}

export const door = {
  kind: 'block',
  prefixes: ['portless::'],

  async execute(blockId, content, ctx) {
    const { actions, log } = ctx;
    const { cmd, target } = parseCommand(content);

    const routes = await fetchRoutes();

    if (!routes) {
      actions.setBlockOutput(blockId, { type: 'error', data: 'Could not read portless routes (not running?)' }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    if (cmd === 'list') {
      if (routes.length === 0) {
        actions.setBlockOutput(blockId, { type: 'error', data: '(no portless apps running)' }, 'eval-result');
        actions.setBlockStatus(blockId, 'complete');
        return;
      }
      // Check existing children to avoid duplicates (additive only —
      // don't remove stopped routes in case an iframe is still active)
      const existingNames = new Set();
      const block = actions.getBlock?.(blockId);
      if (block?.childIds) {
        for (const cid of block.childIds) {
          const child = actions.getBlock?.(cid);
          if (child?.content) {
            const m = child.content.match(/^portless::\s*(\S+)/i);
            if (m) existingNames.add(m[1].toLowerCase());
          }
        }
      }
      const newRoutes = routes.filter(r => !existingNames.has(r.name));
      if (newRoutes.length > 0) {
        const ops = newRoutes.map(r => ({ content: `portless:: ${r.name}` }));
        actions.batchCreateBlocksInside(blockId, ops);
      }
      const summary = `${routes.length} running` + (newRoutes.length < routes.length ? `, ${newRoutes.length} new` : '');
      actions.setBlockOutput(blockId, { type: 'text', data: summary }, 'eval-result');
      actions.setBlockStatus(blockId, 'complete');
      log(`Listed ${routes.length} portless apps (${newRoutes.length} new)`);
      return;
    }

    // cmd === 'view' — resolve name to direct URL, render inline
    const route = routes.find(r => r.name === target);
    if (!route) {
      actions.setBlockOutput(blockId, { type: 'error', data: `"${target}" not found (${routes.length} portless apps running)` }, 'eval-result');
      actions.setBlockStatus(blockId, 'error');
      return;
    }

    const resolvedUrl = `http://127.0.0.1:${route.port}/`;
    actions.setBlockOutput(blockId, { type: 'url', data: resolvedUrl }, 'eval-result');
    actions.setBlockStatus(blockId, 'complete');
    log(`Resolved ${target} → ${resolvedUrl}`);
  },
};

export const meta = {
  id: 'portless',
  name: 'Portless',
  version: '0.3.0',
  selfRender: true,
};
