/**
 * useBlockStore - SolidJS store backed by Y.Doc
 */

import { createRoot, batch } from 'solid-js';
import { createStore } from 'solid-js/store';
import * as Y from 'yjs';
import { parseBlockType, createBlock } from '../lib/blockTypes';
import type { Block, BlockType } from '../lib/blockTypes';

// ═══════════════════════════════════════════════════════════════
// STORE TYPES
// ═══════════════════════════════════════════════════════════════

export interface BlockState {
  blocks: Record<string, Block>;
  rootIds: string[];
  isInitialized: boolean;
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

function setValueOnYMap(blocksMap: Y.Map<unknown>, blockId: string, key: string, value: unknown): void {
  const existing = blocksMap.get(blockId);

  if (existing instanceof Y.Map) {
    if (key === 'childIds') {
      // Mutate existing Y.Array in place (CRDT-safe)
      const childIdsArr = existing.get('childIds');
      if (childIdsArr instanceof Y.Array) {
        const newChildIds = value as string[];
        childIdsArr.delete(0, childIdsArr.length);  // Clear
        if (newChildIds.length > 0) {
          childIdsArr.push(newChildIds);  // Replace with new array
        }
      } else {
        // Fallback: create new Y.Array if somehow missing
        const newArr = new Y.Array<string>();
        const newChildIds = value as string[];
        if (newChildIds.length > 0) {
          newArr.push(newChildIds);
        }
        existing.set('childIds', newArr);
      }
    } else {
      existing.set(key, value);
    }
  } else if (existing && typeof existing === 'object') {
    // Legacy fallback for plain objects (migration period)
    const updated = { ...(existing as Record<string, unknown>), [key]: value };
    blocksMap.set(blockId, updated);
  }
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
  };
}

