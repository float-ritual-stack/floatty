/**
 * Timestamp Door
 *
 * Renders formatted timestamps in multiple modes.
 * Proves: multi-prefix routing, settings, generalization.
 *
 * Compile: node scripts/compile-door.mjs doors/timestamp/timestamp.tsx ~/.floatty-dev/doors/timestamp/index.js
 */

import { Show } from 'solid-js';
import type { Component } from 'solid-js';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

type TsFormat = 'iso' | 'unix' | 'date' | 'time';

interface TsData {
  formatted: string;
  format: TsFormat;
  raw: number;
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
  settings: Record<string, unknown>;
  log: (...args: unknown[]) => void;
}

interface DoorResult<T> {
  data: T;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// CORE LOGIC
// ═══════════════════════════════════════════════════════════════

const FORMAT_LABELS: Record<TsFormat, string> = {
  iso: 'ISO 8601',
  unix: 'Unix',
  date: 'Date',
  time: 'Time',
};

function parseFormat(arg: string, defaultFormat: TsFormat): TsFormat {
  const normalized = arg.toLowerCase().trim();
  if (normalized === 'iso' || normalized === 'iso8601') return 'iso';
  if (normalized === 'unix' || normalized === 'epoch') return 'unix';
  if (normalized === 'date') return 'date';
  if (normalized === 'time') return 'time';
  return defaultFormat;
}

function formatTimestamp(now: Date, format: TsFormat): string {
  switch (format) {
    case 'iso':
      return now.toISOString();
    case 'unix':
      return String(Math.floor(now.getTime() / 1000));
    case 'date':
      return now.toLocaleDateString(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    case 'time':
      return now.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
  }
}

// ═══════════════════════════════════════════════════════════════
// VIEW
// ═══════════════════════════════════════════════════════════════

function TimestampView(props: DoorViewProps<TsData>) {
  return (
    <div class="door-timestamp">
      <div class="door-timestamp-header">
        <span class="door-pill">{FORMAT_LABELS[props.data.format]}</span>
      </div>
      <div class="door-timestamp-value">{props.data.formatted}</div>
      <Show when={props.data.format === 'unix'}>
        <div class="door-timestamp-sub">
          {new Date(props.data.raw).toISOString()}
        </div>
      </Show>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DOOR EXPORTS
// ═══════════════════════════════════════════════════════════════

export const door = {
  kind: 'view' as const,
  prefixes: ['ts::', 'timestamp::'],

  async execute(
    _blockId: string,
    content: string,
    ctx: DoorContext,
  ): Promise<DoorResult<TsData>> {
    // Strip prefix
    const arg = content.replace(/^(ts|timestamp)::\s*/i, '').trim();
    const defaultFormat = (ctx.settings?.default_format as TsFormat) || 'iso';
    const format = parseFormat(arg, defaultFormat);

    const now = new Date();
    const formatted = formatTimestamp(now, format);

    ctx.log('Timestamp:', format, formatted);

    return {
      data: {
        formatted,
        format,
        raw: now.getTime(),
      },
    };
  },

  view: TimestampView as Component<any>,
};

export const meta = {
  id: 'timestamp',
  name: 'Timestamp',
  version: '0.1.0',
};
