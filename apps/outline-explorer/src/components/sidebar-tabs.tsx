"use client";

import { FileText, Search, Clock } from "lucide-react";
import type { ViewMode } from "@/lib/types";

interface SidebarTabsProps {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  pageCount: number;
  ctxCount: number;
}

const tabs: { id: ViewMode; icon: typeof FileText; label: string }[] = [
  { id: "pages", icon: FileText, label: "Pages" },
  { id: "search", icon: Search, label: "Search" },
  { id: "timeline", icon: Clock, label: "Ctx" },
];

export function SidebarTabs({
  view,
  onViewChange,
  pageCount,
  ctxCount,
}: SidebarTabsProps) {
  return (
    <div className="flex border-b border-border px-1.5 shrink-0">
      {tabs.map((t) => {
        const Icon = t.icon;
        const active = view === t.id;
        const count =
          t.id === "pages" ? pageCount : t.id === "timeline" ? ctxCount : null;
        return (
          <button
            key={t.id}
            onClick={() => onViewChange(t.id)}
            className={`flex items-center gap-1 px-2 py-1.5 text-[10px] border-b-2 bg-transparent cursor-pointer transition-colors ${
              active
                ? "border-cyan text-cyan"
                : "border-transparent text-muted hover:text-text"
            }`}
          >
            <Icon size={11} />
            {t.label}
            {count != null && (
              <span className="text-dim text-[9px]">({count})</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
