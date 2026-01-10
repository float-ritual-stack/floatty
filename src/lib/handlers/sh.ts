/**
 * Shell Command Handler (sh::, term::)
 *
 * Executes shell commands via Tauri backend.
 * Supports $tv() variable resolution and markdown output parsing.
 */

import { createCommandHandler } from './commandHandler';

export const shHandler = createCommandHandler({
  prefixes: ['sh::', 'term::'],
  tauriCommand: 'execute_shell_command',
  argName: 'command',
  outputPrefix: 'output::',
  pendingMessage: 'Running...',
  logPrefix: 'sh',
});
