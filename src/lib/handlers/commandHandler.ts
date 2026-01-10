/**
 * Command Handler Factory
 *
 * Creates handlers for command-style blocks (sh::, ai::, etc.) that:
 * - Execute via Tauri backend
 * - Support $tv() variable resolution
 * - Parse markdown output into block trees
 */

import { invoke } from '../tauriTypes';
import { parseMarkdownTree } from '../markdownParser';
import { resolveTvVariables, hasTvVariables } from '../tvResolver';
import type { BlockHandler, ExecutorActions } from './types';
import { extractContent, insertParsedBlocks } from './utils';

// ═══════════════════════════════════════════════════════════════
// FACTORY CONFIG
// ═══════════════════════════════════════════════════════════════

export interface CommandHandlerConfig {
  /** Block prefixes that trigger this handler (e.g., ['sh::', 'term::']) */
  prefixes: string[];
  /** Tauri command to invoke (e.g., 'execute_shell_command') */
  tauriCommand: string;
  /** Argument name for the command payload (e.g., 'command' or 'prompt') */
  argName: string;
  /** Prefix for output blocks (e.g., 'output::' or 'ai::') */
  outputPrefix: string;
  /** Message shown while executing (e.g., 'Running...' or 'Thinking...') */
  pendingMessage: string;
  /** Log prefix for console messages (e.g., 'sh' or 'ai') */
  logPrefix: string;
}

// ═══════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════

/**
 * Create a command handler with the given configuration.
 * Shared logic for sh::, ai::, and similar command-style blocks.
 */
export function createCommandHandler(config: CommandHandlerConfig): BlockHandler {
  const { prefixes, tauriCommand, argName, outputPrefix, pendingMessage, logPrefix } = config;

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

      // If we resolved $tv(), create a "ran::" block showing the actual command
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
        const rawOutput = await invoke(tauriCommand, { [argName]: extracted });
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
