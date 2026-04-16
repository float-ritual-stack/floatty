"use client";

import { useState } from "react";
import { Square, CheckSquare } from "lucide-react";
import { truncate, getTypeColor } from "@/lib/constants";
import { useSearch } from "@/hooks/use-search";

interface SearchViewProps {
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onNavigate: (id: string) => void;
}

export function SearchView({
  selectedIds,
  onToggleSelect,
  onNavigate,
}: SearchViewProps) {
  const [query, setQuery] = useState("");
  const { results, total, loading } = useSearch(query);

  return (
    <div>
      <div className="p-1.5 border-b border-border">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search blocks\u2026"
          className="w-full px-2 py-1 bg-bg border border-border text-text text-[11px] rounded outline-none focus:border-cyan transition-colors"
        />
      </div>
      {query.length >= 2 && (
        <div className="px-1.5 py-0.5 text-dim text-[9px]">
          {loading ? "searching\u2026" : `${total} results`}
        </div>
      )}
      {results.map((h) => {
        const isSel = selectedIds.has(h.blockId);
        return (
          <div
            key={h.blockId}
            className="flex gap-1 px-1.5 py-0.5 border-b border-border/5 text-[11px] hover:bg-hover transition-colors"
          >
            <span
              onClick={() => onToggleSelect(h.blockId)}
              className={`cursor-pointer mt-0.5 ${
                isSel ? "text-magenta" : "text-dim"
              }`}
            >
              {isSel ? <CheckSquare size={10} /> : <Square size={10} />}
            </span>
            {h.blockType && (
              <span
                className="text-[8px] w-6 mt-0.5 uppercase shrink-0"
                style={{ color: getTypeColor(h.blockType) }}
              >
                {h.blockType}
              </span>
            )}
            <span
              onClick={() => onNavigate(h.blockId)}
              className="text-text flex-1 cursor-pointer break-words"
            >
              {truncate(h.content, 200)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
