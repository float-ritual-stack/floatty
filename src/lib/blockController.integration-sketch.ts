/**
 * BlockController ↔ BlockItem.tsx Integration Sketch
 *
 * Shows how the existing BlockItem onBlur/onInput handlers change from
 * "sync to Y.Doc on every keystroke (debounced)" to "commitBlock on blur."
 *
 * This is NOT runnable code — it's a diff-style reference showing
 * what changes in BlockItem.tsx when adopting BlockController.
 *
 * ──────────────────────────────────────────────────────────
 * BEFORE (current model):  keystroke → debounce(150ms) → Y.Doc write
 * AFTER  (controller model): keystroke → DOM only → blur/enter → Y.Doc write
 * ──────────────────────────────────────────────────────────
 */

// ═══════════════════════════════════════════════════════════════
// WHAT GETS REMOVED from BlockItem.tsx
// ═══════════════════════════════════════════════════════════════

/*
- const UPDATE_DEBOUNCE_MS = 150;
- const { debounced: debouncedUpdateContent, flush: flushContentUpdate, cancel: cancelContentUpdate } =
-   createDebouncedUpdater((id: string, content: string) => {
-     store.updateBlockContent(id, content);
-     setHasLocalChanges(false);
-   }, UPDATE_DEBOUNCE_MS);
-
- onCleanup(() => { flushContentUpdate(); });

The entire debounce machinery goes away. No more debouncedUpdateContent,
flushContentUpdate, cancelContentUpdate, hasLocalChanges signal.
*/

// ═══════════════════════════════════════════════════════════════
// WHAT GETS ADDED
// ═══════════════════════════════════════════════════════════════

import type { BlockController, CommitSource } from './blockController';

/**
 * BlockItem receives controller via WorkspaceContext (same as blockStore).
 *
 *   const { blockStore, blockController } = useWorkspace();
 *
 * Then in the component body:
 */
function sketchBlockItemIntegration(
  props: { id: string },
  blockController: BlockController,
  contentRef: { current: HTMLDivElement | null },
) {
  // ── onFocus → startComposing ────────────────────────────
  //
  // BEFORE: nothing (composing was implicit)
  // AFTER:  explicit lifecycle start

  const handleFocus = () => {
    blockController.startComposing(props.id);
  };

  // ── onInput → DOM only, no Y.Doc write ─────────────────
  //
  // BEFORE:
  //   setHasLocalChanges(true);
  //   setDisplayContent(content);
  //   debouncedUpdateContent(blockId, content);
  //
  // AFTER:
  //   setDisplayContent(content);   // Still needed for overlay
  //   // That's it. No store write. No debounce.

  const handleInput = () => {
    const content = contentRef.current?.innerText ?? '';
    // displayContent signal still updates for inline formatting overlay
    // setDisplayContent(content);
    //
    // NO debouncedUpdateContent call. Content lives in DOM only.
  };

  // ── onBlur → commitBlock ───────────────────────────────
  //
  // BEFORE:
  //   flushContentUpdate();  // Force debounce flush
  //
  // AFTER:
  //   Read DOM, commit to Y.Doc in one transaction

  const handleBlur = () => {
    const content = contentRef.current?.innerText ?? '';
    blockController.commitBlock(props.id, content, 'blur');
  };

  // ── Enter (split/execute) → commit before action ───────
  //
  // BEFORE:
  //   flushContentUpdate();  // Ensure store is current
  //   then split or execute
  //
  // AFTER:
  //   commitBlock, then split or execute

  const handleEnterKey = (cursorOffset: number) => {
    const content = contentRef.current?.innerText ?? '';
    blockController.commitBlock(props.id, content, 'enter');
    // Now safe to split — store has current content
    // store.splitBlock(props.id, cursorOffset);
  };

  // ── Escape → cancelComposing ───────────────────────────
  //
  // New capability! Discard local edits and revert.

  const handleEscape = () => {
    const baseline = blockController.cancelComposing(props.id);
    if (baseline !== null && contentRef.current) {
      contentRef.current.innerText = baseline;
    }
  };

  // ── Content sync effect (remote updates) ───────────────
  //
  // BEFORE: Complex gate with hasLocalChanges + origin checking
  //   if (isFocusedNow && hasLocalChanges() && !isAuthoritative) return;
  //
  // AFTER: Simple gate with isComposing
  //   if (blockController.isComposing(props.id)) return;
  //
  // When composing, ALL remote updates are deferred.
  // When not composing, ALL updates apply immediately.
  // No more hasLocalChanges / origin inspection.

  return {
    handleFocus,
    handleInput,
    handleBlur,
    handleEnterKey,
    handleEscape,
  };
}

// ═══════════════════════════════════════════════════════════════
// WHAT STAYS THE SAME
// ═══════════════════════════════════════════════════════════════

/*
- displayContent signal (needed for inline formatting overlay)
- cursor utilities (getAbsoluteCursorOffset, setCursorAtOffset)
- determineKeyAction (pure keyboard logic, unchanged)
- Block type detection (parseBlockType)
- Selection modes (anchor, range, toggle)
- Keyboard handler routing (Tab, Shift+Tab, arrows, etc.)
- All Y.Doc CRDT infrastructure (just called less frequently)

The controller is a THIN layer between DOM events and Y.Doc.
It doesn't change what gets written — only WHEN.
*/

// ═══════════════════════════════════════════════════════════════
// PAUSE-BASED AUTO-COMMIT (future, not in this prototype)
// ═══════════════════════════════════════════════════════════════

/*
A typing pause detector could auto-commit after N ms of inactivity:

  let pauseTimer: number | undefined;

  const handleInput = () => {
    clearTimeout(pauseTimer);
    pauseTimer = window.setTimeout(() => {
      const content = contentRef.current?.innerText ?? '';
      blockController.commitBlock(props.id, content, 'pause');
    }, 2000); // 2 second pause = auto-commit
  };

This gives the best of both worlds:
- No Y.Doc writes during active typing (performance)
- Content reaches Y.Doc within 2s of pause (sync safety)
- Blur still commits immediately (navigation safety)

Left as future work — the core lifecycle works without it.
*/

export { sketchBlockItemIntegration };
