/**
 * Daily Notes Door
 *
 * Reader-view of daily notes with forward/back navigation.
 * Headless-first: queries floatty-server REST API (same as CLI agents).
 * Navigation is door-internal (createSignal for date, createResource for data).
 *
 * Compile: node scripts/compile-door.mjs doors/daily/daily.tsx ~/.floatty-dev/doors/daily/index.js
 */

import { createSignal, createResource, Show, For } from 'solid-js';
import type { Component } from 'solid-js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface TimelogEntry {
  time: string;
  summary: string;
  project?: string;
  mode?: string;
  issue?: string;
  meeting?: string;
  details: string[];
  phases: string[];
  prs: Array<{ num: number; status: string }>;
}

interface DailyData {
  date: string;
  dayOfWeek: string;
  entries: TimelogEntry[];
  notes: Array<{ title: string; content: string }>;
  stats: { sessions: number; hours: string; prs: number };
}

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
  log: (...args: unknown[]) => void;
}

interface DoorResult<T> {
  data: T;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function resolveDate(arg: string): string {
  if (!arg || arg === 'today') return new Date().toISOString().slice(0, 10);
  if (arg === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  if (arg === 'tomorrow') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  return arg; // assume YYYY-MM-DD
}

async function fetchDailyData(
  date: string,
  serverFetch: (path: string, init?: RequestInit) => Promise<Response>,
): Promise<DailyData> {
  const resp = await serverFetch('/api/v1/blocks');
  if (!resp.ok) {
    throw new Error(`API error: ${resp.status} ${resp.statusText}`);
  }
  const { blocks } = (await resp.json()) as { blocks: Array<Record<string, any>> };

  const dayStart = new Date(date).getTime();
  const dayEnd = dayStart + 86400000;
  const dayBlocks = blocks.filter(
    (b: any) => b.createdAt >= dayStart && b.createdAt < dayEnd,
  );

  const entries: TimelogEntry[] = dayBlocks
    .filter((b: any) => b.metadata?.markers?.some((m: any) => m.markerType === 'ctx'))
    .map((b: any) => ({
      time: new Date(b.createdAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
      summary: b.content?.slice(0, 120) || '',
      project: b.metadata?.markers?.find((m: any) => m.markerType === 'project')?.value,
      mode: b.metadata?.markers?.find((m: any) => m.markerType === 'mode')?.value,
      issue: b.metadata?.markers?.find((m: any) => m.markerType === 'issue')?.value,
      meeting: b.metadata?.markers?.find((m: any) => m.markerType === 'meeting')?.value,
      details: [],
      phases: [],
      prs: [],
    }));

  return {
    date,
    dayOfWeek: new Date(date).toLocaleDateString([], { weekday: 'long' }),
    entries,
    notes: [],
    stats: { sessions: entries.length, hours: '\u2014', prs: 0 },
  };
}

// ═══════════════════════════════════════════════════════════════
// VIEW COMPONENTS
// ═══════════════════════════════════════════════════════════════

function TimelineEntry(props: { entry: TimelogEntry }) {
  const type = () => {
    if (props.entry.meeting) return 'meeting';
    if (props.entry.mode === 'spike') return 'spike';
    if (props.entry.prs?.some((p) => p.status === 'merged')) return 'shipped';
    return '';
  };

  return (
    <div class={`door-daily-entry ${type()}`}>
      <div class="door-entry-head">
        <span class="door-time">{props.entry.time}</span>
        <div class="door-tags">
          <Show when={props.entry.project}>
            <span class="door-tag project">{props.entry.project}</span>
          </Show>
          <Show when={props.entry.mode}>
            <span class="door-tag mode">{props.entry.mode}</span>
          </Show>
          <Show when={props.entry.issue}>
            <span class="door-tag issue">{props.entry.issue}</span>
          </Show>
        </div>
      </div>
      <div class="door-summary">{props.entry.summary}</div>
      <Show when={props.entry.details?.length > 0}>
        <details open>
          <summary>Details ({props.entry.details.length})</summary>
          <ul class="door-list">
            <For each={props.entry.details}>
              {(detail) => <li>{detail}</li>}
            </For>
          </ul>
        </details>
      </Show>
      <Show when={props.entry.prs?.length > 0}>
        <div class="door-chips">
          <For each={props.entry.prs}>
            {(pr) => (
              <span class={`door-chip pr ${pr.status}`}>#{pr.num}</span>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function DailyView(props: DoorViewProps<DailyData>) {
  const [date, setDate] = createSignal(props.data.date);

  // Re-fetch when date changes via nav buttons
  const [data] = createResource(date, async (d) => {
    if (d === props.data.date) return props.data;
    try {
      return await fetchDailyData(d, props.server.fetch);
    } catch (err) {
      console.error('[door:daily] Navigation fetch failed:', err);
      return {
        date: d,
        dayOfWeek: '?',
        entries: [],
        notes: [],
        stats: { sessions: 0, hours: '\u2014', prs: 0 },
      } as DailyData;
    }
  });

  const navigateDate = (offset: number) => {
    const d = new Date(date());
    d.setDate(d.getDate() + offset);
    setDate(d.toISOString().slice(0, 10));
  };

  const current = () => data() ?? props.data;
  const stats = () =>
    current().stats || { sessions: 0, hours: '\u2014', prs: 0 };

  return (
    <div class="door-daily">
      <div class="door-daily-header">
        <div class="door-daily-nav">
          <button
            class="door-nav-btn"
            onClick={() => navigateDate(-1)}
            aria-label="Previous day"
          >
            ←
          </button>
          <div class="door-daily-date">{current().date}</div>
          <button
            class="door-nav-btn"
            onClick={() => navigateDate(1)}
            aria-label="Next day"
          >
            →
          </button>
        </div>
        <div class="door-daily-meta">
          <Show when={current().dayOfWeek}>
            <span class="door-pill">{current().dayOfWeek}</span>
          </Show>
          <span class="door-pill">{current().entries.length} entries</span>
        </div>
        <div class="door-daily-stats">
          <div class="door-stat">
            <strong>{stats().sessions}</strong> sessions
          </div>
          <div class="door-stat">
            <strong>{stats().hours}</strong> time
          </div>
          <div class="door-stat">
            <strong>{stats().prs}</strong> PRs
          </div>
        </div>
      </div>
      <Show when={current().entries.length > 0}>
        <div class="door-timeline">
          <For each={current().entries}>
            {(entry) => <TimelineEntry entry={entry} />}
          </For>
        </div>
      </Show>
      <Show when={current().notes?.length > 0}>
        <div class="door-notes">
          <h3>Notes</h3>
          <For each={current().notes}>
            {(note) => (
              <div class="door-note-card">
                <h4>{note.title}</h4>
                <p>{note.content}</p>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={!current().entries.length && !current().notes?.length}>
        <div class="door-empty">No entries for {current().date}</div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORTS
// ═══════════════════════════════════════════════════════════════

export const door = {
  kind: 'view' as const,
  prefixes: ['daily::'],

  async execute(
    blockId: string,
    content: string,
    ctx: DoorContext,
  ): Promise<DoorResult<DailyData>> {
    const dateArg = content.replace(/^daily::\s*/i, '').trim();
    const date = resolveDate(dateArg);
    ctx.log('Executing for date:', date);

    try {
      const data = await fetchDailyData(date, ctx.server.fetch);
      return { data };
    } catch (err) {
      ctx.log('Error fetching daily data:', err);
      return {
        data: {
          date,
          dayOfWeek: '?',
          entries: [],
          notes: [],
          stats: { sessions: 0, hours: '\u2014', prs: 0 },
        },
        error: String(err),
      };
    }
  },

  view: DailyView as Component<any>,
};

export const meta = {
  id: 'daily',
  name: 'Daily Notes',
  version: '0.1.0',
};
