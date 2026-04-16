/* eslint-disable @typescript-eslint/no-explicit-any */
import { colors, ArrowRight, resolveColor } from "./shared";

export const visualizationRenderers = {
  LinkGraph: ({ element }: any) => {
    const nodes = element.props.nodes ?? [];
    const edges = element.props.edges ?? [];
    const w = 420, h = 260;

    const centerNode = nodes.find((n: { center?: boolean }) => n.center);
    const others = nodes.filter((n: { center?: boolean }) => !n.center);
    const positioned: Record<string, { x: number; y: number; color: string; label: string; weight?: number; type?: string; center?: boolean }> = {};
    if (centerNode) positioned[centerNode.id] = { ...centerNode, x: w / 2, y: h / 2, color: resolveColor(centerNode.color) };
    others.forEach((n: { id: string; color?: string; ring?: number; label: string; weight?: number; type?: string }, i: number) => {
      const angle = (i / others.length) * Math.PI * 2 - Math.PI / 2;
      const r = 90 + (n.ring || 1) * 30;
      positioned[n.id] = { ...n, x: w / 2 + Math.cos(angle) * r, y: h / 2 + Math.sin(angle) * r, color: resolveColor(n.color) };
    });

    return (
      <div className="bg-surface rounded-md overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
        <svg width={w} height={h} style={{ display: "block" }}>
          {edges.map((edge: string[], i: number) => {
            const a = positioned[edge[0]], b = positioned[edge[1]];
            if (!a || !b) return null;
            return (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={colors.border} strokeWidth={0.5}
                strokeDasharray={a.type === "stub" || b.type === "stub" ? "3,3" : "none"}
              />
            );
          })}
          {Object.values(positioned).map((n) => {
            const r = n.center ? 18 : n.type === "stub" ? 5 : 8 + Math.min(n.weight || 0, 6);
            return (
              <g key={n.label}>
                <circle cx={n.x} cy={n.y} r={r}
                  fill={n.color + "30"} stroke={n.color}
                  strokeWidth={n.center ? 2 : 1}
                />
                {(n.center || r > 8) && (
                  <text x={n.x} y={n.y + r + 12} textAnchor="middle"
                    fill={colors.muted} fontSize={8} fontFamily="monospace"
                  >{n.label.length > 18 ? n.label.slice(0, 16) + "\u2026" : n.label}</text>
                )}
                {(n.weight ?? 0) > 3 && !n.center && (
                  <text x={n.x} y={n.y + 3} textAnchor="middle"
                    fill={colors.bg} fontSize={7} fontFamily="monospace" fontWeight="bold"
                  >{n.weight}</text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    );
  },

  ActivityHeatmap: ({ element }: any) => {
    const data = element.props.data ?? [];
    const c = resolveColor(element.props.color ?? "cyan");
    const maxVal = Math.max(...data.map((d: { value: number }) => d.value), 1);
    return (
      <div className="bg-surface rounded-md p-2" style={{ border: `1px solid ${colors.border}` }}>
        <div className="flex gap-0.5 flex-wrap p-1">
          {data.map((d: { label: string; value: number }, i: number) => {
            const intensity = d.value / maxVal;
            const bg = intensity === 0 ? colors.surface2
              : intensity < 0.25 ? c + "15"
              : intensity < 0.5 ? c + "30"
              : intensity < 0.75 ? c + "50"
              : c + "80";
            return (
              <div key={i} title={`${d.label}: ${d.value}`} style={{
                width: 14, height: 14, borderRadius: 2, backgroundColor: bg,
                border: `1px solid ${intensity > 0.5 ? c + "30" : colors.border}`,
              }} />
            );
          })}
        </div>
        <div className="flex justify-between px-1 mt-0.5">
          <span className="text-dim text-[8px] font-mono">{data[0]?.label}</span>
          <span className="text-dim text-[8px] font-mono">peak: {maxVal}</span>
          <span className="text-dim text-[8px] font-mono">{data[data.length - 1]?.label}</span>
        </div>
      </div>
    );
  },

  ProvenanceChain: ({ element }: any) => {
    const steps = element.props.steps ?? [];
    const sourceColors: Record<string, string> = {
      qmd: colors.cyan, conversation: colors.magenta, bbs: colors.purple,
      outline: colors.green, loki: colors.amber, autorag: colors.cyan,
    };
    return (
      <div className="bg-surface rounded-md p-2.5" style={{ border: `1px solid ${colors.border}` }}>
        {steps.map((step: { source: string; content: string; docId?: string; confidence?: number; lines?: string }, i: number) => {
          const sc = sourceColors[step.source] ?? colors.dim;
          const isLast = i === steps.length - 1;
          return (
            <div key={i} className="flex gap-2.5" style={{ marginBottom: isLast ? 0 : 4 }}>
              <div className="flex flex-col items-center shrink-0" style={{ width: 16 }}>
                <div className="shrink-0 mt-1 rounded-full" style={{ width: 10, height: 10, backgroundColor: sc + "30", border: `2px solid ${sc}` }} />
                {!isLast && <div className="flex-1 mt-0.5" style={{ width: 2, backgroundColor: colors.border }} />}
              </div>
              <div className="flex-1" style={{ paddingBottom: isLast ? 0 : 8 }}>
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="text-[8px] font-mono uppercase tracking-wide px-1.5 py-px rounded" style={{ color: sc, backgroundColor: sc + "12" }}>
                    {step.source}
                  </span>
                  {step.docId && <span className="text-dim text-[9px] font-mono">#{step.docId}</span>}
                  {step.confidence != null && (
                    <span className="text-[9px] font-mono ml-auto" style={{
                      color: step.confidence > 0.8 ? colors.green : step.confidence > 0.5 ? colors.amber : colors.coral,
                    }}>{Math.round(step.confidence * 100)}%</span>
                  )}
                </div>
                <div className="text-text text-[11px] font-mono leading-snug">{step.content}</div>
                {step.lines && <span className="text-dim text-[9px] font-mono">lines {step.lines}</span>}
              </div>
            </div>
          );
        })}
      </div>
    );
  },

  RiskMatrix: ({ element }: any) => {
    const items = element.props.items ?? [];
    const rows = ["high", "medium", "low"] as const;
    const cols = ["structural", "content", "cosmetic"] as const;
    const colColors: Record<string, string> = { structural: colors.coral, content: colors.amber, cosmetic: colors.muted };

    return (
      <div className="bg-surface rounded-md overflow-hidden" style={{ border: `1px solid ${colors.border}` }}>
        <div className="grid" style={{ gridTemplateColumns: "60px 1fr 1fr 1fr", borderBottom: `1px solid ${colors.border}` }}>
          <div className="p-1.5" />
          {cols.map(c => (
            <div key={c} className="p-1.5 text-center text-[9px] font-mono uppercase" style={{ color: colColors[c], borderLeft: `1px solid ${colors.border}` }}>
              {c}
            </div>
          ))}
        </div>
        {rows.map(r => (
          <div key={r} className="grid" style={{ gridTemplateColumns: "60px 1fr 1fr 1fr", borderBottom: `1px solid ${colors.border}20` }}>
            <div className="p-1.5 text-[9px] font-mono uppercase flex items-center" style={{
              color: r === "high" ? colors.coral : r === "medium" ? colors.amber : colors.muted,
            }}>{r}</div>
            {cols.map(c => {
              const cellItems = items.filter((it: { severity: string; impact: string }) => it.severity === r && it.impact === c);
              const cc = colColors[c];
              return (
                <div key={c} className="p-1 flex flex-col gap-0.5" style={{ borderLeft: `1px solid ${colors.border}`, minHeight: 40 }}>
                  {cellItems.map((item: { label: string }, idx: number) => (
                    <div key={idx} className="px-1.5 py-0.5 rounded text-[9px] font-mono text-text leading-snug" style={{
                      backgroundColor: cc + "10", borderLeft: `2px solid ${cc}40`,
                    }}>{item.label}</div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  },

  TimelineDiff: ({ element }: any) => {
    const before = element.props.before ?? { date: "", items: [] };
    const after = element.props.after ?? { date: "", items: [] };
    return (
      <div className="grid bg-surface rounded-md overflow-hidden" style={{ gridTemplateColumns: "1fr 20px 1fr", border: `1px solid ${colors.border}` }}>
        <div className="p-1.5" style={{ borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.coral + "08" }}>
          <span className="text-[9px] font-mono uppercase" style={{ color: colors.coral }}>before</span>
          <span className="text-dim text-[9px] font-mono ml-1.5">{before.date}</span>
        </div>
        <div className="flex items-center justify-center" style={{ borderBottom: `1px solid ${colors.border}` }}>
          <ArrowRight size={10} className="text-dim" />
        </div>
        <div className="p-1.5" style={{ borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.green + "08" }}>
          <span className="text-[9px] font-mono uppercase" style={{ color: colors.green }}>after</span>
          <span className="text-dim text-[9px] font-mono ml-1.5">{after.date}</span>
        </div>
        <div className="p-1.5">
          {before.items.map((item: { text: string; removed?: boolean }, i: number) => (
            <div key={i} className="px-1.5 py-0.5 text-[10px] font-mono mb-0.5" style={{
              color: colors.muted,
              backgroundColor: item.removed ? colors.coral + "10" : "transparent",
              textDecoration: item.removed ? "line-through" : "none",
              borderLeft: item.removed ? `2px solid ${colors.coral}40` : "2px solid transparent",
            }}>{item.text}</div>
          ))}
        </div>
        <div />
        <div className="p-1.5">
          {after.items.map((item: { text: string; added?: boolean }, i: number) => (
            <div key={i} className="px-1.5 py-0.5 text-[10px] font-mono mb-0.5" style={{
              color: item.added ? colors.green : colors.muted,
              backgroundColor: item.added ? colors.green + "08" : "transparent",
              borderLeft: item.added ? `2px solid ${colors.green}40` : "2px solid transparent",
            }}>{item.text}</div>
          ))}
        </div>
      </div>
    );
  },
};
