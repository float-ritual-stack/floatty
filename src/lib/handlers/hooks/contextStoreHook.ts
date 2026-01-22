/**
 * Context Store Hook
 *
 * Provides store access to /context and /inherited handlers.
 * Simple pass-through hook that makes the store available via hookContext.
 *
 * @see FLO-187 Provider-Aware Dispatch System
 */

import type { Hook, HookContext, HookResult } from '../../hooks/types';

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

export const contextStoreHook: Hook = {
  id: 'context-store-passthrough',
  event: 'execute:before',
  priority: 0, // Standard processing

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/context') || content.startsWith('/inherited');
  },

  handler: (ctx: HookContext): HookResult => {
    // Pass through store info for the context handler to consume
    return {
      context: {
        store: {
          blocks: ctx.store.blocks,
          rootIds: ctx.store.rootIds,
          zoomedRootId: ctx.store.zoomedRootId,
        },
      },
    };
  },
};
