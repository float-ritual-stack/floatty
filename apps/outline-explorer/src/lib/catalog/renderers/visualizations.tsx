/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { colors, ArrowRight, resolveColor } from "./shared";

// Project color map used by ArcTimeline and ContextStream
const arcProjectColors: Record<string, string> = {
  floatty: colors.cyan,
  "float-hub": colors.green,
  rangle: colors.amber,
  "json-render": colors.magenta,
};

function projectColor(project?: string): string {
  if (!project) return colors.dim;
  return arcProjectColors[project] ?? colors.dim;
}

// Status colors for TreeView nodes
const treeStatusColors: Record<string, string> = {
  done: colors.green,
  active: colors.cyan,
  pending: colors.muted,
  deferred: colors.amber,
};

// Status colors for DependencyChain
const depStatusColors: Record<string, string> = {
  todo: colors.cyan,
  blocked: colors.amber,
  done: colors.green,
};

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
                  >{n.label.length > 18 ? n.label.slice(0, 16) + "…" : n.label}</text>
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
        <div className="flex items-center justify-between gap-2 px-1 mt-0.5">
          <span className="text-dim text-[8px] font-mono truncate min-w-0">{data[0]?.label}</span>
          <span className="text-dim text-[8px] font-mono shrink-0">peak: {maxVal}</span>
          <span className="text-dim text-[8px] font-mono truncate min-w-0 text-right">{data[data.length - 1]?.label}</span>
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
                  {Number.isFinite(step.confidence) && (() => {
                    // Schema documents 0–1 fractions (renderer multiplies by 100).
                    // Auto-detect agents that emit 0–100 ints by mistake — if the
                    // value is > 1 (and at most 100, the only sensible upper
                    // bound), treat it as already-percent. Daddy's 2026-04-26
                    // bug #4: confidence: 100 → 10000% before this guard.
                    const raw = step.confidence!;
                    const pct = raw > 1 && raw <= 100 ? raw : raw * 100;
                    return (
                      <span className="text-[9px] font-mono ml-auto" style={{
                        color: pct > 80 ? colors.green : pct > 50 ? colors.amber : colors.coral,
                      }}>{Math.round(pct)}%</span>
                    );
                  })()}
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

  BarChart: ({ element, children }: any) => {
    const title = element.props.title;
    const maxHeight = element.props.maxHeight ?? 120;
    // Compute a chart-level max so all BarItems share the same scale. Use the
    // explicit `max` prop when supplied; otherwise derive from children values.
    // Without this, each BarItem fell back to its own value and every bar
    // rendered at 100% (CodeRabbit Major on PR #307).
    const childArray = Array.isArray(children) ? children : [children].filter(Boolean);
    const computedMax = (() => {
      if (typeof element.props.max === "number") return element.props.max;
      const values: number[] = [];
      for (const child of childArray) {
        const v = child?.props?.element?.props?.value;
        if (typeof v === "number") values.push(v);
      }
      return values.length ? Math.max(...values) : 1;
    })();
    // Inject the computed max into each BarItem child via the element.props.
    // BarItem reads element.props.max first; this thread-down is what makes
    // the auto-scale contract honest.
    const scaledChildren = childArray.map((child: any, i: number) => {
      if (!child?.props?.element) return child;
      const el = child.props.element;
      // Don't clobber an item-level explicit max if the spec set one.
      if (typeof el.props?.max === "number") return child;
      const scaledElement = { ...el, props: { ...el.props, max: computedMax } };
      const Component = child.type;
      return <Component key={el.key ?? i} {...child.props} element={scaledElement} />;
    });
    return (
      <div className="bg-surface rounded-md p-2.5 mb-2" style={{ border: `1px solid ${colors.border}` }}>
        {title && (
          <div className="text-[10px] font-mono uppercase tracking-wide mb-2" style={{ color: colors.muted }}>
            {title}
          </div>
        )}
        <div className="flex items-end gap-2" style={{ height: maxHeight }}>
          {scaledChildren}
        </div>
      </div>
    );
  },

  BarItem: ({ element }: any) => {
    const label = element.props.label;
    const value = element.props.value ?? 0;
    const max = element.props.max ?? value ?? 1;
    const c = resolveColor(element.props.color ?? "cyan");
    const heightPct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
    return (
      <div className="flex flex-col items-center flex-1 min-w-0" style={{ height: "100%" }}>
        <div className="flex flex-col justify-end items-center w-full" style={{ flex: 1, minHeight: 0 }}>
          <div className="text-[9px] font-mono mb-0.5" style={{ color: c }}>{value}</div>
          <div
            className="w-full rounded-sm"
            style={{
              height: `${heightPct}%`,
              backgroundColor: c + "40",
              borderTop: `2px solid ${c}`,
              minHeight: 2,
            }}
            title={`${label}: ${value}`}
          />
        </div>
        <div
          className="text-[9px] font-mono mt-1 text-center truncate w-full"
          style={{ color: colors.muted }}
          title={label}
        >
          {label}
        </div>
      </div>
    );
  },

  DataBlock: ({ element }: any) => {
    const label = element.props.label;
    const content = element.props.content ?? "";
    return (
      <div className="relative mb-2">
        {label && (
          <div
            className="absolute -top-2 left-2 px-1.5 text-[8px] font-mono uppercase tracking-wide rounded"
            style={{ color: colors.muted, backgroundColor: colors.bg, border: `1px solid ${colors.border}` }}
          >
            {label}
          </div>
        )}
        <pre
          className="text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-words p-2.5 rounded-md overflow-x-auto"
          style={{
            color: colors.text,
            backgroundColor: colors.surface2,
            border: `1px solid ${colors.border}`,
            margin: 0,
          }}
        >
          {content}
        </pre>
      </div>
    );
  },

  Image: ({ element }: any) => {
    const src = element.props.src;
    const alt = element.props.alt ?? "";
    const maxWidth = element.props.maxWidth;
    const maxHeight = element.props.maxHeight;
    const borderRadius = element.props.borderRadius ?? 4;
    const caption = element.props.caption;
    return (
      <figure className="mb-2 flex flex-col items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          style={{
            maxWidth: maxWidth ? `${maxWidth}px` : "100%",
            maxHeight: maxHeight ? `${maxHeight}px` : undefined,
            borderRadius: `${borderRadius}px`,
            border: `1px solid ${colors.border}`,
            display: "block",
          }}
        />
        {caption && (
          <figcaption
            className="text-[10px] font-mono mt-1.5 text-center"
            style={{ color: colors.muted }}
          >
            {caption}
          </figcaption>
        )}
      </figure>
    );
  },

  ArcTimeline: ({ element }: any) => {
    const entries: { time: string; label: string; project: string }[] = element.props.entries ?? [];
    const arcs: { name: string; start: string; end: string; project: string }[] = element.props.arcs ?? [];
    const title = element.props.title;

    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    function inArc(time: string, arc: { start: string; end: string }): boolean {
      return time >= arc.start && time <= arc.end;
    }

    // Parse "HH:MM" → minutes since midnight; returns NaN for malformed input.
    function timeToMinutes(t: string): number {
      const [h, m] = t.split(":").map((n) => Number.parseInt(n, 10));
      if (Number.isNaN(h) || Number.isNaN(m)) return Number.NaN;
      return h * 60 + m;
    }

    // Format minutes → "Xh Ym" / "Ym" (drop the hour when 0). Used for arc duration.
    function formatDuration(start: string, end: string): string | null {
      const s = timeToMinutes(start);
      const e = timeToMinutes(end);
      if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
      const total = e - s;
      const h = Math.floor(total / 60);
      const m = total % 60;
      if (h === 0) return `${m}m`;
      if (m === 0) return `${h}h`;
      return `${h}h ${m}m`;
    }

    const orphanEntries = entries.filter((e) => !arcs.some((a) => inArc(e.time, a)));

    return (
      <div className="bg-surface rounded-md p-2.5 mb-2" style={{ border: `1px solid ${colors.border}` }}>
        {title && (
          <div className="text-[10px] font-mono uppercase tracking-wide mb-2" style={{ color: colors.muted }}>
            {title}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {arcs.map((arc, ai) => {
            const arcEntries = entries.filter((e) => inArc(e.time, arc));
            const c = projectColor(arc.project);
            const key = `${arc.name}-${ai}`;
            const isOpen = expanded[key] ?? true;
            return (
              <div
                key={key}
                className="rounded-md overflow-hidden"
                style={{
                  borderLeft: `3px solid ${c}`,
                  backgroundColor: c + "08",
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpanded((s) => ({ ...s, [key]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] font-mono font-semibold truncate" style={{ color: c }}>
                      {arc.name}
                    </span>
                    <span className="text-[9px] font-mono shrink-0" style={{ color: colors.muted }}>
                      {arc.start}–{arc.end}
                    </span>
                    {(() => {
                      const dur = formatDuration(arc.start, arc.end);
                      return dur ? (
                        <span className="text-[9px] font-mono shrink-0" style={{ color: colors.dim }}>
                          · {dur}
                        </span>
                      ) : null;
                    })()}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span
                      className="text-[8px] font-mono uppercase px-1.5 py-px rounded font-bold"
                      style={{ color: colors.green, backgroundColor: colors.green + "12", border: `1px solid ${colors.green}40` }}
                      title="completed session"
                    >
                      DONE
                    </span>
                    <span className="text-[8px] font-mono uppercase px-1.5 py-px rounded" style={{ color: c, backgroundColor: c + "15" }}>
                      {arc.project}
                    </span>
                    <span className="text-[9px] font-mono" style={{ color: colors.muted }} title="entry count">
                      {arcEntries.length}
                    </span>
                    <span className="text-[9px] font-mono" style={{ color: colors.dim }} aria-hidden="true">
                      {isOpen ? "▾" : "▸"}
                    </span>
                  </div>
                </button>
                {isOpen && arcEntries.length > 0 && (
                  <div className="px-2 pb-1.5 flex flex-col gap-0.5">
                    {arcEntries.map((e, ei) => (
                      <div key={ei} className="flex items-center gap-2 text-[10px] font-mono">
                        <span className="shrink-0" style={{ color: colors.dim }}>{e.time}</span>
                        <span
                          className="shrink-0 rounded-full"
                          style={{ width: 6, height: 6, backgroundColor: projectColor(e.project) }}
                        />
                        <span className="truncate" style={{ color: colors.text }}>{e.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {orphanEntries.length > 0 && (
            <div className="mt-1">
              <div className="text-[8px] font-mono uppercase tracking-wide mb-1" style={{ color: colors.dim }}>
                orphan entries
              </div>
              <div className="flex flex-col gap-0.5">
                {orphanEntries.map((e, ei) => (
                  <div key={ei} className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="shrink-0" style={{ color: colors.dim }}>{e.time}</span>
                    <span
                      className="shrink-0 rounded-full"
                      style={{ width: 6, height: 6, backgroundColor: projectColor(e.project) }}
                    />
                    <span className="truncate" style={{ color: colors.text }}>{e.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  },

  KanbanCard: ({ element }: any) => {
    const content = element.props.content ?? "";
    const c = resolveColor(element.props.color ?? "cyan");
    return (
      <div
        className="rounded-md p-2 text-[10px] font-mono leading-snug"
        style={{
          backgroundColor: c + "12",
          border: `1px solid ${c}40`,
          borderLeft: `3px solid ${c}`,
          color: colors.text,
          marginBottom: 4,
        }}
      >
        {content}
      </div>
    );
  },

  KanbanColumn: ({ element, children }: any) => {
    const title = element.props.title;
    const titleColor = resolveColor(element.props.titleColor ?? "cyan");
    const childCount = element.props.childCount;
    return (
      <div
        className="rounded-md p-2 flex flex-col min-w-[160px]"
        style={{
          backgroundColor: colors.surface2,
          border: `1px solid ${colors.border}`,
        }}
      >
        {title && (
          <div className="flex items-center justify-between mb-2 px-1">
            <span
              className="text-[10px] font-mono uppercase tracking-wide font-semibold"
              style={{ color: titleColor }}
            >
              {title}
            </span>
            {typeof childCount === "number" && (
              <span
                className="text-[9px] font-mono px-1.5 py-px rounded"
                style={{ color: titleColor, backgroundColor: titleColor + "15" }}
              >
                {childCount}
              </span>
            )}
          </div>
        )}
        <div className="flex flex-col">{children}</div>
      </div>
    );
  },

  TreeView: ({ element }: any) => {
    type TreeNode = {
      id: string;
      label: string;
      status?: string;
      detail?: string;
      children?: TreeNode[];
    };
    const title: string | undefined = element.props.title;
    const nodes: TreeNode[] = element.props.nodes ?? [];
    const defaultExpanded: boolean = element.props.defaultExpanded ?? true;
    const connectsTo: string[] = element.props.connectsTo ?? [];

    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    function isExpanded(id: string): boolean {
      return expanded[id] ?? defaultExpanded;
    }
    function toggle(id: string) {
      setExpanded((s) => ({ ...s, [id]: !isExpanded(id) }));
    }

    function renderNode(node: TreeNode, depth: number): React.ReactNode {
      const c = node.status ? treeStatusColors[node.status] ?? colors.dim : colors.text;
      const hasChildren = !!(node.children && node.children.length > 0);
      const open = isExpanded(node.id);
      const rowInner = (
        <>
          <span className="shrink-0 w-3 text-center" style={{ color: colors.dim }} aria-hidden="true">
            {hasChildren ? (open ? "▾" : "▸") : "·"}
          </span>
          <span className="shrink-0" style={{ color: c }}>{node.label}</span>
          {node.detail && (
            <span className="truncate" style={{ color: colors.muted }}>— {node.detail}</span>
          )}
        </>
      );
      return (
        <div key={node.id} className="flex flex-col" style={{ marginLeft: depth * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              className="flex w-full items-start gap-1.5 py-0.5 text-[10px] font-mono leading-snug cursor-pointer text-left"
              aria-expanded={open}
              onClick={() => toggle(node.id)}
            >
              {rowInner}
            </button>
          ) : (
            <div className="flex items-start gap-1.5 py-0.5 text-[10px] font-mono leading-snug">
              {rowInner}
            </div>
          )}
          {hasChildren && open && (
            <div>{node.children!.map((child) => renderNode(child, depth + 1))}</div>
          )}
        </div>
      );
    }

    return (
      <div className="bg-surface rounded-md p-2.5 mb-2" style={{ border: `1px solid ${colors.border}` }}>
        {title && (
          <div className="text-[10px] font-mono uppercase tracking-wide mb-2" style={{ color: colors.muted }}>
            {title}
          </div>
        )}
        <div className="flex flex-col">
          {nodes.map((n) => renderNode(n, 0))}
        </div>
        {connectsTo.length > 0 && (
          <div
            className="mt-2 pt-2 flex flex-wrap gap-1.5"
            style={{ borderTop: `1px solid ${colors.border}` }}
          >
            <span className="text-[8px] font-mono uppercase tracking-wide" style={{ color: colors.dim }}>
              connects to:
            </span>
            {connectsTo.map((ref, i) => (
              <span
                key={i}
                className="text-[9px] font-mono px-1.5 py-px rounded"
                style={{ color: colors.cyan, backgroundColor: colors.cyan + "12" }}
              >
                {ref}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  },

  DependencyChain: ({ element }: any) => {
    const nodes: { id: string; title: string; assignee: string; status: string; deps: string[] }[] = element.props.nodes ?? [];
    const blocker: string | undefined = element.props.blocker;

    return (
      <div className="bg-surface rounded-md p-2.5 mb-2" style={{ border: `1px solid ${colors.border}` }}>
        <div className="flex items-stretch gap-1 overflow-x-auto">
          {nodes.map((node, i) => {
            const c = depStatusColors[node.status] ?? colors.dim;
            return (
              <div key={node.id ?? i} className="flex items-stretch gap-1">
                <div
                  className="rounded-md p-2 flex flex-col gap-0.5 min-w-[120px]"
                  style={{
                    backgroundColor: c + "10",
                    border: `1px solid ${c}40`,
                    borderLeft: `3px solid ${c}`,
                  }}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <span className="text-[9px] font-mono" style={{ color: colors.dim }}>{node.id}</span>
                    <span
                      className="text-[8px] font-mono uppercase px-1 py-px rounded"
                      style={{ color: c, backgroundColor: c + "15" }}
                    >
                      {node.status}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono leading-snug" style={{ color: colors.text }}>
                    {node.title}
                  </div>
                  <div className="text-[9px] font-mono" style={{ color: colors.muted }}>
                    @{node.assignee}
                  </div>
                </div>
                {i < nodes.length - 1 && (
                  <div className="flex items-center px-0.5" style={{ color: colors.dim }}>
                    <ArrowRight size={12} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {blocker && (
          <div
            className="mt-2 px-2 py-1.5 rounded-md text-[10px] font-mono leading-snug"
            style={{
              backgroundColor: colors.amber + "10",
              border: `1px solid ${colors.amber}40`,
              borderLeft: `3px solid ${colors.amber}`,
              color: colors.text,
            }}
          >
            <span className="font-bold uppercase text-[8px] tracking-wide mr-1.5" style={{ color: colors.amber }}>
              blocker
            </span>
            {blocker}
          </div>
        )}
      </div>
    );
  },

  ContextStream: ({ element }: any) => {
    const captures: { time: string; project: string; mode: string; text: string }[] = element.props.captures ?? [];
    const title: string | undefined = element.props.title;

    const projects = Array.from(new Set(captures.map((c) => c.project))).filter(Boolean);
    const [activeFilter, setActiveFilter] = useState<string | null>(null);
    // Per-entry expansion state — schema promises "Click to expand entries"
    // so each capture row toggles between truncated and full text. Keyed by
    // capture index since captures have no stable id (matches the render-key
    // pattern below).
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({});
    const toggleRow = (i: number) =>
      setExpandedRows((s) => ({ ...s, [i]: !s[i] }));

    const visible = activeFilter
      ? captures.filter((c) => c.project === activeFilter)
      : captures;

    return (
      <div className="bg-surface rounded-md p-2.5 mb-2" style={{ border: `1px solid ${colors.border}` }}>
        {title && (
          <div className="text-[10px] font-mono uppercase tracking-wide mb-2" style={{ color: colors.muted }}>
            {title}
          </div>
        )}
        {projects.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            <button
              type="button"
              onClick={() => setActiveFilter(null)}
              className="text-[9px] font-mono uppercase px-1.5 py-px rounded"
              style={{
                color: activeFilter === null ? colors.bg : colors.muted,
                backgroundColor: activeFilter === null ? colors.cyan : "transparent",
                border: `1px solid ${activeFilter === null ? colors.cyan : colors.border}`,
              }}
            >
              all
            </button>
            {projects.map((p) => {
              const c = projectColor(p);
              const active = activeFilter === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setActiveFilter(active ? null : p)}
                  className="text-[9px] font-mono uppercase px-1.5 py-px rounded"
                  style={{
                    color: active ? colors.bg : c,
                    backgroundColor: active ? c : c + "12",
                    border: `1px solid ${c}${active ? "" : "40"}`,
                  }}
                >
                  {p}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex flex-col gap-1">
          {visible.map((cap, i) => {
            const c = projectColor(cap.project);
            const open = !!expandedRows[i];
            return (
              <button
                key={i}
                type="button"
                onClick={() => toggleRow(i)}
                aria-expanded={open}
                className="flex items-start gap-2 text-[10px] font-mono leading-snug px-1.5 py-1 rounded text-left w-full hover:brightness-110 transition"
                style={{ backgroundColor: colors.surface2 }}
              >
                <span className="shrink-0" style={{ color: colors.dim }}>{cap.time}</span>
                <span
                  className="shrink-0 text-[8px] uppercase px-1 py-px rounded"
                  style={{ color: c, backgroundColor: c + "15" }}
                >
                  {cap.project}
                </span>
                <span
                  className="shrink-0 text-[8px] uppercase px-1 py-px rounded"
                  style={{ color: colors.purple, backgroundColor: colors.purple + "15" }}
                >
                  {cap.mode}
                </span>
                <span
                  className={`min-w-0 flex-1 ${open ? "whitespace-pre-wrap break-words" : "truncate"}`}
                  style={{ color: colors.text }}
                >
                  {cap.text}
                </span>
                <span
                  className="shrink-0 text-[9px] font-mono ml-1"
                  style={{ color: colors.dim }}
                  aria-hidden="true"
                >
                  {open ? "▾" : "▸"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  },
};
