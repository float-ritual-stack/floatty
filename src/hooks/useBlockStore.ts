/**
 * useBlockStore - Zustand store backed by Y.Doc
 *
 * Provides:
 * - Reactive block state from Y.Map observation
 * - Block CRUD operations that modify Y.Doc
 * - Tree traversal utilities
 */

import { create } from 'zustand';
import * as Y from 'yjs';
import { Block, BlockType, parseBlockType, createBlock } from '../lib/blockTypes';

// ═══════════════════════════════════════════════════════════════
// STORE TYPES
// ═══════════════════════════════════════════════════════════════

export interface BlockStore {
  // State
  blocks: Map<string, Block>;
  rootIds: string[];
  isInitialized: boolean;

  // Y.Doc reference
  _doc: Y.Doc | null;

  // Initialization
  initFromYDoc: (doc: Y.Doc) => void;

  // Block operations
  getBlock: (id: string) => Block | undefined;
  updateBlockContent: (id: string, content: string) => void;
  createBlockAfter: (afterId: string) => string;
  createBlockInside: (parentId: string) => string;
  deleteBlock: (id: string) => void;
  indentBlock: (id: string) => void;
  outdentBlock: (id: string) => void;
  toggleCollapsed: (id: string) => void;

  // Internal
  _syncFromYDoc: () => void;
}

// ═══════════════════════════════════════════════════════════════
// Y.DOC HELPERS
// ═══════════════════════════════════════════════════════════════

function getValue(obj: unknown, key: string): unknown {
  if (obj instanceof Y.Map) {
    return obj.get(key);
  }
  if (obj && typeof obj === 'object') {
    return (obj as Record<string, unknown>)[key];
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
    collapsed: block.collapsed,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt,
  };
}

// ═══════════════════════════════════════════════════════════════
// STORE
// ═══════════════════════════════════════════════════════════════

export const useBlockStore = create<BlockStore>((set, get) => ({
  blocks: new Map(),
  rootIds: [],
  isInitialized: false,
  _doc: null,

  initFromYDoc: (doc: Y.Doc) => {
    set({ _doc: doc });

    get()._syncFromYDoc();

    const blocksMap = doc.getMap('blocks');
    blocksMap.observe(() => {
      get()._syncFromYDoc();
    });

    const rootIds = doc.getArray<string>('rootIds');
    rootIds.observe(() => {
      get()._syncFromYDoc();
    });

    set({ isInitialized: true });
  },

  _syncFromYDoc: () => {
    const { _doc } = get();
    if (!_doc) return;

    const blocksMap = _doc.getMap('blocks');
    const rootIdsArr = _doc.getArray<string>('rootIds');

    const blocks = new Map<string, Block>();
    blocksMap.forEach((value, key) => {
      const block = toBlock(value);
      if (block) {
        blocks.set(key, block);
      }
    });

    const oldBlocks = get().blocks;
    const oldRootIds = get().rootIds;
    const newRootIds = rootIdsArr.toArray();

    let blocksChanged = oldBlocks.size !== blocks.size;
    if (!blocksChanged) {
      for (const [id, block] of blocks) {
        const oldBlock = oldBlocks.get(id);
        if (!oldBlock || oldBlock.content !== block.content ||
            oldBlock.collapsed !== block.collapsed ||
            JSON.stringify(oldBlock.childIds) !== JSON.stringify(block.childIds)) {
          blocksChanged = true;
          break;
        }
      }
    }

    const rootIdsChanged = JSON.stringify(oldRootIds) !== JSON.stringify(newRootIds);

    if (blocksChanged || rootIdsChanged) {
      set({
        blocks: blocksChanged ? blocks : oldBlocks,
        rootIds: rootIdsChanged ? newRootIds : oldRootIds,
      });
    }
  },

  getBlock: (id: string) => {
    return get().blocks.get(id);
  },

  updateBlockContent: (id: string, content: string) => {
    const { _doc } = get();
    if (!_doc) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'content', content);
      setValueOnYMap(blocksMap, id, 'type', parseBlockType(content));
      setValueOnYMap(blocksMap, id, 'updatedAt', Date.now());
    });
  },

  createBlockAfter: (afterId: string) => {
    const { _doc, blocks } = get();
    if (!_doc) return '';

    const afterBlock = blocks.get(afterId);
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
  },

  createBlockInside: (parentId: string) => {
    const { _doc, blocks } = get();
    if (!_doc) return '';

    const parentBlock = blocks.get(parentId);
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
  },

  deleteBlock: (id: string) => {
    const { _doc, blocks } = get();
    if (!_doc) return;

    const block = blocks.get(id);
    if (!block) return;

    if (block.childIds.length > 0) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');

      if (block.parentId) {
        const parentData = blocksMap.get(block.parentId);
        const childIds = ((getValue(parentData, 'childIds') as string[]) || []).filter(cid => cid !== id);
        setValueOnYMap(blocksMap, block.parentId, 'childIds', childIds);
      } else {
        const rootIds = _doc.getArray<string>('rootIds');
        const arr = rootIds.toArray();
        const index = arr.indexOf(id);
        if (index >= 0) {
          rootIds.delete(index, 1);
        }
      }

      blocksMap.delete(id);
    });
  },

  indentBlock: (id: string) => {
    const { _doc, blocks } = get();
    if (!_doc) return;

    const block = blocks.get(id);
    if (!block) return;

    let siblings: string[];
    if (block.parentId) {
      const parent = blocks.get(block.parentId);
      siblings = parent?.childIds || [];
    } else {
      siblings = get().rootIds;
    }

    const index = siblings.indexOf(id);
    if (index <= 0) return;

    const newParentId = siblings[index - 1];
    const newParent = blocks.get(newParentId);
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
  },

  outdentBlock: (id: string) => {
    const { _doc, blocks } = get();
    if (!_doc) return;

    const block = blocks.get(id);
    if (!block || !block.parentId) return;

    const parent = blocks.get(block.parentId);
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
  },

  toggleCollapsed: (id: string) => {
    const { _doc, blocks } = get();
    if (!_doc) return;

    const block = blocks.get(id);
    if (!block || block.childIds.length === 0) return;

    _doc.transact(() => {
      const blocksMap = _doc.getMap('blocks');
      setValueOnYMap(blocksMap, id, 'collapsed', !block.collapsed);
    });
  },
}));
