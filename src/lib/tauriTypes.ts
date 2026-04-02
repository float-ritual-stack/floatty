/**
 * tauriTypes.ts - Type-safe wrapper for Tauri invoke() calls
 *
 * This prevents stringly-typed command invocations that fail silently at runtime.
 * All Tauri commands should be defined here with their args and return types.
 */

import { invoke as tauriInvoke } from '@tauri-apps/api/core';

// ═══════════════════════════════════════════════════════════════
// SHARED TYPES (match Rust structs)
// ═══════════════════════════════════════════════════════════════

/** Parsed ctx:: marker from sidebar */
export interface ParsedCtx {
  timestamp?: string;
  time?: string;
  project?: string;
  mode?: string;
  message?: string;
}

/** Marker status from database */
export type MarkerStatus = 'pending' | 'parsing' | 'parsed' | 'failed';

/** Full ctx:: marker from database */
export interface CtxMarker {
  id: string;
  session_file: string;
  raw_line: string;
  status: MarkerStatus;
  parsed?: ParsedCtx;
  cwd?: string;
  git_branch?: string;
  session_id?: string;
  msg_type?: string;
  created_at: string;
  retry_count: number;
}

/** Marker counts by status */
export interface MarkerCounts {
  pending: number;
  parsing: number;
  parsed: number;
  failed: number;
}

/** PR info from daily note extraction */
export interface PrInfo {
  num: number;
  status: 'open' | 'merged' | 'closed';
}

/** Timelog entry from daily note */
export interface TimelogEntry {
  time: string;
  project: string | null;
  mode: string | null;
  issue: string | null;
  meeting: string | null;
  summary: string;
  details: string[];
  phases: string[];
  prs: PrInfo[];
}

/** Scattered thought from daily note */
export interface ScatteredThought {
  title: string;
  content: string;
}

/** Day statistics from daily note */
export interface DayStats {
  sessions: number;
  hours: string;
  prs: number;
}

/** Extracted daily note data from Ollama */
export interface DailyNoteData {
  date: string;
  day_of_week: string;
  stats: DayStats;
  timelogs: TimelogEntry[];
  scattered_thoughts: ScatteredThought[];
}

/** Aggregator configuration from ~/.floatty/config.toml */
export interface AggregatorConfig {
  watch_path: string;
  ollama_endpoint: string;
  ollama_model: string;
  poll_interval_ms: number;
  max_retries: number;
  max_age_hours: number;
  theme: string;
  font_size: number;
  font_weight: number;
  font_weight_bold: number;
  line_height: number;
  max_shell_output_bytes: number;
  /** Workspace name for title bar display (default: "default") */
  workspace_name: string;
  /** Server port (default: 8765) */
  server_port: number;
  /** Collapse depth when splitting outliner panes (0 = disabled) */
  split_collapse_depth?: number;
  /** Collapse depth on initial app load (0 = disabled) */
  initial_collapse_depth?: number;
  /** Show diagnostics strip in status bar (port, build type, config path) */
  show_diagnostics: boolean;
  /** Opacity of unfocused panes (0.0–1.0, default 0.7). 1.0 = no dimming. */
  unfocused_pane_opacity: number;
  /** Max children to render per block (0 = no limit). */
  child_render_limit?: number;
  /** Sidebar width in pixels (0 = default 280px). */
  sidebar_width?: number;
  /** Per-door plugin settings from [plugins.*] sections in config.toml */
  plugins?: Record<string, Record<string, unknown>>;
  /** Whether this is a dev (debug) build (runtime-only, not persisted) */
  is_dev_build: boolean;
  /** Resolved data directory path (runtime-only, not persisted) */
  data_dir: string;
}

export type VoiceSessionMode =
  | 'quick-note'
  | 'solo'
  | 'one-on-one'
  | 'group'
  | 'dump';

export type VoiceSessionStatus = 'active' | 'paused' | 'complete';

export interface VoiceEvidenceAnchor {
  chunkIndex: number;
  lineStart: number;
  lineEnd: number;
  startedAt?: string | null;
  endedAt?: string | null;
  speaker?: string | null;
}

export interface VoiceProjectionItem {
  id: string;
  text: string;
  done: boolean;
  evidence?: VoiceEvidenceAnchor[];
}

export interface VoiceProjection {
  summary?: string | null;
  keyPoints?: string[];
  decisions?: VoiceProjectionItem[];
  actionItems?: VoiceProjectionItem[];
  followUps?: VoiceProjectionItem[];
  openQuestions?: VoiceProjectionItem[];
  candidateIdeas?: VoiceProjectionItem[];
  thoughtThreads?: VoiceProjectionItem[];
}

export interface VoiceSession {
  id: string;
  title: string;
  mode: VoiceSessionMode;
  status: VoiceSessionStatus;
  sourceBlockId?: string | null;
  transcriptAttachmentName: string;
  metadataAttachmentName: string;
  transcriptPath: string;
  metadataPath: string;
  audioAttachmentName?: string | null;
  audioPath?: string | null;
  createdAt: string;
  updatedAt: string;
  transcriptChunks: number;
  transcriptLines: number;
  transcriptWords: number;
  projection: VoiceProjection;
}

