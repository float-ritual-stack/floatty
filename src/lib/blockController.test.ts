import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRoot } from 'solid-js';
import { createBlockController, type BlockStoreAdapter, type BlockController, type BlockCommittedEvent } from './blockController';

function createMockStore(blocks: Record<string, string> = {}): BlockStoreAdapter {
  const data = new Map(Object.entries(blocks));
  return {
    getBlockContent: (id) => data.get(id),
    updateBlockContent: vi.fn((id: string, content: string) => {
      data.set(id, content);
    }),
  };
}

describe('BlockController', () => {
  let store: BlockStoreAdapter;
  let controller: BlockController;
  let dispose: () => void;

  beforeEach(() => {
    store = createMockStore({ 'b1': 'hello world', 'b2': 'second block' });
    createRoot((d) => {
      dispose = d;
      controller = createBlockController(store);
    });
  });

  // ── Composing lifecycle ──────────────────────────────────

  it('startComposing captures baseline from Y.Doc', () => {
    controller.startComposing('b1');
    expect(controller.isComposing('b1')).toBe(true);
    expect(controller.getBaseline('b1')).toBe('hello world');
  });

  it('startComposing is idempotent (no baseline overwrite)', () => {
    controller.startComposing('b1');
    // Simulate store content changing externally
    (store.updateBlockContent as ReturnType<typeof vi.fn>)('b1', 'changed');
    controller.startComposing('b1'); // Should not re-capture
    expect(controller.getBaseline('b1')).toBe('hello world');
  });

  it('startComposing warns for unknown block', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    controller.startComposing('nonexistent');
    expect(controller.isComposing('nonexistent')).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('isComposing returns false for non-composing blocks', () => {
    expect(controller.isComposing('b1')).toBe(false);
    expect(controller.isComposing('unknown')).toBe(false);
  });

  // ── Commit ───────────────────────────────────────────────

  it('commitBlock writes to store when content changed', () => {
    controller.startComposing('b1');
    const event = controller.commitBlock('b1', 'hello world!', 'blur');

    expect(store.updateBlockContent).toHaveBeenCalledWith('b1', 'hello world!');
    expect(event).not.toBeNull();
    expect(event!.previous).toBe('hello world');
    expect(event!.next).toBe('hello world!');
    expect(event!.source).toBe('blur');
    expect(event!.blockId).toBe('b1');
    expect(controller.isComposing('b1')).toBe(false);
  });

  it('commitBlock is no-op when content unchanged', () => {
    controller.startComposing('b1');
    const event = controller.commitBlock('b1', 'hello world', 'blur');

    expect(store.updateBlockContent).not.toHaveBeenCalled();
    expect(event).toBeNull();
    expect(controller.isComposing('b1')).toBe(false);
  });

  it('commitBlock works without startComposing (graceful fallback)', () => {
    const event = controller.commitBlock('b1', 'new content', 'explicit');

    expect(store.updateBlockContent).toHaveBeenCalledWith('b1', 'new content');
    expect(event).not.toBeNull();
    expect(event!.previous).toBe('hello world');
    expect(event!.next).toBe('new content');
  });

  it('commitBlock graceful fallback no-ops if content matches store', () => {
    const event = controller.commitBlock('b1', 'hello world', 'explicit');
    expect(event).toBeNull();
    expect(store.updateBlockContent).not.toHaveBeenCalled();
  });

  // ── Cancel ───────────────────────────────────────────────

  it('cancelComposing returns baseline and clears state', () => {
    controller.startComposing('b1');
    const baseline = controller.cancelComposing('b1');

    expect(baseline).toBe('hello world');
    expect(controller.isComposing('b1')).toBe(false);
    expect(store.updateBlockContent).not.toHaveBeenCalled();
  });

  it('cancelComposing returns null for non-composing block', () => {
    expect(controller.cancelComposing('b1')).toBeNull();
  });

  // ── Event subscription ──────────────────────────────────

  it('onCommitted fires handler on commit', () => {
    const events: BlockCommittedEvent[] = [];
    controller.onCommitted((e) => events.push(e));

    controller.startComposing('b1');
    controller.commitBlock('b1', 'changed', 'enter');

    expect(events).toHaveLength(1);
    expect(events[0].blockId).toBe('b1');
    expect(events[0].source).toBe('enter');
  });

  it('onCommitted does not fire on no-op commit', () => {
    const events: BlockCommittedEvent[] = [];
    controller.onCommitted((e) => events.push(e));

    controller.startComposing('b1');
    controller.commitBlock('b1', 'hello world', 'blur'); // unchanged

    expect(events).toHaveLength(0);
  });

  it('unsubscribe stops handler', () => {
    const events: BlockCommittedEvent[] = [];
    const unsub = controller.onCommitted((e) => events.push(e));

    controller.startComposing('b1');
    unsub();
    controller.commitBlock('b1', 'changed', 'blur');

    expect(events).toHaveLength(0);
  });

  it('handler errors are caught and logged', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goodEvents: BlockCommittedEvent[] = [];

    controller.onCommitted(() => { throw new Error('boom'); });
    controller.onCommitted((e) => goodEvents.push(e));

    controller.startComposing('b1');
    controller.commitBlock('b1', 'changed', 'blur');

    expect(error).toHaveBeenCalledOnce();
    expect(goodEvents).toHaveLength(1); // Second handler still runs
    error.mockRestore();
  });

  // ── Multiple blocks ─────────────────────────────────────

  it('tracks composing state independently per block', () => {
    controller.startComposing('b1');
    controller.startComposing('b2');

    expect(controller.isComposing('b1')).toBe(true);
    expect(controller.isComposing('b2')).toBe(true);

    controller.commitBlock('b1', 'b1 changed', 'blur');

    expect(controller.isComposing('b1')).toBe(false);
    expect(controller.isComposing('b2')).toBe(true);
  });

  // ── Dispose ─────────────────────────────────────────────

  it('dispose clears all state', () => {
    controller.startComposing('b1');
    const events: BlockCommittedEvent[] = [];
    controller.onCommitted((e) => events.push(e));

    controller.dispose();

    expect(controller.isComposing('b1')).toBe(false);
    // Handler cleared — commit via fallback path shouldn't fire
    controller.commitBlock('b1', 'new', 'explicit');
    expect(events).toHaveLength(0);
  });

  // ── Cleanup SolidJS root ────────────────────────────────

  it('survives SolidJS root disposal', () => {
    controller.startComposing('b1');
    dispose();
    // After disposal, signals are dead but Map still works
    expect(controller.getBaseline('b1')).toBe('hello world');
  });
});
