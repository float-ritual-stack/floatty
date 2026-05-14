"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare } from "lucide-react";
import { useBlockSessions } from "@/hooks/use-block-sessions";
import type { SessionListItem } from "@/lib/sessions/types";

/**
 * Inline "N chats" badge for a block. Renders nothing when the block has no
 * associated chat sessions — zero visual cost for the vast majority of blocks.
 * Click expands a small popover listing the sessions; click a session to load
 * it into the AI panel.
 *
 * The hook's module-level cache dedupes across remounts, so scrolling a list
 * doesn't re-fetch. First page-load still fires N requests for N visible
 * rows — acceptable for now (sqlite queries are ~5ms, browser parallelizes).
 * If profiling shows this hurts, follow up with a bulk
 * `/api/sessions/blocks-with-chats` endpoint.
 */

export interface BlockChatBadgeProps {
  blockId: string;
  /** Called when the user clicks a session in the popover. */
  onLoadSession: (session: { id: string; title: string }) => void | Promise<unknown>;
}

export function BlockChatBadge({ blockId, onLoadSession }: BlockChatBadgeProps) {
  const { sessions } = useBlockSessions(blockId);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  if (sessions.length === 0) return null;

  async function pick(s: SessionListItem) {
    setOpen(false);
    await onLoadSession({ id: s.id, title: s.title });
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={`${sessions.length} chat${sessions.length === 1 ? "" : "s"} referenced this block`}
        aria-label={`${sessions.length} chats about this block`}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex items-center gap-0.5 bg-cyan/10 border border-cyan/25 text-cyan px-1 py-px rounded text-[9px] cursor-pointer hover:bg-cyan/20 transition-colors"
      >
        <MessageSquare size={9} />
        {sessions.length}
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Chats about this block"
          className="absolute right-0 top-full mt-1 w-[260px] max-h-[300px] flex flex-col bg-surface border border-border rounded shadow-lg z-50 overflow-y-auto"
        >
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={(e) => {
                e.stopPropagation();
                void pick(s);
              }}
              className="block w-full text-left bg-transparent border-none border-b border-border/20 last:border-b-0 px-2 py-1.5 cursor-pointer hover:bg-hover transition-colors"
            >
              <div className="text-text text-[11px] font-medium truncate">{s.title}</div>
              {s.preview && (
                <div className="text-dim text-[10px] truncate mt-0.5">{s.preview}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
