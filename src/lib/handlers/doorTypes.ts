/**
 * Door System Types
 *
 * Type definitions for the door plugin system.
 * Doors are pre-compiled .js files that extend HandlerRegistry
 * with user-defined handlers and SolidJS view components.
 */

import type { Component } from 'solid-js';
import type { BatchBlockOp } from '../../hooks/useBlockStore';

// ═══════════════════════════════════════════════════════════════
// PRIMITIVES
// ═══════════════════════════════════════════════════════════════

/** JSON-safe recursive type. DoorResult.data must be this. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type DoorKind = 'view' | 'block';

// ═══════════════════════════════════════════════════════════════
// DOOR INTERFACE (exported by door modules)
// ═══════════════════════════════════════════════════════════════

/** View door: returns structured data, renders via SolidJS component */
export interface ViewDoor<T = unknown> {
  kind: 'view';
  prefixes: string[];
  execute(blockId: string, content: string, ctx: DoorContext): Promise<DoorResult<T>>;
  view: Component<DoorViewProps<T>>;
}

/** Block door: mutates blocks via ctx.actions, no view component */
export interface BlockDoor {
  kind: 'block';
  prefixes: string[];
  execute(blockId: string, content: string, ctx: DoorContext): Promise<void>;
  view?: never;
}

export type Door<T = unknown> = ViewDoor<T> | BlockDoor;

// ═══════════════════════════════════════════════════════════════
// DOOR META (exported by door modules alongside door)
// ═══════════════════════════════════════════════════════════════

/** Door metadata — stable identity, capabilities declaration */
export interface DoorMeta {
  /** Stable registry key, output key, settings key. NOT a prefix. */
  id: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  /** Tier 2 capability declarations (omit if Tier 1 only) */
  capabilities?: {
    fs?: string[];
    invoke?: string[];
    fetch?: string[];
  };
  /** Whether this door can appear as a sidebar tab (Phase 2+) */
  sidebarEligible?: boolean;
}

// ═══════════════════════════════════════════════════════════════
// DOOR CONTEXT (passed to door.execute)
// ═══════════════════════════════════════════════════════════════

/** Pre-authenticated access to floatty-server REST API */
export interface DoorServerAccess {
  url: string;
  wsUrl: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** Scoped block operations available to doors */
export interface ScopedActions {
  // Block creation
  createBlockInside(parentId: string): string;
  createBlockInsideAtTop(parentId: string): string;
  createBlockAfter(afterId: string): string;
  // Batch creation (single Y.Doc transaction)
  batchCreateBlocksAfter(afterId: string, ops: BatchBlockOp[]): string[];
  batchCreateBlocksInside(parentId: string, ops: BatchBlockOp[]): string[];
  batchCreateBlocksInsideAtTop(parentId: string, ops: BatchBlockOp[]): string[];
  // Block mutation
  updateBlockContent(id: string, content: string): void;
  deleteBlock(id: string): boolean;
  // Block read
  getBlock(id: string): unknown | undefined;
  getParentId(id: string): string | undefined;
  getChildren(id: string): string[];
  rootIds(): readonly string[];
  // Block output/status
  setBlockOutput(id: string, output: unknown, outputType: string): void;
  setBlockStatus(id: string, status: 'idle' | 'running' | 'complete' | 'error'): void;
  // UI interaction
  focusBlock(id: string): void;
  // Streaming (optional — not all contexts support it)
  appendBlockContent?(id: string, chunk: string): void;
}

/** Full context provided to door.execute() */
export interface DoorContext {
  // Tier 1 — always available
  server: DoorServerAccess;
  actions: ScopedActions;
  settings: Record<string, unknown>;
  blockId: string;
  content: string;
  doorId: string;
  log: (...args: unknown[]) => void;

  // Tier 2 — requires capabilities declaration
  fs: ScopedFS;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  invoke: ScopedInvoke;

  /** Internal: tracks block IDs created during execution */
  _createdBlockIds?: () => string[];
}

/** Scoped filesystem access (Tier 2) */
export interface ScopedFS {
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string, glob?: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

/** Scoped Tauri invoke (Tier 2) */
export type ScopedInvoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

// ═══════════════════════════════════════════════════════════════
// DOOR OUTPUT (stored in Y.Doc via setBlockOutput)
// ═══════════════════════════════════════════════════════════════

/** Result from a view door's execute() */
export interface DoorResult<T = unknown> {
  data: T;
  error?: string;
}

/** Props received by a door's view component */
export interface DoorViewProps<T = unknown> {
  data: T;
  settings: Record<string, unknown>;
  server: DoorServerAccess;
  onNavigateOut?: (direction: 'up' | 'down') => void;
  onNavigate?: (target: string, opts?: { type?: 'page' | 'block'; splitDirection?: 'horizontal' | 'vertical' }) => void;
}

/** View door output envelope (stored in block.output) */
export interface DoorViewOutput {
  kind: 'view';
  doorId: string;
  schema: 1;
  data: JsonValue | null;
  error?: string;
}

/** Block door output envelope (stored in block.output) */
export interface DoorExecOutput {
  kind: 'exec';
  schema: 1;
  doorId: string;
  startedAt: number;
  finishedAt?: number;
  ok: boolean;
  summary?: string;
  error?: string;
  createdBlockIds?: string[];
}

/** Discriminated union for block.output when outputType === 'door' */
export type DoorEnvelope = DoorViewOutput | DoorExecOutput;

// ═══════════════════════════════════════════════════════════════
// LOADER TYPES
// ═══════════════════════════════════════════════════════════════

/** Door manifest info returned from Rust list_door_files command */
export interface DoorInfo {
  id: string;
  prefixes: string[];
  name: string;
  version?: string;
  hasEntry: boolean;
}

/** Per-door load result */
export interface DoorLoadResult {
  doorId: string;
  ok: boolean;
  error?: string;
}
