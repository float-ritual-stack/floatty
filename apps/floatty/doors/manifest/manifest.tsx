/**
 * Claude-Mem Door — Sidebar viewer for claude-mem observations
 *
 * Embeds the claude-mem worker's built-in viewer UI (localhost:4077)
 * as an iframe. The viewer handles auth, SSE, pagination, theming.
 *
 * sidebarEligible: true — shows as a tab in the sidebar.
 * Also triggered by `mem::` prefix in outliner blocks.
 *
 * Compile: node scripts/compile-door.mjs doors/manifest/manifest.tsx ~/.floatty-dev/doors/manifest/index.js
 */

import { createSignal, Show, onMount } from 'solid-js';
import type { Component } from 'solid-js';

// ═══════════════════════════════════════════════════════════════
// TYPES
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
}

interface DoorContext {
  server: { fetch(path: string, init?: RequestInit): Promise<Response> };
  settings: Record<string, unknown>;
  log: (...args: unknown[]) => void;
}

interface DoorResult<T> {
  data: T;
  error?: string;
}

interface MemData {
  url: string;
}

// ═══════════════════════════════════════════════════════════════
// VIEW
// ═══════════════════════════════════════════════════════════════

function ClaudeMemView(props: DoorViewProps<MemData | null>) {
  const [alive, setAlive] = createSignal<boolean | null>(null);
  const url = () => (props.settings?.url as string) || 'http://localhost:4077';

  onMount(async () => {
    try {
      const res = await fetch(`${url()}/health`);
      setAlive(res.ok);
    } catch {
      setAlive(false);
    }
  });

  return (
    <div style="width:100%;flex:1;display:flex;flex-direction:column;min-height:0;">
      <Show when={alive() === false}>
        <div style="padding:12px;font-family:monospace;font-size:11px;color:var(--color-fg-muted);">
          claude-mem worker not responding at {url()}
        </div>
      </Show>
      <Show when={alive() === true}>
        <iframe
          src={url()}
          style="width:100%;flex:1;border:none;background:var(--color-bg-dark);min-height:0;"
          title="claude-mem viewer"
        />
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORTS
// ═══════════════════════════════════════════════════════════════

export const door = {
  kind: 'view' as const,
  prefixes: ['mem::'],

  async execute(
    _blockId: string,
    _content: string,
    ctx: DoorContext,
  ): Promise<DoorResult<MemData>> {
    const url = (ctx.settings?.url as string) || 'http://localhost:4077';
    ctx.log('Claude-mem viewer:', url);
    return { data: { url } };
  },

  view: ClaudeMemView as Component<any>,
};

export const meta = {
  id: 'claude-mem',
  name: 'mem',
  version: '0.1.0',
  sidebarEligible: true,
};
