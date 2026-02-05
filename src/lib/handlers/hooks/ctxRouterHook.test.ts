/**
 * Tests for ctx:: Router Hook
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerCtxRouterHook,
  unregisterCtxRouterHook,
} from './ctxRouterHook';
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

describe('ctxRouterHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerCtxRouterHook();
  });

  afterEach(() => {
    unregisterCtxRouterHook();
  });

  function createTestBlock(content: string): Block {
    return {
      id: 'test-block',
      parentId: null,
      childIds: [],
      content,
      type: 'ctx',
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

  it('extracts markers from ctx:: block and updates metadata', () => {
    const block = createTestBlock('ctx::2026-02-05 @ 10:00 AM [project::floatty] [mode::work]');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        markers: [
          { markerType: 'ctx', value: '2026-02-05' },  // Date extracted from timestamp
          { markerType: 'project', value: 'floatty' },
          { markerType: 'mode', value: 'work' },
        ],
        extractedAt: expect.any(Number),
      }),
      'hook'
    );
  });

  it('ignores blocks without ctx:: pattern', () => {
    const block = createTestBlock('just some regular text');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('ignores ctx:: without timestamp (abstract discussion)', () => {
    const block = createTestBlock('we talked about ctx:: patterns yesterday');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('skips events from hook origin (prevents loops)', () => {
    const block = createTestBlock('ctx::2026-02-05 @ 10:00 AM [project::floatty]');

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
    const block = createTestBlock('ctx::2026-02-05 @ 10:00 AM [issue::123]');

    emitBlockEvent(block, 'block:update');

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        markers: [
          { markerType: 'ctx', value: '2026-02-05' },  // Date extracted from timestamp
          { markerType: 'issue', value: '123' },
        ],
      }),
      'hook'
    );
  });

  it('skips update if markers unchanged', () => {
    const block = createTestBlock('ctx::2026-02-05 @ 10:00 AM [project::floatty]');
    // Pre-set existing markers to match what would be extracted
    block.metadata = {
      markers: [
        { markerType: 'ctx', value: '2026-02-05' },  // Date matches extracted value
        { markerType: 'project', value: 'floatty' },
      ],
      outlinks: [],
      isStub: false,
      extractedAt: Date.now() - 1000,
    };

    emitBlockEvent(block, 'block:update');

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('requires date after ctx:: to trigger extraction', () => {
    // ctx:: without YYYY-MM-DD is treated as prose, not a marker
    // This prevents false positives like "we discussed ctx:: patterns"
    const block = createTestBlock('ctx:: [project::floatty] notes without date');

    emitBlockEvent(block);

    // Should NOT extract - hasCtxPatterns requires ctx::YYYY-MM-DD
    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });
});
