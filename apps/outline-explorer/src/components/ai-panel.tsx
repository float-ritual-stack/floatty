"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart, getToolName } from "ai";
import { Sparkles, X, Send, Loader, Compass, Settings, PlayCircle, RotateCcw } from "lucide-react";
import type { ExplorerUIMessage } from "@/lib/agents/explorer-agent";
import { AiActions, type AiActionWithPrompt } from "./ai-actions";
import { WalkChip } from "./walk-chip";
import { MessageBubble } from "./message-bubble";

/**
 * Session persistence wire-up:
 *
 * - On mount, fetch the most recent session (or create a new one if none exist)
 *   and hydrate `useChat` via `setMessages`. Selection changes do NOT swap the
 *   session — per the explicit-reset doctrine, only the ⟲ button creates a new
 *   session row.
 *
 * - After every assistant turn completes (status transitions back to "ready"),
 *   PATCH the session with the current message array. The server re-derives
 *   the `session_blocks` index from the messages.
 *
 * - Reset (⟲) creates a fresh session row + clears messages, so the prior
 *   thread is preserved in sqlite and surfaceable from PR 2's picker.
 */

interface AiPanelProps {
  selectedIds: string[];
  pageContextId: string | null;
  onClose: () => void;
  onNavigateToPage: (title: string) => void | Promise<unknown>;
}

