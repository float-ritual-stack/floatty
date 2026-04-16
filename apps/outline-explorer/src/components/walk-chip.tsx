"use client";

import { ArrowRight } from "lucide-react";

interface WalkChipProps {
  title: string;
  onClick: () => void;
}

export function WalkChip({ title, onClick }: WalkChipProps) {
  return (
    <span
      onClick={onClick}
      className="inline-flex items-center gap-1 bg-purple/10 border border-purple/25 text-purple px-2 py-0.5 rounded text-[11px] cursor-pointer hover:bg-purple/25 hover:border-purple/40 hover:scale-[1.02] transition-all"
    >
      <ArrowRight size={10} />
      {title}
    </span>
  );
}
