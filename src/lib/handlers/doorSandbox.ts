/**
 * Door Sandbox — DoorContext Builder with Tier Enforcement
 *
 * Builds the DoorContext passed to door.execute().
 * Tier 1 (server, actions, settings, log) always available.
 * Tier 2 (fs, fetch, invoke) requires capabilities declaration — stubs throw for v1.
 */

import type {
  DoorContext,
  DoorMeta,
  DoorServerAccess,
  ScopedActions,
  ScopedFS,
  ScopedInvoke,
} from './doorTypes';
import type { ExecutorActions } from './types';
import type { BatchBlockOp } from '../../hooks/useBlockStore';

// ═══════════════════════════════════════════════════════════════
// SERVER ACCESS (Tier 1)
// ═══════════════════════════════════════════════════════════════

/**
 * Build DoorServerAccess from globals set by httpClient.ts.
 * Pre-injects Bearer token so doors don't need to know the API key.
 */
export function createServerAccess(): DoorServerAccess {
  const url = window.__FLOATTY_SERVER_URL__;
  const apiKey = window.__FLOATTY_API_KEY__;

  if (!url || !apiKey) {
    throw new Error('[doorSandbox] Server info not available — httpClient not initialized');
  }

  const wsUrl = url.replace(/^http/, 'ws') + '/ws';

  return {
    url,
    wsUrl,
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      const fullUrl = `${url}${path}`;
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${apiKey}`);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      return globalThis.fetch(fullUrl, { ...init, headers });
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// SCOPED ACTIONS (Tier 1)
// ═══════════════════════════════════════════════════════════════

/**
 * Wrap ExecutorActions into ScopedActions, tracking created block IDs.
 */
function createScopedActions(
  actions: ExecutorActions,
  createdBlockIds: string[]
): ScopedActions {
  return {
    // ── Block creation ──────────────────────────────────────────
    createBlockInside(parentId: string): string {
      const id = actions.createBlockInside(parentId);
      createdBlockIds.push(id);
      return id;
    },
    createBlockInsideAtTop(parentId: string): string {
      const id = actions.createBlockInsideAtTop?.(parentId);
      if (!id) throw new Error('createBlockInsideAtTop not available');
      createdBlockIds.push(id);
      return id;
    },
    createBlockAfter(afterId: string): string {
      const id = actions.createBlockAfter?.(afterId);
      if (!id) throw new Error('createBlockAfter not available');
      createdBlockIds.push(id);
      return id;
    },
    // ── Batch creation ──────────────────────────────────────────
    batchCreateBlocksAfter(afterId: string, ops: BatchBlockOp[]): string[] {
      const ids = actions.batchCreateBlocksAfter?.(afterId, ops);
      if (!ids) throw new Error('batchCreateBlocksAfter not available');
      createdBlockIds.push(...ids);
      return ids;
    },
    batchCreateBlocksInside(parentId: string, ops: BatchBlockOp[]): string[] {
      const ids = actions.batchCreateBlocksInside?.(parentId, ops);
      if (!ids) throw new Error('batchCreateBlocksInside not available');
      createdBlockIds.push(...ids);
      return ids;
    },
    batchCreateBlocksInsideAtTop(parentId: string, ops: BatchBlockOp[]): string[] {
      const ids = actions.batchCreateBlocksInsideAtTop?.(parentId, ops);
      if (!ids) throw new Error('batchCreateBlocksInsideAtTop not available');
      createdBlockIds.push(...ids);
      return ids;
    },
    // ── Block mutation ──────────────────────────────────────────
    updateBlockContent(id: string, content: string): void {
      actions.updateBlockContent(id, content);
    },
    deleteBlock(id: string): boolean {
      return actions.deleteBlock?.(id) ?? false;
    },
    moveBlock(blockId: string, targetParentId: string | null, targetIndex: number): boolean {
      return actions.moveBlock?.(blockId, targetParentId, targetIndex) ?? false;
    },
    // ── Block read ──────────────────────────────────────────────
    getBlock(id: string): unknown | undefined {
      return actions.getBlock?.(id);
    },
    getParentId(id: string): string | undefined {
      return actions.getParentId?.(id);
    },
    getChildren(id: string): string[] {
      return actions.getChildren?.(id) ?? [];
    },
    rootIds(): readonly string[] {
      return actions.rootIds ?? [];
    },
    // ── Block output/status ─────────────────────────────────────
    setBlockOutput(id: string, output: unknown, outputType: string): void {
      actions.setBlockOutput?.(id, output, outputType);
    },
    setBlockStatus(id: string, status: 'idle' | 'running' | 'complete' | 'error'): void {
      actions.setBlockStatus?.(id, status);
    },
    // ── UI interaction ──────────────────────────────────────────
    focusBlock(id: string): void {
      actions.focusBlock?.(id);
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// TIER 2 STUBS
// ═══════════════════════════════════════════════════════════════

const tier2Stub = (cap: string) => () =>
  Promise.reject(new Error(`${cap} requires capabilities declaration in door meta`));

const TIER_2_FS: ScopedFS = {
  readFile: tier2Stub('fs access'),
  readBinary: tier2Stub('fs access'),
  writeFile: tier2Stub('fs access'),
  listDir: tier2Stub('fs access'),
  exists: tier2Stub('fs access'),
};

const TIER_2_FETCH: DoorContext['fetch'] = tier2Stub('External fetch. Use ctx.server.fetch() for floatty-server');

const TIER_2_INVOKE: ScopedInvoke = tier2Stub('invoke access');

// ═══════════════════════════════════════════════════════════════
// CONTEXT BUILDER
// ═══════════════════════════════════════════════════════════════

export interface CreateDoorContextOptions {
  blockId: string;
  content: string;
  meta: DoorMeta;
  actions: ExecutorActions;
  settings?: Record<string, unknown>;
}

/**
 * Build a DoorContext for a door execution.
 * Returns context + accessor for createdBlockIds.
 */
export function createDoorContext(
  opts: CreateDoorContextOptions
): DoorContext {
  const createdBlockIds: string[] = [];
  const server = createServerAccess();
  const scopedActions = createScopedActions(opts.actions, createdBlockIds);

  return {
    // Tier 1
    server,
    actions: scopedActions,
    settings: opts.settings ?? {},
    blockId: opts.blockId,
    content: opts.content,
    doorId: opts.meta.id,
    log: (...args: unknown[]) => console.log(`[door:${opts.meta.id}]`, ...args),

    // Tier 2 stubs (v1 — throw on access)
    fs: TIER_2_FS,
    fetch: TIER_2_FETCH,
    invoke: TIER_2_INVOKE,

    // Internal tracking
    _createdBlockIds: () => [...createdBlockIds],
  };
}
