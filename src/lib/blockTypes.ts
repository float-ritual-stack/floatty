/**
 * Block types for the integrated outliner
 */

export type BlockType =
  | 'text'      // No prefix - inert text
  | 'sh'        // sh:: or term:: - shell/terminal
  | 'ai'        // ai:: or chat:: - LLM interface
  | 'ctx'       // ctx:: - context scope
  | 'dispatch'  // dispatch:: - agent execution
  | 'web'       // web:: or link:: - iframe embed
  | 'output'    // Output from sh:: or ai:: execution
  | 'error'     // Error output from execution
  | 'picker'    // picker:: - temporary picker block (tv fuzzy finder)
  | 'h1'        // # heading
  | 'h2'        // ## heading
  | 'h3'        // ### heading
  | 'bullet'    // - bullet point
  | 'todo'      // - [ ] or - [x] checkbox
  | 'quote';    // > blockquote

export interface Block {
  id: string;
  parentId: string | null;
  childIds: string[];
  content: string;
  type: BlockType;
  metadata?: Record<string, any>;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
}

export function parseBlockType(content: string): BlockType {
  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();

  // Magic triggers (case-insensitive)
  if (lower.startsWith('sh::') || lower.startsWith('term::')) return 'sh';
  if (lower.startsWith('ai::') || lower.startsWith('chat::')) return 'ai';
  if (lower.startsWith('ctx::')) return 'ctx';
  if (lower.startsWith('dispatch::')) return 'dispatch';
  if (lower.startsWith('web::') || lower.startsWith('link::')) return 'web';
  if (lower.startsWith('output::')) return 'output';
  if (lower.startsWith('error::')) return 'error';
  if (lower.startsWith('picker::')) return 'picker';

  // Markdown syntax (case-sensitive prefix matching)
  if (trimmed.startsWith('### ')) return 'h3';
  if (trimmed.startsWith('## ')) return 'h2';
  if (trimmed.startsWith('# ')) return 'h1';
  if (trimmed.startsWith('> ')) return 'quote';
  if (/^- \[[ x]\] /i.test(trimmed)) return 'todo';
  if (trimmed.startsWith('- ')) return 'bullet';

  return 'text';
}

export function createBlock(
  id: string,
  content: string = '',
  parentId: string | null = null
): Block {
  const now = Date.now();
  return {
    id,
    parentId,
    childIds: [],
    content,
    type: parseBlockType(content),
    collapsed: false,
    createdAt: now,
    updatedAt: now,
  };
}
