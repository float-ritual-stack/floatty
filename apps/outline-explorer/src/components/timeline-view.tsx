"use client";

import { useEffect, useState } from "react";
import { Square, CheckSquare } from "lucide-react";
import { truncate, getProjectColor } from "@/lib/constants";
import type { SearchHit } from "@/lib/types";

function parseCtxDate(content: string): string {
  // Handle: ctx::2026-04-06, ctx:: 2026-04-06, ctx:: [[2026-04-06]]
  const m = content.match(/^ctx::\s*\[?\[?(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

interface TimelineViewProps {
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onNavigate: (id: string) => void;
}

export function TimelineView({
  selectedIds,
  onToggleSelect,
  onNavigate,
}: TimelineViewProps) {
  const [items, setItems] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/search?q=ctx%3A%3A&limit=150&include_metadata=true")
      .then((res) => res.json())
      .then((data) => setItems(data.hits))
      .catch((e) => console.error("Timeline fetch error:", e))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-4 text-muted text-[11px]">loading ctx:: timeline&hellip;</div>;
  }

  return (
    <div>
      {items.map((hit) => {
        const isSel = selectedIds.has(hit.blockId);
        const proj =
          hit.metadata?.markers?.find((m) => m.markerType === "project")?.value ?? null;
        const projColor = getProjectColor(proj);

        return (
          <div
            key={hit.blockId}
            className="flex gap-1.5 px-1.5 py-0.5 border-b border-border/5 text-[10px] hover:bg-hover transition-colors"
            style={{ borderLeftWidth: 2, borderLeftColor: projColor }}
          >
            <span
              onClick={() => onToggleSelect(hit.blockId)}
              className={`cursor-pointer ${
                isSel ? "text-magenta" : "text-dim"
              }`}
            >
              {isSel ? <CheckSquare size={9} /> : <Square size={9} />}
            </span>
            <span className="text-dim text-[9px] w-16 shrink-0">
              {parseCtxDate(hit.content ?? "")}
            </span>
            <span
              onClick={() => onNavigate(hit.blockId)}
              className="text-muted flex-1 cursor-pointer break-words"
            >
              {truncate(hit.content?.replace(/^ctx::\s*/, ""), 130)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
