/**
 * Block types for the integrated outliner
 *
 * BlockType, BlockMetadata, and Marker are generated from Rust via ts-rs.
 * To regenerate: `cd src-tauri && cargo run --bin ts-gen`
 */

// Re-export generated types (single source of truth from Rust)
export type { BlockType } from '../generated/BlockType';
export type { BlockMetadata } from '../generated/BlockMetadata';
export type { Marker } from '../generated/Marker';

import type { BlockType } from '../generated/BlockType';
import type { BlockMetadata } from '../generated/BlockMetadata';

/**
 * Block interface for the outliner.
 *
 * **Core fields** (id through updatedAt) are synced to Rust via ts-rs generated types
 * and persisted in Y.Doc. See `src-tauri/floatty-core/src/block.rs` for Rust definition.
 *
 * **Execution output fields** (output, outputType, outputStatus) are client-only state
 * stored in Y.Doc but NOT synced to Rust. These track the transient state of executable
 * blocks (sh::, ai::, daily::) and are intentionally excluded from the Rust Block struct
 * because:
 *   1. Execution is frontend-only (no server-side execution yet)
 *   2. Output can be large and is ephemeral (regenerated on re-run)
 *   3. Status is UI-only state (pending/running/complete/error)
 *
 * Future consideration: If server-side execution is added, these fields should move
 * to `metadata.execution` to maintain the metadata-as-extensible-storage pattern.
 */
export interface Block {
  id: string;
  parentId: string | null;
  childIds: string[];
  content: string;
  type: BlockType;
  metadata?: BlockMetadata | null;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;

  /**
   * Execution output for executable blocks (sh::, ai::, daily::).
   * Client-only state, stored in Y.Doc but not synced to Rust.
   */
  output?: unknown;
  /** Output view type: 'daily-view', 'kanban-view', etc. */
  outputType?: string;
  /** Execution status for UI feedback. */
  outputStatus?: 'pending' | 'running' | 'complete' | 'error';

  /**
   * Table configuration for blocks containing markdown tables.
   * Stored in Y.Doc but not synced to Rust (UI-only state like output fields).
   */
  tableConfig?: TableConfig;
}

/**
 * Configuration for markdown tables (FLO-58).
 * Stored per-block to persist column widths after resize.
 */
export interface TableConfig {
  /** Column widths as percentages (must sum to ~100). Only stored after first resize. */
  columnWidths?: number[];
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
  // Note: daily:: uses child-output pattern (like sh::, ai::)
  // See docs/BLOCK_TYPE_PATTERNS.md for when to use type-based vs child-output
  if (lower.startsWith('filter::')) return 'filter';
  if (lower.startsWith('search::')) return 'search';

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
