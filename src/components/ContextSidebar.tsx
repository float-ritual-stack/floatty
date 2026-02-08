import { createSignal, createEffect, onCleanup, Show, For } from 'solid-js';
import { invoke } from '../lib/tauriTypes';
import { onCtxMarkersChanged } from '../lib/ctxEvents';

// Check if running in Tauri environment (Tauri 2 uses '__TAURI_INTERNALS__')
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

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
  let fetchInFlight = false;
  let fetchQueued = false;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  const queueFetch = (delayMs = 0) => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      fetchMarkers();
    }, delayMs);
  };

  // Fetch markers from backend
  const fetchMarkers = async () => {
    if (fetchInFlight) {
      fetchQueued = true;
      return;
    }
    fetchInFlight = true;

    try {
      if (!isTauri) {
        // Mock data for browser mode
        setMarkers([
          {
            id: 'mock-1',
            session_file: '/mock/session.jsonl',
            raw_line: 'ctx::2024-03-20 @ 10:30 AM [project::floatty] [mode::coding] Initial setup',
            status: 'parsed',
            parsed: {
              timestamp: '2024-03-20',
              time: '10:30 AM',
              project: 'floatty',
              mode: 'coding',
              message: 'Initial setup completed',
            },
            created_at: new Date().toISOString(),
            retry_count: 0,
          },
        ]);
        setCounts({ pending: 0, parsed: 1, error: 0, total: 1 });
        setLoading(false);
        return;
      }

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
    } finally {
      fetchInFlight = false;
      if (fetchQueued) {
        fetchQueued = false;
        queueFetch(0);
      }
    }
  };

  // Event-driven refresh lifecycle (visible only): initial load + ctx events + focus/visibility.
  createEffect(() => {
    if (!props.visible) return;

    queueFetch(0);
    const unsubscribeCtx = onCtxMarkersChanged(() => queueFetch(150));
    const onFocus = () => queueFetch(0);
    const onVisibilityChange = () => {
      if (!document.hidden) {
        queueFetch(0);
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    onCleanup(() => {
      unsubscribeCtx();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      fetchQueued = false;
    });
  });

  return (
    <Show when={props.visible}>
      <Show
        when={!loading()}
        fallback={
          <aside class="ctx-sidebar" role="complementary" aria-label="Context stream">
            <div class="ctx-sidebar-header">Context Stream</div>
            <div class="ctx-empty-state">Loading...</div>
          </aside>
        }
      >
        <Show
          when={!error()}
          fallback={
            <aside class="ctx-sidebar ctx-sidebar-error" role="complementary" aria-label="Context stream">
              <div class="ctx-sidebar-header">Context Stream</div>
              <div class="ctx-error-state">
                <div class="ctx-error-message" role="alert">{error()}</div>
                <button class="ctx-retry-button" onClick={() => queueFetch(0)}>
                  Retry
                </button>
              </div>
            </aside>
          }
        >
          <Show
            when={markers().length > 0}
            fallback={
              <aside class="ctx-sidebar ctx-sidebar-empty" role="complementary" aria-label="Context stream">
                <div class="ctx-sidebar-header">Context Stream</div>
                <div class="ctx-empty-state">
                  No ctx:: markers yet
                  <div class="ctx-hint">
                    Watching ~/.claude/projects/*.jsonl
                  </div>
                </div>
              </aside>
            }
          >
            <aside class="ctx-sidebar" role="complementary" aria-label="Context stream">
              <div class="ctx-sidebar-header">
                Context Stream ({counts().total})
                <Show when={counts().pending > 0}>
                  <span class="ctx-pending-badge" aria-live="polite">{counts().pending} parsing...</span>
                </Show>
              </div>
              <div class="ctx-markers-list">
                <For each={markers()}>
                  {(marker) => <MarkerCard marker={marker} />}
                </For>
              </div>
            </aside>
          </Show>
        </Show>
      </Show>
    </Show>
  );
}

// Raw marker card for pending/error states
function RawMarkerCard(props: { marker: CtxMarker; repo: string | null; branch: string | undefined }) {
  const isPending = () => props.marker.status === 'pending';
  const isError = () => props.marker.status === 'error';
  const time = () => extractTimeFromRaw(props.marker.raw_line);
  const project = () => extractTagFromRaw(props.marker.raw_line, 'project');
  const mode = () => extractTagFromRaw(props.marker.raw_line, 'mode');

  return (
    <div class={`ctx-marker ${isPending() ? 'ctx-marker-pending' : ''} ${isError() ? 'ctx-marker-error' : ''}`}>
      <div class="ctx-marker-time">
        {time()}
        <Show when={isPending()}>
          <span class="ctx-parsing-indicator">...</span>
        </Show>
        <Show when={isError()}>
          <span class="ctx-error-indicator">!</span>
        </Show>
      </div>
      <div class="ctx-marker-tags">
        <Show when={props.repo}>
          <span class={`ctx-tag ${TAG_COLORS.repo}`}>{props.repo}</span>
        </Show>
        <Show when={props.branch && props.branch !== 'main'}>
          <span class={`ctx-tag ${TAG_COLORS.branch}`}>{props.branch}</span>
        </Show>
        <Show when={project()}>
          <span class={`ctx-tag ${TAG_COLORS.project}`}>{project()}</span>
        </Show>
        <Show when={mode()}>
          <span class={`ctx-tag ${TAG_COLORS.mode}`}>{mode()}</span>
        </Show>
      </div>
      <div class="ctx-marker-message ctx-marker-raw">
        {extractMessageFromRaw(props.marker.raw_line)}
      </div>
    </div>
  );
}

// Parsed marker card with structured data
function ParsedMarkerCard(props: { marker: CtxMarker; parsed: ParsedCtx; repo: string | null; branch: string | undefined }) {
  const isPending = () => props.marker.status === 'pending';
  const isError = () => props.marker.status === 'error';

  // Dedupe: skip repo badge if project matches repo name
  const showRepo = () => props.repo && (!props.parsed.project || !props.parsed.project.toLowerCase().includes(props.repo!.toLowerCase()));

  return (
    <div class={`ctx-marker ${isPending() ? 'ctx-marker-pending' : ''} ${isError() ? 'ctx-marker-error' : ''}`}>
      <div class="ctx-marker-time">{props.parsed.time || extractTimeFromRaw(props.marker.raw_line)}</div>
      <div class="ctx-marker-tags">
        <Show when={showRepo()}>
          <span class={`ctx-tag ${TAG_COLORS.repo}`}>{props.repo}</span>
        </Show>
        <Show when={props.branch && props.branch !== 'main'}>
          <span class={`ctx-tag ${TAG_COLORS.branch}`}>{props.branch}</span>
        </Show>
        <Show when={props.parsed.project}>
          <span class={`ctx-tag ${TAG_COLORS.project}`}>{props.parsed.project}</span>
        </Show>
        <Show when={props.parsed.mode}>
          <span class={`ctx-tag ${TAG_COLORS.mode}`}>{props.parsed.mode}</span>
        </Show>
        <Show when={props.parsed.meeting}>
          <span class={`ctx-tag ${TAG_COLORS.meeting}`}>{props.parsed.meeting}</span>
        </Show>
        <Show when={props.parsed.issue}>
          <span class={`ctx-tag ${TAG_COLORS.issue}`}>{props.parsed.issue}</span>
        </Show>
      </div>
      <Show when={props.parsed.summary}>
        <div class="ctx-marker-summary">{props.parsed.summary}</div>
      </Show>
      <Show when={props.parsed.message}>
        <div class="ctx-marker-message">{props.parsed.message}</div>
      </Show>
    </div>
  );
}

function MarkerCard(props: { marker: CtxMarker }) {
  // JSONL metadata (always available)
  const repo = () => getRepoFromCwd(props.marker.cwd);
  const branch = () => props.marker.git_branch;

  return (
    <Show
      when={props.marker.parsed}
      keyed
      fallback={<RawMarkerCard marker={props.marker} repo={repo()} branch={branch()} />}
    >
      {(parsed) => <ParsedMarkerCard marker={props.marker} parsed={parsed} repo={repo()} branch={branch()} />}
    </Show>
  );
}

// Simple regex fallbacks for raw lines
function extractTimeFromRaw(line: string): string {
  const match = line.match(/@\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)/i);
  return match?.[1]?.trim() || '';
}

function extractTagFromRaw(line: string, tag: string): string | null {
  // Double-escape for template string → regex: \\[ becomes \[ in regex
  const regex = new RegExp(`\\[${tag}::([^\\]]+)\\]`, 'i');
  const match = line.match(regex);
  return match?.[1]?.trim() || null;
}

function extractMessageFromRaw(line: string): string {
  // Remove ctx:: prefix and tags, return remaining
  let msg = line
    .replace(/ctx::\d{4}-\d{2}-\d{2}\s*@\s*[\d:]+\s*(?:AM|PM)?/i, '')
    .replace(/\[[\w-]+\s*::[^\]]+\]/g, '')
    .replace(/"\s*,\s*"[^"\\]+\s*:/g, '')  // Remove JSON field patterns
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
