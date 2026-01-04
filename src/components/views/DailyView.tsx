/**
 * Daily View Component
 *
 * Renders structured data from a daily note as a timeline with
 * tags, expandable details, and PR chips.
 */

import { For, Show } from 'solid-js';
import type { DailyNoteData, TimelogEntry, PrInfo, ScatteredThought } from '../../lib/dailyExecutor';

interface DailyViewProps {
  data: DailyNoteData;
}

/**
 * Determine entry type for timeline dot color
 */
function entryType(entry: TimelogEntry): string {
  if (entry.meeting) return 'meeting';
  if (entry.mode === 'spike') return 'spike';
  if (entry.mode === 'maintenance') return 'maintenance';
  const hasMerged = entry.prs?.some(p => p.status === 'merged');
  return hasMerged ? 'shipped' : '';
}

/**
 * Timeline entry component
 */
function TimelineEntry(props: { entry: TimelogEntry }) {
  const type = () => entryType(props.entry);

  return (
    <div class={`daily-entry ${type()}`}>
      <div class="daily-entry-head">
        <div class="daily-time">
          <span class="daily-clock">{props.entry.time}</span>
        </div>
        <div class="daily-tags">
          <Show when={props.entry.project}>
            <span class="daily-tag project">{props.entry.project}</span>
          </Show>
          <Show when={props.entry.mode}>
            <span class="daily-tag mode">{props.entry.mode}</span>
          </Show>
          <Show when={props.entry.issue}>
            <span class="daily-tag issue">{props.entry.issue}</span>
          </Show>
          <Show when={props.entry.meeting}>
            <span class="daily-tag meeting">{props.entry.meeting}</span>
          </Show>
        </div>
      </div>

      <div class="daily-summary">{props.entry.summary}</div>

      <div class="daily-sub">
        {/* Details list */}
        <Show when={props.entry.details?.length > 0}>
          <details open>
            <summary>
              <span class="daily-caret">▸</span>
              Details ({props.entry.details.length})
            </summary>
            <ul class="daily-list">
              <For each={props.entry.details}>
                {(detail) => <li>{detail}</li>}
              </For>
            </ul>
          </details>
        </Show>

        {/* Phases */}
        <Show when={props.entry.phases?.length > 0}>
          <details open>
            <summary>
              <span class="daily-caret">▸</span>
              Phases ({props.entry.phases.length})
            </summary>
            <div class="daily-phases">
              <For each={props.entry.phases}>
                {(phase) => {
                  const parts = phase.split(':');
                  const head = parts[0] || '';
                  const rest = parts.slice(1).join(':').trim();
                  return (
                    <div class="daily-phase">
                      <strong>{head}:</strong> {rest}
                    </div>
                  );
                }}
              </For>
            </div>
          </details>
        </Show>

        {/* PR chips */}
        <Show when={props.entry.prs?.length > 0}>
          <div class="daily-chips">
            <For each={props.entry.prs}>
              {(pr: PrInfo) => (
                <span class={`daily-chip pr ${pr.status}`}>
                  <span class="daily-dot" />
                  #{pr.num}
                </span>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}

/**
 * Scattered thought note component
 */
function NoteCard(props: { thought: ScatteredThought }) {
  return (
    <div class="daily-note">
      <h3>{props.thought.title}</h3>
      <p>{props.thought.content}</p>
    </div>
  );
}

export function DailyView(props: DailyViewProps) {
  // Defensive fallbacks for optional fields
  const stats = () => props.data.stats || { sessions: 0, hours: '—', prs: 0 };
  const dayOfWeek = () => props.data.day_of_week || '';
  const timelogs = () => props.data.timelogs || [];

  return (
    <div class="daily-view">
      {/* Header with stats */}
      <div class="daily-header">
        <div class="daily-date-info">
          <div class="daily-date">{props.data.date}</div>
          <div class="daily-meta">
            <Show when={dayOfWeek()}>
              <span class="daily-pill">{dayOfWeek()}</span>
            </Show>
            <span class="daily-pill">{timelogs().length} entries</span>
          </div>
        </div>
        <Show when={stats()}>
          <div class="daily-stats">
            <div class="daily-stat">
              <div class="daily-stat-value">{stats().sessions}</div>
              <div class="daily-stat-label">Sessions</div>
            </div>
            <div class="daily-stat">
              <div class="daily-stat-value">{stats().hours}</div>
              <div class="daily-stat-label">Time</div>
            </div>
            <div class="daily-stat">
              <div class="daily-stat-value">{stats().prs}</div>
              <div class="daily-stat-label">PRs</div>
            </div>
          </div>
        </Show>
      </div>

      {/* Timeline */}
      <Show when={timelogs().length > 0}>
        <div class="daily-timeline">
          <For each={timelogs()}>
            {(entry: TimelogEntry) => <TimelineEntry entry={entry} />}
          </For>
        </div>
      </Show>

      {/* Scattered thoughts */}
      <Show when={props.data.scattered_thoughts?.length > 0}>
        <div class="daily-notes">
          <h2>Notes</h2>
          <For each={props.data.scattered_thoughts}>
            {(thought: ScatteredThought) => <NoteCard thought={thought} />}
          </For>
        </div>
      </Show>

      {/* Empty state */}
      <Show when={timelogs().length === 0 && (!props.data.scattered_thoughts || props.data.scattered_thoughts.length === 0)}>
        <div class="daily-empty">No timelogs or notes found for {props.data.date}</div>
      </Show>
    </div>
  );
}

interface DailyErrorViewProps {
  error: string;
}

export function DailyErrorView(props: DailyErrorViewProps) {
  return (
    <div class="daily-error">
      <span class="daily-error-icon">⚠</span>
      <span class="daily-error-text">{props.error}</span>
    </div>
  );
}
