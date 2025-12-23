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
    existing.set(key, value);
  } else if (existing && typeof existing === 'object') {
    const updated = { ...(existing as Record<string, unknown>), [key]: value };
    blocksMap.set(blockId, updated);
  }
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
    metadata: (getValue(value, 'metadata') as Record<string, any>) || undefined,
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

  const initFromYDoc = (doc: Y.Doc) => {
    // Double-check guard: store state (reactive) + local flag (sync)
    if (state.isInitialized || _isInitializing) return;
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

    // Observe Blocks Map (Granular Updates)
    blocksMap.observe((event) => {
      batch(() => {
        event.changes.keys.forEach((change, key) => {
          if (change.action === 'add' || change.action === 'update') {
            const block = toBlock(blocksMap.get(key));
            if (block) {
              setState('blocks', key, block);
            }
          } else if (change.action === 'delete') {
            setState('blocks', key, undefined!); 
          }
        });
      });
    });

    // Observe Root IDs (Full sync for simplicity on list changes)
    rootIdsArr.observe(() => {
      console.log('[BlockStore] Root IDs updated:', rootIdsArr.length);
      setState('rootIds', rootIdsArr.toArray());
    });
  };

  const getBlock = (id: string) => {
    return state.blocks[id];
  };

  const updateBlockContent = (id: string, content: string) => {
    if (!_doc) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'content', content);
      setValueOnYMap(blocksMap, id, 'type', parseBlockType(content));
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    });
  };

  const createBlockAfter = (afterId: string) => {
    if (!_doc) return '';

    const afterBlock = state.blocks[afterId];
    if (!afterBlock) return '';

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '', afterBlock.parentId);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      blocksMap.set(newId, blockToPlainObject(newBlock));

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
    if (!_doc) return '';

    const parentBlock = state.blocks[parentId];
    if (!parentBlock) return '';

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '', parentId);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      blocksMap.set(newId, blockToPlainObject(newBlock));

      const parentData = blocksMap.get(parentId);
      const childIds = [...((getValue(parentData, 'childIds') as string[]) || [])];
      childIds.push(newId);
      setValueOnYMap(blocksMap, parentId, 'childIds', childIds);
      setValueOnYMap(blocksMap, parentId, 'collapsed', false);
    });

    return newId;
  };

  const createBlockInsideAtTop = (parentId: string) => {
    if (!_doc) return '';

    const parentBlock = state.blocks[parentId];
    if (!parentBlock) return '';

    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '', parentId);

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      blocksMap.set(newId, blockToPlainObject(newBlock));

      const parentData = blocksMap.get(parentId);
      const childIds = [...((getValue(parentData, 'childIds') as string[]) || [])];
      childIds.unshift(newId); // Insert at start
      setValueOnYMap(blocksMap, parentId, 'childIds', childIds);
      setValueOnYMap(blocksMap, parentId, 'collapsed', false);
    });

    return newId;
  };

  const splitBlock = (id: string, offset: number) => {
    if (!_doc) return null;

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
      blocksMap.set(newId, blockToPlainObject(newBlock));

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

  const deleteBlock = (id: string) => {
    if (!_doc) return;

    const block = state.blocks[id];
    if (!block) return;

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
  };

  const clearWorkspace = () => {
    if (!_doc) return;

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
    });

    console.log('[BlockStore] Workspace cleared, sync will persist to Rust.');
  };

  const indentBlock = (id: string) => {
    if (!_doc) return;

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
    if (!_doc) return;

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
    if (!_doc) return;

    const block = state.blocks[id];
    if (!block || block.childIds.length === 0) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'collapsed', !block.collapsed);
    });
  };

  const createInitialBlock = () => {
    if (!_doc) return '';
    
    const newId = crypto.randomUUID();
    const newBlock = createBlock(newId, '');

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      const rootIds = _doc.getArray<string>('rootIds');
      
      blocksMap.set(newId, blockToPlainObject(newBlock));
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
    createBlockAfter,
    createBlockInside,
    createBlockInsideAtTop,
    splitBlock,
    deleteBlock,
    indentBlock,
    outdentBlock,
    toggleCollapsed,
    createInitialBlock,
    clearWorkspace,
  };
}

export const blockStore = createRoot(createBlockStore);