/**
 * useContentSync — content sync between contentEditable and Y.Doc.
 *
 * Extracted from BlockItem.tsx (Unit 1.5, FLO-539). Rewritten for FLO-387
 * blur-is-the-boundary: the 150ms Y.Doc debounce is removed. Y.Doc receives
 * content writes only at user-meaningful boundaries — blur, structural ops,
 * and unmount — via synchronous `flushContentUpdate` calls at ~25 existing
 * call sites (useBlockInput.ts, useEditingActions.ts, useExecutionAction.ts,
 * BlockItem.tsx handlePaste, Outliner.tsx explicit-blur paths).
 *
 * The call sites did not change. Their internals did:
 *   Before: flushContentUpdate drained a debounced timer of the last typed content
 *   After:  flushContentUpdate reads the current DOM innerText and commits once
 *
 * Between boundaries, the DOM is authoritative. contentEditable handles local
 * typing natively. `displayContent` tracks every input event for the overlay.
 * `hasLocalChanges` still gates the sync effect so remote updates don't clobber
 * in-progress DOM during focus.
 *
 * Critical invariants preserved:
 * - FLO-197: hasLocalChanges prevents sync from overwriting pending local edits
 * - FLO-256: Authoritative origins (reconnect, undo) bypass the dirty flag
 * - store.lastUpdateOrigin read via untrack() — NOT a reactive dependency
 * - IME composition guard (isComposing) — unchanged
 * - ydoc-patterns.md #6 blur/remote race — preserved via contentAtFocus snapshot
 * - ydoc-patterns.md #7 multi-pane echo — preserved via origin-aware sync effect
 *
 * Conflict handling (MVP): a `contentAtFocus` snapshot captures the store's
 * view of block.content at the moment the current dirty session starts (the
 * hasLocalChanges false→true transition in updateContentFromDom). At commit
 * time, if the store's block.content no longer matches the snapshot, a
 * background writer (remote, hook, another handler) changed the content
 * during this edit session. Current behavior is last-write-wins; the
 * `logger.warn('conflict-detected: ...')` diagnostic makes the LWW event
 * visible.
 *
 * NOTE: the snapshot is keyed to "start of dirty session" NOT "focus-in".
 * This matters because code paths like handleAutocompleteSelect and
 * handleStructuredPaste legitimately write to the store mid-focus, bouncing
 * the dirty flag clean→dirty multiple times within a single focus session.
 * A focus-time snapshot would produce false-positive conflict logs every
 * time the user kept typing after autocomplete or paste. The dirty-transition
 * snapshot automatically re-baselines on each new edit session.
 */
import { createSignal, createEffect, onCleanup, untrack, type Accessor, type Setter } from 'solid-js';
import { createLogger } from '../lib/logger';

const logger = createLogger('ContentSync');
import { getAbsoluteCursorOffset, setCursorAtOffset } from '../lib/cursorUtils';

// ─── Types ──────────────────────────────────────────────────────────────

interface ContentSyncBlock {
  id: string;
  content: string;
}

export interface ContentSyncStore {
  updateBlockContent: (id: string, content: string) => void;
  lastUpdateOrigin: unknown;
}

export interface ContentSyncDeps {
  getBlockId: () => string;
  getBlock: () => ContentSyncBlock | undefined;
  getContentRef: () => HTMLDivElement | undefined;
  store: ContentSyncStore;
  onAutocompleteCheck?: (content: string, offset: number, ref: HTMLElement) => void;
  onContentChange?: () => void;
}

export interface ContentSyncReturn {
  displayContent: Accessor<string>;
  setDisplayContent: Setter<string>;
  isComposing: Accessor<boolean>;
  setIsComposing: Setter<boolean>;
  hasLocalChanges: Accessor<boolean>;
  setHasLocalChanges: Setter<boolean>;
  cancelContentUpdate: () => void;
  flushContentUpdate: () => void;
  handleInput: (e: InputEvent) => void;
  handleBlurSync: () => void;
  updateContentFromDom: (target: HTMLDivElement) => void;
}

// ─── Hook ───────────────────────────────────────────────────────────────

