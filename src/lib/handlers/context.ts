/**
 * Context Handler - Shows inherited context for debugging
 *
 * Usage:
 *   /context   → Shows provider, model, session, and scope info
 *   /inherited → Alias for /context
 *
 * When deep in a nested outline, it's not obvious which provider/config is inherited.
 * This handler shows what's in effect at the current position.
 *
 * @see FLO-187 Provider-Aware Dispatch System
 */

import type { BlockHandler, ExecutorActions } from './types';
import {
  buildInheritedContext,
  type TraversalStore,
  type ProviderConfig,
} from '../treeTraversal';
import type { Block } from '../blockTypes';

// ═══════════════════════════════════════════════════════════════
// FORMATTING
// ═══════════════════════════════════════════════════════════════

/**
 * Format provider config for display
 *
 * Config-driven: shows whatever info is available, no hardcoded provider lists
 */
function formatProvider(provider: ProviderConfig): string {
  const parts: string[] = [`ai::${provider.name}`];

  // Show workingDir if set (CLI providers)
  if (provider.workingDir) {
    parts.push(`dir: ${provider.workingDir}`);
  }

  // Show model if set (could be from provider line or config)
  // Skip if same as workingDir (parseProviderConfig sets both to same value)
  if (provider.model && provider.model !== provider.workingDir) {
    parts.push(`model: ${provider.model}`);
  }

  return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
}

/**
 * Format inherited context for display
 */
function formatInheritedContext(
  provider: ProviderConfig | undefined,
  model: string | undefined,
  sessionId: string | undefined,
  zoomedRootId: string | undefined,
  ancestorCount: number
): string {
  const lines: string[] = ['**Inherited Context:**'];

  // Provider
  if (provider && provider.blockId) {
    lines.push(`├── provider: ${formatProvider(provider)}`);
  } else {
    lines.push('├── provider: ai:: (default Ollama)');
  }

  // Model
  if (model) {
    lines.push(`├── model: ${model}`);
  }

  // Session
  if (sessionId) {
    lines.push(`├── session: ${sessionId}`);
  }

  // Scope
  if (zoomedRootId) {
    lines.push(`├── scope: zoomed to "${zoomedRootId}"`);
  } else {
    lines.push('├── scope: full document');
  }

  // Ancestor depth
  lines.push(`└── depth: ${ancestorCount} blocks from root`);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// STORE ADAPTER
// ═══════════════════════════════════════════════════════════════

/**
 * Build a minimal TraversalStore from ExecutorActions
 */
function buildStoreFromActions(actions: ExecutorActions, blocks: Record<string, Block>): TraversalStore {
  return {
    getBlock: (id: string) => {
      // Try actions.getBlock first
      if (actions.getBlock) {
        const block = actions.getBlock(id);
        if (block) return block as Block;
      }
      // Fallback to blocks record
      return blocks[id];
    },
    rootIds: Object.keys(blocks).filter(id => !blocks[id]?.parentId),
  };
}

// ═══════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════

export const contextHandler: BlockHandler = {
  prefixes: ['/context', '/inherited'],

  async execute(blockId: string, _content: string, actions: ExecutorActions): Promise<void> {
    actions.setBlockStatus?.(blockId, 'running');

    try {
      // Get hook context which contains the store info
      const hookContext = (actions as unknown as { hookContext?: { store?: { blocks?: Record<string, Block>; zoomedRootId?: string } } }).hookContext;

      // Build store from available data
      const blocks = hookContext?.store?.blocks ?? {};
      const zoomedRootId = hookContext?.store?.zoomedRootId;

      // If we don't have blocks from hook context, we can still try using actions
      if (Object.keys(blocks).length === 0) {
        // Fall back to minimal store using actions
        const outputId = actions.createBlockInside(blockId);
        actions.updateBlockContent(
          outputId,
          '**Inherited Context:**\n└── Unable to access block tree. Run via hook-enabled execution path.'
        );
        actions.setBlockStatus?.(blockId, 'complete');
        return;
      }

      const store = buildStoreFromActions(actions, blocks);
      const ctx = buildInheritedContext(blockId, store, zoomedRootId);

      // Format and display
      const formatted = formatInheritedContext(
        ctx.provider,
        ctx.model,
        ctx.sessionId,
        ctx.zoomedRootId,
        ctx.ancestors.length
      );

      const outputId = actions.createBlockInside(blockId);
      actions.updateBlockContent(outputId, formatted);
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      const errorId = actions.createBlockInside(blockId);
      actions.updateBlockContent(errorId, `Error getting context: ${err}`);
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};
