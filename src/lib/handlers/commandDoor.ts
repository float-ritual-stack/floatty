/**
 * Command Door Factory
 *
 * Creates handlers for command-style blocks (sh::, ai::, etc.)
 * that execute a backend command and display the output.
 *
 * This is the foundation for user-defined "doors" - specialized
 * views/executors for different types of thought processing.
 */

import { invoke } from '../tauriTypes';
import { parseMarkdownTree } from '../markdownParser';
import { resolveTvVariables, hasTvVariables } from '../tvResolver';
import type { BlockHandler, ExecutorActions } from './types';
import { extractContent, insertParsedBlocks } from './utils';

// ═══════════════════════════════════════════════════════════════
// DOOR CONFIGURATION
// ═══════════════════════════════════════════════════════════════

export interface CommandDoorConfig {
  /** Prefixes that trigger this door (e.g., ['sh::', 'term::']) */
  prefixes: string[];
  /** Tauri command name to invoke */
  backend: string;
  /** Parameter name for the backend call ('command' for shell, 'prompt' for AI) */
  paramName: string;
  /** Prefix for output blocks */
  outputPrefix: string;
  /** Message shown while executing */
  pendingMessage: string;
  /** Log prefix for console output */
  logPrefix: string;
}

// ═══════════════════════════════════════════════════════════════
// FACTORY
// ═══════════════════════════════════════════════════════════════

/**
 * Create a command door handler from configuration
 */
export function createCommandDoor(config: CommandDoorConfig): BlockHandler {
  const { prefixes, backend, paramName, outputPrefix, pendingMessage, logPrefix } = config;

  return {
    prefixes,

    async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
      const startTime = performance.now();
      let extracted = extractContent(content, prefixes);

      // Resolve $tv() variables before execution
      let resolvedFromTv = false;
      if (hasTvVariables(extracted)) {
        try {
          const original = extracted;
          extracted = await resolveTvVariables(extracted, blockId, actions, actions.paneId);

          if (!extracted.trim()) {
            return; // User cancelled, don't execute
          }

          resolvedFromTv = extracted !== original;
        } catch (err) {
          console.error(`[${logPrefix}] TV resolution failed:`, err);
          // Fall through and try to execute with unresolved variables
        }
      }

      // If we resolved $tv(), create a "ran::" block showing the actual input
      let outputParentId = blockId;
      if (resolvedFromTv) {
        const ranId = actions.createBlockInsideAtTop?.(blockId) ?? actions.createBlockInside(blockId);
        actions.updateBlockContent(ranId, `ran:: ${extracted}`);
        outputParentId = ranId;
      }

      // Create placeholder block immediately
      const outputId = actions.createBlockInsideAtTop?.(outputParentId) ?? actions.createBlockInside(outputParentId);
      actions.updateBlockContent(outputId, `${outputPrefix}${pendingMessage}`);

      try {
        const rawOutput = await invoke(backend, { [paramName]: extracted });
        const duration = performance.now() - startTime;
        const cleanOutput = rawOutput.trimEnd();
        console.log(`[${logPrefix}] Complete:`, { duration: `${duration.toFixed(1)}ms`, outputBytes: cleanOutput.length });

        // Parse markdown structure if present
        if (cleanOutput) {
          const parsed = parseMarkdownTree(cleanOutput);

          // Check if output is simple (single block, no children)
          const isSimpleOutput = parsed.length === 1 && parsed[0].children.length === 0;

          if (isSimpleOutput) {
            // Simple output - just update the placeholder
            actions.updateBlockContent(outputId, `${outputPrefix}${parsed[0].content}`);
          } else if (parsed.length > 0) {
            // Structured output - remove placeholder, insert tree
            if (actions.deleteBlock) {
              actions.deleteBlock(outputId);
            } else {
              // Fallback: clear placeholder if deleteBlock unavailable
              actions.updateBlockContent(outputId, `${outputPrefix}(output below)`);
            }
            insertParsedBlocks(outputParentId, parsed, actions);
          } else {
            // Empty parsed output
            actions.updateBlockContent(outputId, `${outputPrefix}(empty)`);
          }
        } else {
          // No output
          actions.updateBlockContent(outputId, `${outputPrefix}(empty)`);
        }
      } catch (err) {
        console.error(`[${logPrefix}] Error:`, err);
        actions.updateBlockContent(outputId, `error::${String(err)}`);
      }
    }
  };
}

// ═══════════════════════════════════════════════════════════════
// BUILT-IN DOORS
// ═══════════════════════════════════════════════════════════════

/** Shell command door - executes shell commands via PTY-less backend */
export const shHandler = createCommandDoor({
  prefixes: ['sh::', 'term::'],
  backend: 'execute_shell_command',
  paramName: 'command',
  outputPrefix: 'output::',
  pendingMessage: 'Running...',
  logPrefix: 'sh',
});

/** AI prompt door - sends prompts to Ollama */
export const aiHandler = createCommandDoor({
  prefixes: ['ai::', 'chat::'],
  backend: 'execute_ai_command',
  paramName: 'prompt',
  outputPrefix: 'ai::',
  pendingMessage: 'Thinking...',
  logPrefix: 'ai',
});
