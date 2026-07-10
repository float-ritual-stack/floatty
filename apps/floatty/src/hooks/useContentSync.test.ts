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
import { createRoot, createSignal } from 'solid-js';

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

import { useContentSync, flushPendingContent, type ContentSyncDeps, type ContentSyncStore } from './useContentSync';

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
 *
 * Auto-disposes after `fn` returns so the module-level `activeFlushers`
 * registry (FLO-646) does not leak useContentSync instances across tests.
 * Callers that invoke `dispose()` mid-fn are unaffected — Solid's root
 * disposer is idempotent, so the `finally` call is a no-op on re-entry.
 */
function inRoot<T>(fn: (dispose: () => void) => T): T {
  let out!: T;
  createRoot((dispose) => {
    try {
      out = fn(dispose);
    } finally {
      dispose();
    }
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

  // FLIPPED by quirk-audit cluster C (was "acknowledged limitation: does
  // NOT flush"). The old tradeoff dropped ALL in-flight characters when a
  // block unmounted mid-IME, because flushContentUpdate bailed on the
  // stuck isComposing flag. The audit reclassified the stuck flag as a
  // data-loss bug: onCleanup now resets isComposing before the final
  // flush, so unmount commits the in-flight DOM content. The cost is that
  // the committed tail may include a half-composed glyph — data
  // preservation wins over glyph purity at teardown, since the DOM (and
  // any chance of finishing the composition) is gone either way.
  it('10. Unmount during active IME composition DOES flush (cluster C: preservation over purity)', () => {
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
      expect(sync.hasLocalChanges()).toBe(true);
      expect(sync.isComposing()).toBe(true);
    });

    // Unmount: onCleanup resets isComposing, THEN flushes — the in-flight
    // character is committed instead of silently dropped.
    dispose();

    expect(store.updateBlockContent).toHaveBeenCalledWith('blk-10', '你');
  });
});

// ═══════════════════════════════════════════════════════════════
// FLO-646: flushPendingContent registry
// ═══════════════════════════════════════════════════════════════
// Call sites that read store content (markdown export, clipboard copy)
// need pending DOM typing committed first. Each mounted useContentSync
// instance registers its flushContentUpdate in a module-level Set; the
// exported flushPendingContent() iterates it.

describe('flushPendingContent — cross-module flush registry (FLO-646)', () => {
  it('calls the registered flush when flushPendingContent() is invoked', () => {
    inRoot((dispose) => {
      const ref = makeContentRef('');
      const block: MutableBlock = { id: 'reg-2', content: '' };
      const { deps, store } = makeDeps({ block, contentRef: ref });
      const sync = useContentSync(deps);

      ref.innerText = 'hello';
      sync.updateContentFromDom(ref);
      expect(store.updateBlockContent).toHaveBeenCalledTimes(0);

      // Cross-module caller — e.g., exportToMarkdown — flushes before read.
      flushPendingContent();

      expect(store.updateBlockContent).toHaveBeenCalledTimes(1);
      expect(store.updateBlockContent).toHaveBeenCalledWith('reg-2', 'hello');

      dispose(); // deregister flusher so it does not leak into later tests
    });
  });

  it('deregisters the flusher on cleanup (unmounted instances are not flushed)', () => {
    const refA = makeContentRef('');
    const blockA: MutableBlock = { id: 'reg-3a', content: '' };
    const { deps: depsA, store: storeA } = makeDeps({ block: blockA, contentRef: refA });

    const refB = makeContentRef('');
    const blockB: MutableBlock = { id: 'reg-3b', content: '' };
    const { deps: depsB, store: storeB } = makeDeps({ block: blockB, contentRef: refB });

    // Mount A + dirty + dispose. Dispose's onCleanup flushes once (pending
    // content is not lost on unmount) and also deregisters the flusher.
    let disposeA!: () => void;
    createRoot((dispose) => {
      disposeA = dispose;
      const syncA = useContentSync(depsA);
      refA.innerText = 'from-A';
      syncA.updateContentFromDom(refA);
    });
    disposeA();
    const storeACallsAfterDispose = storeA.updateBlockContent.mock.calls.length;
    expect(storeACallsAfterDispose).toBe(1); // sanity: onCleanup flushed once

    inRoot((dispose) => {
      const syncB = useContentSync(depsB);
      refB.innerText = 'from-B';
      syncB.updateContentFromDom(refB);

      flushPendingContent();

      // A's flusher was deregistered → no further calls on storeA.
      expect(storeA.updateBlockContent.mock.calls.length).toBe(storeACallsAfterDispose);
      // B is still mounted → its pending content was committed.
      expect(storeB.updateBlockContent).toHaveBeenCalledTimes(1);
      expect(storeB.updateBlockContent).toHaveBeenCalledWith('reg-3b', 'from-B');

      dispose();
    });
  });

  it('is a no-op when nothing is mounted', () => {
    // No active instances — flushPendingContent should not throw.
    expect(() => flushPendingContent()).not.toThrow();
  });
});

