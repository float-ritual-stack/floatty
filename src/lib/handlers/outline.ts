/**
 * Outline Handler - switch between outlines
 *
 * Usage:
 *   outline::           → list available outlines as children
 *   outline:: name      → dispatch switch event (handled by App-level listener)
 */

import type { BlockHandler, ExecutorActions } from './types';
import { currentOutline } from '../httpClient';
import { setPendingOutlineSwitch } from '../events/appEvents';

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

    // No argument → list outlines
    if (!arg) {
      actions.setBlockStatus?.(blockId, 'running');
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

    // Argument provided → request outline switch via typed app signal (App.tsx handles it)
    const name = arg.replace(/\s*←\s*current\s*$/, '').trim();
    if (name === currentOutline()) {
      actions.setBlockStatus?.(blockId, 'complete');
      return;
    }

    // Handler's job is done: signal fired, App.tsx effect owns the rest.
    // Set 'complete' so the block doesn't spin forever if App.tsx aborts.
    setPendingOutlineSwitch(name);
    actions.setBlockStatus?.(blockId, 'complete');
  },
};
