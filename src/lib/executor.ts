/**
 * Unified Executable Block Handler
 *
 * Abstraction for sh::, ai::, and future executable block types.
 * Each handler defines prefixes, execution, and optional output parsing.
 */

import { invoke } from '@tauri-apps/api/core';
import { parseMarkdownTree, type ParsedBlock } from './markdownParser';
import { resolveTvVariables, hasTvVariables } from './tvResolver';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export interface ExecutorActions {
  /** Create a new block as the last child of parentId */
  createBlockInside: (parentId: string) => string;
  /** Create a new block as the first child of parentId (optional) */
  createBlockInsideAtTop?: (parentId: string) => string;
  /** Update the content of a block */
  updateBlockContent: (id: string, content: string) => void;
  /** Delete a block (optional - for replacing placeholder with structured output) */
  deleteBlock?: (id: string) => boolean;
}

export interface ExecutableBlockHandler {
  /** Prefixes that trigger this handler (e.g., ['sh::', 'term::']) */
  prefixes: string[];
  /** Execute the extracted content and return raw output */
  execute: (content: string) => Promise<string>;
  /** Optional: parse output into structured blocks */
  parseOutput?: (output: string) => ParsedBlock[];
  /** Block type for output (default: 'output') */
  outputType?: 'output' | 'ai';
  /** Block type for errors */
  errorType?: 'error';
  /** Pending message while executing */
  pendingMessage?: string;
}

// ═══════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════

const handlers: ExecutableBlockHandler[] = [
  {
    prefixes: ['sh::', 'term::'],
    execute: (cmd) => invoke<string>('execute_shell_command', { command: cmd }),
    parseOutput: parseMarkdownTree,
    outputType: 'output',
    pendingMessage: 'Running...',
  },
  {
    prefixes: ['ai::', 'chat::'],
    execute: (prompt) => invoke<string>('execute_ai_command', { prompt }),
    parseOutput: parseMarkdownTree,
    outputType: 'ai',
    pendingMessage: 'Thinking...',
  },
];

// ═══════════════════════════════════════════════════════════════
// HANDLER LOOKUP
// ═══════════════════════════════════════════════════════════════

/**
 * Find handler for content based on prefix match
 */
export function findHandler(content: string): ExecutableBlockHandler | null {
  const trimmed = content.trim().toLowerCase();
  return handlers.find(h =>
    h.prefixes.some(p => trimmed.startsWith(p))
  ) ?? null;
}

/**
 * Check if content is an executable block
 */
export function isExecutableBlock(content: string): boolean {
  return findHandler(content) !== null;
}

/**
 * Extract the content after the prefix
 * Note: Only call after findHandler() succeeds - fallback return is defensive only
 */
export function extractContent(content: string, handler: ExecutableBlockHandler): string {
  const trimmed = content.trim();
  for (const prefix of handler.prefixes) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  // Defensive: should never reach here if handler was found correctly
  return trimmed;
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED EXECUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Insert parsed blocks recursively as children of parentId
 * Note: No output:: prefix - parent sh::/ai:: block provides context
 */
function insertParsedBlocks(
  parentId: string,
  blocks: ParsedBlock[],
  actions: ExecutorActions
): void {
  for (const block of blocks) {
    const newId = actions.createBlockInside(parentId);
    // Content without prefix - cleaner display, parent provides context
    actions.updateBlockContent(newId, block.content);

    if (block.children.length > 0) {
      insertParsedBlocks(newId, block.children, actions);
    }
  }
}

/**
 * Execute a block using the unified handler system
 */
export async function executeBlock(
  blockId: string,
  content: string,
  actions: ExecutorActions
): Promise<void> {
  const handler = findHandler(content);
  if (!handler) return;

  let extracted = extractContent(content, handler);
  const outputType = handler.outputType ?? 'output';
  const outputPrefix = `${outputType}::`;
  const pendingMessage = handler.pendingMessage ?? 'Running...';

  // Resolve $tv() variables before execution
  // This spawns picker blocks and waits for user selection
  if (hasTvVariables(extracted)) {
    try {
      extracted = await resolveTvVariables(extracted, blockId, actions);
      // If user cancelled all pickers, extracted might be empty or have empty substitutions
      if (!extracted.trim()) {
        return; // User cancelled, don't execute
      }
      // Note: We intentionally DON'T update the parent block content.
      // Keeping $tv(...) makes the block a reusable "saved picker" -
      // hit Enter again to select a different file.
    } catch (err) {
      console.error('[executor] TV resolution failed:', err);
      // Fall through and try to execute with unresolved variables
      // (will likely fail, but error message will be shown)
    }
  }

  // Create placeholder block immediately
  const outputId = actions.createBlockInsideAtTop?.(blockId) ?? actions.createBlockInside(blockId);
  actions.updateBlockContent(outputId, `${outputPrefix}${pendingMessage}`);

  try {
    const rawOutput = await handler.execute(extracted);
    const cleanOutput = rawOutput.trimEnd();

    // Parse if handler has parseOutput, otherwise single block
    if (handler.parseOutput && cleanOutput) {
      const parsed = handler.parseOutput(cleanOutput);

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
        insertParsedBlocks(blockId, parsed, actions);
      } else {
        // Empty output
        actions.updateBlockContent(outputId, `${outputPrefix}(empty)`);
      }
    } else {
      // No parser or empty output
      actions.updateBlockContent(outputId, `${outputPrefix}${cleanOutput || '(empty)'}`);
    }
  } catch (err) {
    actions.updateBlockContent(outputId, `error::${String(err)}`);
  }
}
