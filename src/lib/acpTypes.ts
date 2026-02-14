/**
 * ACP (Agent Client Protocol) types for frontend
 *
 * These mirror the Rust types in services/acp.rs, received via Tauri Channel.
 */

/** Connection state for an ACP agent */
export type AcpConnectionState =
  | 'connecting'
  | 'connected'
  | { error: string }
  | 'disconnected';

/** A streamed update from the agent, received via Tauri Channel */
export type AcpUpdate =
  | { type: 'connectionState'; state: AcpConnectionState }
  | { type: 'messageChunk'; text: string }
  | { type: 'thoughtChunk'; text: string }
  | { type: 'toolCall'; toolCallId: string; title: string; status: string; kind?: string }
  | { type: 'toolCallUpdate'; toolCallId: string; status: string; contentText?: string }
  | { type: 'plan'; entries: AcpPlanEntry[] }
  | { type: 'permissionRequest'; requestId: string; toolCallId: string; title: string; options: AcpPermissionOption[] }
  | { type: 'promptComplete'; stopReason: string }
  | { type: 'processExited'; exitCode?: number };

export interface AcpPlanEntry {
  title: string;
  status: string; // 'pending' | 'in_progress' | 'completed'
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string; // 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

/** Configuration for spawning an ACP agent */
export interface AcpAgentConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

/** A rendered message in the ACP pane */
export interface AcpMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
}

/** A tool call displayed in the ACP pane */
export interface AcpToolCallDisplay {
  toolCallId: string;
  title: string;
  status: string;
  kind?: string;
  contentText?: string;
}
