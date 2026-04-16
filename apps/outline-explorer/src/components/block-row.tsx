"use client";

import { useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  Square,
  CheckSquare,
} from "lucide-react";
import { getTypeColor } from "@/lib/constants";
import { BlockContent } from "./block-content";
import type { Block } from "@/lib/types";

interface BlockRowProps {
  block: Block;
  depth: number;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onNavigate: (id: string) => void;
}

export function BlockRow({
  block,
  depth,
  selectedIds,
  onToggleSelect,
  onNavigate,
}: BlockRowProps) {
  const isSelected = selectedIds.has(block.id);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Block[] | null>(null);
  const [loading, setLoading] = useState(false);

  const hasKids = block.childIds?.length > 0;
  const typeColor = getTypeColor(block.blockType);

  async function handleExpand() {
    if (!hasKids) return;

    if (expanded) {
      setExpanded(false);
      return;
    }

    if (!children) {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/blocks/${block.id}?include=children`
        );
        if (res.ok) {
          const data = await res.json();
          setChildren(data.children ?? []);
        }
      } catch (e) {
        console.error("Failed to load children:", e);
      } finally {
        setLoading(false);
      }
    }

    setExpanded(true);
  }

  return (
    <>
      <div
        className={`flex items-start gap-1 px-1.5 py-0.5 text-[12px] leading-relaxed border-b border-border/5 hover:bg-hover transition-colors ${
          isSelected ? "bg-magenta/5" : ""
        }`}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
      >
        <span
          onClick={() => onToggleSelect(block.id)}
          className={`cursor-pointer mt-0.5 shrink-0 ${
            isSelected ? "text-magenta" : "text-dim"
          }`}
        >
          {isSelected ? <CheckSquare size={11} /> : <Square size={11} />}
        </span>
        <span
          onClick={handleExpand}
          className={`w-3 shrink-0 mt-0.5 text-dim ${
            hasKids ? "cursor-pointer" : ""
          }`}
        >
          {loading ? (
            <span className="text-[9px]">&hellip;</span>
          ) : hasKids ? (
            expanded ? (
              <ChevronDown size={11} />
            ) : (
              <ChevronRight size={11} />
            )
          ) : null}
        </span>
        <span
          className="text-[9px] w-7 shrink-0 mt-0.5 uppercase"
          style={{ color: typeColor }}
        >
          {block.blockType}
        </span>
        <span
          onClick={() => onNavigate(block.id)}
          className="flex-1 cursor-pointer break-words min-w-0"
        >
          <BlockContent block={block} truncateAt={180} />
        </span>
        <span className="text-dim text-[9px] shrink-0 mt-0.5">
          {block.id.slice(0, 6)}
        </span>
      </div>
      {expanded &&
        children?.map((child) => (
          <BlockRow
            key={child.id}
            block={child}
            depth={depth + 1}
            selectedIds={selectedIds}
            onToggleSelect={onToggleSelect}
            onNavigate={onNavigate}
          />
        ))}
    </>
  );
}
