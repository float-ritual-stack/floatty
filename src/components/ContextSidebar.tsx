import { useEffect, useState, useCallback } from 'react';
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

export function ContextSidebar({ visible }: { visible: boolean }) {
  const [markers, setMarkers] = useState<CtxMarker[]>([]);
  const [counts, setCounts] = useState<MarkerCounts>({ pending: 0, parsed: 0, error: 0, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch markers from backend
  const fetchMarkers = useCallback(async () => {
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
  }, []);

  // Poll for updates
  useEffect(() => {
    if (!visible) return;

    // Schedule initial fetch (not called synchronously in effect)
    const initialTimeout = setTimeout(fetchMarkers, 0);

    // Poll every 2 seconds
    const interval = setInterval(fetchMarkers, 2000);
    return () => {
      clearTimeout(initialTimeout);
      clearInterval(interval);
    };
  }, [visible, fetchMarkers]);

  if (!visible) return null;

  if (loading) {
    return (
      <div className="ctx-sidebar">
        <div className="ctx-sidebar-header">Context Stream</div>
        <div className="ctx-empty-state">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ctx-sidebar ctx-sidebar-error">
        <div className="ctx-sidebar-header">Context Stream</div>
        <div className="ctx-error-state">
          <div className="ctx-error-message">{error}</div>
          <button className="ctx-retry-button" onClick={fetchMarkers}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (markers.length === 0) {
    return (
      <div className="ctx-sidebar ctx-sidebar-empty">
        <div className="ctx-sidebar-header">Context Stream</div>
        <div className="ctx-empty-state">
          No ctx:: markers yet
          <div className="ctx-hint">
            Watching ~/.claude/projects/*.jsonl
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ctx-sidebar">
      <div className="ctx-sidebar-header">
        Context Stream ({counts.total})
        {counts.pending > 0 && (
          <span className="ctx-pending-badge">{counts.pending} parsing...</span>
        )}
      </div>
      <div className="ctx-markers-list">
        {markers.map((marker) => (
          <MarkerCard key={marker.id} marker={marker} />
        ))}
      </div>
    </div>
  );
}

function MarkerCard({ marker }: { marker: CtxMarker }) {
  const isPending = marker.status === 'pending';
  const isError = marker.status === 'error';

  // JSONL metadata (always available)
  const repo = getRepoFromCwd(marker.cwd);
  const branch = marker.git_branch;

  // For parsed markers, use the structured data
  if (marker.parsed) {
    const { time, project, mode, meeting, issue, summary, message } = marker.parsed;

    // Dedupe: skip repo badge if project matches repo name
    const showRepo = repo && (!project || !project.toLowerCase().includes(repo.toLowerCase()));

    return (
      <div className={`ctx-marker ${isPending ? 'ctx-marker-pending' : ''} ${isError ? 'ctx-marker-error' : ''}`}>
        <div className="ctx-marker-time">{time || extractTimeFromRaw(marker.raw_line)}</div>
        <div className="ctx-marker-tags">
          {showRepo && <span className={`ctx-tag ${TAG_COLORS.repo}`}>{repo}</span>}
          {branch && branch !== 'main' && <span className={`ctx-tag ${TAG_COLORS.branch}`}>{branch}</span>}
          {project && <span className={`ctx-tag ${TAG_COLORS.project}`}>{project}</span>}
          {mode && <span className={`ctx-tag ${TAG_COLORS.mode}`}>{mode}</span>}
          {meeting && <span className={`ctx-tag ${TAG_COLORS.meeting}`}>{meeting}</span>}
          {issue && <span className={`ctx-tag ${TAG_COLORS.issue}`}>{issue}</span>}
        </div>
        {summary && <div className="ctx-marker-summary">{summary}</div>}
        {message && <div className="ctx-marker-message">{message}</div>}
      </div>
    );
  }

  // For raw markers (pending/error), show simplified version
  const time = extractTimeFromRaw(marker.raw_line);
  const project = extractTagFromRaw(marker.raw_line, 'project');
  const mode = extractTagFromRaw(marker.raw_line, 'mode');

  return (
    <div className={`ctx-marker ${isPending ? 'ctx-marker-pending' : ''} ${isError ? 'ctx-marker-error' : ''}`}>
      <div className="ctx-marker-time">
        {time}
        {isPending && <span className="ctx-parsing-indicator">...</span>}
        {isError && <span className="ctx-error-indicator">!</span>}
      </div>
      <div className="ctx-marker-tags">
        {repo && <span className={`ctx-tag ${TAG_COLORS.repo}`}>{repo}</span>}
        {branch && branch !== 'main' && <span className={`ctx-tag ${TAG_COLORS.branch}`}>{branch}</span>}
        {project && <span className={`ctx-tag ${TAG_COLORS.project}`}>{project}</span>}
        {mode && <span className={`ctx-tag ${TAG_COLORS.mode}`}>{mode}</span>}
      </div>
      <div className="ctx-marker-message ctx-marker-raw">
        {extractMessageFromRaw(marker.raw_line)}
      </div>
    </div>
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
