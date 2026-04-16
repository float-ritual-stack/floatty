"use client";

import { colors } from "@/lib/constants";

const toolColors: Record<string, string> = {
  expand_page: colors.cyan,
  search_blocks: colors.amber,
  get_inbound: colors.purple,
  suggest_walks: colors.green,
  get_block: colors.green,
  qmd_search: colors.coral,
};

function formatOutput(output: unknown): string {
  if (typeof output !== "object" || output === null) return "done";
  const o = output as Record<string, unknown>;
  if ("error" in o) return `error: ${String(o.error).slice(0, 60)}`;
  if ("hits" in o && Array.isArray(o.hits) && o.hits.length > 0)
    return `${o.hits.length} docs`;
  if ("total" in o) return `${o.total} results`;
  if ("treeBlockCount" in o) return `${o.treeBlockCount} blocks`;
  if ("blockCount" in o) return `${o.blockCount} blocks`;
  if ("suggested" in o && Array.isArray(o.suggested))
    return `${o.suggested.length} suggestions`;
  return "done";
}

interface StepCardProps {
  toolName: string;
  state: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

export function StepCard({ toolName, state, input, output }: StepCardProps) {
  const color = toolColors[toolName] || colors.dim;

  return (
    <div
      className="py-1.5 px-2.5 bg-surface mb-1 text-[11px]"
      style={{ borderLeftWidth: 2, borderLeftColor: color }}
    >
      <div className="flex items-center gap-2">
        <span className="uppercase" style={{ color }}>
          {toolName}
        </span>
        {state !== "output-available" && (
          <span className="text-dim text-[9px]">{state}</span>
        )}
      </div>
      {input && (
        <div className="text-text mt-0.5">
          {Object.entries(input).map(([k, v]) => (
            <span key={k} className="mr-2">
              {typeof v === "string" ? v : String(JSON.stringify(v))}
            </span>
          ))}
        </div>
      )}
      {state === "output-available" && output != null ? (
        <div className="text-muted text-[10px] mt-0.5">
          {formatOutput(output)}
        </div>
      ) : null}
    </div>
  );
}
