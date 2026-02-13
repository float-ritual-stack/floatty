/**
 * useBlockStore - SolidJS store backed by Y.Doc
 */

import { createRoot, batch } from 'solid-js';
import { createStore } from 'solid-js/store';
import * as Y from 'yjs';
import { parseBlockType, createBlock } from '../lib/blockTypes';
import type { Block, BlockType, TableConfig } from '../lib/blockTypes';
import {
  blockEventBus,
  blockProjectionScheduler,
  Origin,
  type BlockChangeField,
  type BlockEvent,
  type EventEnvelope,
  type OriginType,
  type BlockMovePosition,
} from '../lib/events';
import { stopUndoCaptureBoundary } from './useSyncedYDoc';

// ═══════════════════════════════════════════════════════════════
// AUTO-EXECUTE CALLBACK (for external block creation via API)
// ═══════════════════════════════════════════════════════════════

type AutoExecuteHandler = (blockId: string, content: string) => void;
let _autoExecuteHandler: AutoExecuteHandler | null = null;

/**
 * Register handler for auto-executing blocks created externally (API/CRDT sync).
 * Called when a block is ADDED with non-empty executable content.
 */
export function setAutoExecuteHandler(handler: AutoExecuteHandler | null) {
  _autoExecuteHandler = handler;
}

function isAutoExecutable(content: string): boolean {
  // Only auto-execute idempotent view blocks, not side-effect ones like sh::
  // Check content directly (not handler.prefixes) to avoid false positives
  // if a future handler has multiple prefixes including 'daily::'
  const trimmed = content.trim().toLowerCase();
  return trimmed.startsWith('daily::');
  // Future: add || trimmed.startsWith('web::') || trimmed.startsWith('query::')
}

// ═══════════════════════════════════════════════════════════════
// EVENT EMISSION HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Map Y.Doc transaction origin to our Origin type.
 * Used for EventBus origin tagging.
 */
function mapTransactionOrigin(txOrigin: unknown): OriginType {
  if (txOrigin === 'user') return Origin.User;
  if (txOrigin === 'user-drag') return Origin.User;
  if (txOrigin === 'executor') return Origin.Executor;
  if (txOrigin === 'hook') return Origin.Hook;
  if (txOrigin === 'api') return Origin.Api;
  if (txOrigin === 'bulk_import') return Origin.BulkImport;
  if (txOrigin === 'system') return Origin.System;
  if (txOrigin === 'reconnect-authority') return Origin.ReconnectAuthority;
  // Y.UndoManager passes itself as origin
  if (txOrigin && typeof txOrigin === 'object' && 'undo' in txOrigin) {
    return Origin.Undo;
  }
  // Remote changes from other clients
  return Origin.Remote;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqualJsonLike(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;

  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualJsonLike(a[i], b[i])) return false;
    }
    return true;
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqualJsonLike(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
}

/**
 * Compute canonical changedFields for block:update events.
 * Excludes timestamp-only changes (e.g., updatedAt) to keep filters meaningful.
 */
export function computeChangedFields(block: Block, previousBlock: Block): BlockChangeField[] {
  const changedFields: BlockChangeField[] = [];

  if (block.content !== previousBlock.content) changedFields.push('content');
  if (block.type !== previousBlock.type) changedFields.push('type');
  if (block.collapsed !== previousBlock.collapsed) changedFields.push('collapsed');
  if (block.parentId !== previousBlock.parentId) changedFields.push('parentId');
  if (!deepEqualJsonLike(block.childIds, previousBlock.childIds)) changedFields.push('childIds');
  if (!deepEqualJsonLike(block.metadata ?? null, previousBlock.metadata ?? null)) changedFields.push('metadata');
  if (!deepEqualJsonLike(block.output, previousBlock.output)) changedFields.push('output');
  if (block.outputType !== previousBlock.outputType) changedFields.push('outputType');
  if (block.outputStatus !== previousBlock.outputStatus) changedFields.push('outputStatus');

  return changedFields;
}

// ═══════════════════════════════════════════════════════════════
// STORE TYPES
// ═══════════════════════════════════════════════════════════════

export interface BlockState {
  blocks: Record<string, Block>;
  rootIds: string[];
  isInitialized: boolean;
  /** Origin of last Y.Doc transaction - used by BlockItem sync gate */
  lastUpdateOrigin: unknown;
}

interface MoveBlockOptions {
  position?: BlockMovePosition;
  targetId?: string | null;
  sourcePaneId?: string;
  targetPaneId?: string;
  origin?: 'user-drag' | 'user';
}

// ═══════════════════════════════════════════════════════════════
// Y.DOC HELPERS
// ═══════════════════════════════════════════════════════════════

function getValue(obj: unknown, key: string): unknown {
  if (obj instanceof Y.Map) {
    const val = obj.get(key);
    if (val instanceof Y.Array) return val.toArray();
    if (val instanceof Y.Map) return val.toJSON();
    return val;
  }
  if (obj && typeof obj === 'object') {
    const val = (obj as Record<string, unknown>)[key];
    if (val instanceof Y.Array) return val.toArray();
    if (val instanceof Y.Map) return val.toJSON();
    return val;
  }
  return undefined;
}

/** Set a scalar field on a block's Y.Map. Do NOT use for childIds — use surgical helpers instead. */
function setValueOnYMap(blocksMap: Y.Map<unknown>, blockId: string, key: string, value: unknown): void {
  const existing = blocksMap.get(blockId);

  if (existing instanceof Y.Map) {
    existing.set(key, value);
  } else if (existing && typeof existing === 'object') {
    // Legacy fallback for plain objects (migration period)
    const updated = { ...(existing as Record<string, unknown>), [key]: value };
    blocksMap.set(blockId, updated);
  }
}

