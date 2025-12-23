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
  | 'error';    // Error output from execution

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
  const trimmed = content.trim().toLowerCase();

  if (trimmed.startsWith('sh::') || trimmed.startsWith('term::')) return 'sh';
  if (trimmed.startsWith('ai::') || trimmed.startsWith('chat::')) return 'ai';
  if (trimmed.startsWith('ctx::')) return 'ctx';
  if (trimmed.startsWith('dispatch::')) return 'dispatch';
  if (trimmed.startsWith('web::') || trimmed.startsWith('link::')) return 'web';

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
