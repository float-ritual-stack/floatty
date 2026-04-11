/**
 * Tests for Outlinks Extraction Hook
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerOutlinksHook,
  unregisterOutlinksHook,
} from './outlinksHook';
import {
  blockEventBus,
  Origin,
  type EventEnvelope,
  type BlockEvent,
} from '../../events';
import type { Block } from '../../blockTypes';
import { blockStore } from '../../../hooks/useBlockStore';

// Mock blockStore
vi.mock('../../../hooks/useBlockStore', () => ({
  blockStore: {
    updateBlockMetadata: vi.fn(),
  },
}));

describe('outlinksHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerOutlinksHook();
  });

  afterEach(() => {
    unregisterOutlinksHook();
  });

  function createTestBlock(content: string): Block {
    return {
      id: 'test-block',
      parentId: null,
      childIds: [],
      content,
      type: 'text',
      collapsed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function emitBlockEvent(block: Block, type: 'block:create' | 'block:update' = 'block:create') {
    const event: BlockEvent = {
      type,
      blockId: block.id,
      block,
    };

    const envelope: EventEnvelope = {
      batchId: 'test-batch',
      timestamp: Date.now(),
      origin: Origin.User,
      events: [event],
    };

    blockEventBus.emit(envelope);
  }

  it('extracts outlinks from wikilinks and updates metadata', () => {
    const block = createTestBlock('Check out [[Page One]] and [[Page Two]]');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        outlinks: expect.arrayContaining(['Page One', 'Page Two']),
        extractedAt: expect.any(Number),
      }),
      'hook'
    );
  });

  it('handles aliased wikilinks [[Target|Alias]]', () => {
    const block = createTestBlock('See [[Real Page|display text]] for more');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        outlinks: ['Real Page'],
      }),
      'hook'
    );
  });

  it('deduplicates multiple links to same page', () => {
    const block = createTestBlock('[[Page]] is great. Did I mention [[Page]]?');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        outlinks: ['Page'],  // Only one, not two
      }),
      'hook'
    );
  });

  it('ignores blocks without wikilinks', () => {
    const block = createTestBlock('just some regular text without links');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('skips events from hook origin (prevents loops)', () => {
    const block = createTestBlock('[[Some Page]]');

    const event: BlockEvent = {
      type: 'block:update',
      blockId: block.id,
      block,
    };

    const envelope: EventEnvelope = {
      batchId: 'test-batch',
      timestamp: Date.now(),
      origin: Origin.Hook,  // From a hook
      events: [event],
    };

    blockEventBus.emit(envelope);

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('handles block:update events', () => {
    const block = createTestBlock('Updated to include [[New Link]]');

    emitBlockEvent(block, 'block:update');

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        outlinks: ['New Link'],
      }),
      'hook'
    );
  });

  it('skips update if outlinks unchanged', () => {
    const block = createTestBlock('See [[Existing Page]] here');
    // Pre-set existing outlinks to match what would be extracted
    block.metadata = {
      markers: [],
      outlinks: ['Existing Page'],
      isStub: false,
      extractedAt: Date.now() - 1000,
    };

    emitBlockEvent(block, 'block:update');

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('handles nested wikilinks', () => {
    const block = createTestBlock('Meeting with [[person:: [[John Smith]]]]');

    emitBlockEvent(block);

    // Should extract the outer target which contains the nested brackets
    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        outlinks: expect.arrayContaining(['person:: [[John Smith]]']),
      }),
      'hook'
    );
  });
});
