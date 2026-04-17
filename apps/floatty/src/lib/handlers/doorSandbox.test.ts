/**
 * doorSandbox — buildSubscribeBlockChanges (FLO-587 outside-in plumbing).
 *
 * The infrastructure behind `server.subscribeBlockChanges(handler, options?)`.
 * Door view layer uses this to re-project when their subtree changes; tests
 * here cover the plumbing (subscribe/unsubscribe round-trip, field filter
 * translation, multi-subscription isolation).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { EventEnvelope } from '../events/types';

// vi.mock is hoisted above imports — use vi.hoisted for shared references
const mocks = vi.hoisted(() => ({
  subscribe: vi.fn<(handler: (envelope: EventEnvelope) => void, opts?: unknown) => string>(
    () => 'sub-id-1',
  ),
  unsubscribe: vi.fn<(id: string) => boolean>(() => true),
}));

vi.mock('../events/eventBus', () => ({
  blockEventBus: {
    subscribe: mocks.subscribe,
    unsubscribe: mocks.unsubscribe,
  },
}));

import { buildSubscribeBlockChanges } from './doorSandbox';

describe('buildSubscribeBlockChanges (FLO-587)', () => {
  beforeEach(() => {
    mocks.subscribe.mockClear();
    mocks.unsubscribe.mockClear();
    mocks.subscribe.mockImplementation(() => 'sub-id-1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subscribes with priority 50 and a debug name', () => {
    const subscribe = buildSubscribeBlockChanges();
    const handler = vi.fn();

    subscribe(handler);

    expect(mocks.subscribe).toHaveBeenCalledTimes(1);
    const [, opts] = mocks.subscribe.mock.calls[0];
    expect(opts).toMatchObject({
      priority: 50,
      name: 'door-subscribeBlockChanges',
    });
  });

  it('invokes the door-supplied handler with no arguments (pulse)', () => {
    const subscribe = buildSubscribeBlockChanges();
    const handler = vi.fn();

    subscribe(handler);

    // Simulate the event bus calling our wrapped handler with a real envelope
    const wrapped = mocks.subscribe.mock.calls[0][0];
    const fakeEnvelope = {
      batchId: 'b1',
      timestamp: 0,
      origin: 'user',
      events: [],
    } as unknown as EventEnvelope;
    wrapped(fakeEnvelope);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(); // no args
  });

  it('omits filter when no fields option is provided', () => {
    const subscribe = buildSubscribeBlockChanges();
    subscribe(vi.fn());

    const [, opts] = mocks.subscribe.mock.calls[0];
    expect((opts as { filter?: unknown }).filter).toBeUndefined();
  });

  it('translates { fields: ["content", "childIds"] } into a filter function', () => {
    const subscribe = buildSubscribeBlockChanges();
    subscribe(vi.fn(), { fields: ['content', 'childIds'] });

    const [, opts] = mocks.subscribe.mock.calls[0];
    const filter = (opts as { filter?: unknown }).filter;
    expect(typeof filter).toBe('function');
  });

  it('returns an unsubscribe function that calls blockEventBus.unsubscribe', () => {
    const subscribe = buildSubscribeBlockChanges();
    const unsubscribe = subscribe(vi.fn());

    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    unsubscribe();
    expect(mocks.unsubscribe).toHaveBeenCalledWith('sub-id-1');
  });

  it('supports multiple independent subscriptions with distinct ids', () => {
    const subscribe = buildSubscribeBlockChanges();
    mocks.subscribe
      .mockImplementationOnce(() => 'sub-a')
      .mockImplementationOnce(() => 'sub-b');

    const unsubA = subscribe(vi.fn());
    const unsubB = subscribe(vi.fn());

    expect(mocks.subscribe).toHaveBeenCalledTimes(2);

    unsubA();
    expect(mocks.unsubscribe).toHaveBeenLastCalledWith('sub-a');

    unsubB();
    expect(mocks.unsubscribe).toHaveBeenLastCalledWith('sub-b');
  });

  it('filter accepts events whose changedFields include a requested field', () => {
    const subscribe = buildSubscribeBlockChanges();
    subscribe(vi.fn(), { fields: ['content'] });

    const [, opts] = mocks.subscribe.mock.calls[0];
    const filter = (opts as {
      filter?: (event: unknown, envelope: EventEnvelope) => boolean;
    }).filter;
    expect(typeof filter).toBe('function');
    if (typeof filter !== 'function') return;

    const envelope = {
      batchId: 'b', timestamp: 0, origin: 'user', events: [],
    } as unknown as EventEnvelope;
    const matchingEvent = {
      type: 'block:update', blockId: 'x', changedFields: ['content'],
    };
    expect(filter(matchingEvent, envelope)).toBe(true);
  });

  it('filter rejects events whose changedFields do not intersect the requested fields', () => {
    const subscribe = buildSubscribeBlockChanges();
    subscribe(vi.fn(), { fields: ['content'] });

    const [, opts] = mocks.subscribe.mock.calls[0];
    const filter = (opts as {
      filter?: (event: unknown, envelope: EventEnvelope) => boolean;
    }).filter;
    expect(typeof filter).toBe('function');
    if (typeof filter !== 'function') return;

    const envelope = {
      batchId: 'b', timestamp: 0, origin: 'user', events: [],
    } as unknown as EventEnvelope;
    const nonMatchingEvent = {
      type: 'block:update', blockId: 'x', changedFields: ['collapsed'],
    };
    expect(filter(nonMatchingEvent, envelope)).toBe(false);
  });
});