// ═══════════════════════════════════════════════════════════════
// COMMAND TYPE MAP
// ═══════════════════════════════════════════════════════════════

/**
 * Map of all Tauri commands to their args and return types.
 * Add new commands here to get type checking at call sites.
 */
interface TauriCommands {
  // ─────────────────────────────────────────────────────────────
  // CTX MARKER COMMANDS
  // ─────────────────────────────────────────────────────────────
  get_ctx_markers: {
    args: { limit?: number; offset?: number };
    returns: CtxMarker[];
  };
  get_ctx_counts: {
    args: Record<string, never>;
    returns: MarkerCounts;
  };
  get_ctx_config: {
    args: Record<string, never>;
    returns: AggregatorConfig;
  };
  set_ctx_config: {
    args: { config: AggregatorConfig };
    returns: void;
  };
  clear_ctx_markers: {
    args: Record<string, never>;
    returns: void;
  };

  // ─────────────────────────────────────────────────────────────
  // DIAGNOSTICS
  // ─────────────────────────────────────────────────────────────
  toggle_diagnostics: {
    args: Record<string, never>;
    returns: boolean;
  };

  // ─────────────────────────────────────────────────────────────
  // THEME COMMANDS
  // ─────────────────────────────────────────────────────────────
  get_theme: {
    args: Record<string, never>;
    returns: string;
  };
  set_theme: {
    args: { theme: string };
    returns: void;
  };

  // ─────────────────────────────────────────────────────────────
  // SERVER INFO (for HTTP client initialization)
  // ─────────────────────────────────────────────────────────────
  get_server_info: {
    args: Record<string, never>;
    returns: { url: string; api_key: string };
  };

  // ─────────────────────────────────────────────────────────────
  // WORKSPACE PERSISTENCE
  // ─────────────────────────────────────────────────────────────
  get_workspace_state: {
    args: { key: string };
    returns: { stateJson: string; saveSeq: number } | null;
  };
  save_workspace_state: {
    args: { key: string; stateJson: string; saveSeq: number };
    returns: void;
  };
  clear_workspace: {
    args: Record<string, never>;
    returns: void;
  };

  // ─────────────────────────────────────────────────────────────
  // SHELL EXECUTION
  // ─────────────────────────────────────────────────────────────
  execute_shell_command: {
    args: { command: string };
    returns: string;
  };
  execute_ai_command: {
    args: { prompt: string };
    returns: string;
  };

  // ─────────────────────────────────────────────────────────────
  // SHELL HOOKS
  // ─────────────────────────────────────────────────────────────
  check_hooks_installed: {
    args: Record<string, never>;
    returns: boolean;
  };
  install_shell_hooks: {
    args: Record<string, never>;
    returns: void;
  };
  uninstall_shell_hooks: {
    args: Record<string, never>;
    returns: void;
  };

  // ─────────────────────────────────────────────────────────────
  // DAILY VIEW
  // ─────────────────────────────────────────────────────────────
  execute_daily_command: {
    args: { dateArg: string };
    returns: DailyNoteData;
  };

  // ─────────────────────────────────────────────────────────────
  // VOICE SESSIONS
  // ─────────────────────────────────────────────────────────────
  create_voice_session: {
    args: { mode?: VoiceSessionMode | null; title?: string; sourceBlockId?: string | null };
    returns: VoiceSession;
  };
  get_voice_session: {
    args: { sessionId: string };
    returns: VoiceSession;
  };
  list_voice_sessions: {
    args: { limit?: number };
    returns: VoiceSession[];
  };
  append_voice_transcript: {
    args: {
      sessionId: string;
      text: string;
      speaker?: string | null;
      startedAt?: string | null;
      endedAt?: string | null;
      kind?: string | null;
    };
    returns: VoiceSession;
  };
  update_voice_session_status: {
    args: {
      sessionId: string;
      status: VoiceSessionStatus;
    };
    returns: VoiceSession;
  };

  // ─────────────────────────────────────────────────────────────
  // MISC
  // ─────────────────────────────────────────────────────────────
  save_clipboard_image: {
    args: { base64: string };
    returns: string; // file path
  };
  open_url: {
    args: { url: string };
    returns: void;
  };
}

// ═══════════════════════════════════════════════════════════════
// TYPED INVOKE WRAPPER
// ═══════════════════════════════════════════════════════════════

/**
 * Type-safe invoke wrapper for Tauri commands.
 *
 * @example
 * // Type-checked args and return
 * const markers = await invoke('get_ctx_markers', { limit: 50 });
 *
 * // Error: 'unknown_command' not in TauriCommands
 * await invoke('unknown_command', {});
 *
 * // Error: wrong arg type
 * await invoke('get_ctx_markers', { limit: 'not a number' });
 */
export async function invoke<K extends keyof TauriCommands>(
  cmd: K,
  args: TauriCommands[K]['args']
): Promise<TauriCommands[K]['returns']> {
  return tauriInvoke(cmd, args);
}

/**
 * For commands with no args, allow calling without args parameter
 */
export async function invokeNoArgs<
  K extends keyof TauriCommands
>(
  cmd: K & { [P in K]: TauriCommands[P]['args'] extends Record<string, never> ? P : never }[K]
): Promise<TauriCommands[K]['returns']> {
  return tauriInvoke(cmd, {});
}
