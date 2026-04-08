/**
 * Outline Handler - switch between outlines
 *
 * Usage:
 *   outline::           → list available outlines as children
 *   outline:: name      → switch to that outline (creates if doesn't exist)
 */

import type { BlockHandler, ExecutorActions } from './types';
import { switchOutline } from '../../hooks/useSyncedYDoc';
import { currentOutline } from '../httpClient';

export const outlineHandler: BlockHandler = {
  prefixes: ['outline::'],

  async execute(blockId: string, content: string, actions: ExecutorActions) {
    const arg = content.replace(/^outline::\s*/i, '').trim();
    const serverUrl = window.__FLOATTY_SERVER_URL__;
    const apiKey = window.__FLOATTY_API_KEY__;
    if (!serverUrl || !apiKey) {
      const errId = actions.createBlockInside(blockId);
      actions.updateBlockContent(errId, 'Server not connected');
      actions.setBlockStatus?.(blockId, 'error');
      return;
    }

    actions.setBlockStatus?.(blockId, 'running');

    // No argument → list outlines
    if (!arg) {
      try {
        const resp = await fetch(`${serverUrl}/api/v1/outlines`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        if (!resp.ok) throw new Error(`${resp.status}`);
        const outlines: { name: string }[] = await resp.json();
        const current = currentOutline();

        for (const o of outlines) {
          const childId = actions.createBlockInside(blockId);
          const marker = o.name === current ? ' ← current' : '';
          actions.updateBlockContent(childId, `outline:: ${o.name}${marker}`);
        }
        actions.setBlockStatus?.(blockId, 'complete');
      } catch (err) {
        const errId = actions.createBlockInside(blockId);
        actions.updateBlockContent(errId, `Failed to list outlines: ${err}`);
        actions.setBlockStatus?.(blockId, 'error');
      }
      return;
    }

    // Argument provided → switch (or create + switch)
    const name = arg.replace(/\s*←\s*current\s*$/, '').trim();
    if (name === currentOutline()) {
      actions.setBlockStatus?.(blockId, 'complete');
      return;
    }

    actions.setBlockStatus?.(blockId, 'running');

    // Run switch async AFTER handler returns — switchOutline destroys the Y.Doc,
    // so we can't create blocks or touch the store after it runs.
    setTimeout(async () => {
      try {
        // Check if outline exists, create if not
        const listResp = await fetch(`${serverUrl}/api/v1/outlines`, {
          headers: { 'Authorization': `Bearer ${apiKey}` },
        });
        const outlines: { name: string }[] = listResp.ok ? await listResp.json() : [];
        const exists = outlines.some(o => o.name === name);

        if (!exists) {
          const createResp = await fetch(`${serverUrl}/api/v1/outlines`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (!createResp.ok) {
            const text = await createResp.text();
            throw new Error(`Create failed: ${text}`);
          }
        }

        await switchOutline(name);
      } catch (err) {
        console.error(`Failed to switch to outline '${name}':`, err);
      }
    }, 0);
  },
};
