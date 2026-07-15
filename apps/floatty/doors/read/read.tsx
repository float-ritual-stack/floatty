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

import { For, Show, createSignal, createMemo, createEffect } from 'solid-js';
import type { Component } from 'solid-js';
import { exec } from '@floatty/stdlib';
import {
  buildReadCommand,
  enhanceReaderDoc,
  isQmdSource,
  parseReadPath,
  renderMarkdownDoc,
  splitFrontmatter,
  stripQmdPreamble,
  wikilinkTargetFromEvent,
  type ReadData,
  type ReaderHeading,
} from './readDoc';
import { READ_DOOR_CSS } from './readStyles';

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
  // Stale-output guard: a block previously executed by a different door (or
  // an older shape of this one) can carry output.data that is null or
  // missing fields. Never crash on render — degrade to an empty document;
  // re-executing the block writes fresh, correctly-shaped output.
  const data = createMemo<ReadData>(() => {
    const d = props.data as ReadData | null | undefined;
    return d && typeof d.raw === 'string'
      ? d
      : { path: typeof d?.path === 'string' ? d.path : '', raw: '' };
  });
  // Frontmatter renders as a compact metadata strip, never as body prose —
  // marked would mash the YAML into giant paragraphs (live-test finding).
  const doc = createMemo(() => splitFrontmatter(data().raw));
  const html = createMemo(() => renderMarkdownDoc(doc().body));

  let docRef: HTMLDivElement | undefined;
  // Heading model for the table of contents (FLO-815). Populated by the
  // enhance pass below, straight off the rendered DOM so ToC targets and
  // heading ids can't drift apart.
  const [headings, setHeadings] = createSignal<ReaderHeading[]>([]);

  // After each render, rewrite the doc into collapsible sections and read back
  // the ToC. Depends on html() + showSource(): when html() changes Solid
  // resets innerHTML (dropping the previous <details> wrapping) and this
  // re-runs; source mode has no doc to enhance. Defensive — a transform fault
  // must never blank the document.
  createEffect(() => {
    html();
    if (showSource()) {
      setHeadings([]);
      return;
    }
    if (!docRef) return;
    try {
      setHeadings(enhanceReaderDoc(docRef));
    } catch {
      setHeadings([]);
    }
  });

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

  // ToC jump: open any collapsed ancestor sections, then scroll the heading
  // into view. Same-document scroll only — never navigation.
  const handleTocJump = (slug: string) => {
    const root = docRef;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[id="${slug}"]`);
    if (!el) return;
    let p = el.parentElement;
    while (p && p !== root) {
      if (p.tagName === 'DETAILS') (p as HTMLDetailsElement).open = true;
      p = p.parentElement;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div class="door-read">
      {/* Styles travel WITH the door bundle — doors are drop-in plugins and
          must render correctly on app builds that predate them. */}
      <style>{READ_DOOR_CSS}</style>
      <div class="door-read-toolbar">
        <span class="door-read-path" title={data().path}>{data().path || 'read:: (re-run to load)'}</span>
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
        fallback={<pre class="door-read-raw">{data().raw}</pre>}
      >
        <Show when={doc().front}>
          {(front) => (
            <div class="door-read-front">
              <For each={front()}>
                {([k, v]) => (
                  <span class="fm-pair">
                    <span class="fm-k">{k}</span>
                    <span class="fm-v">{v}</span>
                  </span>
                )}
              </For>
            </div>
          )}
        </Show>
        {/* On-page table of contents (FLO-815) — only when there's more than
            one heading to jump between. */}
        <Show when={headings().length > 1}>
          <details class="door-read-toc" open>
            <summary class="door-read-toc-title">On this page</summary>
            <nav>
              <For each={headings()}>
                {(h) => (
                  <a
                    class="door-read-toc-link"
                    data-level={h.level}
                    onClick={(e) => { e.stopPropagation(); handleTocJump(h.slug); }}
                  >
                    {h.text}
                  </a>
                )}
              </For>
            </nav>
          </details>
        </Show>
        {/* innerHTML is sanitized by DOMPurify inside renderMarkdownDoc(); the
            enhance effect then wraps headings into collapsible <details>. */}
        <div class="door-read-doc" ref={docRef} onClick={handleClick} innerHTML={html()} />
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
      let raw = await exec(buildReadCommand(path));
      if (raw && isQmdSource(path)) raw = stripQmdPreamble(raw);
      // A successful exec() returning '' is a valid empty file — render it as
      // an empty document, don't error. exec() throws on command failure
      // (missing file → non-zero exit), which the catch below turns into the
      // real error. Reserving errors for rejected exec() matches how the other
      // doors (portless, rangle-dash) trust exec().
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
