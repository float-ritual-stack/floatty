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

  // FLO-954: expectations are the SERVER's grammar (parsing.rs
  // extract_all_markers, asserted by __fixtures__/marker-grammar.json): the
  // prefix pass yields ctx/null, the standalone pass yields ctx/<date>, tags
  // are any [key::value], and the result is sorted (type, then value with
  // null first).
  it('extracts markers from ctx:: block and updates metadata', () => {
    const block = createTestBlock('ctx::2026-02-05 @ 10:00 AM [project::floatty] [mode::work]');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        markers: [
          { markerType: 'ctx', value: null },
          { markerType: 'ctx', value: '2026-02-05' },
          { markerType: 'mode', value: 'work' },
          { markerType: 'project', value: 'floatty' },
        ],
        extractedAt: expect.any(Number),
      }),
      'hook'
    );
  });

  it('ignores blocks with no markers at all', () => {
    const block = createTestBlock('just some regular text');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('extracts [key::value] tags WITHOUT a ctx:: timestamp (the FLO-954 clobber case)', () => {
    const block = createTestBlock('**demo thursday board**\n[project::demo/catalyst-check] [status::doing]');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        markers: [
          { markerType: 'project', value: 'demo/catalyst-check' },
          { markerType: 'status', value: 'doing' },
        ],
      }),
      'hook'
    );
  });

  it('a bare ctx:: is a marker with no value, like the server says', () => {
    const block = createTestBlock('we talked about ctx:: patterns yesterday');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({ markers: [{ markerType: 'ctx', value: null }] }),
      'hook'
    );
  });

  it('never empties a remote block\'s server-extracted markers (drift is loud, not lossy)', () => {
    // Simulate drift: content this client's grammar finds nothing in, but the
    // server had extracted something for.
    const block = createTestBlock('plain prose');
    block.metadata = {
      markers: [{ markerType: 'project', value: 'server-only' }],
      outlinks: [],
      isStub: false,
      extractedAt: 1_700_000_000,
    };
    const envelope: EventEnvelope = {
      batchId: 'test-batch',
      timestamp: Date.now(),
      origin: Origin.Remote,
      events: [{ type: 'block:create', blockId: block.id, block }],
    };

    blockEventBus.emit(envelope);

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('a LOCAL edit that removes every marker still clears them', () => {
    const block = createTestBlock('plain prose now');
    block.metadata = {
      markers: [{ markerType: 'project', value: 'gone' }],
      outlinks: [],
      isStub: false,
      extractedAt: 1_700_000_000,
    };

    emitBlockEvent(block, 'block:update');

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({ markers: [] }),
      'hook'
    );
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
          { markerType: 'ctx', value: null },
          { markerType: 'ctx', value: '2026-02-05' },
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
        { markerType: 'ctx', value: null },
        { markerType: 'ctx', value: '2026-02-05' },
        { markerType: 'project', value: 'floatty' },
      ],
      outlinks: [],
      isStub: false,
      extractedAt: Date.now() - 1000,
    };

    emitBlockEvent(block, 'block:update');

    expect(blockStore.updateBlockMetadata).not.toHaveBeenCalled();
  });

  it('ctx:: prefix without a date still yields the prefix marker + tags (server parity)', () => {
    const block = createTestBlock('ctx:: [project::floatty] notes without date');

    emitBlockEvent(block);

    expect(blockStore.updateBlockMetadata).toHaveBeenCalledWith(
      'test-block',
      expect.objectContaining({
        markers: [
          { markerType: 'ctx', value: null },
          { markerType: 'project', value: 'floatty' },
        ],
      }),
      'hook'
    );
  });
});
