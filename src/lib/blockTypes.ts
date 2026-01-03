/**
 * Block types for the integrated outliner
 *
 * BlockType is generated from Rust via ts-rs to ensure consistency.
 * To regenerate: `cd src-tauri && cargo run --bin ts-gen`
 */

// Re-export the generated BlockType (single source of truth from Rust)
export type { BlockType } from '../generated/BlockType';
import type { BlockType } from '../generated/BlockType';

export interface Block {
  id: string;
  parentId: string | null;
  childIds: string[];
  content: string;
  type: BlockType;
  metadata?: Record<string, unknown>;
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
  // ctx:: at line start OR bullet with ctx:: - block-level context marker
  // Other ctx:: (mid-line in headings, etc) handled by inline parser
  if (lower.startsWith('ctx::') || /^- ctx::\d{4}-\d{2}-\d{2}/i.test(trimmed)) return 'ctx';
  if (lower.startsWith('dispatch::')) return 'dispatch';
  if (lower.startsWith('web::') || lower.startsWith('link::')) return 'web';
  if (lower.startsWith('output::')) return 'output';
  if (lower.startsWith('error::')) return 'error';
  if (lower.startsWith('picker::')) return 'picker';
  if (lower.startsWith('ran::')) return 'ran';

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
