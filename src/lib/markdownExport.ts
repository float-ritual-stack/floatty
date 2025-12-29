/**
 * markdownExport.ts - Convert selected blocks to markdown with hierarchy
 *
 * FLO-74: Export selection for clipboard copy
 */

import type { Block } from './blockTypes';

/**
 * Convert a set of selected blocks to markdown text with hierarchy preserved
 *
 * @param selectedIds - Set of block IDs to export
 * @param blocks - Block store (Record<id, Block>)
 * @param visibleOrder - Array of visible block IDs in document order
 * @returns Markdown string with proper indentation
 */
export function blocksToMarkdown(
  selectedIds: Set<string>,
  blocks: Record<string, Block>,
  visibleOrder: string[]
): string {
  if (selectedIds.size === 0) return '';

  // Filter to only selected blocks in document order
  const orderedSelected = visibleOrder.filter(id => selectedIds.has(id));
  if (orderedSelected.length === 0) return '';

  // Find minimum depth to normalize indentation
  const depths = orderedSelected.map(id => getBlockDepth(id, blocks));
  const minDepth = Math.min(...depths);

  // Convert each block to markdown line
  const lines = orderedSelected.map(id => {
    const block = blocks[id];
    if (!block) return '';

    const depth = getBlockDepth(id, blocks);
    const relativeDepth = depth - minDepth;
    const indent = '  '.repeat(relativeDepth);

    return formatBlockLine(block, indent);
  });

  return lines.filter(Boolean).join('\n');
}

/**
 * Get depth of a block (how many ancestors)
 */
function getBlockDepth(id: string, blocks: Record<string, Block>): number {
  let depth = 0;
  let current = blocks[id];
  while (current?.parentId) {
    depth++;
    current = blocks[current.parentId];
  }
  return depth;
}

/**
 * Format a single block as a markdown line
 */
function formatBlockLine(block: Block, indent: string): string {
  const content = block.content;
  const type = block.type;

  // Handle different block types
  switch (type) {
    case 'h1':
      return `${indent}# ${content}`;
    case 'h2':
      return `${indent}## ${content}`;
    case 'h3':
      return `${indent}### ${content}`;
    case 'bullet':
      return `${indent}- ${content}`;
    case 'todo':
      return `${indent}- [ ] ${content}`;
    case 'quote':
      return `${indent}> ${content}`;
    case 'sh':
    case 'ai':
    case 'ctx':
    case 'dispatch':
      // Preserve prefix as-is (these are special markers)
      return `${indent}${content}`;
    case 'output':
    case 'error':
      // Output blocks as code blocks
      return `${indent}\`\`\`\n${content}\n\`\`\``;
    default:
      // Plain text with bullet for hierarchy
      return indent ? `${indent}- ${content}` : content;
  }
}
