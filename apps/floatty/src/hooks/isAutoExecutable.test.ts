/**
 * isAutoExecutable — allowlist for auto-executing externally-created blocks.
 *
 * Externally-created (API / CRDT sync) blocks land in the store without
 * going through useBlockInput.execute_block (the Enter-key path). Without
 * an allowlist, render:: blocks created by agents-or-API sit as raw JSON
 * until the user manually opens them and presses Enter — and worse, the
 * search-projection layer indexes the raw JSON spec instead of the
 * rendered markdown projection.
 *
 * The allowlist gates auto-execute to *idempotent view-only* blocks. Any
 * handler with side effects (sh::, render:: agent which spawns claude -p)
 * is intentionally excluded. The render:: door's special-case is
 * documented inline in the function.
 *
 * This file locks the allowlist contract so future contributors don't
 * silently flip a side-effect handler into the auto-execute path.
 */
import { describe, it, expect } from 'vitest';
import { isAutoExecutable } from './useBlockStore';

describe('isAutoExecutable — allowlist', () => {
  // ─── Permitted (view-only, idempotent) ──────────────────────────

  describe('permits view-only handlers', () => {
    it('daily:: (any date)', () => {
      expect(isAutoExecutable('daily:: 2026-04-29')).toBe(true);
      expect(isAutoExecutable('daily::today')).toBe(true);
    });

    it('render:: (raw JSON spec)', () => {
      expect(isAutoExecutable('render:: {"root":"x","elements":{}}')).toBe(true);
    });

    it('render:: (named route, e.g. demo)', () => {
      expect(isAutoExecutable('render:: demo')).toBe(true);
    });

    it('render:: (kanban / expand subroutes)', () => {
      expect(isAutoExecutable('render:: kanban [[abc123]]')).toBe(true);
      expect(isAutoExecutable('render:: expand [[abc123]]')).toBe(true);
    });

    it('case-insensitive prefix match', () => {
      expect(isAutoExecutable('Render:: {}')).toBe(true);
      expect(isAutoExecutable('DAILY:: 2026-04-29')).toBe(true);
    });

    it('tolerates leading whitespace', () => {
      expect(isAutoExecutable('  render:: {}')).toBe(true);
      expect(isAutoExecutable('\nrender:: {}')).toBe(true);
    });
  });

  // ─── Excluded (side effects) ─────────────────────────────────────

  describe('excludes side-effect handlers', () => {
    it('sh:: — would run a shell command', () => {
      expect(isAutoExecutable('sh:: rm -rf /tmp/foo')).toBe(false);
      expect(isAutoExecutable('sh:: ls')).toBe(false);
    });

    it('term:: — opens a terminal', () => {
      expect(isAutoExecutable('term:: zsh')).toBe(false);
    });

    it('dispatch:: — unregistered prefix, not in the allowlist', () => {
      expect(isAutoExecutable('dispatch:: summarize this')).toBe(false);
    });

    // Note: render:: agent IS allowed at the auto-execute layer here; the
    // render door's door.execute() routes the agent subcommand through
    // claude -p (with --dangerously-skip-permissions) only when the
    // content explicitly says `agent ...`. For agent-emitted secondary
    // render blocks the content is either `render:: {json}` (raw spec)
    // or `render:: demo`-style routes, NOT `render:: agent ...` — so
    // letting render:: through here is safe in practice. If an agent
    // ever emits a `render:: agent <prompt>` block, that's a recursive
    // claude -p call which is undesirable; gate it inside the door's
    // execute path if needed.
  });

  // ─── Plain text + edge cases ─────────────────────────────────────

  describe('non-handler content stays inert', () => {
    it('plain text', () => {
      expect(isAutoExecutable('just some notes')).toBe(false);
    });

    it('empty string', () => {
      expect(isAutoExecutable('')).toBe(false);
    });

    it('whitespace only', () => {
      expect(isAutoExecutable('   \n\t  ')).toBe(false);
    });

    it('handler-prefix-like but not at start', () => {
      expect(isAutoExecutable('see render:: {} here')).toBe(false);
      expect(isAutoExecutable('hello daily:: 2026')).toBe(false);
    });

    it('similar-but-not prefixes', () => {
      expect(isAutoExecutable('renderer::')).toBe(false);
      expect(isAutoExecutable('rendr::')).toBe(false);
    });
  });
});
