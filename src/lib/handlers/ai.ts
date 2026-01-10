/**
 * AI Command Handler (ai::, chat::)
 *
 * Executes AI prompts via Ollama backend.
 * Supports $tv() variable resolution and markdown output parsing.
 */

import { createCommandHandler } from './commandHandler';

export const aiHandler = createCommandHandler({
  prefixes: ['ai::', 'chat::'],
  tauriCommand: 'execute_ai_command',
  argName: 'prompt',
  outputPrefix: 'ai::',
  pendingMessage: 'Thinking...',
  logPrefix: 'ai',
});
