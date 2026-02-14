/**
 * AcpPane - ACP (Agent Client Protocol) agent interaction pane
 *
 * Displays an AI coding agent session with streaming messages, tool calls,
 * plan entries, and permission dialogs. Communicates with agents (Claude Code,
 * Gemini CLI, etc.) via ACP over Tauri IPC.
 *
 * Follows the same absolute-positioned overlay pattern as TerminalPane and OutlinerPane.
 */

import { createSignal, createEffect, onMount, onCleanup, Show, For } from 'solid-js';
import type { PaneHandle } from '../lib/layoutTypes';
import { createAcpSession } from '../hooks/useAcpStore';
import type { AcpAgentConfig } from '../lib/acpTypes';

export interface AcpPaneProps {
  id: string;
  placeholderId: string;
  cwd?: string;
  isActive?: boolean;
  isVisible?: boolean;
  onPaneClick?: () => void;
  onDragHandlePointerDown?: (e: PointerEvent) => void;
  isBeingDragged?: boolean;
  ref?: (handle: PaneHandle) => void;
}

export function AcpPane(props: AcpPaneProps) {
  let containerRef: HTMLDivElement | undefined;
  let scrollRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;

  const [rect, setRect] = createSignal({ top: 0, left: 0, width: 0, height: 0 });
  const [inputText, setInputText] = createSignal('');
  const [agentCommand, setAgentCommand] = createSignal('claude');
  const [agentArgs, setAgentArgs] = createSignal('--acp');

  const session = createAcpSession(props.id);

  // ---------------------------------------------------------------------------
  // Position tracking (same pattern as OutlinerPane)
  // ---------------------------------------------------------------------------

  const updatePosition = () => {
    const placeholder = document.querySelector(`[data-pane-id="${props.placeholderId}"]`);
    if (!placeholder || !containerRef) return;

    const pRect = placeholder.getBoundingClientRect();
    const parent = containerRef.parentElement;
    if (!parent) return;

    const parentRect = parent.getBoundingClientRect();
    setRect({
      top: pRect.top - parentRect.top,
      left: pRect.left - parentRect.left,
      width: pRect.width,
      height: pRect.height,
    });
  };

  onMount(() => {
    // Expose imperative handle for parent
    const handle: PaneHandle = {
      focus: () => inputRef?.focus(),
      fit: () => updatePosition(),
      refresh: () => updatePosition(),
    };
    props.ref?.(handle);
    updatePosition();

    // Observe placeholder for geometry changes
    const placeholder = document.querySelector(`[data-pane-id="${props.placeholderId}"]`);
    if (placeholder) {
      const observer = new ResizeObserver(() => updatePosition());
      observer.observe(placeholder);
      onCleanup(() => observer.disconnect());
    }

    // Window resize
    const onResize = () => updatePosition();
    window.addEventListener('resize', onResize);
    onCleanup(() => window.removeEventListener('resize', onResize));
  });

  // Visibility effect
  createEffect(() => {
    if (props.isVisible) {
      const frameId = requestAnimationFrame(() => updatePosition());
      onCleanup(() => cancelAnimationFrame(frameId));
    }
  });

  // Auto-scroll on new content
  createEffect(() => {
    // Track dependencies
    session.state.messages.length;
    session.state.streamingText;
    session.state.toolCalls.length;

    if (scrollRef) {
      requestAnimationFrame(() => {
        if (scrollRef) {
          scrollRef.scrollTop = scrollRef.scrollHeight;
        }
      });
    }
  });

  // Kill session on cleanup
  onCleanup(() => {
    session.killSession();
  });

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleConnect = async () => {
    const config: AcpAgentConfig = {
      command: agentCommand(),
      args: agentArgs().split(/\s+/).filter(Boolean),
      cwd: props.cwd || undefined,
    };
    await session.spawnAgent(config);
  };

  const handleSend = async () => {
    const text = inputText().trim();
    if (!text) return;
    setInputText('');
    await session.sendPrompt(text);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={containerRef}
      class="terminal-pane-positioned acp-pane"
      style={{
        position: 'absolute',
        top: `${rect().top}px`,
        left: `${rect().left}px`,
        width: `${rect().width}px`,
        height: `${rect().height}px`,
        display: (props.isVisible ?? true) ? 'flex' : 'none',
        'flex-direction': 'column',
        overflow: 'hidden',
      }}
      classList={{
        'pane-being-dragged': props.isBeingDragged,
      }}
      onClick={props.onPaneClick}
    >
      {/* Drag handle */}
      <div
        class="pane-drag-handle"
        onPointerDown={props.onDragHandlePointerDown}
      >
        &#x22EE;&#x22EE;
      </div>

      {/* Connection bar (shown when disconnected) */}
      <Show when={session.state.connectionState === 'disconnected'}>
        <div class="acp-connect-bar">
          <input
            type="text"
            class="acp-connect-input"
            value={agentCommand()}
            onInput={(e) => setAgentCommand(e.currentTarget.value)}
            placeholder="Agent command (e.g. claude)"
          />
          <input
            type="text"
            class="acp-connect-input"
            value={agentArgs()}
            onInput={(e) => setAgentArgs(e.currentTarget.value)}
            placeholder="Args (e.g. --acp)"
          />
          <button class="acp-connect-btn" onClick={handleConnect}>
            Connect
          </button>
        </div>
      </Show>

      {/* Connection status */}
      <Show when={session.state.connectionState === 'connecting'}>
        <div class="acp-status-bar acp-status-connecting">
          Connecting to {agentCommand()}...
        </div>
      </Show>

      <Show when={session.connectionError()}>
        <div class="acp-status-bar acp-status-error">
          Error: {session.connectionError()}
        </div>
      </Show>

      {/* Messages area */}
      <div ref={scrollRef} class="acp-messages">
        <For each={session.state.messages}>
          {(msg) => (
            <div class={`acp-message acp-message-${msg.role}`}>
              <span class="acp-message-role">
                {msg.role === 'user' ? 'You' : 'Agent'}
              </span>
              <div class="acp-message-text">{msg.text}</div>
            </div>
          )}
        </For>

        {/* Streaming text */}
        <Show when={session.state.streamingText}>
          <div class="acp-message acp-message-agent acp-message-streaming">
            <span class="acp-message-role">Agent</span>
            <div class="acp-message-text">{session.state.streamingText}</div>
          </div>
        </Show>

        {/* Tool calls */}
        <For each={session.state.toolCalls}>
          {(tc) => (
            <div class="acp-tool-call" classList={{ 'acp-tool-completed': tc.status === 'completed' }}>
              <span class="acp-tool-icon">
                {tc.kind === 'read' ? '>' : tc.kind === 'edit' ? '*' : '#'}
              </span>
              <span class="acp-tool-title">{tc.title}</span>
              <span class="acp-tool-status">{tc.status}</span>
              <Show when={tc.contentText}>
                <pre class="acp-tool-content">{tc.contentText}</pre>
              </Show>
            </div>
          )}
        </For>

        {/* Plan */}
        <Show when={session.state.plan.length > 0}>
          <div class="acp-plan">
            <div class="acp-plan-header">Plan</div>
            <For each={session.state.plan}>
              {(entry) => (
                <div class="acp-plan-entry" classList={{
                  'acp-plan-pending': entry.status === 'pending',
                  'acp-plan-progress': entry.status === 'in_progress',
                  'acp-plan-done': entry.status === 'completed',
                }}>
                  <span class="acp-plan-indicator">
                    {entry.status === 'completed' ? '[x]' : entry.status === 'in_progress' ? '[~]' : '[ ]'}
                  </span>
                  {entry.title}
                </div>
              )}
            </For>
          </div>
        </Show>

        {/* Permission request */}
        <Show when={session.state.permissionRequest}>
          {(req) => (
            <div class="acp-permission">
              <div class="acp-permission-title">{req().title}</div>
              <div class="acp-permission-options">
                <For each={req().options}>
                  {(opt) => (
                    <button
                      class="acp-permission-btn"
                      classList={{
                        'acp-permission-allow': opt.kind.startsWith('allow'),
                        'acp-permission-reject': opt.kind.startsWith('reject'),
                      }}
                      onClick={() => session.respondPermission(opt.optionId)}
                    >
                      {opt.name}
                    </button>
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
      </div>

      {/* Input area */}
      <Show when={session.isConnected()}>
        <div class="acp-input-area">
          <textarea
            ref={inputRef}
            class="acp-input"
            value={inputText()}
            onInput={(e) => setInputText(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={session.state.isPrompting ? 'Agent is working...' : 'Send a message...'}
            disabled={session.state.isPrompting}
            rows={2}
          />
          <Show when={session.state.isPrompting}>
            <button class="acp-cancel-btn" onClick={() => session.cancelPrompt()}>
              Cancel
            </button>
          </Show>
          <Show when={!session.state.isPrompting}>
            <button class="acp-send-btn" onClick={handleSend} disabled={!inputText().trim()}>
              Send
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