export function useContentSync(deps: ContentSyncDeps): ContentSyncReturn {
  // Local display content — updated immediately on input for responsive overlay.
  // Store content is committed at boundaries (blur / structural op / unmount),
  // but the overlay needs to track DOM immediately during typing.
  const [displayContent, setDisplayContent] = createSignal(deps.getBlock()?.content || '');

  // IME composition state — narrowly scoped to CJK character assembly.
  // Prevents blur/structural commits from writing a half-composed glyph.
  // NOTE: This is NOT a general "block is being edited" flag — that role is
  // played by `hasLocalChanges` plus `document.activeElement === contentRef`.
  const [isComposing, setIsComposing] = createSignal(false);

  // FLO-197: Dirty flag — tracks whether the DOM has uncommitted edits.
  // Set true on input; cleared by flushContentUpdate / cancelContentUpdate /
  // the authoritative-origin branch of the sync effect.
  // Still used by the sync effect to skip DOM overwrites during active typing.
  const [hasLocalChanges, setHasLocalChanges] = createSignal(false);

  // FLO-387: Snapshot for conflict detection. Captured lazily at the moment
  // the current dirty session begins (the false→true transition of
  // hasLocalChanges inside updateContentFromDom). Represents "store content
  // when my edits last diverged from it." On commit, flushContentUpdate
  // compares against the current block.content — if different, a background
  // writer (remote, hook, another handler) mutated the block during this
  // dirty session, and a conflict diagnostic is logged before LWW applies.
  //
  // Intentionally NOT captured on focusin: code paths like
  // handleAutocompleteSelect and handleStructuredPaste write to the store
  // mid-focus and legitimately bounce the dirty flag, and a focus-time
  // snapshot would produce false-positive conflict logs every time the user
  // continued typing after such a write.
  const [contentAtFocus, setContentAtFocus] = createSignal<string | null>(null);

  // FLO-387: Commit the current DOM innerText to the store, synchronously.
  // Called at boundaries — blur (handleBlurSync), structural ops (~25 call
  // sites in useBlockInput.ts / useEditingActions.ts / useExecutionAction.ts /
  // BlockItem.tsx handlePaste), unmount (onCleanup). NOT called on plain
  // keystrokes — that is the whole point of blur-is-the-boundary.
  //
  // Idempotent: bail fast if nothing to commit. Safe to call twice in a row.
  // IME-safe: bails if isComposing is true (cannot commit mid-composition).
  const flushContentUpdate = () => {
    const ref = deps.getContentRef();
    const block = deps.getBlock();

    // No ref or no block → no work, clear dirty flag defensively.
    if (!ref || !block) {
      setHasLocalChanges(false);
      return;
    }

    // Nothing to commit — dirty flag is already clean.
    if (!hasLocalChanges()) {
      return;
    }

    // Cannot commit mid-IME composition — wait for compositionend.
    // The composition path calls updateContentFromDom again on end, which
    // updates displayContent. A subsequent blur/structural op triggers the
    // actual commit.
    if (isComposing()) {
      return;
    }

    const content = ref.innerText || '';

    // DOM matches store — the dirty flag was set speculatively but no net
    // change remains. Clear and bail; no transaction needed.
    if (content === block.content) {
      setHasLocalChanges(false);
      return;
    }

    // FLO-387 conflict detection (MVP: LWW + diagnostic log).
    // If the store's content diverged from the focus-time snapshot, a remote
    // update landed during this edit session. Log it. The local commit still
    // wins (LWW on Y.Map field merge). A conflict-resolution UI is a future
    // follow-up — the logger.warn + onConflictDetected test hook make the
    // LWW event observable so the UI work can be scoped when it's queued.
    const snapshot = contentAtFocus();
    if (snapshot !== null && block.content !== snapshot) {
      logger.warn(
        `conflict-detected: block ${block.id} content changed during focus ` +
        `(focus len=${snapshot.length}, pre-commit store len=${block.content.length}, ` +
        `local len=${content.length}) — LWW applied`
      );
      // E2E test hook — no-op in production (window.__floattyTestHooks is never set).
      // The harness installs { onConflictDetected: (id) => ... } before the test run.
      // We can't spy on console.warn because logger.ts captures originalConsole at
      // module load time, before any spy is installed.
      (window as any).__floattyTestHooks?.onConflictDetected?.(block.id);
    }

    deps.store.updateBlockContent(block.id, content);
    setHasLocalChanges(false);
  };

  // FLO-387: Discard any pending local DOM content without committing.
  // Called before a block is deleted (useBlockInput.ts delete_block case) and
  // inside the authoritative-origin branch of the sync effect, where the
  // server's state is about to be adopted and the local DOM is about to be
  // overwritten. In the new model there is no timer to cancel — this is
  // purely a dirty-flag reset.
  //
  // Also called from BlockItem.tsx:374 (handleAutocompleteSelect) to suppress
  // an obsolete pending commit before writing [[Page Name]], and from
  // BlockItem.tsx:525 (handleRenderTitleKeyDown) on render:: title mode entry.
  // Both semantics remain correct.
  const cancelContentUpdate = () => {
    setHasLocalChanges(false);
  };

  // Cleanup: flush pending edits on unmount. If a block unmounts while dirty
  // (e.g., outline navigation, tab close, HMR reload) the user's in-flight
  // DOM content must be committed before teardown or it is lost.
  onCleanup(() => {
    flushContentUpdate();
  });

  // ─── Content sync effect ────────────────────────────────────────────
  // Sync content FROM store TO DOM + displayContent signal.
  // Origin-aware gate:
  //   - Not focused → always sync (split pane, unfocused blocks, remote updates)
  //   - Focused + user origin → skip (don't echo typing back, causes cursor jump)
  //   - Focused + non-user origin → sync (undo, redo, remote are authoritative)
  //
  // Note: in the blur-is-the-boundary model, user-origin updates no longer
  // fire during typing (no debounced path writes to the store). They only
  // fire at boundaries. So the "Focused + user origin → skip" branch is
  // exercised less often than before — mainly on in-flight structural ops
  // where the same block just committed and the effect re-runs with the
  // new store content.
  //
  // NOTE: Use innerText for comparison (preserves newlines from <br> elements)
  createEffect(() => {
    const currentBlock = deps.getBlock();
    const contentRef = deps.getContentRef();
    if (!contentRef || !currentBlock) return;

    const origin = untrack(() => deps.store.lastUpdateOrigin);

    // Authoritative origins bypass the hasLocalChanges guard.
    // These represent state that MUST sync to DOM:
    // - 'reconnect-authority': Server state on WebSocket reconnect
    // - 'gap-fill': Missing updates fetched via HTTP
    // - 'system': Integrity repairs (dedup, orphan quarantine)
    // - UndoManager instance: Undo/redo (CRDT history is truth)
    const isAuthoritative =
      origin === 'reconnect-authority' ||
      origin === 'gap-fill' ||
      origin === 'system' ||
      (origin && typeof origin === 'object' && 'undo' in origin);

    // FLO-197: Skip sync if we have uncommitted local changes, UNLESS
    // the origin is authoritative. Prevents the race where:
    //   1. User types in block A, hasLocalChanges=true
    //   2. Block B changes with 'remote'/'hook' origin
    //   3. This effect re-runs (triggered by global lastUpdateOrigin)
    //   4. Without this guard, DOM would be overwritten with stale store content
    // FLO-256: With reconnect-authority, we WANT to overwrite — server is truth.
    if (hasLocalChanges()) {
      if (!isAuthoritative) return;
      // Authoritative update while local changes pending:
      // Drop the dirty flag so the sync effect can proceed.
      cancelContentUpdate();
    }

    const domContent = contentRef.innerText;
    const storeContent = currentBlock.content;
    const isFocusedNow = document.activeElement === contentRef;

    // Check if this update is from user's own typing (should skip when focused)
    // UndoManager sets its own instance as origin, not 'user'
    const isUserOrigin = origin === 'user';

    // Gate: sync if not focused, OR if focused but not from user typing
    const shouldSync = !isFocusedNow || !isUserOrigin;

    // Warn on unexpected focused-block syncs (could cause cursor jump)
    if (shouldSync && isFocusedNow && domContent !== storeContent) {
      logger.warn(`Syncing focused block (origin: ${typeof origin === 'string' ? origin : typeof origin})`);
    }

    if (shouldSync) {
      // Sync displayContent for overlay
      if (displayContent() !== storeContent) {
        setDisplayContent(storeContent);
      }

      // Sync DOM — DEFENSIVE: Save/restore cursor if focused to prevent jump
      if (domContent !== storeContent) {
        // If focused, save cursor position before DOM manipulation
        const savedOffset = isFocusedNow ? getAbsoluteCursorOffset(contentRef) : -1;

        // DEFENSIVE: Verify ref is actually in document (ghost node detection)
        if (!document.contains(contentRef)) {
          logger.warn(`Ghost node detected - skipping DOM sync ${currentBlock.id}`);
          return;
        }

        contentRef.innerText = storeContent;

        // Restore cursor position if we were focused
        // Clamp to new content length in case content shortened
        if (savedOffset >= 0) {
          const clampedOffset = Math.min(savedOffset, storeContent.length);
          setCursorAtOffset(contentRef, clampedOffset);
        }
      }
    }
  });

  // ─── Blur sync ──────────────────────────────────────────────────────
  // CRITICAL: In the blur-is-the-boundary model, blur IS the commit.
  // flushContentUpdate reads the current DOM innerText and writes it to the
  // store. After the commit, we also rehydrate the DOM from store.content in
  // case a remote update landed while focused (which hasLocalChanges was
  // suppressing — see ydoc-patterns.md #6 blur/remote race).
  //
  // NOTE: Caller (BlockItem) wraps this to also dismiss autocomplete.
  const handleBlurSync = () => {
    // Commit any in-flight DOM content to Y.Doc before blur completes.
    flushContentUpdate();

    const currentBlock = deps.getBlock();
    const contentRef = deps.getContentRef();
    if (contentRef && currentBlock) {
      // Sync DOM to store on blur (catches remote updates that arrived while focused)
      if (contentRef.innerText !== currentBlock.content) {
        contentRef.innerText = currentBlock.content;
      }
      // CRITICAL: Also sync displayContent for overlay layer.
      // After block splits, the effect may not re-run (focus guard), so sync here.
      if (displayContent() !== currentBlock.content) {
        setDisplayContent(currentBlock.content);
      }
    }
  };

  // ─── Content update from DOM ────────────────────────────────────────
  /**
   * Core content update logic for input and composition handlers.
   * Reads innerText from the contentEditable target, updates the overlay,
   * triggers autocomplete checks, and marks the dirty flag.
   *
   * FLO-387: Does NOT write to Y.Doc during typing. The commit happens at
   * boundaries via flushContentUpdate (blur / structural op / unmount).
   */
  const updateContentFromDom = (target: HTMLDivElement) => {
    // CRITICAL: Use innerText, not textContent!
    // textContent ignores <div> and <br> elements, losing line breaks.
    // innerText respects visual line breaks and converts them to \n.
    const content = target.innerText || '';

    // FLO-387: On the false→true transition of hasLocalChanges, capture the
    // store's current block.content as the conflict-detection baseline for
    // THIS dirty session. Re-captures after every flush/cancel + new input,
    // so autocomplete/paste/remove_spaces that clean the dirty flag and then
    // resume typing get a fresh baseline and don't trip false positives.
    if (!hasLocalChanges()) {
      const block = deps.getBlock();
      setContentAtFocus(block?.content ?? null);
    }

    // FLO-197: Mark as dirty BEFORE any updates so the sync effect knows
    // not to overwrite DOM from store during the same frame.
    setHasLocalChanges(true);

    // Update display content IMMEDIATELY for responsive overlay.
    setDisplayContent(content);

    // Autocomplete trigger check (callback to BlockItem).
    const contentRef = deps.getContentRef();
    if (contentRef && deps.onAutocompleteCheck) {
      const offset = getAbsoluteCursorOffset(contentRef);
      deps.onAutocompleteCheck(content, offset, contentRef);
    }

    // Skip Y.Doc-related work during IME composition — commit will happen
    // on compositionend → blur/structural boundary.
    if (isComposing()) return;

    // FLO-387: NO Y.Doc write here. The debounced write was deleted as part
    // of blur-is-the-boundary. The commit fires at boundaries via
    // flushContentUpdate (blur handler or structural op call sites).

    // FLO-136: Typing pins ephemeral panes (callback to BlockItem).
    deps.onContentChange?.();
  };

  const handleInput = (e: InputEvent) => {
    updateContentFromDom(e.target as HTMLDivElement);
  };

  return {
    displayContent,
    setDisplayContent,
    isComposing,
    setIsComposing,
    hasLocalChanges,
    setHasLocalChanges,
    cancelContentUpdate,
    flushContentUpdate,
    handleInput,
    handleBlurSync,
    updateContentFromDom,
  };
}
