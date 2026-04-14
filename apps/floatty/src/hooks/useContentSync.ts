/**
 * useContentSync — content sync between contentEditable and Y.Doc.
 *
 * Extracted from BlockItem.tsx (Unit 1.5, FLO-539).
 * Handles: debounced Y.Doc updates, origin-aware sync, blur flush,
 * input handling, IME composition, and the hasLocalChanges dirty flag.
 *
 * Critical invariants:
 * - FLO-197: hasLocalChanges prevents sync from overwriting pending debounced edits
 * - FLO-256: Authoritative origins (reconnect, undo) bypass the dirty flag
 * - store.lastUpdateOrigin read via untrack() — NOT a reactive dependency
 */
import { createSignal, createEffect, onCleanup, untrack, type Accessor, type Setter } from 'solid-js';
import { createLogger } from '../lib/logger';

const logger = createLogger('ContentSync');
import { getAbsoluteCursorOffset, setCursorAtOffset } from '../lib/cursorUtils';
import type { CursorState } from './useCursor';

const UPDATE_DEBOUNCE_MS = 150;

// ─── Debounce utility ──────────────────────────────────────────────────

/**
 * Creates a debounced function with flush and cancel capabilities.
 * - Immediate DOM updates happen outside this (contentEditable handles it)
 * - Only Y.Doc/store updates are debounced
 */
