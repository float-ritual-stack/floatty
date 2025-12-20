import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

// Status of a ctx:: marker parsing
type MarkerStatus = 'pending' | 'parsed' | 'error';

// Parsed ctx:: marker data (from Ollama)
// Simplified - dedicated fields instead of generic tags array
interface ParsedCtx {
  timestamp?: string;
  time?: string;
  project?: string;
  mode?: string;
  meeting?: string;
  issue?: string;
  summary?: string;
  message?: string;
}

// Full ctx:: marker record from database
interface CtxMarker {
  id: string;
  session_file: string;
  raw_line: string;
  status: MarkerStatus;
  parsed?: ParsedCtx;
  // JSONL metadata (extracted at insert time)
  cwd?: string;
  git_branch?: string;
  session_id?: string;
  msg_type?: string;
  created_at: string;
  retry_count: number;
}

// Marker counts by status
interface MarkerCounts {
  pending: number;
  parsed: number;
  error: number;
  total: number;
}

// Tag color map
const TAG_COLORS: Record<string, string> = {
  project: 'ctx-tag-project',
  mode: 'ctx-tag-mode',
  meeting: 'ctx-tag-meeting',
  issue: 'ctx-tag-issue',
  repo: 'ctx-tag-repo',
  branch: 'ctx-tag-branch',
};

// Extract repo name from cwd path
function getRepoFromCwd(cwd?: string): string | null {
  if (!cwd) return null;
  // Get last path segment as repo name
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || null;
}

