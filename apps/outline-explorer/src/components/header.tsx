"use client";

import { Sparkles } from "lucide-react";

interface HeaderProps {
  blockCount: number;
  selectedCount: number;
  aiOpen: boolean;
  onToggleAi: () => void;
}

export function Header({
  blockCount,
  selectedCount,
  aiOpen,
  onToggleAi,
}: HeaderProps) {
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5 border-b border-border shrink-0">
      <span className="text-magenta font-bold text-[13px]">floatty</span>
      <span className="text-cyan text-[11px]">+ AI</span>
      <span className="text-dim text-[11px]">
        {blockCount.toLocaleString()} blocks
      </span>
      {selectedCount > 0 && (
        <span className="text-magenta text-[10px] bg-magenta/10 px-1.5 py-0.5 rounded-full">
          {selectedCount} sel
        </span>
      )}
      <div className="flex-1" />
      {!aiOpen && (
        <button
          onClick={onToggleAi}
          className="flex items-center gap-1 bg-magenta/10 border border-magenta/25 text-magenta px-2 py-0.5 rounded text-[10px] cursor-pointer hover:bg-magenta/20 transition-colors"
        >
          <Sparkles size={10} /> AI
        </button>
      )}
    </div>
  );
}