function blockToPlainObject(block: Block): Record<string, unknown> {
  return {
    id: block.id,
    parentId: block.parentId,
    childIds: block.childIds,
    content: block.content,
    type: block.type,
    metadata: block.metadata,
    collapsed: block.collapsed,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
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
  });

  let _doc: Y.Doc | null = null;
  let _isInitializing = false; // Sync guard against race conditions
  let _blocksObserver: ((events: Y.YEvent<any>[]) => void) | null = null;
  let _rootIdsObserver: ((event: Y.YArrayEvent<string>) => void) | null = null;

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
    _blocksObserver = (events: Y.YEvent<any>[]) => {
      batch(() => {
        // Track which blocks need refresh (deduped)
        const blocksToRefresh = new Set<string>();
        const blocksToDelete = new Set<string>();

        for (const event of events) {
          const path = event.path;

          if (path.length === 0 && event instanceof Y.YMapEvent) {
            // Top-level: block added/removed from blocksMap
            event.changes.keys.forEach((change, key) => {
              if (change.action === 'add' || change.action === 'update') {
                blocksToRefresh.add(key);
              } else if (change.action === 'delete') {
                blocksToDelete.add(key);
              }
            });
          } else if (path.length >= 1) {
            // Nested: property changed on existing block
            // path[0] is the block ID
            const blockId = path[0] as string;
            blocksToRefresh.add(blockId);
          }
        }

        // Apply refreshes
        for (const key of blocksToRefresh) {
          const block = toBlock(blocksMap.get(key));
          if (block) {
            setState('blocks', key, block);
          }
        }

        // Apply deletes
        for (const key of blocksToDelete) {
          setState('blocks', key, undefined!);
        }
      });
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
    });
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
        const childIds = [...((getValue(parentData, 'childIds') as string[]) || [])];
        const beforeIndex = childIds.indexOf(beforeId);
        childIds.splice(beforeIndex, 0, newId);  // Insert BEFORE
        setValueOnYMap(blocksMap, beforeBlock.parentId, 'childIds', childIds);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const beforeIndex = arr.indexOf(beforeId);
        rootIds.insert(beforeIndex, [newId]);  // Insert BEFORE
      }
    });

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
        const childIds = [...((getValue(parentData, 'childIds') as string[]) || [])];
        const afterIndex = childIds.indexOf(afterId);
        childIds.splice(afterIndex + 1, 0, newId);
        setValueOnYMap(blocksMap, afterBlock.parentId, 'childIds', childIds);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const afterIndex = arr.indexOf(afterId);
        rootIds.insert(afterIndex + 1, [newId]);
      }
    });

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

      const parentData = blocksMap.get(parentId);
      const childIds = [...((getValue(parentData, 'childIds') as string[]) || [])];
      childIds.push(newId);
      setValueOnYMap(blocksMap, parentId, 'childIds', childIds);
      setValueOnYMap(blocksMap, parentId, 'collapsed', false);
    });

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

      const parentData = blocksMap.get(parentId);
      const childIds = [...((getValue(parentData, 'childIds') as string[]) || [])];
      childIds.unshift(newId); // Insert at start
      setValueOnYMap(blocksMap, parentId, 'childIds', childIds);
      setValueOnYMap(blocksMap, parentId, 'collapsed', false);
    });

    return newId;
  };

  const splitBlock = (id: string, offset: number) => {
    if (!_doc) { warnDocNotReady('splitBlock'); return null; }

    const block = state.blocks[id];
    if (!block) return null;

    const contentBefore = block.content.slice(0, offset);
    const contentAfter = block.content.slice(offset);

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
        const childIds = [...((getValue(parentData, 'childIds') as string[]) || [])];
        const afterIndex = childIds.indexOf(id);
        childIds.splice(afterIndex + 1, 0, newId);
        setValueOnYMap(blocksMap, block.parentId, 'childIds', childIds);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const afterIndex = arr.indexOf(id);
        rootIds.insert(afterIndex + 1, [newId]);
      }
    });

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

    const contentBefore = block.content.slice(0, offset);
    const contentAfter = block.content.slice(offset);

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
      const blockData = blocksMap.get(id);
      const childIds = [...((getValue(blockData, 'childIds') as string[]) || [])];
      childIds.unshift(newId);  // Insert at start
      setValueOnYMap(blocksMap, id, 'childIds', childIds);
      // Ensure expanded so user sees the new child
      setValueOnYMap(blocksMap, id, 'collapsed', false);
    });

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
        const parentData = blocksMap.get(block.parentId);
        const childIds = ((getValue(parentData, 'childIds') as string[]) || []).filter(cid => cid !== id);
        setValueOnYMap(blocksMap, block.parentId, 'childIds', childIds);
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
    });

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
          const parentData = blocksMap.get(parentId);
          const childIds = ((getValue(parentData, 'childIds') as string[]) || []).filter(cid => cid !== id);
          setValueOnYMap(blocksMap, parentId, 'childIds', childIds);
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
    });

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
    });

    console.log('[BlockStore] Workspace cleared with fresh block.');
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
        const oldParentData = blocksMap.get(block.parentId);
        const oldChildIds = ((getValue(oldParentData, 'childIds') as string[]) || []).filter(cid => cid !== id);
        setValueOnYMap(blocksMap, block.parentId, 'childIds', oldChildIds);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const idx = arr.indexOf(id);
        if (idx >= 0) rootIds.delete(idx, 1);
      }

      const newParentData = blocksMap.get(newParentId);
      const newChildIds = [...((getValue(newParentData, 'childIds') as string[]) || []), id];
      setValueOnYMap(blocksMap, newParentId, 'childIds', newChildIds);
      setValueOnYMap(blocksMap, newParentId, 'collapsed', false);

      setValueOnYMap(blocksMap, id, 'parentId', newParentId);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    });
  };

  const outdentBlock = (id: string) => {
    if (!_doc) { warnDocNotReady('outdentBlock'); return; }

    const block = state.blocks[id];
    if (!block || !block.parentId) return;

    const parent = state.blocks[block.parentId];
    if (!parent) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      const parentData = blocksMap.get(block.parentId!);
      if (parentData) {
        const childIds = ((getValue(parentData, 'childIds') as string[]) || []).filter(cid => cid !== id);
        setValueOnYMap(blocksMap, block.parentId!, 'childIds', childIds);
      }

      if (parent.parentId) {
        const grandparentData = blocksMap.get(parent.parentId);
        if (grandparentData) {
          const childIds = [...((getValue(grandparentData, 'childIds') as string[]) || [])];
          const parentIndex = childIds.indexOf(block.parentId!);
          childIds.splice(parentIndex + 1, 0, id);
          setValueOnYMap(blocksMap, parent.parentId, 'childIds', childIds);
        }
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const parentIndex = arr.indexOf(block.parentId!);
        rootIds.insert(parentIndex + 1, [id]);
      }

      setValueOnYMap(blocksMap, id, 'parentId', parent.parentId);
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    });
  };

  const toggleCollapsed = (id: string) => {
    if (!_doc) { warnDocNotReady('toggleCollapsed'); return; }

    const block = state.blocks[id];
    if (!block || block.childIds.length === 0) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'collapsed', !block.collapsed);
    });
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
    });

    return newId;
  };

  return {
    get blocks() { return state.blocks; },
    get rootIds() { return state.rootIds; },
    get isInitialized() { return state.isInitialized; },
    initFromYDoc,
    getBlock,
    updateBlockContent,
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
    toggleCollapsed,
    createInitialBlock,
    clearWorkspace,
  };
}

export const blockStore = createRoot(createBlockStore);