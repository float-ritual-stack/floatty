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
 * ARCHITECTURE: Context assembly is done by sendContextHook (execute:before).
 * This handler CONSUMES hookContext.messages instead of collecting context itself.
 * This is how the hook system is supposed to work:
 *   Hooks assemble → Handlers consume
 */

import { invoke } from '@tauri-apps/api/core';
import type { BlockHandler, ExecutorActions } from './types';

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

// ═══════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════

/**
 * Send handler - explicit conversation trigger
 *
 * Reads context from hookContext.messages (assembled by sendContextHook).
 * This demonstrates the hook system architecture working correctly.
 */
export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(
    blockId: string,
    _content: string,
    actions: ExecutorActions
  ): Promise<void> {
    const startTime = performance.now();

    // Get hook context - assembled by sendContextHook in execute:before
    const hookContext = (actions as unknown as { hookContext?: SendHookContext }).hookContext;

    // Verify hook ran and provided context
    if (!hookContext?.messages || hookContext.messages.length === 0) {
      console.error('[send] No hookContext.messages - is sendContextHook registered?');
      actions.updateBlockContent(blockId, 'error:: Context hook not providing messages');
      return;
    }

    const { messages, blockCount } = hookContext;

    console.log('[send] Context from hook:', {
      blockCount,
      messageCount: messages.length,
      textLength: messages.reduce((sum, m) => sum + m.content.length, 0),
    });

    // Replace /send block with ## assistant marker
    // Use executor origin so UI updates even while block is focused
    const updateContent = actions.updateBlockContentFromExecutor ?? actions.updateBlockContent;
    updateContent(blockId, ASSISTANT_MARKER);
    actions.setBlockStatus?.(blockId, 'running');

    // Create response placeholder as child
    const responseId = actions.createBlockInside(blockId);
    updateContent(responseId, 'Thinking...');

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
      // Call LLM with conversation API
      // Messages come from hook - handler just sends them
      const response = await invoke<string>('execute_ai_conversation', {
        messages,
        system: 'You are a helpful assistant responding to notes and thoughts in an outliner. Be concise and direct. Focus on what the user is asking about.',
      });

      const duration = performance.now() - startTime;
      console.log('[send] Complete:', {
        duration: `${duration.toFixed(1)}ms`,
        responseLength: response.length,
      });

      // Update response
      actions.updateBlockContent(responseId, response.trim());
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      console.error('[send] Error:', err);
      actions.updateBlockContent(responseId, `Error: ${String(err)}`);
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};