export function ContextSidebar(props: { visible: boolean }) {
  const [markers, setMarkers] = createSignal<CtxMarker[]>([]);
  const [counts, setCounts] = createSignal<MarkerCounts>({ pending: 0, parsed: 0, error: 0, total: 0 });
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  // Fetch markers from backend
  const fetchMarkers = async () => {
    try {
      const [newMarkers, newCounts] = await Promise.all([
        invoke<CtxMarker[]>('get_ctx_markers', { limit: 100 }),
        invoke<MarkerCounts>('get_ctx_counts'),
      ]);
      setMarkers(newMarkers);
      setCounts(newCounts);
      setError(null);
      setLoading(false);
    } catch (e) {
      console.error('Failed to fetch markers:', e);
      setError(String(e));
      setLoading(false);
    }
  };

  // Poll for updates
  createEffect(() => {
    if (!props.visible) return;

    // Schedule initial fetch (not called synchronously in effect)
    const initialTimeout = setTimeout(fetchMarkers, 0);

    // Poll every 2 seconds
    const interval = setInterval(fetchMarkers, 2000);

    onCleanup(() => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    });
  });

  return (
    <Show when={props.visible}>
      <Show
        when={!loading()}
        fallback={
          <div class="ctx-sidebar">
            <div class="ctx-sidebar-header">Context Stream</div>
            <div class="ctx-empty-state">Loading...</div>
          </div>
        }
      >
        <Show
          when={!error()}
          fallback={
            <div class="ctx-sidebar ctx-sidebar-error">
              <div class="ctx-sidebar-header">Context Stream</div>
              <div class="ctx-error-state">
                <div class="ctx-error-message">{error()}</div>
                <button class="ctx-retry-button" onClick={fetchMarkers}>
                  Retry
                </button>
              </div>
            </div>
          }
        >
          <Show
            when={markers().length > 0}
            fallback={
              <div class="ctx-sidebar ctx-sidebar-empty">
                <div class="ctx-sidebar-header">Context Stream</div>
                <div class="ctx-empty-state">
                  No ctx:: markers yet
                  <div class="ctx-hint">
                    Watching ~/.claude/projects/*.jsonl
                  </div>
                </div>
              </div>
            }
          >
            <div class="ctx-sidebar">
              <div class="ctx-sidebar-header">
                Context Stream ({counts().total})
                <Show when={counts().pending > 0}>
                  <span class="ctx-pending-badge">{counts().pending} parsing...</span>
                </Show>
              </div>
              <div class="ctx-markers-list">
                <For each={markers()}>
                  {(marker) => <MarkerCard marker={marker} />}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

function MarkerCard(props: { marker: CtxMarker }) {
  const isPending = () => props.marker.status === 'pending';
  const isError = () => props.marker.status === 'error';

  // JSONL metadata (always available)
  const repo = () => getRepoFromCwd(props.marker.cwd);
  const branch = () => props.marker.git_branch;

  return (
    <Show
      when={props.marker.parsed}
      fallback={
        // For raw markers (pending/error), show simplified version
        (() => {
          const time = extractTimeFromRaw(props.marker.raw_line);
          const project = extractTagFromRaw(props.marker.raw_line, 'project');
          const mode = extractTagFromRaw(props.marker.raw_line, 'mode');

          return (
            <div class={`ctx-marker ${isPending() ? 'ctx-marker-pending' : ''} ${isError() ? 'ctx-marker-error' : ''}`}>
              <div class="ctx-marker-time">
                {time}
                <Show when={isPending()}>
                  <span class="ctx-parsing-indicator">...</span>
                </Show>
                <Show when={isError()}>
                  <span class="ctx-error-indicator">!</span>
                </Show>
              </div>
              <div class="ctx-marker-tags">
                <Show when={repo()}>
                  <span class={`ctx-tag ${TAG_COLORS.repo}`}>{repo()}</span>
                </Show>
                <Show when={branch() && branch() !== 'main'}>
                  <span class={`ctx-tag ${TAG_COLORS.branch}`}>{branch()}</span>
                </Show>
                <Show when={project}>
                  <span class={`ctx-tag ${TAG_COLORS.project}`}>{project}</span>
                </Show>
                <Show when={mode}>
                  <span class={`ctx-tag ${TAG_COLORS.mode}`}>{mode}</span>
                </Show>
              </div>
              <div class="ctx-marker-message ctx-marker-raw">
                {extractMessageFromRaw(props.marker.raw_line)}
              </div>
            </div>
          );
        })()
      }
    >
      {/* For parsed markers, use the structured data */}
      {(() => {
        const parsed = props.marker.parsed!;
        const { time, project, mode, meeting, issue, summary, message } = parsed;

        // Dedupe: skip repo badge if project matches repo name
        const showRepo = repo() && (!project || !project.toLowerCase().includes(repo()!.toLowerCase()));

        return (
          <div class={`ctx-marker ${isPending() ? 'ctx-marker-pending' : ''} ${isError() ? 'ctx-marker-error' : ''}`}>
            <div class="ctx-marker-time">{time || extractTimeFromRaw(props.marker.raw_line)}</div>
            <div class="ctx-marker-tags">
              <Show when={showRepo}>
                <span class={`ctx-tag ${TAG_COLORS.repo}`}>{repo()}</span>
              </Show>
              <Show when={branch() && branch() !== 'main'}>
                <span class={`ctx-tag ${TAG_COLORS.branch}`}>{branch()}</span>
              </Show>
              <Show when={project}>
                <span class={`ctx-tag ${TAG_COLORS.project}`}>{project}</span>
              </Show>
              <Show when={mode}>
                <span class={`ctx-tag ${TAG_COLORS.mode}`}>{mode}</span>
              </Show>
              <Show when={meeting}>
                <span class={`ctx-tag ${TAG_COLORS.meeting}`}>{meeting}</span>
              </Show>
              <Show when={issue}>
                <span class={`ctx-tag ${TAG_COLORS.issue}`}>{issue}</span>
              </Show>
            </div>
            <Show when={summary}>
              <div class="ctx-marker-summary">{summary}</div>
            </Show>
            <Show when={message}>
              <div class="ctx-marker-message">{message}</div>
            </Show>
          </div>
        );
      })()}
    </Show>
  );
}

// Simple regex fallbacks for raw lines
function extractTimeFromRaw(line: string): string {
  const match = line.match(/@\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
  return match?.[1]?.trim() || '';
}

function extractTagFromRaw(line: string, tag: string): string | null {
  const regex = new RegExp(`\\[${tag}::([^\\]]+)\\]`, 'i');
  const match = line.match(regex);
  return match?.[1]?.trim() || null;
}

function extractMessageFromRaw(line: string): string {
  // Remove ctx:: prefix and tags, return remaining
  let msg = line
    .replace(/ctx::\d{4}-\d{2}-\d{2}\s*@\s*[\d:]+\s*(?:AM|PM)?/i, '')
    .replace(/\[[\w-]+::[^\]]+\]/g, '')
    .replace(/"\s*,\s*"[^"]+"\s*:/g, '')  // Remove JSON field patterns
    .replace(/[}\]]+.*$/g, '')  // Remove trailing JSON garbage
    .replace(/"stop_reason.*$/i, '')  // Remove stop_reason and after
    .replace(/"type.*$/i, '')  // Remove type field and after
    .trim();

  // Truncate if too long
  if (msg.length > 80) {
    msg = msg.slice(0, 80) + '...';
  }
  return msg;
}
