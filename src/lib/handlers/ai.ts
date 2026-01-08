/**
 * AI Command Handler (ai::, chat::)
 * 
 * Executes AI prompts via Ollama backend.
 * Supports $tv() variable resolution and markdown output parsing.
 */

import { invoke } from '../tauriTypes';
import { parseMarkdownTree } from '../markdownParser';
import { resolveTvVariables, hasTvVariables } from '../tvResolver';
import type { BlockHandler, ExecutorActions } from './types';
import type { ParsedBlock } from '../markdownParser';

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Extract content after handler prefix
 */
function extractContent(content: string, prefixes: string[]): string {
  const trimmed = content.trim();
  for (const prefix of prefixes) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

/**
 * Insert parsed blocks recursively as children of parentId
 */
function insertParsedBlocks(
  parentId: string,
  blocks: ParsedBlock[],
  actions: ExecutorActions
): void {
  for (const block of blocks) {
    const newId = actions.createBlockInside(parentId);
    actions.updateBlockContent(newId, block.content);

    if (block.children.length > 0) {
      insertParsedBlocks(newId, block.children, actions);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// HANDLER IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

export const aiHandler: BlockHandler = {
  prefixes: ['ai::', 'chat::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    let extracted = extractContent(content, this.prefixes);
    const outputPrefix = 'ai::';
    const pendingMessage = 'Thinking...';

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
        console.error('[ai] TV resolution failed:', err);
        // Fall through and try to execute with unresolved variables
      }
    }

    // If we resolved $tv(), create a "ran::" block showing the actual prompt
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
      const rawOutput = await invoke<string>('execute_ai_command', { prompt: extracted });
      const duration = performance.now() - startTime;
      const cleanOutput = rawOutput.trimEnd();
      console.log('[ai] Complete:', { duration: `${duration.toFixed(1)}ms`, outputBytes: cleanOutput.length });

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
      console.error('[ai] Error:', err);
      actions.updateBlockContent(outputId, `error::${String(err)}`);
    }
  }
};