// ═══════════════════════════════════════════════════════════════
// SURGICAL Y.ARRAY HELPERS
//
// These produce minimal CRDT operations instead of the destructive
// delete-all-then-push pattern that caused childIds duplication
// during bidirectional sync merges (FLO-280).
// ═══════════════════════════════════════════════════════════════

/** Get the Y.Array handle for a block's childIds. Returns null if block or array missing. */
function getChildIdsArray(blocksMap: Y.Map<unknown>, blockId: string): Y.Array<string> | null {
  const blockMap = blocksMap.get(blockId);
  if (!(blockMap instanceof Y.Map)) return null;
  const arr = blockMap.get('childIds');
  if (!(arr instanceof Y.Array)) return null;
  return arr as Y.Array<string>;
}

/** Insert a single child ID at a specific index (clamped to valid range). */
function insertChildId(blocksMap: Y.Map<unknown>, parentId: string, childId: string, atIndex: number): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr) return;
  const safeIndex = Math.max(0, Math.min(atIndex, arr.length));
  arr.insert(safeIndex, [childId]);
}

/** Append a single child ID to the end. */
function appendChildId(blocksMap: Y.Map<unknown>, parentId: string, childId: string): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr) return;
  arr.push([childId]);
}

/** Remove a single child ID by value (finds index, then deletes). */
function removeChildId(blocksMap: Y.Map<unknown>, parentId: string, childId: string): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr) return;
  const items = arr.toArray();
  const idx = items.indexOf(childId);
  if (idx >= 0) {
    arr.delete(idx, 1);
  }
}

/** Insert multiple child IDs at a specific index (clamped to valid range). */
function insertChildIds(blocksMap: Y.Map<unknown>, parentId: string, childIds: string[], atIndex: number): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr || childIds.length === 0) return;
  const safeIndex = Math.max(0, Math.min(atIndex, arr.length));
  arr.insert(safeIndex, childIds);
}

/** Clear all child IDs from a block (intentional full wipe). */
function clearChildIds(blocksMap: Y.Map<unknown>, blockId: string): void {
  const arr = getChildIdsArray(blocksMap, blockId);
  if (!arr || arr.length === 0) return;
  arr.delete(0, arr.length);
}

/** Swap two adjacent entries in childIds. Produces 2 delete + 2 insert ops. */
function swapChildIds(blocksMap: Y.Map<unknown>, parentId: string, indexA: number, indexB: number): void {
  const arr = getChildIdsArray(blocksMap, parentId);
  if (!arr) return;
  // Ensure indexA < indexB
  const lo = Math.min(indexA, indexB);
  const hi = Math.max(indexA, indexB);
  if (lo < 0 || hi >= arr.length || lo === hi) return;
  const valLo = arr.get(lo);
  const valHi = arr.get(hi);
  // Delete hi first (higher index), then lo, to keep indices stable
  arr.delete(hi, 1);
  arr.delete(lo, 1);
  // Insert in order: lo position gets old hi value, hi position gets old lo value
  arr.insert(lo, [valHi]);
  arr.insert(hi, [valLo]);
}

/**
 * Log warning when Y.Doc mutation is skipped because doc isn't ready.
 * This catches silent data loss during initialization race conditions.
 */
function warnDocNotReady(operation: string): void {
  console.warn(`[BlockStore] ${operation} skipped: Y.Doc not initialized. User edit may be lost.`);
}

function toBlock(value: unknown): Block | null {
  if (!value || typeof value !== 'object') return null;

  const id = getValue(value, 'id') as string;
  if (!id) return null;

  return {
    id,
    parentId: getValue(value, 'parentId') as string | null,
    childIds: (getValue(value, 'childIds') as string[]) || [],
    content: (getValue(value, 'content') as string) || '',
    type: (getValue(value, 'type') as BlockType) || 'text',
    metadata: (getValue(value, 'metadata') as Record<string, unknown>) || undefined,
    collapsed: (getValue(value, 'collapsed') as boolean) || false,
    createdAt: getValue(value, 'createdAt') as number,
    updatedAt: getValue(value, 'updatedAt') as number,
    // Execution output fields
    output: getValue(value, 'output') as unknown,
    outputType: getValue(value, 'outputType') as string | undefined,
    outputStatus: getValue(value, 'outputStatus') as Block['outputStatus'],
    // Table config (UI-only)
    tableConfig: getValue(value, 'tableConfig') as TableConfig | undefined,
  };
}

/**
 * Create a nested Y.Map for a block with Y.Array for childIds.
 * This enables granular CRDT updates (no full-block rewrites).
 */
function blockToYMap(block: Block): Y.Map<unknown> {
  const blockMap = new Y.Map<unknown>();
  blockMap.set('id', block.id);
  blockMap.set('parentId', block.parentId);
  blockMap.set('content', block.content);
  blockMap.set('type', block.type);
  blockMap.set('metadata', block.metadata);
  blockMap.set('collapsed', block.collapsed);
  blockMap.set('createdAt', block.createdAt);
  blockMap.set('updatedAt', block.updatedAt);
  // Execution output fields (may be undefined)
  if (block.output !== undefined) {
    blockMap.set('output', block.output);
  }
  if (block.outputType !== undefined) {
    blockMap.set('outputType', block.outputType);
  }
  if (block.outputStatus !== undefined) {
    blockMap.set('outputStatus', block.outputStatus);
  }
  if (block.tableConfig !== undefined) {
    // Clone to avoid storing SolidJS store proxies in Y.Map
    const tableConfig = {
      ...block.tableConfig,
      columnWidths: block.tableConfig.columnWidths
        ? [...block.tableConfig.columnWidths]
        : undefined,
    };
    blockMap.set('tableConfig', tableConfig);
  }

  // childIds as Y.Array for CRDT-safe ordered list
  const childIdsArr = new Y.Array<string>();
  if (block.childIds.length > 0) {
    childIdsArr.push(block.childIds);
  }
  blockMap.set('childIds', childIdsArr);

  return blockMap;
}