export function AiPanel({
  selectedIds,
  pageContextId,
  onClose,
  onNavigateToPage,
}: AiPanelProps) {
  const [input, setInput] = useState("");
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [maxSteps, setMaxSteps] = useState(8);
  const [maxTokens, setMaxTokens] = useState(4000);
  const [streamSpec, setStreamSpec] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Session persistence — see header comment block.
  // sessionId is declared *before* the transport so we can include it in
  // every chat request via `prepareSendMessagesRequest`. The server uses it
  // to load previous messages + persist on stream finish.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        // Send only the latest user message + the session id; server loads
        // prior messages from sqlite and appends. Matches the canonical
        // `prepareSendMessagesRequest` pattern from the ai-sdk persistence
        // guide and cuts request payload to O(1) on growing threads.
        prepareSendMessagesRequest({ messages, id: chatId }) {
          const last = messages[messages.length - 1];
          const sid = sessionIdRef.current ?? chatId;
          return {
            body: sid
              ? { id: sid, message: last, maxSteps, maxTokens }
              : { messages, maxSteps, maxTokens }, // fallback: no session yet
          };
        },
      }),
    [maxSteps, maxTokens]
  );

  const { messages, sendMessage, status, setMessages } =
    useChat<ExplorerUIMessage>({ transport });

  // Auto-scroll on new content
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const noContent = !pageContextId && selectedIds.length === 0;
  const isLoading = status !== "ready";

  // Session hydrate on mount. Server-side persistence happens automatically
  // via `onFinish` in /api/chat (see ai-sdk persistence canonical pattern),
  // so the client only needs to:
  //   • load the latest session's messages and seed useChat
  //   • create a fresh session row when none exists
  //   • create a fresh row on user-triggered reset (⟲)
  // No client-side persist effect — server owns that.
  const hydrateStarted = useRef(false);

  useEffect(() => {
    if (hydrateStarted.current) return;
    hydrateStarted.current = true;

    (async () => {
      try {
        const listRes = await fetch("/api/sessions?limit=1");
        if (!listRes.ok) throw new Error(`list ${listRes.status}`);
        const { sessions } = (await listRes.json()) as {
          sessions: Array<{ id: string }>;
        };

        if (sessions.length > 0) {
          const getRes = await fetch(`/api/sessions/${sessions[0].id}`);
          if (!getRes.ok) throw new Error(`get ${getRes.status}`);
          const { session } = (await getRes.json()) as {
            session: { id: string; messages: ExplorerUIMessage[] };
          };
          setSessionId(session.id);
          setMessages(session.messages);
        } else {
          const createRes = await fetch("/api/sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              originPageId: pageContextId,
              originSelectedIds: selectedIds,
            }),
          });
          if (!createRes.ok) throw new Error(`create ${createRes.status}`);
          const { session } = (await createRes.json()) as { session: { id: string } };
          setSessionId(session.id);
        }
      } catch (err) {
        // Persistence failures should not break chat — surface to console,
        // leave sessionId null. Server route will fall back to the legacy
        // ad-hoc `{ messages }` shape when id is absent.
        console.error("[ai-panel] session hydrate failed:", err);
      }
    })();
    // Intentionally run once on mount — selection / pageContext changes should
    // NOT re-hydrate (would re-introduce the "history evaporates on
    // selection" bug at a different layer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildContextMessage(taskPrompt: string): string {
    if (pageContextId) {
      return `I'm looking at block ID "${pageContextId}" in the floatty knowledge graph.\n\nFirst, use the get_block tool with this block ID to fetch its content and subtree. Then:\n\n${taskPrompt}`;
    }
    if (selectedIds.length > 0) {
      const blockIds = selectedIds.filter((id) => !id.startsWith("page:"));
      const pageNames = selectedIds
        .filter((id) => id.startsWith("page:"))
        .map((id) => id.slice(5));

      const parts: string[] = [];
      if (blockIds.length > 0) {
        parts.push(`Use get_block to fetch these block IDs: ${blockIds.join(", ")}`);
      }
      if (pageNames.length > 0) {
        parts.push(`Use expand_page to fetch these pages: ${pageNames.map((p) => JSON.stringify(p)).join(", ")}`);
      }

      return `I've selected ${selectedIds.length} items in the floatty knowledge graph.\n\nFirst, ${parts.join(". Also, ")}.\n\nThen:\n\n${taskPrompt}`;
    }
    return taskPrompt;
  }

  function handleAction(action: AiActionWithPrompt) {
    setActiveAction(action.id);
    const msg = buildContextMessage(action.prompt);
    sendMessage({ text: msg });
  }

  function handleResetThread() {
    if (messages.length === 0) return;
    // Bail if a response is mid-stream — clearing under an in-flight write
    // would leave the UI in a contradictory state (history cleared, then new
    // streamed output appears with no preceding context).
    if (isLoading) return;
    const ok = window.confirm("Clear conversation history?");
    if (!ok) return;

    // Clear UI immediately for responsiveness; fork a new session row in
    // the background so the prior thread is preserved (surfaces in the
    // picker once PR 2 lands). Null sessionId synchronously to close the
    // race window: if the user submits another message before the POST
    // resolves, `prepareSendMessagesRequest` would otherwise read the
    // STALE id from `sessionIdRef.current` and write the new message into
    // the OLD session's history. (Greptile P2.) The chat route falls
    // back to the ad-hoc `{ messages }` shape when id is null — those
    // messages won't persist until the new session id lands, which is
    // the correct trade-off vs. mis-routing them.
    setMessages([]);
    setActiveAction(null);
    setSessionId(null);
    void (async () => {
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originPageId: pageContextId,
            originSelectedIds: selectedIds,
          }),
        });
        if (!res.ok) throw new Error(`create ${res.status}`);
        const { session } = (await res.json()) as { session: { id: string } };
        setSessionId(session.id);
      } catch (err) {
        console.error("[ai-panel] new session create failed:", err);
      }
    })();
  }

  function handleCustomSubmit() {
    if (!input.trim() || noContent) return;
    setActiveAction("custom");
    const msg = buildContextMessage(input);
    sendMessage({ text: msg });
    setInput("");
  }

  function handleWalkTo(pageTitle: string) {
    // Continue the conversation — don't reset context
    sendMessage({
      text: `Now walk to the page "${pageTitle}". Use expand_page to fetch its subtree, then continue your analysis from where you left off. What connections do you see between this page and what we were just looking at?`,
    });
  }

  // Detect if the agent hit the step limit via server-sent data part
  const hitStepLimit = useMemo(() => {
    if (status !== "ready" || messages.length === 0) return false;
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (!lastAssistant) return false;
    for (const part of lastAssistant.parts) {
      if (
        part.type === "data-step-status" &&
        typeof part.data === "object" &&
        part.data !== null &&
        "finishReason" in part.data &&
        (part.data as { finishReason: string }).finishReason === "tool-calls"
      ) {
        return true;
      }
    }
    return false;
  }, [messages, status]);

  function handleContinue() {
    sendMessage({
      text: "Continue your analysis from where you left off. You were cut off by the step limit.",
    });
  }

  // Extract walk suggestions from the latest suggest_walks tool call
  const walkSuggestions = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts) {
        if (
          isToolUIPart(part) &&
          getToolName(part) === "suggest_walks" &&
          part.state === "output-available" &&
          part.output &&
          typeof part.output === "object" &&
          "suggested" in part.output
        ) {
          return (part.output as { suggested: string[] }).suggested;
        }
      }
    }
    return [];
  }, [messages]);

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0">
        <Sparkles size={14} className="text-magenta" />
        <span className="text-magenta text-[13px] font-bold">AI</span>
        <span className="text-dim text-[10px] ml-auto">
          {noContent ? "select content" : pageContextId ? "page context" : `${selectedIds.length} selected`}
        </span>
        <button
          type="button"
          onClick={handleResetThread}
          disabled={messages.length === 0 || isLoading}
          title="Clear conversation history"
          aria-label="Clear conversation history"
          className="bg-transparent border-none text-muted cursor-pointer hover:text-text transition-colors disabled:opacity-40 disabled:cursor-default"
        >
          <RotateCcw size={12} />
        </button>
        <button
          onClick={() => setShowSettings(!showSettings)}
          className={`bg-transparent border-none cursor-pointer transition-colors ${showSettings ? "text-cyan" : "text-muted hover:text-text"}`}
        >
          <Settings size={12} />
        </button>
        <button
          onClick={onClose}
          className="bg-transparent border-none text-muted cursor-pointer hover:text-text transition-colors"
        >
          <X size={13} />
        </button>
      </div>

      {/* Settings */}
      {showSettings && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border/40 text-[10px] font-mono bg-bg">
          <label className="flex items-center gap-1 text-muted">
            steps
            <input
              type="number"
              min={1}
              max={20}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.target.value))}
              className="w-10 px-1 py-0.5 bg-surface border border-border text-text text-[10px] rounded outline-none text-center"
            />
          </label>
          <label className="flex items-center gap-1 text-muted">
            tokens
            <input
              type="number"
              min={500}
              max={16000}
              step={500}
              value={maxTokens}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
              className="w-14 px-1 py-0.5 bg-surface border border-border text-text text-[10px] rounded outline-none text-center"
            />
          </label>
          <label className="flex items-center gap-1 text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={streamSpec}
              onChange={(e) => setStreamSpec(e.target.checked)}
              className="accent-cyan"
            />
            live render
          </label>
        </div>
      )}

      {/* Actions */}
      <AiActions
        activeAction={activeAction}
        disabled={noContent || isLoading}
        onAction={handleAction}
      />

      {/* Custom question */}
      <div className="flex gap-1 p-1.5 border-b border-border/60 shrink-0">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={noContent || isLoading}
          placeholder={noContent ? "select content\u2026" : "ask anything\u2026"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim() && !noContent) {
              handleCustomSubmit();
            }
          }}
          className="flex-1 px-2 py-1 bg-bg border border-border text-text text-[11px] rounded outline-none focus:border-magenta transition-colors"
        />
        <button
          disabled={!input.trim() || noContent || isLoading}
          onClick={handleCustomSubmit}
          className="bg-magenta/15 border border-magenta/25 text-magenta px-2 py-0.5 rounded cursor-pointer disabled:opacity-40 transition-colors"
        >
          <Send size={11} />
        </button>
      </div>

      {/* Response area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2.5">
        {messages
          .filter((m) => m.role === "assistant")
          .map((msg, i, arr) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onNavigateToPage={onNavigateToPage}
              isStreaming={isLoading && i === arr.length - 1}
              streamSpec={streamSpec}
            />
          ))}

        {isLoading && (
          <div className="flex items-center gap-2 text-magenta text-[12px] p-2">
            <Loader size={14} className="animate-spin-slow" />
            thinking&hellip;
          </div>
        )}

        {/* Step limit reached — continue button */}
        {hitStepLimit && !isLoading && (
          <button
            onClick={handleContinue}
            className="flex items-center gap-1.5 w-full px-3 py-2 mt-2 bg-amber/8 border border-amber/20 text-amber text-[11px] font-mono rounded cursor-pointer hover:bg-amber/15 transition-colors"
          >
            <PlayCircle size={13} />
            reached max steps — click to continue
          </button>
        )}

        {/* Walk suggestions */}
        {walkSuggestions.length > 0 && !isLoading && (
          <div className="mt-4 pt-3 border-t border-border/40">
            <div className="text-dim text-[10px] uppercase tracking-wider mb-2 flex items-center gap-1">
              <Compass size={10} /> walk next
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {walkSuggestions.map((w) => (
                <WalkChip
                  key={w}
                  title={w}
                  onClick={() => handleWalkTo(w)}
                />
              ))}
            </div>
          </div>
        )}

        {messages.length === 0 && !isLoading && (
          <div className="text-dim text-[11px] text-center mt-10">
            {noContent
              ? "browse + select, or click \u2728 on a page"
              : "pick an action or ask a question"}
          </div>
        )}
      </div>
    </div>
  );
}