function createDebouncedUpdater<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay: number
): { debounced: (...args: Args) => void; flush: () => void; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let pendingArgs: Args | null = null;

  const debounced = (...args: Args) => {
    pendingArgs = args;
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      if (pendingArgs) {
        fn(...pendingArgs);
        pendingArgs = null;
      }
      timeoutId = null;
    }, delay);
  };

  const flush = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (pendingArgs) {
      fn(...pendingArgs);
      pendingArgs = null;
    }
  };

  const cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    pendingArgs = null;
  };

  return { debounced, flush, cancel };
}

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
  /**
   * FLO-387: Optional cursor state used to invalidate the snapshot cache
   * after programmatic innerText mutations (which do not fire input events).
   * Optional so tests can omit it.
   */
  cursor?: CursorState;
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
  // Local display content - updated immediately on input for responsive overlay
  // Store content is debounced (150ms), but overlay needs to track DOM immediately
  const [displayContent, setDisplayContent] = createSignal(deps.getBlock()?.content || '');

  // IME composition state - prevents debounced updates during CJK character composition
  // Without this, incomplete characters would be synced to Y.Doc mid-composition
  const [isComposing, setIsComposing] = createSignal(false);

  // FLO-197: Dirty flag pattern - tracks uncommitted local edits
  // Prevents content sync effect from overwriting pending debounced changes
  // when another block's change triggers effect re-evaluation
  const [hasLocalChanges, setHasLocalChanges] = createSignal(false);

  // Debounced Y.Doc updates - DOM stays immediate via contentEditable
  // Flush on blur, cancel on unmount
  // FLO-197: Clear dirty flag after store commit (enables content sync for non-local changes)
  const { debounced: debouncedUpdateContent, flush: flushContentUpdate, cancel: cancelContentUpdate } =
    createDebouncedUpdater((id: string, content: string) => {
      deps.store.updateBlockContent(id, content);
      setHasLocalChanges(false);
    }, UPDATE_DEBOUNCE_MS);

  // Cleanup: flush pending edits on unmount (don't discard user's work)
  onCleanup(() => {
    flushContentUpdate();
  });

  // ─── Content sync effect ────────────────────────────────────────────
  // Sync content from store to DOM and displayContent signal
  // Origin-aware gate:
  //   - Not focused → always sync (split pane, unfocused blocks)
  //   - Focused + user origin → skip (don't echo typing back, causes cursor jump)
  //   - Focused + non-user origin → sync (undo, redo, remote are authoritative)
  // NOTE: Use innerText for comparison (preserves newlines from <div>/<br> elements)
  createEffect(() => {
    const currentBlock = deps.getBlock();
    const contentRef = deps.getContentRef();
    if (!contentRef || !currentBlock) return;

    const origin = untrack(() => deps.store.lastUpdateOrigin);

    // Authoritative origins bypass the hasLocalChanges guard
    // These origins represent state that MUST sync to DOM:
    // - 'reconnect-authority': Server state on WebSocket reconnect (server is truth)
    // - 'gap-fill': Missing updates fetched via HTTP (server data filling gaps)
    // - 'system': Integrity repairs (dedup, orphan quarantine)
    // - UndoManager instance: Undo/redo operations (CRDT history is truth)
    const isAuthoritative =
      origin === 'reconnect-authority' ||
      origin === 'gap-fill' ||
      origin === 'system' ||
      (origin && typeof origin === 'object' && 'undo' in origin);

    // FLO-197: CRITICAL - Skip sync if we have uncommitted local changes
    // UNLESS the origin is authoritative (reconnect, undo/redo)
    // This prevents the race condition where:
    // 1. User types in block A, debounce pending
    // 2. Block B changes with 'remote'/'hook' origin
    // 3. This effect re-runs (triggered by global lastUpdateOrigin)
    // 4. Without this guard, DOM would be overwritten with stale store content
    // FLO-256: With reconnect-authority, we WANT to overwrite - server is truth
    if (hasLocalChanges()) {
      if (!isAuthoritative) return;
      // Authoritative update while local changes pending:
      // Cancel debounce and clear dirty flag to prevent stale content from being flushed
      cancelContentUpdate();
      setHasLocalChanges(false);
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

      // Sync DOM - DEFENSIVE: Save/restore cursor if focused to prevent jump
      if (domContent !== storeContent) {
        // If focused, save cursor position before DOM manipulation
        const savedOffset = isFocusedNow ? getAbsoluteCursorOffset(contentRef) : -1;

        // DEFENSIVE: Verify ref is actually in document (ghost node detection)
        if (!document.contains(contentRef)) {
          logger.warn(`Ghost node detected - skipping DOM sync ${currentBlock.id}`);
          return;
        }

        contentRef.innerText = storeContent;

        // FLO-387: programmatic innerText assignment does not fire
        // input/selectionchange, so the cursor snapshot cache (if any)
        // is now stale. Invalidate explicitly before repositioning.
        deps.cursor?.invalidate();

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
  // CRITICAL: Sync DOM when focus leaves (catches splits where store updated while focused)
  // NOTE: Caller (BlockItem) wraps this to also dismiss autocomplete
  const handleBlurSync = () => {
    // Flush any pending debounced content updates to Y.Doc before blur completes
    flushContentUpdate();

    const currentBlock = deps.getBlock();
    const contentRef = deps.getContentRef();
    if (contentRef && currentBlock) {
      // Sync DOM to store on blur (catches remote updates that arrived while focused)
      if (contentRef.innerText !== currentBlock.content) {
        contentRef.innerText = currentBlock.content;
      }
      // CRITICAL: Also sync displayContent for overlay layer
      // After block splits, the effect may not re-run (focus guard), so sync here
      if (displayContent() !== currentBlock.content) {
        setDisplayContent(currentBlock.content);
      }
    }
  };

  // ─── Content update from DOM ────────────────────────────────────────
  /**
   * Core content update logic for input and composition handlers.
   * Reads innerText from the contentEditable target, syncs display,
   * triggers autocomplete check, and debounces Y.Doc update.
   */
  const updateContentFromDom = (target: HTMLDivElement) => {
    // CRITICAL: Use innerText, not textContent!
    // textContent ignores <div> and <br> elements, losing line breaks.
    // innerText respects visual line breaks and converts them to \n.
    const content = target.innerText || '';

    // FLO-197: Mark as dirty BEFORE any updates
    setHasLocalChanges(true);

    // Update display content IMMEDIATELY for responsive overlay
    setDisplayContent(content);

    // Autocomplete trigger check (callback to BlockItem)
    const contentRef = deps.getContentRef();
    if (contentRef && deps.onAutocompleteCheck) {
      const offset = getAbsoluteCursorOffset(contentRef);
      deps.onAutocompleteCheck(content, offset, contentRef);
    }

    // Skip Y.Doc update during IME composition
    if (isComposing()) return;

    // Debounce Y.Doc/store update
    debouncedUpdateContent(deps.getBlockId(), content);

    // FLO-136: Typing pins ephemeral panes (callback to BlockItem)
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
