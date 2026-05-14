"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { History, Search, X, Loader, Check } from "lucide-react";
import type { SessionListItem } from "@/lib/sessions/types";

/**
 * Compact header dropdown listing recent chat sessions. Click a row to load
 * it into the panel; inline rename via the title button; hover-X to delete
 * with confirm. Search box filters titles + previews.
 *
 * No popover library — hand-rolled positioned div anchored to a trigger
 * button. Outside-click + Escape close. State is local to the picker;
 * loading + applying a session is delegated up via `onLoad`.
 */

export interface SessionPickerProps {
  /** Currently active session id (used to mark the row + disable delete). */
  activeSessionId: string | null;
  /** Disable the trigger while a stream is in flight. */
  disabled?: boolean;
  /** Called when the user picks a session — caller hydrates useChat. */
  onLoad: (session: { id: string; title: string }) => void | Promise<unknown>;
}

export function SessionPicker({ activeSessionId, disabled, onLoad }: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Defers single-click load so a double-click (which fires after two
  // clicks) can cancel it and route to inline rename instead. The browser
  // always fires the second `click` before `dblclick`, so without this the
  // rename path is silently unreachable. (Greptile P1.)
  const clickTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelDeferredLoad() {
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current);
      clickTimeoutRef.current = null;
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions?limit=50");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { sessions: SessionListItem[] };
      setSessions(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh whenever the picker opens — sessions update server-side via
  // chat completions, so a stale list is the common case.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // Outside-click + Escape close.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filtered = sessions.filter((s) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    // Defensive: preview is typed as string but the server can emit empty.
    // Guard for null/undefined to match the runtime-shape assumption already
    // visible in the JSX (`{s.preview && ...}`). (Greptile P1.)
    return (
      s.title.toLowerCase().includes(q) ||
      (s.preview ?? "").toLowerCase().includes(q)
    );
  });

  async function handleLoad(s: SessionListItem) {
    if (s.id === activeSessionId) {
      setOpen(false);
      return;
    }
    setPendingId(s.id);
    try {
      await onLoad({ id: s.id, title: s.title });
      setOpen(false);
    } finally {
      setPendingId(null);
    }
  }

  function handleRowClick(s: SessionListItem) {
    // Defer the load so a follow-up double-click can cancel and route to
    // rename. 220ms is a common dblclick threshold (browser default sits
    // around 250-500ms but the OS event delivery is usually well under).
    cancelDeferredLoad();
    clickTimeoutRef.current = setTimeout(() => {
      clickTimeoutRef.current = null;
      void handleLoad(s);
    }, 220);
  }

  function startEdit(s: SessionListItem) {
    cancelDeferredLoad();
    setEditingId(s.id);
    setEditValue(s.title);
  }

  async function commitEdit(s: SessionListItem) {
    const next = editValue.trim();
    setEditingId(null);
    if (!next || next === s.title) return;
    try {
      const res = await fetch(`/api/sessions/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSessions((prev) => prev.map((row) => (row.id === s.id ? { ...row, title: next } : row)));
    } catch (err) {
      console.error("[session-picker] rename failed:", err);
    }
  }

  async function handleDelete(s: SessionListItem) {
    if (s.id === activeSessionId) return;
    const ok = window.confirm(`Delete session "${s.title}"?`);
    if (!ok) return;
    try {
      const res = await fetch(`/api/sessions/${s.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSessions((prev) => prev.filter((row) => row.id !== s.id));
    } catch (err) {
      console.error("[session-picker] delete failed:", err);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Session history"
        aria-label="Open session history"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="bg-transparent border-none text-muted cursor-pointer hover:text-text transition-colors disabled:opacity-40 disabled:cursor-default"
      >
        <History size={12} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Session history"
          className="absolute right-0 top-full mt-1 w-[340px] max-h-[420px] flex flex-col bg-surface border border-border rounded shadow-lg z-50 overflow-hidden"
        >
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/40">
            <Search size={11} className="text-dim shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search sessions…"
              className="flex-1 bg-transparent text-text text-[11px] outline-none"
            />
            <span className="text-dim text-[10px] font-mono">
              {filtered.length}/{sessions.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto">
            {loading && sessions.length === 0 && (
              <div className="flex items-center gap-2 text-dim text-[11px] p-3">
                <Loader size={11} className="animate-spin-slow" /> loading…
              </div>
            )}
            {error && (
              <div className="text-coral text-[11px] p-3">load failed: {error}</div>
            )}
            {!loading && !error && filtered.length === 0 && (
              <div className="text-dim text-[11px] p-3 text-center">
                {sessions.length === 0 ? "no sessions yet" : "no matches"}
              </div>
            )}
            {filtered.map((s) => {
              const isActive = s.id === activeSessionId;
              const isEditing = editingId === s.id;
              const isPending = pendingId === s.id;
              return (
                <div
                  key={s.id}
                  role="option"
                  aria-selected={isActive}
                  className={`group flex items-start gap-1.5 px-2 py-1.5 border-b border-border/20 text-[11px] ${
                    isActive ? "bg-cyan/10" : "hover:bg-hover"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onBlur={() => commitEdit(s)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(s);
                          else if (e.key === "Escape") setEditingId(null);
                        }}
                        className="w-full bg-bg border border-cyan/40 rounded px-1 py-0.5 text-text text-[11px] outline-none"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleRowClick(s)}
                        onDoubleClick={(e) => {
                          e.preventDefault();
                          startEdit(s);
                        }}
                        disabled={isPending}
                        className={`block w-full text-left bg-transparent border-none p-0 cursor-pointer text-text font-medium truncate ${
                          isActive ? "text-cyan" : ""
                        }`}
                      >
                        {isActive && <Check size={10} className="inline mr-1 text-cyan" />}
                        {s.title}
                      </button>
                    )}
                    {s.preview && !isEditing && (
                      <div className="text-dim text-[10px] truncate mt-0.5">
                        {s.preview}
                      </div>
                    )}
                  </div>
                  <span className="text-dim text-[9px] font-mono shrink-0 mt-0.5">
                    {formatRelative(s.updatedAt)}
                  </span>
                  {!isActive && !isEditing && (
                    <button
                      type="button"
                      onClick={() => handleDelete(s)}
                      title="Delete session"
                      aria-label={`Delete session ${s.title}`}
                      className="opacity-0 group-hover:opacity-100 bg-transparent border-none text-muted hover:text-coral cursor-pointer transition-opacity shrink-0"
                    >
                      <X size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function formatRelative(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}