// ═══════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════

function createBlockStore() {
  const [state, setState] = createStore<BlockState>({
    blocks: {},
    rootIds: [],
    isInitialized: false,
    // Origin of last Y.Doc transaction (for sync gate in BlockItem)
    // 'user' = local typing, UndoManager = undo/redo, other = remote/external
    lastUpdateOrigin: null as unknown,
  });

  let _doc: Y.Doc | null = null;
  let _isInitializing = false; // Sync guard against race conditions
  let _blocksObserver: ((events: Y.YEvent<unknown>[]) => void) | null = null;
  let _rootIdsObserver: ((event: Y.YArrayEvent<string>) => void) | null = null;
  let _pendingMoveEvent: (BlockEvent & { move: NonNullable<BlockEvent['move']> }) | null = null;

  /**
   * Initialize the store from a Y.Doc.
   * Safe to call multiple times - only first call takes effect.
   *
   * NOTE: Returns a no-op. Observers are never removed because blockStore is
   * a singleton that outlives individual Outliner components. If the first
   * pane's cleanup removed observers, other panes would break.
   */
  const initFromYDoc = (doc: Y.Doc): (() => void) => {
    // Double-check guard: store state (reactive) + local flag (sync)
    if (state.isInitialized || _isInitializing) {
      // Return no-op - observers already set up, don't need per-component cleanup
      return () => {};
    }
    _isInitializing = true;
    _doc = doc;

    const blocksMap = doc.getMap('blocks');
    const rootIdsArr = doc.getArray<string>('rootIds');

    // Initial Sync
    const initialBlocks: Record<string, Block> = {};
    blocksMap.forEach((value, key) => {
      const block = toBlock(value);
      if (block) {
        initialBlocks[key] = block;
      }
    });

    batch(() => {
      setState('blocks', initialBlocks);
      setState('rootIds', rootIdsArr.toArray());
      setState('isInitialized', true);
    });

    // Observe Blocks Map (Deep - handles nested Y.Map property changes)
    _blocksObserver = (events: Y.YEvent<unknown>[]) => {
      // Capture transaction origin for BlockItem sync gate
      // NOTE: All events in a batch share the same transaction, so events[0] is representative
      // 'user' = local typing, UndoManager instance = undo/redo, other = remote/external
      const txOrigin = events[0]?.transaction.origin;
      const origin = mapTransactionOrigin(txOrigin);

      // FLO-320: Bulk origins (initial sync, reconnect) — slim path.
      // Skip event building, previousBlocks capture, auto-execute, drag events.
      // Just sync state to SolidJS store. Hooks don't need 13k+ events on startup.
      const isBulk = origin === Origin.Remote
        || origin === Origin.ReconnectAuthority
        || origin === Origin.BulkImport;

      if (isBulk) {
        batch(() => {
          setState('lastUpdateOrigin', txOrigin);
          const blocksToRefresh = new Set<string>();
          const blocksToDelete = new Set<string>();

          for (const event of events) {
            const path = event.path;
            if (path.length === 0 && event instanceof Y.YMapEvent) {
              event.changes.keys.forEach((change, key) => {
                if (change.action === 'add' || change.action === 'update') {
                  blocksToRefresh.add(key);
                } else if (change.action === 'delete') {
                  blocksToDelete.add(key);
                }
              });
            } else if (path.length >= 1) {
              blocksToRefresh.add(path[0] as string);
            }
          }

          for (const key of blocksToRefresh) {
            const block = toBlock(blocksMap.get(key));
            if (block) setState('blocks', key, block);
          }
          for (const key of blocksToDelete) {
            setState('blocks', key, undefined!);
          }
        });
        return;
      }

      // Normal path: full event building + emission
      const blockEvents: BlockEvent[] = [];
      // Track previous block state for update events (before we modify state)
      const previousBlocks = new Map<string, Block>();

      batch(() => {
        // Expose origin to components (BlockItem uses this for sync decisions)
        setState('lastUpdateOrigin', txOrigin);

        // Track which blocks need refresh (deduped)
        const blocksToRefresh = new Set<string>();
        const blocksToDelete = new Set<string>();

        for (const event of events) {
          const path = event.path;

          if (path.length === 0 && event instanceof Y.YMapEvent) {
            // Top-level: block added/removed from blocksMap
            event.changes.keys.forEach((change, key) => {
              if (change.action === 'add') {
                blocksToRefresh.add(key);

                // AUTO-EXECUTE: Block added with executable content = external origin
                // Local creates use empty content, so non-empty + executable = API/sync
                if (_autoExecuteHandler) {
                  const blockData = blocksMap.get(key);
                  const content = getValue(blockData, 'content') as string;
                  if (content && isAutoExecutable(content)) {
                    // Queue for next tick to let state settle
                    setTimeout(() => _autoExecuteHandler!(key, content), 0);
                  }
                }

                // EventBus: block:create
                const newBlock = toBlock(blocksMap.get(key));
                if (newBlock) {
                  blockEvents.push({
                    type: 'block:create',
                    blockId: key,
                    block: newBlock,
                  });
                }
              } else if (change.action === 'update') {
                // Capture previous state before refresh
                const prevBlock = state.blocks[key];
                if (prevBlock) previousBlocks.set(key, { ...prevBlock });
                blocksToRefresh.add(key);
              } else if (change.action === 'delete') {
                // Capture deleted block state for event
                const deletedBlock = state.blocks[key];
                if (deletedBlock) {
                  blockEvents.push({
                    type: 'block:delete',
                    blockId: key,
                    previousBlock: { ...deletedBlock },
                  });
                }
                blocksToDelete.add(key);
              }
            });
          } else if (path.length >= 1) {
            // Nested: property changed on existing block
            // path[0] is the block ID
            const blockId = path[0] as string;
            // Capture previous state before refresh
            if (!previousBlocks.has(blockId)) {
              const prevBlock = state.blocks[blockId];
              if (prevBlock) previousBlocks.set(blockId, { ...prevBlock });
            }
            blocksToRefresh.add(blockId);
          }
        }

        // Apply refreshes
        for (const key of blocksToRefresh) {
          const block = toBlock(blocksMap.get(key));
          if (block) {
            setState('blocks', key, block);

            // EventBus: block:update (only if we had previous state, i.e., not just created)
            const prevBlock = previousBlocks.get(key);
            if (prevBlock) {
              blockEvents.push({
                type: 'block:update',
                blockId: key,
                block,
                previousBlock: prevBlock,
                changedFields: computeChangedFields(block, prevBlock),
              });
            }
          }
        }

        // Apply deletes
        for (const key of blocksToDelete) {
          setState('blocks', key, undefined!);
        }
      });

      // Attach explicit move event metadata for drag/drop transactions.
      // We keep block:update events for compatibility and add block:move details.
      if (txOrigin === 'user-drag' && _pendingMoveEvent) {
        const moved = toBlock(blocksMap.get(_pendingMoveEvent.blockId));
        if (moved) {
          blockEvents.push({
            ..._pendingMoveEvent,
            block: moved,
          });
        }
        _pendingMoveEvent = null;
      }

      // Emit to EventBus (sync lane) and ProjectionScheduler (async lane)
      // Skip for bulk remote loads (initial sync, reconnect) — hooks don't need to
      // process 13k+ blocks on startup. Metadata was already extracted when blocks
      // were originally created/edited.
      if (blockEvents.length > 0 &&
          origin !== Origin.Remote &&
          origin !== Origin.ReconnectAuthority &&
          origin !== Origin.BulkImport) {
        const envelope: EventEnvelope = {
          batchId: crypto.randomUUID(),
          timestamp: Date.now(),
          origin,
          events: blockEvents,
        };

        // Sync: immediate reactions (UI updates, validation)
        blockEventBus.emit(envelope);

        // Async: batched expensive operations (search index, backlinks)
        blockProjectionScheduler.enqueue(envelope);
      }
    };
    blocksMap.observeDeep(_blocksObserver);

    // Observe Root IDs (Full sync for simplicity on list changes)
    _rootIdsObserver = () => {
      console.log('[BlockStore] Root IDs updated:', rootIdsArr.length);
      setState('rootIds', rootIdsArr.toArray());
    };
    rootIdsArr.observe(_rootIdsObserver);

    // Return no-op - observers live for app lifetime (singleton pattern)
    // Don't cleanup here - other Outliner instances depend on these observers
    return () => {};
  };

  const getBlock = (id: string) => {
    return state.blocks[id];
  };

  const updateBlockContent = (id: string, content: string) => {
    if (!_doc) { warnDocNotReady('updateBlockContent'); return; }

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'content', content);
      setValueOnYMap(blocksMap, id, 'type', parseBlockType(content));
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'user');
  };

  /**
   * Update block content from executor/handler (uses 'executor' origin)
   * Unlike updateBlockContent, this will sync to DOM even when block is focused.
   * Use for handler-initiated changes that should update UI immediately.
   */
  const updateBlockContentFromExecutor = (id: string, content: string) => {
    if (!_doc) { warnDocNotReady('updateBlockContentFromExecutor'); return; }

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'content', content);
      setValueOnYMap(blocksMap, id, 'type', parseBlockType(content));
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'executor');
  };

  /**
   * Set execution output on a block (for daily::, ai::, etc.)
   * Automatically sets outputStatus to 'complete'
   */
  const setBlockOutput = (id: string, output: unknown, outputType: string, status: Block['outputStatus'] = 'complete') => {
    if (!_doc) { warnDocNotReady('setBlockOutput'); return; }

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'output', output);
      setValueOnYMap(blocksMap, id, 'outputType', outputType);
      setValueOnYMap(blocksMap, id, 'outputStatus', status);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'user');
  };

  /**
   * Set output status on a block (for loading indicators)
   */
  const setBlockStatus = (id: string, status: Block['outputStatus']) => {
    if (!_doc) { warnDocNotReady('setBlockStatus'); return; }

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'outputStatus', status);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'user');
  };

  const createBlockBefore = (beforeId: string) => {
    if (!_doc) { warnDocNotReady('createBlockBefore'); return ''; }

    const beforeBlock = state.blocks[beforeId];
    if (!beforeBlock) return '';

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '', beforeBlock.parentId);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      blocksMap.set(newId, blockToYMap(newBlock));

      if (beforeBlock.parentId) {
        const parentData = blocksMap.get(beforeBlock.parentId);
        const childIds = (getValue(parentData, 'childIds') as string[]) || [];
        const beforeIndex = childIds.indexOf(beforeId);
        insertChildId(blocksMap, beforeBlock.parentId, newId, beforeIndex);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const beforeIndex = arr.indexOf(beforeId);
        rootIds.insert(beforeIndex, [newId]);  // Insert BEFORE
      }
    }, 'user');

    return newId;
  };

  const createBlockAfter = (afterId: string) => {
    if (!_doc) { warnDocNotReady('createBlockAfter'); return ''; }

    const afterBlock = state.blocks[afterId];
    if (!afterBlock) return '';

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '', afterBlock.parentId);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      blocksMap.set(newId, blockToYMap(newBlock));

      if (afterBlock.parentId) {
        const parentData = blocksMap.get(afterBlock.parentId);
        const childIds = (getValue(parentData, 'childIds') as string[]) || [];
        const afterIndex = childIds.indexOf(afterId);
        insertChildId(blocksMap, afterBlock.parentId, newId, afterIndex + 1);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const afterIndex = arr.indexOf(afterId);
        rootIds.insert(afterIndex + 1, [newId]);
      }
    }, 'user');

    return newId;
  };

  const createBlockInside = (parentId: string) => {
    if (!_doc) { warnDocNotReady('createBlockInside'); return ''; }

    const parentBlock = state.blocks[parentId];
    if (!parentBlock) return '';

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '', parentId);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      blocksMap.set(newId, blockToYMap(newBlock));

      appendChildId(blocksMap, parentId, newId);
      setValueOnYMap(blocksMap, parentId, 'collapsed', false);
    }, 'user');

    return newId;
  };

  const createBlockInsideAtTop = (parentId: string) => {
    if (!_doc) { warnDocNotReady('createBlockInsideAtTop'); return ''; }

    const parentBlock = state.blocks[parentId];
    if (!parentBlock) return '';

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '', parentId);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      blocksMap.set(newId, blockToYMap(newBlock));

      insertChildId(blocksMap, parentId, newId, 0);
      setValueOnYMap(blocksMap, parentId, 'collapsed', false);
    }, 'user');

    return newId;
  };

  const splitBlock = (id: string, offset: number) => {
    if (!_doc) { warnDocNotReady('splitBlock'); return null; }

    const block = state.blocks[id];
    if (!block) return null;

    // UX: When splitting at a blank line, keep trailing newlines with the top block
    // This feels more natural - the blank line "belongs to" the paragraph above
    let adjustedOffset = offset;
    const content = block.content;

    // If we're at a newline position, consume all consecutive newlines
    if (content[offset] === '\n' || (offset > 0 && content[offset - 1] === '\n')) {
      // Find start of newline sequence (walk back)
      let start = offset;
      while (start > 0 && content[start - 1] === '\n') {
        start--;
      }
      // Find end of newline sequence (walk forward)
      let end = offset;
      while (end < content.length && content[end] === '\n') {
        end++;
      }
      // Keep all newlines with the top block (split at end of newline sequence)
      adjustedOffset = end;
    }

    const contentBefore = content.slice(0, adjustedOffset);
    const contentAfter = content.slice(adjustedOffset);

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, contentAfter, block.parentId);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      // Update current block content
      setValueOnYMap(blocksMap, id, 'content', contentBefore);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());

      // Create new block
      blocksMap.set(newId, blockToYMap(newBlock));

      // Insert new block after current
      if (block.parentId) {
        const parentData = blocksMap.get(block.parentId);
        const childIds = (getValue(parentData, 'childIds') as string[]) || [];
        const afterIndex = childIds.indexOf(id);
        insertChildId(blocksMap, block.parentId, newId, afterIndex + 1);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const afterIndex = arr.indexOf(id);
        rootIds.insert(afterIndex + 1, [newId]);
      }
    }, 'user');

    return newId;
  };

  /**
   * Split block and make the "after" content become FIRST CHILD
   * Used when splitting in middle of an EXPANDED parent - content nests inside
   */
  const splitBlockToFirstChild = (id: string, offset: number) => {
    if (!_doc) { warnDocNotReady('splitBlockToFirstChild'); return null; }

    const block = state.blocks[id];
    if (!block) return null;

    // UX: When splitting at a blank line, keep trailing newlines with the top block
    let adjustedOffset = offset;
    const content = block.content;

    if (content[offset] === '\n' || (offset > 0 && content[offset - 1] === '\n')) {
      let end = offset;
      while (end < content.length && content[end] === '\n') {
        end++;
      }
      adjustedOffset = end;
    }

    const contentBefore = content.slice(0, adjustedOffset);
    const contentAfter = content.slice(adjustedOffset);

    const newId = crypto.randomUUID();
    // New block becomes child of current block (not sibling)
    const newBlock = createBlock(newId, contentAfter, id);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      // Update current block content
      setValueOnYMap(blocksMap, id, 'content', contentBefore);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());

      // Create new block
      blocksMap.set(newId, blockToYMap(newBlock));

      // Insert as FIRST child (unshift, not push)
      insertChildId(blocksMap, id, newId, 0);
      // Ensure expanded so user sees the new child
      setValueOnYMap(blocksMap, id, 'collapsed', false);
    }, 'user');

    return newId;
  };

  const deleteBlock = (id: string): boolean => {
    if (!_doc) { warnDocNotReady('deleteBlock'); return false; }

    const block = state.blocks[id];
    if (!block) return false;

    // Collect all descendant IDs recursively
    const toDelete = new Set<string>();
    const stack = [id];

    while (stack.length > 0) {
      const currentId = stack.pop()!;
      toDelete.add(currentId);
      
      const currentBlock = state.blocks[currentId];
      if (currentBlock && currentBlock.childIds.length > 0) {
        stack.push(...currentBlock.childIds);
      }
    }

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      // Remove from parent's children list
      if (block.parentId) {
        removeChildId(blocksMap, block.parentId, id);
      } else {
        // Remove from rootIds
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const index = arr.indexOf(id);
        if (index >= 0) {
          rootIds.delete(index, 1);
        }
      }

      // Delete all collected blocks from the map
      toDelete.forEach(delId => {
        blocksMap.delete(delId);
      });
    }, 'user');

    return true;
  };

  /**
   * Delete multiple blocks atomically (single undo operation).
   * Used by multi-select delete to ensure Cmd+Z undoes entire selection.
   */
  const deleteBlocks = (ids: string[]): boolean => {
    if (!_doc) { warnDocNotReady('deleteBlocks'); return false; }
    if (ids.length === 0) return false;

    // Collect all blocks to delete (including descendants)
    const toDelete = new Set<string>();
    const blocksToRemoveFromParent: Array<{ id: string; parentId: string | undefined }> = [];

    for (const id of ids) {
      const block = state.blocks[id];
      if (!block) continue;

      // Track parent relationship for removal
      blocksToRemoveFromParent.push({ id, parentId: block.parentId });

      // Collect descendants
      const stack = [id];
      while (stack.length > 0) {
        const currentId = stack.pop()!;
        toDelete.add(currentId);
        const currentBlock = state.blocks[currentId];
        if (currentBlock && currentBlock.childIds.length > 0) {
          stack.push(...currentBlock.childIds);
        }
      }
    }

    if (toDelete.size === 0) return false;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      const rootIds = _doc.getArray<string>('rootIds');

      // Remove each block from its parent's childIds (or rootIds)
      for (const { id, parentId } of blocksToRemoveFromParent) {
        if (parentId) {
          // Skip if parent is also being deleted
          if (toDelete.has(parentId)) continue;
          removeChildId(blocksMap, parentId, id);
        } else {
          const arr = rootIds.toArray();
          const index = arr.indexOf(id);
          if (index >= 0) {
            rootIds.delete(index, 1);
          }
        }
      }

      // Delete all collected blocks from the map
      toDelete.forEach(delId => {
        blocksMap.delete(delId);
      });
    }, 'user');

    return true;
  };

  const clearWorkspace = () => {
    if (!_doc) { warnDocNotReady('clearWorkspace'); return; }

    console.log('[BlockStore] Clearing workspace locally...');

    _doc.transact(() => {
      // Clear rootIds array
      const rootIds = _doc.getArray<string>('rootIds');
      if (rootIds.length > 0) {
        rootIds.delete(0, rootIds.length);
      }

      // Clear blocks map
      const blocksMap = _doc.getMap('blocks');
      blocksMap.forEach((_value, key) => {
        blocksMap.delete(key);
      });

      // Create initial empty block immediately (fixes SolidJS effect batching issue)
      const newId = crypto.randomUUID();
      const newBlock = createBlock(newId, '');
      blocksMap.set(newId, blockToYMap(newBlock));
      rootIds.push([newId]);
    }, 'user');

    console.log('[BlockStore] Workspace cleared with fresh block.');
  };

  const isDescendant = (sourceId: string, targetId: string): boolean => {
    const source = state.blocks[sourceId];
    if (!source) return false;

    const stack = [...source.childIds];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (id === targetId) return true;
      const block = state.blocks[id];
      if (block?.childIds.length) {
        stack.push(...block.childIds);
      }
    }

    return false;
  };

  const moveBlock = (
    blockId: string,
    targetParentId: string | null,
    targetIndex: number,
    opts: MoveBlockOptions = {}
  ): boolean => {
    if (!_doc) { warnDocNotReady('moveBlock'); return false; }

    const block = state.blocks[blockId];
    if (!block) return false;
    if (targetParentId === blockId) return false;
    if (targetParentId && !state.blocks[targetParentId]) return false;
    if (targetParentId && isDescendant(blockId, targetParentId)) return false;

    const oldParentId = block.parentId;
    const oldSiblings = oldParentId
      ? (state.blocks[oldParentId]?.childIds ?? [])
      : state.rootIds;
    const oldIndex = oldSiblings.indexOf(blockId);
    if (oldIndex < 0) return false;

    const targetSiblings = targetParentId
      ? (state.blocks[targetParentId]?.childIds ?? [])
      : state.rootIds;
    const clampedTarget = Math.max(0, Math.min(targetIndex, targetSiblings.length));
    const adjustedTarget =
      oldParentId === targetParentId && oldIndex < clampedTarget
        ? clampedTarget - 1
        : clampedTarget;

    if (oldParentId === targetParentId && oldIndex === adjustedTarget) return false;

    const previousBlock = { ...block };
    _pendingMoveEvent = {
      type: 'block:move',
      blockId,
      previousBlock,
      changedFields:
        oldParentId === targetParentId
          ? ['order', 'childIds']
          : ['parentId', 'order', 'childIds'],
      move: {
        oldParentId,
        newParentId: targetParentId,
        oldIndex,
        newIndex: adjustedTarget,
        position: opts.position ?? 'inside',
        targetId: opts.targetId ?? null,
        sourcePaneId: opts.sourcePaneId,
        targetPaneId: opts.targetPaneId,
      },
    };

    stopUndoCaptureBoundary();
    try {
      _doc.transact(() => {
        const blocksMap = _doc.getMap('blocks');
        const rootIds = _doc.getArray<string>('rootIds');

        // Delete from source container first.
        if (oldParentId) {
          removeChildId(blocksMap, oldParentId, blockId);
        } else {
          const idx = rootIds.toArray().indexOf(blockId);
          if (idx >= 0) rootIds.delete(idx, 1);
        }

        // Then insert into target container.
        if (targetParentId) {
          insertChildId(blocksMap, targetParentId, blockId, adjustedTarget);
          setValueOnYMap(blocksMap, targetParentId, 'collapsed', false);
        } else {
          rootIds.insert(adjustedTarget, [blockId]);
        }

        setValueOnYMap(blocksMap, blockId, 'parentId', targetParentId);
        setValueOnYMap(blocksMap, blockId, 'updatedAt', Date.now());
      }, opts.origin ?? 'user-drag');
    } catch (error) {
      console.error('[BlockStore] moveBlock failed:', error);
      _pendingMoveEvent = null;
      return false;
    } finally {
      stopUndoCaptureBoundary();
    }

    return true;
  };

  const indentBlock = (id: string) => {
    if (!_doc) { warnDocNotReady('indentBlock'); return; }

    const block = state.blocks[id];
    if (!block) return;

    let siblings: string[];
    if (block.parentId) {
      const parent = state.blocks[block.parentId];
      siblings = parent?.childIds || [];
    } else {
      siblings = state.rootIds;
    }

    const index = siblings.indexOf(id);
    if (index <= 0) return;

    const newParentId = siblings[index - 1];
    const newParent = state.blocks[newParentId];
    if (!newParent) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      if (block.parentId) {
        removeChildId(blocksMap, block.parentId, id);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const idx = arr.indexOf(id);
        if (idx >= 0) rootIds.delete(idx, 1);
      }

      appendChildId(blocksMap, newParentId, id);
      setValueOnYMap(blocksMap, newParentId, 'collapsed', false);

      setValueOnYMap(blocksMap, id, 'parentId', newParentId);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'user');
  };

  const outdentBlock = (id: string) => {
    if (!_doc) { warnDocNotReady('outdentBlock'); return; }

    const block = state.blocks[id];
    if (!block || !block.parentId) return;

    const parent = state.blocks[block.parentId];
    if (!parent) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      removeChildId(blocksMap, block.parentId!, id);

      if (parent.parentId) {
        const grandparentData = blocksMap.get(parent.parentId);
        if (grandparentData) {
          const childIds = (getValue(grandparentData, 'childIds') as string[]) || [];
          const parentIndex = childIds.indexOf(block.parentId!);
          insertChildId(blocksMap, parent.parentId, id, parentIndex + 1);
        }
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const parentIndex = arr.indexOf(block.parentId!);
        rootIds.insert(parentIndex + 1, [id]);
      }

      setValueOnYMap(blocksMap, id, 'parentId', parent.parentId);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'user');
  };

  /**
   * Lift block's children to become siblings after a target block.
   * Used during block merge to preserve subtrees.
   *
   * @param blockId - The block whose children should be lifted
   * @param afterId - The block after which children should be inserted as siblings
   */
  const liftChildrenToSiblings = (blockId: string, afterId: string) => {
    if (!_doc) { warnDocNotReady('liftChildrenToSiblings'); return; }

    const block = state.blocks[blockId];
    const afterBlock = state.blocks[afterId];
    if (!block || !afterBlock || block.childIds.length === 0) return;

    const childrenToLift = [...block.childIds];
    const newParentId = afterBlock.parentId;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      // Insert children as siblings after afterId
      // Guard: verify afterId exists in target container before clearing source
      if (newParentId) {
        // afterBlock has a parent - insert into parent's childIds
        const parentData = blocksMap.get(newParentId);
        if (!parentData) return;
        const childIds = (getValue(parentData, 'childIds') as string[]) || [];
        const afterIndex = childIds.indexOf(afterId);
        if (afterIndex < 0) return; // afterId not found - bail to avoid orphaning children

        // Clear children from source block (only after confirming valid insert location)
        clearChildIds(blocksMap, blockId);

        // Insert all lifted children after afterId
        insertChildIds(blocksMap, newParentId, childrenToLift, afterIndex + 1);
      } else {
        // afterBlock is at root level - insert into rootIds
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const afterIndex = arr.indexOf(afterId);
        if (afterIndex < 0) return; // afterId not found - bail to avoid orphaning children

        // Clear children from source block (only after confirming valid insert location)
        clearChildIds(blocksMap, blockId);

        rootIds.insert(afterIndex + 1, childrenToLift);
      }

      // Update parentId for all lifted children
      for (const childId of childrenToLift) {
        setValueOnYMap(blocksMap, childId, 'parentId', newParentId);
        setValueOnYMap(blocksMap, childId, 'updatedAt', Date.now());
      }
    }, 'user');
  };

  /**
   * FLO-75: Move block before its previous sibling
   * Returns true if move happened, false if already first or escaped to parent level
   * When at first sibling position, escapes to become sibling after parent (like outdent)
   */
  const moveBlockUp = (id: string): boolean => {
    if (!_doc) { warnDocNotReady('moveBlockUp'); return false; }

    const block = state.blocks[id];
    if (!block) return false;

    // Get siblings array
    let siblings: string[];
    if (block.parentId) {
      const parent = state.blocks[block.parentId];
      siblings = parent?.childIds || [];
    } else {
      siblings = state.rootIds;
    }

    const index = siblings.indexOf(id);
    if (index < 0) return false;

    // If already first sibling
    if (index === 0) {
      // Escape to parent level if has parent (mirrors outdent)
      if (block.parentId) {
        outdentBlock(id);
        return true;
      }
      // Root level first - nowhere to go
      return false;
    }

    // Swap with previous sibling
    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      if (block.parentId) {
        // Nested block - swap adjacent in parent's childIds
        swapChildIds(blocksMap, block.parentId, index - 1, index);
      } else {
        // Root block - modify rootIds array
        const rootIds = _doc.getArray<string>('rootIds');
        rootIds.delete(index, 1);
        rootIds.insert(index - 1, [id]);
      }

      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'user');

    return true;
  };

  /**
   * FLO-75: Move block after its next sibling
   * Returns true if move happened, false if already last or escaped to parent level
   * When at last sibling position, escapes to become sibling after parent (like outdent)
   */
  const moveBlockDown = (id: string): boolean => {
    if (!_doc) { warnDocNotReady('moveBlockDown'); return false; }

    const block = state.blocks[id];
    if (!block) return false;

    // Get siblings array
    let siblings: string[];
    if (block.parentId) {
      const parent = state.blocks[block.parentId];
      siblings = parent?.childIds || [];
    } else {
      siblings = state.rootIds;
    }

    const index = siblings.indexOf(id);
    if (index < 0) return false;

    // If already last sibling
    if (index >= siblings.length - 1) {
      // Escape to parent level if has parent (mirrors outdent)
      if (block.parentId) {
        outdentBlock(id);
        return true;
      }
      // Root level last - nowhere to go
      return false;
    }

    // Swap with next sibling
    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      if (block.parentId) {
        // Nested block - swap adjacent in parent's childIds
        swapChildIds(blocksMap, block.parentId, index, index + 1);
      } else {
        // Root block - modify rootIds array
        const rootIds = _doc.getArray<string>('rootIds');
        rootIds.delete(index, 1);
        rootIds.insert(index + 1, [id]);
      }

      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'user');

    return true;
  };

  const toggleCollapsed = (id: string) => {
    if (!_doc) { warnDocNotReady('toggleCollapsed'); return; }

    const block = state.blocks[id];
    if (!block || block.childIds.length === 0) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'collapsed', !block.collapsed);
    }, 'user');
  };

  /**
   * Update table configuration (FLO-58).
   * Replaces table configuration - pass undefined to clear.
   */
  const updateTableConfig = (id: string, config: TableConfig | undefined) => {
    if (!_doc) { warnDocNotReady('updateTableConfig'); return; }

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'tableConfig', config);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, 'user');
  };

  /**
   * Update block metadata (for hooks, projections).
   * Merges new metadata with existing (doesn't replace).
   *
   * @param id - Block ID
   * @param metadata - Metadata fields to merge
   * @param origin - Transaction origin (default: 'hook')
   */
  const updateBlockMetadata = (
    id: string,
    metadata: Partial<NonNullable<Block['metadata']>>,
    origin: string = 'hook'
  ) => {
    if (!_doc) { warnDocNotReady('updateBlockMetadata'); return; }

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      const raw = getValue(blocksMap.get(id), 'metadata') as Block['metadata'] | null | undefined;
      const existing = raw ?? {};
      const merged = { ...existing, ...metadata };
      setValueOnYMap(blocksMap, id, 'metadata', merged);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    }, origin);
  };

  const createInitialBlock = () => {
    if (!_doc) { warnDocNotReady('createInitialBlock'); return ''; }

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '');

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      const rootIds = _doc.getArray<string>('rootIds');

      blocksMap.set(newId, blockToYMap(newBlock));
      rootIds.push([newId]);
    }, 'user');

    return newId;
  };

  /**
   * FLO-350: Quarantine orphaned blocks detected by the background worker.
   * Creates an `orphaned-blocks::YYYY-MM-DD-HHMMSS` container at root level
   * and reparents all orphan blocks into it.
   */
  const quarantineOrphans = (orphanIds: string[]) => {
    if (!_doc) { warnDocNotReady('quarantineOrphans'); return; }
    if (orphanIds.length === 0) return;

    // Filter to only IDs that actually exist in our store
    const validIds = orphanIds.filter(id => state.blocks[id]);
    if (validIds.length === 0) return;

    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const timestamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const containerContent = `orphaned-blocks::${timestamp}`;

    const containerId = crypto.randomUUID();
    const containerBlock = createBlock(containerId, containerContent, null);

    console.warn(`[BlockStore] Quarantining ${validIds.length} orphaned blocks into "${containerContent}"`);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      const rootIds = _doc.getArray<string>('rootIds');

      // Create container block with orphans as children
      containerBlock.childIds = validIds;
      blocksMap.set(containerId, blockToYMap(containerBlock));
      rootIds.push([containerId]);

      // Reparent each orphan to the container
      for (const orphanId of validIds) {
        // Remove from old parent's childIds if parent still exists
        const orphan = state.blocks[orphanId];
        if (orphan?.parentId && state.blocks[orphan.parentId]) {
          removeChildId(blocksMap, orphan.parentId, orphanId);
        }
        // Remove from rootIds if present there
        const rootArr = rootIds.toArray();
        const rootIdx = rootArr.indexOf(orphanId);
        if (rootIdx >= 0) {
          rootIds.delete(rootIdx, 1);
        }
        // Set new parent
        setValueOnYMap(blocksMap, orphanId, 'parentId', containerId);
        setValueOnYMap(blocksMap, orphanId, 'updatedAt', Date.now());
      }
    }, 'system');
  };

  return {
    get blocks() { return state.blocks; },
    get rootIds() { return state.rootIds; },
    get isInitialized() { return state.isInitialized; },
    get lastUpdateOrigin() { return state.lastUpdateOrigin; },
    initFromYDoc,
    getBlock,
    updateBlockContent,
    updateBlockContentFromExecutor,  // For handler-initiated updates (syncs even when focused)
    setBlockOutput,  // For daily::, ai:: execution output
    setBlockStatus,  // For loading indicators
    createBlockBefore,
    createBlockAfter,
    createBlockInside,
    createBlockInsideAtTop,
    splitBlock,
    splitBlockToFirstChild,
    deleteBlock,
    deleteBlocks,
    indentBlock,
    outdentBlock,
    liftChildrenToSiblings,
    moveBlock,
    // FLO-75: Block movement
    moveBlockUp,
    moveBlockDown,
    toggleCollapsed,
    updateTableConfig,  // FLO-58: table column widths
    updateBlockMetadata,  // For hooks/projections to write metadata
    createInitialBlock,
    clearWorkspace,
    quarantineOrphans,  // FLO-350: reparent orphans to quarantine container
  };
}

// HMR: Preserve blockStore across hot reloads to prevent empty store state
// Without this, HMR re-executes the module, creating a fresh store with empty blocks
let _blockStoreInstance: ReturnType<typeof createBlockStore> | null = null;

if (import.meta.hot) {
  // Restore from previous module instance if available
  _blockStoreInstance = import.meta.hot.data?.blockStore ?? null;

  import.meta.hot.dispose((data) => {
    // Save store instance for next module load
    data.blockStore = blockStore;
    console.log('[BlockStore] HMR dispose - preserving store');
  });
}

export const blockStore = _blockStoreInstance ?? createRoot(createBlockStore);
