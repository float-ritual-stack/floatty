"use client";

import { Square, CheckSquare, Sparkles } from "lucide-react";
import { truncate } from "@/lib/constants";
import type { PageListItem } from "@/lib/types";

interface PagesViewProps {
  pages: PageListItem[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onAnalyze: (id: string) => void;
  onNavigateToPage: (title: string) => void | Promise<unknown>;
}

export function PagesView({
  pages,
  selectedIds,
  onToggleSelect,
  onAnalyze,
  onNavigateToPage,
}: PagesViewProps) {
  return (
    <div>
      {pages.map((pg, idx) => {
        const fallbackKey = `${pg.name}-${idx}`;
        const selectKey = pg.blockId ?? `page:${fallbackKey}`;
        const isSel = selectedIds.has(selectKey);
        return (
          <div
            key={pg.blockId ?? fallbackKey}
            className="flex items-center gap-1.5 px-1.5 py-1 border-b border-border/5 text-[11px] hover:bg-hover transition-colors"
          >
            <span
              onClick={() => onToggleSelect(selectKey)}
              className={`cursor-pointer ${
                isSel ? "text-magenta" : "text-dim"
              }`}
            >
              {isSel ? <CheckSquare size={10} /> : <Square size={10} />}
            </span>
            <span
              onClick={() => onNavigateToPage(pg.name)}
              className="text-text flex-1 cursor-pointer"
            >
              {truncate(pg.name, 50)}
            </span>
            <span
              onClick={() => {
                if (pg.blockId) {
                  onAnalyze(pg.blockId);
                } else {
                  onNavigateToPage(pg.name);
                }
              }}
              className="text-magenta cursor-pointer opacity-50 hover:opacity-100 shrink-0 transition-opacity"
            >
              <Sparkles size={10} />
            </span>
            <span className="text-dim text-[9px] w-7 text-right">
              {pg.blockCount || ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
