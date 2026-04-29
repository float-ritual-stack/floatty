/**
 * chirpWriteHandler — verb dispatch and store shape guards.
 *
 * Covers create-child + upsert-child (pre-FLO-587) and update-block +
 * move-block (FLO-587 two-way-binding for render:: kanban).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleChirpWrite,
  isChirpWriteVerb,
  type ChirpWriteStore,
} from './chirpWriteHandler';

vi.mock('./logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeStore(overrides: Partial<ChirpWriteStore> = {}): ChirpWriteStore {
  return {
    createBlockInside: vi.fn(() => 'new-block'),
    updateBlockContent: vi.fn(),
    upsertChildByPrefix: vi.fn(() => 'upsert-block'),
    moveBlock: vi.fn(() => true),
    ...overrides,
  };
}

describe('isChirpWriteVerb', () => {
  it('recognizes all four verbs', () => {
    expect(isChirpWriteVerb('create-child')).toBe(true);
    expect(isChirpWriteVerb('upsert-child')).toBe(true);
    expect(isChirpWriteVerb('update-block')).toBe(true);
    expect(isChirpWriteVerb('move-block')).toBe(true);
  });

  it('rejects unknown verbs', () => {
    expect(isChirpWriteVerb('navigate')).toBe(false);
    expect(isChirpWriteVerb('delete-block')).toBe(false);
    expect(isChirpWriteVerb('')).toBe(false);
  });

  // FLO-587 — focus-sibling is NOT a store write verb. It's host-level
  // focus coordination, dispatched in BlockOutputView's onChirp handler
  // (findPrev/NextVisibleBlock + props.onFocus). If anyone adds it here,
  // handleChirpWrite will try to route it and there's no store method
  // to call — silent drop. This test is the canary.
  it('focus-sibling is NOT a write verb (dispatched in BlockOutputView, not here)', () => {
    expect(isChirpWriteVerb('focus-sibling')).toBe(false);
  });
});

describe('handleChirpWrite — create-child / upsert-child (existing)', () => {
  it('create-child creates a block then sets content', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'create-child',
      { content: 'hello' },
      'parent',
      store,
    );
    expect(result).toEqual({ success: true, blockId: 'new-block' });
    expect(store.createBlockInside).toHaveBeenCalledWith('parent');
    expect(store.updateBlockContent).toHaveBeenCalledWith('new-block', 'hello');
  });

  it('create-child fails when content is missing', () => {
    const store = makeStore();
    const result = handleChirpWrite('create-child', {}, 'parent', store);
    expect(result).toEqual({ success: false });
    expect(store.createBlockInside).not.toHaveBeenCalled();
  });

  it('upsert-child delegates to store', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'upsert-child',
      { content: 'hello', match: 'heading::' },
      'parent',
      store,
    );
    expect(result).toEqual({ success: true, blockId: 'upsert-block' });
    expect(store.upsertChildByPrefix).toHaveBeenCalledWith(
      'parent',
      'heading::',
      'hello',
    );
  });
});

describe('handleChirpWrite — update-block (FLO-587)', () => {
  it('updates the block identified by blockId', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'update-block',
      { blockId: 'card-7', content: 'new text' },
      'parent',
      store,
    );
    expect(result).toEqual({ success: true, blockId: 'card-7' });
    expect(store.updateBlockContent).toHaveBeenCalledWith('card-7', 'new text');
  });

  it('ignores the emitting parent id (blockId in payload wins)', () => {
    const store = makeStore();
    handleChirpWrite(
      'update-block',
      { blockId: 'card-9', content: 'x' },
      'emitter-parent',
      store,
    );
    expect(store.updateBlockContent).toHaveBeenCalledWith('card-9', 'x');
  });

  it('accepts empty-string content (distinct from missing)', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'update-block',
      { blockId: 'card-7', content: '' },
      'parent',
      store,
    );
    expect(result).toEqual({ success: true, blockId: 'card-7' });
    expect(store.updateBlockContent).toHaveBeenCalledWith('card-7', '');
  });

  it('fails when blockId is missing', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'update-block',
      { content: 'orphan' },
      'parent',
      store,
    );
    expect(result).toEqual({ success: false });
    expect(store.updateBlockContent).not.toHaveBeenCalled();
  });

  it('fails when content is missing (undefined, not empty)', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'update-block',
      { blockId: 'card-7' },
      'parent',
      store,
    );
    expect(result).toEqual({ success: false });
    expect(store.updateBlockContent).not.toHaveBeenCalled();
  });
});

describe('handleChirpWrite — move-block (FLO-587)', () => {
  it('dispatches move to the store with provided args', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'move-block',
      { blockId: 'card-3', targetParentId: 'col-doing', targetIndex: 2 },
      'parent',
      store,
    );
    expect(result).toEqual({ success: true, blockId: 'card-3' });
    expect(store.moveBlock).toHaveBeenCalledWith('card-3', 'col-doing', 2);
  });

  it('forwards null targetParentId (move to root)', () => {
    const store = makeStore();
    handleChirpWrite(
      'move-block',
      { blockId: 'card-3', targetParentId: null, targetIndex: 0 },
      'parent',
      store,
    );
    expect(store.moveBlock).toHaveBeenCalledWith('card-3', null, 0);
  });

  it('returns failure when the store rejects the move', () => {
    const store = makeStore({ moveBlock: vi.fn(() => false) });
    const result = handleChirpWrite(
      'move-block',
      { blockId: 'card-3', targetParentId: 'col-doing', targetIndex: 0 },
      'parent',
      store,
    );
    expect(result).toEqual({ success: false });
  });

  it('fails on missing blockId', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'move-block',
      { targetParentId: 'col-doing', targetIndex: 0 },
      'parent',
      store,
    );
    expect(result).toEqual({ success: false });
    expect(store.moveBlock).not.toHaveBeenCalled();
  });

  it('fails on missing targetIndex', () => {
    const store = makeStore();
    const result = handleChirpWrite(
      'move-block',
      { blockId: 'card-3', targetParentId: 'col-doing' },
      'parent',
      store,
    );
    expect(result).toEqual({ success: false });
  });

  it('fails on missing targetParentId (undefined, not null)', () => {
    // null is explicit "move to root"; undefined is malformed payload.
    const store = makeStore();
    const result = handleChirpWrite(
      'move-block',
      { blockId: 'card-3', targetIndex: 0 },
      'parent',
      store,
    );
    expect(result).toEqual({ success: false });
    expect(store.moveBlock).not.toHaveBeenCalled();
  });
});

describe('handleChirpWrite — unknown verbs', () => {
  it('returns failure for unrecognized verb', () => {
    const store = makeStore();
    const result = handleChirpWrite('nuke-everything', {}, 'parent', store);
    expect(result).toEqual({ success: false });
  });
});

// ─── Auto-execute path ──────────────────────────────────────────────────
//
// Closes the user/agent asymmetry: agent-emitted handler-prefixed blocks
// (e.g. `render:: { json }`) auto-trigger executeHandler the same way
// user-typed Enter does. Implementation lives in chirpWriteHandler — it
// invokes the optional `executeBlockIfHandler` callback after success.
// The callback's wiring (registry.findHandler + executeHandler) is in
// useBlockExecution.ts (not exercised here — pure-store unit scope).

describe('handleChirpWrite — auto-execute', () => {
  it('create-child invokes executeBlockIfHandler with the new block id', () => {
    const executeBlockIfHandler = vi.fn();
    const store = makeStore({ executeBlockIfHandler });
    handleChirpWrite(
      'create-child',
      { content: 'render:: {"root":"x","elements":{"x":{"type":"Text"}}}' },
      'parent',
      store,
    );
    expect(executeBlockIfHandler).toHaveBeenCalledWith('new-block');
    expect(executeBlockIfHandler).toHaveBeenCalledTimes(1);
  });

  it('create-child with execute:false skips executeBlockIfHandler', () => {
    const executeBlockIfHandler = vi.fn();
    const store = makeStore({ executeBlockIfHandler });
    handleChirpWrite(
      'create-child',
      { content: 'render:: agent draft', execute: false },
      'parent',
      store,
    );
    expect(executeBlockIfHandler).not.toHaveBeenCalled();
  });

  it('upsert-child invokes executeBlockIfHandler with the resolved block id', () => {
    const executeBlockIfHandler = vi.fn();
    const store = makeStore({ executeBlockIfHandler });
    handleChirpWrite(
      'upsert-child',
      { content: 'render:: {...}', match: 'render::' },
      'parent',
      store,
    );
    expect(executeBlockIfHandler).toHaveBeenCalledWith('upsert-block');
  });

  it('upsert-child with execute:false skips executeBlockIfHandler', () => {
    const executeBlockIfHandler = vi.fn();
    const store = makeStore({ executeBlockIfHandler });
    handleChirpWrite(
      'upsert-child',
      { content: 'render:: draft', match: 'render::', execute: false },
      'parent',
      store,
    );
    expect(executeBlockIfHandler).not.toHaveBeenCalled();
  });

  it('update-block does NOT trigger executeBlockIfHandler (kanban two-way binding only)', () => {
    // FLO-587 update-block fires on every keystroke during card editing.
    // Wiring auto-execute here would re-run the parent door on every
    // letter — not the intent. Only create-child / upsert-child auto-execute.
    const executeBlockIfHandler = vi.fn();
    const store = makeStore({ executeBlockIfHandler });
    handleChirpWrite(
      'update-block',
      { blockId: 'card-7', content: 'render:: {...}' },
      'parent',
      store,
    );
    expect(executeBlockIfHandler).not.toHaveBeenCalled();
  });

  it('move-block does NOT trigger executeBlockIfHandler', () => {
    // Move is structural; the moved block's content is unchanged. Re-running
    // its handler would be at best wasteful, at worst surprising.
    const executeBlockIfHandler = vi.fn();
    const store = makeStore({ executeBlockIfHandler });
    handleChirpWrite(
      'move-block',
      { blockId: 'card-3', targetParentId: 'col-2', targetIndex: 0 },
      'parent',
      store,
    );
    expect(executeBlockIfHandler).not.toHaveBeenCalled();
  });

  it('store without executeBlockIfHandler is a clean no-op', () => {
    // Backwards compat — if a caller hasn't wired up auto-execute yet, the
    // chirp handler must not throw. Existing legacy call sites that haven't
    // migrated to ChirpWriteStore-with-executor pattern still work.
    const store = makeStore();
    delete (store as { executeBlockIfHandler?: unknown }).executeBlockIfHandler;
    expect(() =>
      handleChirpWrite(
        'create-child',
        { content: 'render:: {...}' },
        'parent',
        store,
      ),
    ).not.toThrow();
  });

  it('failed create does NOT trigger executeBlockIfHandler', () => {
    const executeBlockIfHandler = vi.fn();
    const store = makeStore({
      executeBlockIfHandler,
      createBlockInside: vi.fn(() => '' as unknown as string), // returns falsy
    });
    handleChirpWrite(
      'create-child',
      { content: 'render:: {...}' },
      'parent',
      store,
    );
    expect(executeBlockIfHandler).not.toHaveBeenCalled();
  });

  it('failed upsert does NOT trigger executeBlockIfHandler', () => {
    const executeBlockIfHandler = vi.fn();
    const store = makeStore({
      executeBlockIfHandler,
      upsertChildByPrefix: vi.fn(() => null),
    });
    handleChirpWrite(
      'upsert-child',
      { content: 'render:: {...}', match: 'render::' },
      'parent',
      store,
    );
    expect(executeBlockIfHandler).not.toHaveBeenCalled();
  });
});
