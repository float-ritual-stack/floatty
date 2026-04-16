"use client";

import { ArrowLeft, Sparkles, AlertTriangle } from "lucide-react";
import { useBlock } from "@/hooks/use-block";
import { BlockRow } from "./block-row";
import { BlockContent } from "./block-content";
import { getTypeColor } from "@/lib/constants";

interface BlockFocusProps {
  blockId: string;
  selectedIds: Set<string>;
  onBack: () => void;
  onAnalyze: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onNavigate: (id: string) => void;
  onNavigateToPage: (title: string) => void | Promise<unknown>;
}

export function BlockFocus({
  blockId,
  selectedIds,
  onBack,
  onAnalyze,
  onToggleSelect,
  onNavigate,
  onNavigateToPage,
}: BlockFocusProps) {
  const { block, loading, error } = useBlock(blockId, ["children", "ancestors"]);

  if (loading) {
    return (
      <div className="p-4 text-muted text-[11px]">loading block&hellip;</div>
    );
  }

  if (error) {
    return (
      <div className="p-4 flex items-start gap-2 text-coral text-[11px]">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  if (!block) {
    return (
      <div className="p-4 text-muted text-[11px]">block not found</div>
    );
  }

  const typeColor = getTypeColor(block.blockType);
  const outlinks = block.metadata?.outlinks ?? [];

  return (
    <div>
      <div className="flex gap-1 items-center p-1.5 border-b border-border">
        <button
          onClick={onBack}
          className="flex items-center gap-1 bg-transparent border border-border text-muted px-1.5 py-0.5 rounded text-[10px] cursor-pointer hover:text-text transition-colors"
        >
          <ArrowLeft size={9} /> back
        </button>
        <button
          onClick={() => onAnalyze(blockId)}
          className="flex items-center gap-1 bg-magenta/10 border border-magenta/25 text-magenta px-1.5 py-0.5 rounded text-[10px] cursor-pointer hover:bg-magenta/20 transition-colors"
        >
          <Sparkles size={9} /> analyze
        </button>
      </div>

      {/* Block detail */}
      <div
        className="p-2 bg-surface border-b border-border"
        style={{ borderLeftWidth: 3, borderLeftColor: typeColor }}
      >
        <div className="max-h-[150px] overflow-auto">
          <BlockContent block={block} />
        </div>
        {outlinks.length > 0 && (
          <div className="mt-1 flex gap-1 flex-wrap">
            {outlinks.map((l) => (
              <span
                key={l}
                onClick={() => onNavigateToPage(l)}
                className="bg-cyan/10 text-cyan px-1.5 py-0.5 rounded text-[9px] cursor-pointer hover:bg-cyan/20 transition-colors"
              >
                [[{l}]]
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Children */}
      {block.children?.map((child) => (
        <BlockRow
          key={child.id}
          block={child}
          depth={0}
          selectedIds={selectedIds}
          onToggleSelect={onToggleSelect}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
