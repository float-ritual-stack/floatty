"use client";

import { User } from "lucide-react";
import type { ExplorerUIMessage } from "@/lib/agents/explorer-agent";

/**
 * Renders a user message in the chat log. Strips the contextual preamble
 * baked in by `buildContextMessage` (everything before the last "Then:\n\n"
 * marker) so the display shows the user's actual prompt instead of the
 * "I'm looking at block ID ..." wrapper, which is mechanically identical
 * across every turn for the same block.
 *
 * If there's no preamble marker (custom-question path), the full text
 * renders unchanged.
 */

interface UserMessageBubbleProps {
  message: ExplorerUIMessage;
}

export function UserMessageBubble({ message }: UserMessageBubbleProps) {
  const parts = (message as { parts?: Array<{ type: string; text?: string }> }).parts;
  if (!Array.isArray(parts)) return null;

  const text = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => stripPreamble(p.text ?? ""))
    .filter(Boolean)
    .join("\n\n");

  if (!text) return null;

  return (
    <div className="mb-3 flex gap-2">
      <span className="text-cyan/70 shrink-0 mt-0.5">
        <User size={11} />
      </span>
      <div className="flex-1 min-w-0 text-text/85 text-[11px] whitespace-pre-wrap break-words">
        {text}
      </div>
    </div>
  );
}

function stripPreamble(raw: string): string {
  const marker = "Then:\n\n";
  const idx = raw.lastIndexOf(marker);
  return idx >= 0 ? raw.slice(idx + marker.length).trim() : raw.trim();
}
