/**
 * read:: door — rendered markdown reader (v1)
 *
 * `read:: ~/path/to/file.md` → the file rendered as a document, in place.
 *
 * Contract (read-ls-doors charter, PR1):
 * - Render-only. File contents are NEVER materialized into blocks; they live
 *   in this block's door output and nowhere else. Zero outline mutation.
 * - Raw toggle: rendered document ⇄ raw source text.
 * - [[wikilinks]] are clickable. The view PROPOSES a target via onNavigate;
 *   the HOST executes it (BlockOutputView → handleChirpNavigate), which owns
 *   block-id-prefix vs page resolution and pane-link routing. The view holds
 *   no navigation logic, no auth, and no Y.Doc access.
 *
 * File read goes through `exec()` from @floatty/stdlib — the same
 * execute_shell_command path portless/rangle-dash use. ctx.fs is a Tier-2
 * stub that throws (doorSandbox.ts), so it is NOT an option here.
 *
 * Compile:
 *   node apps/floatty/scripts/compile-door-bundle.mjs \
 *     apps/floatty/doors/read/read.tsx ~/.floatty-dev/doors/read/index.js
 */

import { Show, createSignal, createMemo } from 'solid-js';
import type { Component } from 'solid-js';
import { exec } from '@floatty/stdlib';
import {
  buildReadCommand,
  parseReadPath,
  renderMarkdownDoc,
  wikilinkTargetFromEvent,
  type ReadData,
} from './readDoc';

// ═══════════════════════════════════════════════════════════════
// DOOR API SHAPES (doors declare their own — see timestamp.tsx)
// ═══════════════════════════════════════════════════════════════

interface DoorViewProps<T = unknown> {
  data: T;
  settings: Record<string, unknown>;
  server: {
    url: string;
    wsUrl: string;
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  onNavigateOut?: (direction: 'up' | 'down') => void;
  onNavigate?: (
    target: string,
    opts?: { type?: 'page' | 'block'; splitDirection?: 'horizontal' | 'vertical' },
  ) => void;
}

interface DoorContext {
  settings: Record<string, unknown>;
  log: (...args: unknown[]) => void;
}

interface DoorResult<T> {
  data: T;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// VIEW
// ═══════════════════════════════════════════════════════════════

export function ReadView(props: DoorViewProps<ReadData>) {
  const [showSource, setShowSource] = createSignal(false);
  const html = createMemo(() => renderMarkdownDoc(props.data.raw));

  // Wikilink click → propose `navigate` to the host. The host resolves the
  // target pane through the pane-link chain (handleChirpNavigate) — the door
  // must not try to resolve panes itself.
  const handleClick = (e: MouseEvent) => {
    const target = wikilinkTargetFromEvent(e.target);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    props.onNavigate?.(target);
  };

  return (
    <div class="door-read">
      <div class="door-read-toolbar">
        <span class="door-read-path" title={props.data.path}>{props.data.path}</span>
        <button
          class="door-read-toggle"
          onClick={(e) => { e.stopPropagation(); setShowSource((v) => !v); }}
          aria-pressed={showSource()}
          aria-label={showSource() ? 'Show rendered document' : 'Show raw source'}
          title={showSource() ? 'Show rendered document' : 'Show raw source'}
        >
          {showSource() ? '⊞' : '≡'}
        </button>
      </div>
      <Show
        when={!showSource()}
        fallback={<pre class="door-read-raw">{props.data.raw}</pre>}
      >
        {/* innerHTML is sanitized by DOMPurify inside renderMarkdownDoc(). */}
        <div class="door-read-doc" onClick={handleClick} innerHTML={html()} />
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORTS
// ═══════════════════════════════════════════════════════════════

export const door = {
  kind: 'view' as const,
  prefixes: ['read::'],

  async execute(
    _blockId: string,
    content: string,
    ctx: DoorContext,
  ): Promise<DoorResult<ReadData>> {
    const path = parseReadPath(content);
    if (!path) {
      return { data: { path: '', raw: '' }, error: 'Usage: read:: <path-to-file>' };
    }

    try {
      const raw = await exec(buildReadCommand(path));
      if (!raw) {
        return { data: { path, raw: '' }, error: `Empty or unreadable: ${path}` };
      }
      ctx.log('read::', path, `${raw.length} chars`);
      return { data: { path, raw } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { data: { path, raw: '' }, error: `Could not read ${path}: ${message}` };
    }
  },

  view: ReadView as Component<DoorViewProps<ReadData>>,
};

export const meta = {
  id: 'read',
  name: 'Read',
  version: '0.1.0',
};
