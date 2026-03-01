/**
 * DoorHost — Dynamic wrapper for door view components
 *
 * Wraps <Dynamic> with loading/error chrome + raw view toggle.
 * Door views don't know about loading states — DoorHost handles that.
 *
 * Focus contract: DoorHost does NOT own focus — parent outputFocusRef
 * in BlockItem handles all keyboard routing. No tabIndex here.
 */

import { Show, createSignal } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { doorRegistry } from '../../lib/handlers/doorRegistry';
import type { DoorServerAccess } from '../../lib/handlers/doorTypes';
import './doors.css';

// ═══════════════════════════════════════════════════════════════
// SERVER ACCESS (lazy singleton — same pattern as doorSandbox.ts)
// ═══════════════════════════════════════════════════════════════

let cachedServer: DoorServerAccess | null = null;

function getServerAccess(): DoorServerAccess {
  if (cachedServer) return cachedServer;

  const url = window.__FLOATTY_SERVER_URL__;
  const apiKey = window.__FLOATTY_API_KEY__;

  if (!url || !apiKey) {
    throw new Error('[DoorHost] Server info not available');
  }

  const wsUrl = url.replace(/^http/, 'ws') + '/ws';

  cachedServer = {
    url,
    wsUrl,
    async fetch(path: string, init?: RequestInit): Promise<Response> {
      const fullUrl = `${url}${path}`;
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${apiKey}`);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      return globalThis.fetch(fullUrl, { ...init, headers });
    },
  };

  return cachedServer;
}

// ═══════════════════════════════════════════════════════════════
// DOOR HOST (view door wrapper)
// ═══════════════════════════════════════════════════════════════

interface DoorHostProps {
  doorId: string;
  data: unknown;
  error?: string;
  status?: string;
  onNavigateOut?: (direction: 'up' | 'down') => void;
}

export function DoorHost(props: DoorHostProps) {
  const [showRaw, setShowRaw] = createSignal(false);
  const ViewComponent = () => doorRegistry.getView(props.doorId);

  return (
    <div class="door-output">
      <div class="door-output-toolbar">
        <button
          class="door-raw-toggle"
          onClick={(e) => { e.stopPropagation(); setShowRaw(v => !v); }}
          aria-label={showRaw() ? 'Show rendered view' : 'Show raw data'}
          title={showRaw() ? 'Show rendered view' : 'Show raw data'}
        >
          {showRaw() ? '\u229E' : '{ }'}
        </button>
      </div>
      <Show when={props.status === 'running'}>
        <div class="door-loading"><span class="door-spinner">{'\u25D0'}</span> Loading...</div>
      </Show>
      <Show when={props.error && props.status !== 'running'}>
        <div class="door-error">{props.error}</div>
      </Show>
      <Show when={ViewComponent() && props.status === 'complete'}>
        <Show when={!showRaw()} fallback={
          <pre class="door-raw-json">{JSON.stringify(props.data, null, 2)}</pre>
        }>
          <Dynamic
            component={ViewComponent()!}
            data={props.data}
            settings={doorRegistry.getSettings(props.doorId)}
            server={getServerAccess()}
            onNavigateOut={props.onNavigateOut}
          />
        </Show>
      </Show>
      <Show when={!ViewComponent() && props.status === 'complete'}>
        <div class="door-unknown">Unknown door: {props.doorId}</div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXEC CARD (block door receipt)
// ═══════════════════════════════════════════════════════════════

interface DoorExecCardProps {
  doorId: string;
  ok: boolean;
  startedAt: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  createdBlockIds?: string[];
}

export function DoorExecCard(props: DoorExecCardProps) {
  const duration = () => {
    if (!props.finishedAt) return null;
    const ms = props.finishedAt - props.startedAt;
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div class={`door-exec-card ${props.ok ? 'door-exec-ok' : 'door-exec-error'}`}>
      <span class="door-exec-icon">{props.ok ? '\u2713' : '\u2717'}</span>
      <span class="door-exec-name">{props.doorId}</span>
      <Show when={duration()}>
        <span class="door-exec-duration">{duration()}</span>
      </Show>
      <Show when={props.createdBlockIds && props.createdBlockIds.length > 0}>
        <span class="door-exec-created">{props.createdBlockIds!.length} blocks</span>
      </Show>
      <Show when={props.summary}>
        <span class="door-exec-summary">{props.summary}</span>
      </Show>
      <Show when={props.error}>
        <div class="door-exec-error-msg">{props.error}</div>
      </Show>
    </div>
  );
}
