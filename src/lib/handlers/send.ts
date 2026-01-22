/**
 * Send Handler
 *
 * Explicit turn-based conversation trigger.
 * Pattern:
 *   ## user
 *   - thought 1
 *   - thought 2
 *
 *   /send
 *   → creates ## assistant block with response
 *
 * ARCHITECTURE:
 * - Context assembly is done by sendContextHook (execute:before)
 * - Provider detection is done by providerDetectionHook (execute:before, priority -1)
 * - This handler CONSUMES hookContext (messages + provider) instead of collecting itself
 *
 * PROVIDER ROUTING (FLO-187):
 * - ai::              → Ollama (default)
 * - ai::ollama model  → Ollama with model
 * - ai::kitty project → Claude Code CLI
 * - ai::anthropic     → Anthropic API (future)
 */

import { invoke } from '@tauri-apps/api/core';
import type { BlockHandler, ExecutorActions } from './types';
import type { ProviderConfig } from '../treeTraversal';
import type { ProviderHookContext } from './hooks/providerDetectionHook';

// ═══════════════════════════════════════════════════════════════
// TURN MARKERS
// ═══════════════════════════════════════════════════════════════

const USER_MARKER = '## user';
const ASSISTANT_MARKER = '## assistant';

// ═══════════════════════════════════════════════════════════════
// HOOK CONTEXT INTERFACE
// ═══════════════════════════════════════════════════════════════

interface SendHookContext {
  messages: Array<{ role: string; content: string }>;
  blockCount: number;
}

/**
 * Response from provider execution (matches Rust ProviderResponse)
 */
interface ProviderResponse {
  content: string;
  session_id?: string;
  provider_type: string;
}

// ═══════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Send handler - explicit conversation trigger
 *
 * Reads context from hookContext:
 * - messages (assembled by sendContextHook)
 * - provider (detected by providerDetectionHook)
 *
 * Routes to appropriate backend based on provider configuration.
 */
export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(
    blockId: string,
    _content: string,
    actions: ExecutorActions
  ): Promise<void> {
    const startTime = performance.now();

    // Get hook context - assembled by sendContextHook + providerDetectionHook
    const hookContext = (actions as unknown as {
      hookContext?: SendHookContext & Partial<ProviderHookContext>;
    }).hookContext;

    // Verify hook ran and provided context
    if (!hookContext?.messages || hookContext.messages.length === 0) {
      console.error('[send] No hookContext.messages - is sendContextHook registered?');
      actions.updateBlockContent(blockId, 'error:: Context hook not providing messages');
      return;
    }

    const { messages, blockCount } = hookContext;

    // Get provider info from hook (defaults to Ollama if not present)
    const provider: ProviderConfig = hookContext.provider ?? {
      type: 'ollama',
      blockId: '',
    };
    const modelOverride = hookContext.modelOverride;

    console.log('[send] Context from hook:', {
      blockCount,
      messageCount: messages.length,
      textLength: messages.reduce((sum, m) => sum + m.content.length, 0),
      provider: provider.type,
      model: modelOverride,
    });

    // Replace /send block with ## assistant marker
    // Use executor origin so UI updates even while block is focused
    const updateContent = actions.updateBlockContentFromExecutor ?? actions.updateBlockContent;
    updateContent(blockId, ASSISTANT_MARKER);
    actions.setBlockStatus?.(blockId, 'running');

    // Create response placeholder as child
    const responseId = actions.createBlockInside(blockId);
    const thinkingMessage = provider.type === 'claude-code'
      ? 'Claude Code thinking...'
      : 'Thinking...';
    updateContent(responseId, thinkingMessage);

    // Create ## user block IMMEDIATELY so user can start typing while waiting
    // This is the key UX insight: don't make user wait for LLM to start next thought
    let userInputId: string | null = null;
    if (actions.createBlockAfter) {
      const nextUserId = actions.createBlockAfter(blockId);
      if (nextUserId) {
        updateContent(nextUserId, USER_MARKER);
        userInputId = actions.createBlockInside(nextUserId);
        actions.updateBlockContent(userInputId, '');
        // Focus immediately - user can type while LLM is thinking
        if (actions.focusBlock) {
          requestAnimationFrame(() => actions.focusBlock!(userInputId!));
        }
      }
    }

    try {
      // Call provider-aware execution
      const response = await invoke<ProviderResponse>('execute_provider_conversation', {
        messages,
        provider,
        modelOverride,
        system: 'You are a helpful assistant responding to notes and thoughts in an outliner. Be concise and direct. Focus on what the user is asking about.',
      });

      const duration = performance.now() - startTime;
      console.log('[send] Complete:', {
        duration: `${duration.toFixed(1)}ms`,
        responseLength: response.content.length,
        providerType: response.provider_type,
        sessionId: response.session_id,
      });

      // Update response
      actions.updateBlockContent(responseId, response.content.trim());
      actions.setBlockStatus?.(blockId, 'complete');

      // Phase 5: Session persistence - store session_id if returned
      if (response.session_id && provider.blockId) {
        persistSessionId(provider.blockId, response.session_id, actions);
      }
    } catch (err) {
      console.error('[send] Error:', err);
      actions.updateBlockContent(responseId, `Error: ${String(err)}`);
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// SESSION PERSISTENCE
// ═══════════════════════════════════════════════════════════════

/**
 * Persist session ID as a child of the provider block.
 * Pattern: "session: {uuid}"
 *
 * This allows resuming Claude Code conversations on subsequent /send calls.
 */
function persistSessionId(
  providerBlockId: string,
  sessionId: string,
  actions: ExecutorActions
): void {
  // Check if session already exists
  if (actions.getBlock) {
    const providerBlock = actions.getBlock(providerBlockId) as {
      childIds?: string[];
    } | undefined;

    if (providerBlock?.childIds) {
      for (const childId of providerBlock.childIds) {
        const child = actions.getBlock(childId) as { content?: string } | undefined;
        if (child?.content?.startsWith('session:')) {
          // Update existing session block
          actions.updateBlockContent(childId, `session: ${sessionId}`);
          console.log('[send] Updated existing session:', sessionId);
          return;
        }
      }
    }
  }

  // Create new session block as first child of provider
  if (actions.createBlockInsideAtTop) {
    const sessionBlockId = actions.createBlockInsideAtTop(providerBlockId);
    actions.updateBlockContent(sessionBlockId, `session: ${sessionId}`);
    console.log('[send] Created new session block:', sessionId);
  } else {
    // Fallback: create at end
    const sessionBlockId = actions.createBlockInside(providerBlockId);
    actions.updateBlockContent(sessionBlockId, `session: ${sessionId}`);
    console.log('[send] Created session block (at end):', sessionId);
  }
}
