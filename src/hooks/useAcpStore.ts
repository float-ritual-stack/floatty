/**
 * ACP (Agent Client Protocol) store
 *
 * Per-pane state management for ACP agent sessions.
 * Each ACP pane has its own session with an agent subprocess.
 */

import { createSignal, createMemo } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { invoke } from '@tauri-apps/api/core';
import { Channel } from '@tauri-apps/api/core';
import type {
  AcpUpdate,
  AcpConnectionState,
  AcpMessage,
  AcpToolCallDisplay,
  AcpPlanEntry,
  AcpPermissionOption,
  AcpAgentConfig,
} from '../lib/acpTypes';

// ---------------------------------------------------------------------------
// Per-pane session state
// ---------------------------------------------------------------------------

interface AcpSessionState {
  /** Pane-local session ID (returned by Rust) */
  sessionId: string | null;
  /** Connection state */
  connectionState: AcpConnectionState;
  /** Chat messages (user + agent) */
  messages: AcpMessage[];
  /** Currently streaming agent message text */
  streamingText: string;
  /** Active tool calls */
  toolCalls: AcpToolCallDisplay[];
  /** Current plan entries */
  plan: AcpPlanEntry[];
  /** Pending permission request */
  permissionRequest: {
    requestId: string;
    toolCallId: string;
    title: string;
    options: AcpPermissionOption[];
  } | null;
  /** Whether a prompt is currently being processed */
  isPrompting: boolean;
}

function createInitialState(): AcpSessionState {
  return {
    sessionId: null,
    connectionState: 'disconnected',
    messages: [],
    streamingText: '',
    toolCalls: [],
    plan: [],
    permissionRequest: null,
    isPrompting: false,
  };
}

const MAX_MESSAGES = 500;

// ---------------------------------------------------------------------------
// Store factory — one per ACP pane
// ---------------------------------------------------------------------------

export function createAcpSession(paneId: string) {
  const [state, setState] = createStore<AcpSessionState>(createInitialState());
  let nextMessageId = 0;

  /** Start an ACP agent session */
  async function spawnAgent(config: AcpAgentConfig): Promise<void> {
    // Create Tauri Channel for streaming updates
    const onUpdate = new Channel<AcpUpdate>();
    onUpdate.onmessage = (update: AcpUpdate) => handleUpdate(update);

    try {
      const sessionId = await invoke<string>('acp_spawn_agent', {
        config,
        onUpdate,
      });
      setState('sessionId', sessionId);
      console.log(`[ACP] Session ${sessionId} started for pane ${paneId}`);
    } catch (err) {
      console.error(`[ACP] Failed to spawn agent:`, err);
      setState('connectionState', { error: String(err) });
    }
  }

  /** Send a text prompt to the agent */
  async function sendPrompt(text: string): Promise<void> {
    if (!state.sessionId) {
      console.warn('[ACP] Cannot send prompt: no session');
      return;
    }
    if (state.isPrompting) {
      console.warn('[ACP] Cannot send prompt: already prompting');
      return;
    }

    // Add user message
    const userMsg: AcpMessage = {
      id: `msg-${++nextMessageId}`,
      role: 'user',
      text,
      timestamp: Date.now(),
    };
    setState(produce(s => {
      s.messages.push(userMsg);
      if (s.messages.length > MAX_MESSAGES) {
        s.messages = s.messages.slice(-MAX_MESSAGES);
      }
      s.isPrompting = true;
      s.streamingText = '';
      s.toolCalls = [];
      s.plan = [];
    }));

    try {
      await invoke('acp_send_prompt', {
        sessionId: state.sessionId,
        text,
      });
    } catch (err) {
      console.error(`[ACP] Failed to send prompt:`, err);
      setState('isPrompting', false);
    }
  }

  /** Cancel the current prompt */
  async function cancelPrompt(): Promise<void> {
    if (!state.sessionId) return;
    try {
      await invoke('acp_cancel_prompt', { sessionId: state.sessionId });
    } catch (err) {
      console.error(`[ACP] Failed to cancel:`, err);
    }
  }

  /** Respond to a permission request */
  async function respondPermission(optionId: string): Promise<void> {
    if (!state.sessionId || !state.permissionRequest) return;
    try {
      await invoke('acp_respond_permission', {
        sessionId: state.sessionId,
        requestId: state.permissionRequest.requestId,
        optionId,
      });
      setState('permissionRequest', null);
    } catch (err) {
      console.error(`[ACP] Failed to respond to permission:`, err);
    }
  }

  /** Kill the session (called on pane close) */
  async function killSession(): Promise<void> {
    if (!state.sessionId) return;
    try {
      await invoke('acp_kill_session', { sessionId: state.sessionId });
    } catch (err) {
      console.error(`[ACP] Failed to kill session:`, err);
    }
    setState(createInitialState());
  }

  /** Handle a streamed update from the agent */
  function handleUpdate(update: AcpUpdate): void {
    switch (update.type) {
      case 'connectionState':
        setState('connectionState', update.state);
        break;

      case 'messageChunk':
        setState('streamingText', prev => prev + update.text);
        break;

      case 'thoughtChunk':
        // Could display in a collapsed "thinking" section
        break;

      case 'toolCall':
        setState(produce(s => {
          s.toolCalls.push({
            toolCallId: update.toolCallId,
            title: update.title,
            status: update.status,
            kind: update.kind,
          });
        }));
        break;

      case 'toolCallUpdate':
        setState(produce(s => {
          const tc = s.toolCalls.find(t => t.toolCallId === update.toolCallId);
          if (tc) {
            tc.status = update.status;
            if (update.contentText) {
              tc.contentText = update.contentText;
            }
          }
        }));
        break;

      case 'plan':
        setState('plan', update.entries);
        break;

      case 'permissionRequest':
        setState('permissionRequest', {
          requestId: update.requestId,
          toolCallId: update.toolCallId,
          title: update.title,
          options: update.options,
        });
        break;

      case 'promptComplete': {
        // Flush streaming text to a message
        const text = state.streamingText;
        if (text) {
          const agentMsg: AcpMessage = {
            id: `msg-${++nextMessageId}`,
            role: 'agent',
            text,
            timestamp: Date.now(),
          };
          setState(produce(s => {
            s.messages.push(agentMsg);
            if (s.messages.length > MAX_MESSAGES) {
              s.messages = s.messages.slice(-MAX_MESSAGES);
            }
          }));
        }
        setState('streamingText', '');
        setState('isPrompting', false);
        break;
      }

      case 'processExited':
        setState('connectionState', 'disconnected');
        setState('isPrompting', false);
        console.log(`[ACP] Agent exited with code: ${update.exitCode}`);
        break;
    }
  }

  // Derived state
  const isConnected = createMemo(() => state.connectionState === 'connected');
  const connectionError = createMemo(() => {
    const cs = state.connectionState;
    if (typeof cs === 'object' && 'error' in cs) return cs.error;
    return null;
  });

  return {
    state,
    spawnAgent,
    sendPrompt,
    cancelPrompt,
    respondPermission,
    killSession,
    isConnected,
    connectionError,
  };
}

export type AcpSession = ReturnType<typeof createAcpSession>;