// ─── Quirk-audit cluster C — composition + remount hydration ──────────

describe('cluster C: stuck composition recovery', () => {
  it('handleBlurSync resets a stuck isComposing flag and still commits', () => {
    inRoot(() => {
      const block: MutableBlock = { id: 'b1', content: 'old' };
      const contentRef = makeContentRef('typed content');
      const { deps, store } = makeDeps({ block, contentRef });
      const sync = useContentSync(deps);
      // Simulate: compositionstart fired, element lost focus before
      // compositionend ever arrived — the flag is stuck true.
      sync.setIsComposing(true);
      sync.setHasLocalChanges(true);

      sync.handleBlurSync();

      // The stuck flag must not block the blur commit.
      expect(sync.isComposing()).toBe(false);
      expect(store.updateBlockContent).toHaveBeenCalledWith('b1', 'typed content');
      expect(sync.hasLocalChanges()).toBe(false);
    });
  });

  it('unmount with stuck isComposing still flushes pending content', () => {
    inRoot((dispose) => {
      const block: MutableBlock = { id: 'b2', content: 'old' };
      const contentRef = makeContentRef('unsaved typing');
      const { deps, store } = makeDeps({ block, contentRef });
      const sync = useContentSync(deps);
      sync.setIsComposing(true);
      sync.setHasLocalChanges(true);

      dispose(); // unmount — onCleanup must reset the flag THEN flush

      expect(store.updateBlockContent).toHaveBeenCalledWith('b2', 'unsaved typing');
    });
  });
});

describe('cluster C: remount hydration (signal-backed ref)', () => {
  it('sync effect hydrates a newly mounted contentRef from the store', () => {
    // The REACTIVITY CONTRACT: when getContentRef is signal-backed, a CE
    // that mounts LATE (mode toggle, output-block Escape) re-runs the sync
    // effect and receives store content — instead of sitting empty and
    // letting the next keystroke overwrite real content.
    //
    // NOTE: effects don't run inside createRoot's body — mount the editor
    // and assert AFTER the root completes (signal writes then propagate
    // synchronously).
    const block: MutableBlock = { id: 'b3', content: 'real content from store' };
    const [refSig, setRefSig] = createSignal<HTMLDivElement | undefined>(undefined);
    const store = {
      updateBlockContent: vi.fn(),
      lastUpdateOrigin: 'user',
    };
    const deps: ContentSyncDeps = {
      getBlockId: () => block.id,
      getBlock: () => block,
      getContentRef: () => refSig(),
      store,
    };
    let sync!: ReturnType<typeof useContentSync>;
    const dispose = createRoot((d) => {
      sync = useContentSync(deps);
      return d;
    });
    try {
      // A fresh, EMPTY editor mounts (Show flip). No manual repair anywhere —
      // the signal write re-runs the sync effect.
      const el = makeContentRef('');
      setRefSig(el);

      expect(el.innerText).toBe('real content from store');
      expect(sync.displayContent()).toBe('real content from store');
    } finally {
      dispose();
    }
  });
});

// ─── [[ prescreen (quirk-audit cluster D) ─────────────────────────────

describe('cluster D: autocomplete prescreen', () => {
  function makePrescreenDeps(content: string, isOpen: boolean) {
    const block: MutableBlock = { id: 'pd', content: '' };
    const ref = makeContentRef(content);
    const onAutocompleteCheck = vi.fn();
    const { deps } = makeDeps({ block, contentRef: ref });
    deps.onAutocompleteCheck = onAutocompleteCheck;
    deps.isAutocompleteOpen = () => isOpen;
    return { deps, ref, onAutocompleteCheck };
  }

  it('skips the cursor walk + check when content has no [[ and popup is closed', () => {
    inRoot(() => {
      const { deps, ref, onAutocompleteCheck } = makePrescreenDeps('plain typing', false);
      const sync = useContentSync(deps);
      sync.updateContentFromDom(ref);
      expect(onAutocompleteCheck).not.toHaveBeenCalled();
    });
  });

  it('runs the check when content contains [[', () => {
    inRoot(() => {
      const { deps, ref, onAutocompleteCheck } = makePrescreenDeps('see [[pa', false);
      const sync = useContentSync(deps);
      sync.updateContentFromDom(ref);
      expect(onAutocompleteCheck).toHaveBeenCalledTimes(1);
    });
  });

  it('runs the check when the popup is open even without [[ (dismissal path)', () => {
    inRoot(() => {
      const { deps, ref, onAutocompleteCheck } = makePrescreenDeps('trigger deleted', true);
      const sync = useContentSync(deps);
      sync.updateContentFromDom(ref);
      expect(onAutocompleteCheck).toHaveBeenCalledTimes(1);
    });
  });
});
