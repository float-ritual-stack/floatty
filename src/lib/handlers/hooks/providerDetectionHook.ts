/**
 * Provider Detection Hook
 *
 * Detects AI provider configuration from ancestor blocks before /send executes.
 * This hook runs BEFORE sendContextHook to establish which backend to route to.
 *
 * Provider Patterns:
 * - ai::              → Default Ollama
 * - ai::ollama model  → Explicit Ollama with model
 * - ai::kitty project → Claude Code CLI with project dir
 * - ai::anthropic model → Anthropic API with model
 *
 * Collision Avoidance:
 * - kitty:: (without ai:: prefix) is NOT a provider
 * - claude:: is NOT a provider (used for URL sharing)
 *
 * @see FLO-187 Provider-Aware Dispatch System
 */

import type { Hook, HookContext, HookResult } from '../../hooks/types';
import {
  traverseUpForProvider,
  findSessionId,
  findModelOverride,
  type ProviderConfig,
} from '../../treeTraversal';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

/**
 * Provider context injected into send handler's hookContext
 */
export interface ProviderHookContext {
  provider: ProviderConfig;
  sessionId?: string;
  modelOverride?: string;
}

// ═══════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════

export const providerDetectionHook: Hook = {
  id: 'provider-detection',
  event: 'execute:before',
  priority: -1, // Run BEFORE sendContextHook (priority 0) - lower = earlier

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send') || content.startsWith('::send');
  },

  handler: (ctx: HookContext): HookResult => {
    // Traverse up looking for ai::* pattern
    const provider = traverseUpForProvider(ctx.block.id, ctx.store);

    // If we found a provider block, look for session and model in its children
    let sessionId: string | undefined;
    let modelOverride: string | undefined;

    if (provider.blockId) {
      sessionId = findSessionId(provider.blockId, ctx.store);
      modelOverride = findModelOverride(provider.blockId, ctx.store);
    }

    // If provider has model and we found override, prefer override
    // If no override but provider has model, use provider model
    const effectiveModel = modelOverride ??
      ('model' in provider ? provider.model : undefined);

    // For claude-code type, inject session if found
    if (provider.type === 'claude-code' && sessionId) {
      (provider as ProviderConfig & { sessionId?: string }).sessionId = sessionId;
    }

    console.log('[providerDetectionHook] Detected:', {
      type: provider.type,
      blockId: provider.blockId || '(default)',
      sessionId,
      effectiveModel,
    });

    return {
      context: {
        provider,
        sessionId,
        modelOverride: effectiveModel,
      } satisfies ProviderHookContext,
    };
  },
};
