/**
 * useContentSync tests — blur-is-the-boundary (FLO-387)
 *
 * Covers:
 *   1. Zero Y.Doc writes during typing (input events alone)
 *   2. One write on blur with final content
 *   3. Direct flushContentUpdate commits DOM content
 *   4. Idempotent: second flush with dirty cleared is a no-op
 *   5. No-op when DOM matches store content
 *   6. IME composition guard: no commit mid-composition, commit after compositionend + flush
 *   7. Focus-time snapshot + conflict-detected diagnostic on remote update during focus
 *   8. Unmount while dirty flushes pending DOM content
 *   9. cancelContentUpdate clears hasLocalChanges without committing
 */

import { describe, it, expect, beforeEach, vi, type MockedFunction } from 'vitest';
import { createRoot } from 'solid-js';

// The hook calls `createLogger('ContentSync')` once at module load and stores
// the result in a module-level `logger` variable. To inspect warn calls from
// tests, we hoist a shared `warnSpy` and return it from the mocked factory.
// vi.hoisted is mandatory here: the mock factory runs before regular top-level
// statements, so a normal `const warnSpy = vi.fn()` would be undefined inside
// the factory.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('../lib/logger', () => ({
  createLogger: () => ({
    warn: warnSpy,
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { useContentSync, type ContentSyncDeps, type ContentSyncStore } from './useContentSync';

/** Build a fresh contentEditable element attached to the DOM. */
function makeContentRef(initial = ''): HTMLDivElement {
  const el = document.createElement('div');
  el.contentEditable = 'true';
  el.innerText = initial;
  document.body.appendChild(el);
  return el;
}

/** Mutable block holder — tests can change `.content` mid-flight to simulate remote updates. */
interface MutableBlock {
  id: string;
  content: string;
}

function makeDeps(params: {
  block: MutableBlock;
  contentRef: HTMLDivElement;
  storeOrigin?: unknown;
}): {
  deps: ContentSyncDeps;
  store: ContentSyncStore & { updateBlockContent: MockedFunction<ContentSyncStore['updateBlockContent']> };
} {
  const store = {
    updateBlockContent: vi.fn<ContentSyncStore['updateBlockContent']>(),
    lastUpdateOrigin: params.storeOrigin ?? 'user',
  };
  const deps: ContentSyncDeps = {
    getBlockId: () => params.block.id,
    getBlock: () => params.block,
    getContentRef: () => params.contentRef,
    store,
  };
  return { deps, store };
}

/**
 * Tests always run inside createRoot so createEffect/onCleanup work.
 * `fn` receives the disposer so it can tear down between sub-steps.
 */
function inRoot<T>(fn: (dispose: () => void) => T): T {
  let out!: T;
  createRoot((dispose) => {
    out = fn(dispose);
  });
  return out;
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('FLO-387 blur-is-the-boundary: useContentSync', () => {
  it('1. Zero Y.Doc writes during typing (input events alone)', () => {
    inRoot(() => {
      const ref = makeContentRef('');
      const block: MutableBlock = { id: 'blk-1', content: '' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      // Simulate 30 input events as the user types.
      for (let i = 1; i <= 30; i++) {
        ref.innerText = 'a'.repeat(i);
        sync.updateContentFromDom(ref);
      }

      expect(store.updateBlockContent).toHaveBeenCalledTimes(0);
      expect(sync.hasLocalChanges()).toBe(true);
      expect(sync.displayContent()).toBe('a'.repeat(30));
    });
  });

  it('2. One write on blur with final content', () => {
    inRoot(() => {
      const ref = makeContentRef('');
      const block: MutableBlock = { id: 'blk-2', content: '' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      // Type 5 characters
      for (let i = 1; i <= 5; i++) {
        ref.innerText = 'hello'.slice(0, i);
        sync.updateContentFromDom(ref);
      }
      expect(store.updateBlockContent).toHaveBeenCalledTimes(0);

      // Blur fires → handleBlurSync → flushContentUpdate → one commit with final content
      sync.handleBlurSync();

      expect(store.updateBlockContent).toHaveBeenCalledTimes(1);
      expect(store.updateBlockContent).toHaveBeenCalledWith('blk-2', 'hello');
      expect(sync.hasLocalChanges()).toBe(false);
    });
  });

  it('3. Direct flushContentUpdate commits current DOM content', () => {
    inRoot(() => {
      const ref = makeContentRef('');
      const block: MutableBlock = { id: 'blk-3', content: '' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      ref.innerText = 'direct flush';
      sync.updateContentFromDom(ref);

      // Structural-op path calls flushContentUpdate before mutating.
      sync.flushContentUpdate();

      expect(store.updateBlockContent).toHaveBeenCalledTimes(1);
      expect(store.updateBlockContent).toHaveBeenCalledWith('blk-3', 'direct flush');
    });
  });

  it('4. Idempotent: second flush with dirty cleared is a no-op', () => {
    inRoot(() => {
      const ref = makeContentRef('');
      const block: MutableBlock = { id: 'blk-4', content: '' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      ref.innerText = 'once';
      sync.updateContentFromDom(ref);

      sync.flushContentUpdate(); // first: commits
      // Simulate store reconciliation — block.content now matches DOM
      block.content = 'once';
      sync.flushContentUpdate(); // second: dirty flag already false, no-op

      expect(store.updateBlockContent).toHaveBeenCalledTimes(1);
    });
  });

  it('5. No-op when DOM already matches store content', () => {
    inRoot(() => {
      const ref = makeContentRef('already synced');
      const block: MutableBlock = { id: 'blk-5', content: 'already synced' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      // Manually set the dirty flag without a real divergence.
      sync.setHasLocalChanges(true);
      sync.flushContentUpdate();

      expect(store.updateBlockContent).toHaveBeenCalledTimes(0);
      expect(sync.hasLocalChanges()).toBe(false);
    });
  });

  it('6. IME composition guard: no commit mid-composition, commit after compositionend + flush', () => {
    inRoot(() => {
      const ref = makeContentRef('');
      const block: MutableBlock = { id: 'blk-6', content: '' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      // compositionstart (IME active)
      sync.setIsComposing(true);

      // Input events during composition — displayContent updates but no commit path reached.
      ref.innerText = 'ni';
      sync.updateContentFromDom(ref);
      ref.innerText = 'nih';
      sync.updateContentFromDom(ref);

      // Flush attempt mid-composition: must bail (guard).
      sync.flushContentUpdate();
      expect(store.updateBlockContent).toHaveBeenCalledTimes(0);

      // compositionend — clear the flag and fire the final input.
      sync.setIsComposing(false);
      ref.innerText = '你好';
      sync.updateContentFromDom(ref);

      // Now a blur (or any structural flush) commits.
      sync.handleBlurSync();
      expect(store.updateBlockContent).toHaveBeenCalledTimes(1);
      expect(store.updateBlockContent).toHaveBeenCalledWith('blk-6', '你好');
    });
  });

  it('7. Dirty-transition snapshot + conflict-detected diagnostic on background write mid-edit', () => {
    warnSpy.mockClear();
    inRoot(() => {
      const ref = makeContentRef('initial');
      const block: MutableBlock = { id: 'blk-7', content: 'initial' };
      const { deps, store } = makeDeps({ block, contentRef: ref });

      // Wire the mock to mirror production: real updateBlockContent commits
      // to the local Y.Doc synchronously, so deps.getBlock() returns the
      // freshly committed local content on the next read. Without this,
      // handleBlurSync would re-read the stale 'remote' block.content and
      // silently overwrite the DOM with the remote value — the test would
      // still pass the call-count assertion but hide a behavioral drift.
      store.updateBlockContent.mockImplementation((_id, content) => {
        block.content = content;
      });

      const sync = useContentSync(deps);

      // User starts typing locally → hasLocalChanges flips false→true →
      // snapshot captures the store's current view ('initial').
      ref.innerText = 'initial + local edit';
      sync.updateContentFromDom(ref);

      // A background writer (simulating remote update, or a hook, or a
      // different handler writing to the same block) mutates block.content
      // WITHOUT clearing the dirty flag — exactly the pattern the diagnostic
      // is designed to catch.
      block.content = 'initial + REMOTE change';

      // Blur fires. flushContentUpdate sees the divergence between
      // the baseline snapshot ('initial') and the current store view
      // ('initial + REMOTE change'), logs the conflict, LWW applies.
      sync.handleBlurSync();

      expect(store.updateBlockContent).toHaveBeenCalledTimes(1);
      expect(store.updateBlockContent).toHaveBeenCalledWith('blk-7', 'initial + local edit');

      // Assert the diagnostic fired.
      expect(warnSpy).toHaveBeenCalled();
      const warnCalls = (warnSpy as MockedFunction<(msg: string) => void>).mock.calls
        .map((args) => String(args[0]));
      expect(warnCalls.some((msg) => msg.includes('conflict-detected'))).toBe(true);

      // DOM must hold the local edit after blur — production's real
      // updateBlockContent would have updated block.content, the post-flush
      // rehydration in handleBlurSync would see DOM==store and leave it.
      expect(ref.innerText).toBe('initial + local edit');
    });
  });

  it('7b. No false positive when store is cleanly written mid-focus then typing resumes (autocomplete pattern)', () => {
    warnSpy.mockClear();
    inRoot(() => {
      const ref = makeContentRef('');
      const block: MutableBlock = { id: 'blk-7b', content: '' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      // Phase 1: user types '[[pa' — dirty flips true, snapshot = ''.
      ref.innerText = '[[pa';
      sync.updateContentFromDom(ref);
      expect(sync.hasLocalChanges()).toBe(true);

      // Phase 2: autocomplete pattern — an external handler (simulated by
      // direct store mutation + flush + dirty clear) installs the wikilink.
      // Under the new blur-boundary contract, handleAutocompleteSelect would
      // flush first, write the replacement, then clear the dirty flag.
      sync.flushContentUpdate();                       // commits '[[pa' to store
      expect(store.updateBlockContent).toHaveBeenLastCalledWith('blk-7b', '[[pa');
      block.content = '[[Page Name]]';                 // handler writes replacement
      ref.innerText = '[[Page Name]]';                 // handler syncs DOM
      sync.setHasLocalChanges(false);                  // handler clears dirty flag
      // (the real handleAutocompleteSelect also calls setDisplayContent but
      // that's not relevant to the conflict-check path)

      // Phase 3: user keeps typing after the replacement.
      // hasLocalChanges is currently false; first input flips it true and
      // RE-CAPTURES the snapshot to the post-autocomplete store value.
      ref.innerText = '[[Page Name]], cool';
      sync.updateContentFromDom(ref);

      // Phase 4: blur. snapshot should be '[[Page Name]]' (the post-autocomplete
      // baseline, NOT the pre-typing '' from phase 1). No conflict — store
      // matches snapshot.
      sync.handleBlurSync();

      // Final commit should land without any conflict log.
      expect(store.updateBlockContent).toHaveBeenLastCalledWith('blk-7b', '[[Page Name]], cool');

      // Critical assertion: the conflict diagnostic must NOT fire in this
      // legitimate autocomplete + continue-typing flow.
      const warnCalls = (warnSpy as MockedFunction<(msg: string) => void>).mock.calls
        .map((args) => String(args[0]));
      expect(warnCalls.some((msg) => msg.includes('conflict-detected'))).toBe(false);
    });
  });

  it('8. Unmount while dirty flushes pending DOM content', () => {
    let dispose!: () => void;
    const ref = makeContentRef('');
    const block: MutableBlock = { id: 'blk-8', content: '' };
    const { deps, store } = makeDeps({ block, contentRef: ref });

    createRoot((d) => {
      dispose = d;
      const sync = useContentSync(deps);
      ref.innerText = 'about to unmount';
      sync.updateContentFromDom(ref);
      expect(store.updateBlockContent).toHaveBeenCalledTimes(0);
    });

    // Unmount (disposer triggers onCleanup → flushContentUpdate)
    dispose();

    expect(store.updateBlockContent).toHaveBeenCalledTimes(1);
    expect(store.updateBlockContent).toHaveBeenCalledWith('blk-8', 'about to unmount');
  });

  it('9. cancelContentUpdate clears hasLocalChanges without committing', () => {
    inRoot(() => {
      const ref = makeContentRef('');
      const block: MutableBlock = { id: 'blk-9', content: '' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      ref.innerText = 'will be discarded';
      sync.updateContentFromDom(ref);
      expect(sync.hasLocalChanges()).toBe(true);

      sync.cancelContentUpdate();

      expect(sync.hasLocalChanges()).toBe(false);
      expect(store.updateBlockContent).toHaveBeenCalledTimes(0);

      // Subsequent flush must be a no-op — the dirty flag is gone.
      sync.flushContentUpdate();
      expect(store.updateBlockContent).toHaveBeenCalledTimes(0);
    });
  });

  // This test documents an acknowledged limitation, not a bug. The PR plan
  // claims "HMR reload while dirty → no data loss (onCleanup flushes)" —
  // that claim is only true OUTSIDE of IME composition. flushContentUpdate
  // bails early when isComposing() is true, because committing a half-
  // composed CJK glyph would corrupt the block. As a result, a tab-close
  // or HMR reload mid-composition silently drops the in-flight characters.
  // The real fix (if one is ever queued) would be to call
  // `compositionEnd` programmatically on teardown, which is non-trivial
  // and cross-browser messy. For now the tradeoff is explicit.
  it('10. Unmount during active IME composition does NOT flush (acknowledged limitation)', () => {
    let dispose!: () => void;
    const ref = makeContentRef('');
    const block: MutableBlock = { id: 'blk-10', content: '' };
    const { deps, store } = makeDeps({ block, contentRef: ref });

    createRoot((d) => {
      dispose = d;
      const sync = useContentSync(deps);
      // Simulate user mid-IME: first character of a CJK composition is
      // sitting in the DOM but hasn't been finalized by compositionend.
      sync.setIsComposing(true);
      ref.innerText = '你';
      sync.updateContentFromDom(ref);
      // Partial composition IS in the dirty set because updateContentFromDom
      // still flips hasLocalChanges — but flushContentUpdate will bail on
      // isComposing, so onCleanup cannot commit.
      expect(sync.hasLocalChanges()).toBe(true);
      expect(sync.isComposing()).toBe(true);
    });

    // Unmount (disposer triggers onCleanup → flushContentUpdate → bails
    // because isComposing is still true). The half-composed character is
    // lost. This test makes the limitation explicit so a future regression
    // where unmount-during-IME silently starts committing (possibly
    // corrupting with a partial glyph) would be caught.
    dispose();

    expect(store.updateBlockContent).toHaveBeenCalledTimes(0);
  });
});
