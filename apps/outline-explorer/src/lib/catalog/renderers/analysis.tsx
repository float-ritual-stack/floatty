/* eslint-disable @typescript-eslint/no-explicit-any */
import { colors, severityColors, confidenceColors, variantStyles, AlertTriangle, AlertCircle, Info, Link2, FileText, GitBranch, Zap, ExternalLink, ChevronRight, resolveColor } from "./shared";
import { useState } from "react";
import type { LucideIcon } from "lucide-react";

const modeColors: Record<string, string> = {
  work: colors.cyan,
  float: colors.magenta,
  life: colors.green,
  pebble: colors.amber,
  rent: colors.coral,
  spike: colors.coral,
};

const diffStatusColors: Record<string, string> = {
  removed: colors.red,
  added: colors.green,
  unchanged: colors.muted,
};

export const analysisRenderers = {
  Section: ({ element, children }: any) => {
    const style = variantStyles[element.props.variant ?? "default"];
    return (
      <div
        className={`mb-3 ${style.bg}`}
        style={{ borderLeftWidth: 2, borderLeftColor: style.borderColor }}
      >
        <div className="px-2.5 py-1.5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-cyan mb-1.5">
            {element.props.title}
          </div>
          <div className="space-y-1.5">{children}</div>
        </div>
      </div>
    );
  },

  PatternCard: ({ element }: any) => {
    const conf = element.props.confidence ?? "medium";
    return (
      <div
        className="px-2.5 py-1.5 bg-surface rounded mb-1"
        style={{
          borderLeftWidth: 2,
          borderLeftColor: confidenceColors[conf] ?? colors.amber,
        }}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="text-[10px] font-bold"
            style={{ color: confidenceColors[conf] ?? colors.amber }}
          >
            {element.props.label}
          </span>
          {element.props.confidence && (
            <span className="text-dim text-[8px] uppercase">
              {element.props.confidence}
            </span>
          )}
        </div>
        <div className="text-text text-[11px] mt-0.5 leading-relaxed">
          {element.props.description}
        </div>
      </div>
    );
  },

  GapItem: ({ element }: any) => {
    const sev = element.props.severity ?? "info";
    const sevColor = severityColors[sev] ?? colors.cyan;

    const gapTypeConfig: Record<string, { icon: LucideIcon; color: string; label: string }> = {
      stub: { icon: AlertTriangle, color: colors.coral, label: "STUB" },
      orphan: { icon: Link2, color: colors.amber, label: "ORPHAN" },
      empty: { icon: FileText, color: colors.muted, label: "EMPTY" },
      asymmetric: { icon: GitBranch, color: colors.purple, label: "ASYM" },
      unanswered: { icon: Zap, color: colors.magenta, label: "Q?" },
    };

    const gt = element.props.gapType;
    const cfg = gt ? gapTypeConfig[gt] : null;
    const Icon = cfg?.icon ?? (sev === "critical" ? AlertCircle : sev === "warning" ? AlertTriangle : Info);
    const iconColor = cfg?.color ?? sevColor;

    return (
      <div
        className="flex items-start gap-2 px-2.5 py-1.5 bg-surface text-[11px] mb-1"
        style={{ borderLeftWidth: 3, borderLeftColor: sevColor, borderRadius: "0 3px 3px 0" }}
      >
        {cfg && (
          <span
            className="flex items-center gap-1 text-[8px] uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 mt-0.5"
            style={{ color: cfg.color, backgroundColor: `${cfg.color}15`, border: `1px solid ${cfg.color}30` }}
          >
            <cfg.icon size={8} />{cfg.label}
          </span>
        )}
        {!cfg && <Icon size={11} style={{ color: iconColor }} className="mt-0.5 shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="text-text">{element.props.description}</div>
          {element.props.evidence && (
            <div
              className="text-dim text-[9px] font-mono mt-1 pl-2 leading-relaxed"
              style={{ borderLeft: `2px solid ${cfg?.color ?? sevColor}15` }}
            >
              {element.props.evidence}
            </div>
          )}
        </div>
        {element.props.target && (
          <span
            className="inline-flex items-center gap-1 bg-cyan/10 text-cyan px-1.5 py-0.5 rounded text-[9px] cursor-pointer hover:bg-cyan/20 transition-colors shrink-0"
            data-walk-page={element.props.target}
          >
            <ExternalLink size={8} />{element.props.target}
          </span>
        )}
      </div>
    );
  },

  ObservationCard: ({ element }: any) => {
    const sevColors: Record<string, string> = {
      surprising: colors.magenta,
      structural: colors.cyan,
      gap: colors.coral,
      thread: colors.purple,
      meta: colors.amber,
    };
    const sev = element.props.severity ?? "meta";
    const c = sevColors[sev] ?? colors.muted;
    const links = element.props.links ?? [];

    return (
      <details
        className="mb-1.5 bg-surface rounded-r overflow-hidden group"
        style={{ borderLeft: `3px solid ${c}`, border: `1px solid ${colors.border}`, borderLeftWidth: 3, borderLeftColor: c }}
      >
        <summary className="flex items-start gap-2 px-3 py-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <span className="text-[14px] font-bold font-mono leading-none mt-0.5" style={{ color: c }}>
            {element.props.number}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-text text-[12px] font-mono font-semibold leading-snug">
              {element.props.title}
            </div>
            {element.props.body && (
            <div className="text-muted text-[10px] font-mono mt-0.5 truncate group-open:hidden">
              {element.props.body.slice(0, 80)}{element.props.body.length > 80 ? "…" : ""}
            </div>
            )}
          </div>
          <span
            className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded shrink-0"
            style={{ color: c, backgroundColor: "transparent", border: `1px solid ${c}30` }}
          >
            {sev}
          </span>
          <ChevronRight size={12} className="text-dim mt-0.5 shrink-0 transition-transform [[open]>&]:rotate-90" />
        </summary>
        <div className="px-3 pb-2.5 pl-8">
          <div className="text-text text-[11px] font-mono leading-relaxed mb-2">
            {element.props.body}
          </div>
          {links.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {links.map((l: string) => (
                <span
                  key={l}
                  className="inline-flex items-center gap-1 bg-cyan/10 text-cyan px-1.5 py-0.5 rounded text-[10px] cursor-pointer hover:bg-cyan/20 transition-colors"
                  data-wikilink-target={l}
                >
                  <Link2 size={8} />[[{l}]]
                </span>
              ))}
            </div>
          )}
        </div>
      </details>
    );
  },

  PatternCluster: ({ element }: any) => {
    const c = resolveColor(element.props.color);
    const instances = element.props.instances ?? [];
    const connections = element.props.connections ?? [];
    return (
      <div
        className="p-2.5 rounded-md mb-1.5"
        style={{ backgroundColor: `${c}06`, border: `1px solid ${c}20` }}
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span
            className="rounded-full"
            style={{ width: 10, height: 10, backgroundColor: c, boxShadow: `0 0 8px ${c}40` }}
          />
          <span className="text-[12px] font-mono font-bold" style={{ color: c }}>
            {element.props.name}
          </span>
          <span className="text-dim text-[9px] font-mono ml-auto">
            {instances.length} instance{instances.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex gap-1 flex-wrap mb-1.5">
          {instances.map((inst: string) => (
            <span key={inst} className="text-muted text-[10px] font-mono px-1.5 py-0.5 bg-surface2 rounded">
              {inst}
            </span>
          ))}
        </div>
        {connections.length > 0 && (
          <div className="flex items-center gap-1 mt-1">
            <span className="text-dim text-[9px] font-mono">connects to:</span>
            {connections.map((conn: string) => (
              <span
                key={conn}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ color: colors.dim, backgroundColor: `${colors.dim}12`, border: `1px solid ${colors.dim}30` }}
              >
                {conn}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  },

  // ─── Door-promoted vocabulary (PR B) ──────────────────────────────────────

  Metric: ({ element }: any) => (
    <div className="flex items-baseline gap-2 px-2 py-1 font-mono text-[11px] mb-0.5">
      <span className="text-muted shrink-0">{element.props.label}</span>
      <span className="font-bold tabular-nums" style={{ color: colors.cyan }}>
        {element.props.value}
      </span>
    </div>
  ),

  ShippedItem: ({ element }: any) => (
    <div className="flex items-start gap-2 px-2 py-1 font-mono text-[11px] mb-0.5">
      <span className="shrink-0 mt-0.5 font-bold" style={{ color: colors.green }}>
        ✱
      </span>
      <span className="text-text leading-relaxed">{element.props.content}</span>
    </div>
  ),

  BacklinksFooter: ({ element }: any) => {
    const inbound: string[] = element.props.inbound ?? [];
    const outbound: string[] = element.props.outbound ?? [];
    const chip = (l: string, idx: number) => (
      <span
        key={`${l}-${idx}`}
        className="inline-flex items-center gap-1 bg-cyan/10 text-cyan px-1.5 py-0.5 rounded text-[10px] font-mono cursor-pointer hover:bg-cyan/20 transition-colors"
        data-wikilink-target={l}
      >
        <Link2 size={8} />[[{l}]]
      </span>
    );
    return (
      <div
        className="mt-3 pt-2 font-mono text-[10px]"
        style={{ borderTop: `1px solid ${colors.border}` }}
      >
        {inbound.length > 0 && (
          <div className="mb-1.5">
            <div className="text-dim uppercase tracking-wider mb-1 text-[9px]">referenced by</div>
            <div className="flex gap-1 flex-wrap">{inbound.map(chip)}</div>
          </div>
        )}
        {outbound.length > 0 && (
          <div>
            <div className="text-dim uppercase tracking-wider mb-1 text-[9px]">links to</div>
            <div className="flex gap-1 flex-wrap">{outbound.map(chip)}</div>
          </div>
        )}
      </div>
    );
  },

  ModeTag: ({ element }: any) => {
    const mode = element.props.mode ?? "work";
    const c = modeColors[mode] ?? colors.cyan;
    const size = element.props.size ?? "md";
    const padding = size === "sm" ? "px-1.5 py-0" : "px-2 py-0.5";
    const fontSize = size === "sm" ? "text-[9px]" : "text-[10px]";
    return (
      <span
        className={`inline-flex items-center gap-1 rounded font-mono font-bold uppercase tracking-wider ${padding} ${fontSize}`}
        style={{ color: c, backgroundColor: `${c}15`, border: `1px solid ${c}30` }}
      >
        {mode}
        {typeof element.props.count === "number" && (
          <span
            className="tabular-nums opacity-70"
            style={{ borderLeft: `1px solid ${c}40`, paddingLeft: 4, marginLeft: 2 }}
          >
            {element.props.count}
          </span>
        )}
      </span>
    );
  },

  TimeEntry: ({ element }: any) => {
    const c = resolveColor(element.props.color) || colors.cyan;
    const tags: string[] = element.props.tags ?? [];
    return (
      <div className="flex gap-3 px-2 py-1 font-mono text-[11px] mb-0.5 relative">
        <div className="flex flex-col items-center shrink-0 relative" style={{ width: 50 }}>
          <span className="text-muted text-[10px] tabular-nums">{element.props.time}</span>
          <span
            className="rounded-full mt-1"
            style={{
              width: 7,
              height: 7,
              backgroundColor: c,
              boxShadow: `0 0 6px ${c}40`,
            }}
          />
          <span
            className="absolute"
            style={{
              top: 24,
              bottom: -4,
              width: 1,
              backgroundColor: colors.border,
              left: "50%",
              transform: "translateX(-50%)",
            }}
          />
        </div>
        <div className="flex-1 min-w-0 pb-1">
          <div className="text-text font-semibold leading-snug">{element.props.title}</div>
          {element.props.body && (
            <div className="text-muted text-[10px] mt-0.5 leading-relaxed">{element.props.body}</div>
          )}
          {tags.length > 0 && (
            <div className="flex gap-1 flex-wrap mt-1">
              {tags.map((t, i) => (
                <span
                  key={`${t}-${i}`}
                  className="text-dim text-[9px] px-1 py-0 rounded bg-surface2"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  },

  StatsBar: ({ element }: any) => {
    const stats = element.props.stats ?? [];
    const layout = element.props.layout ?? "row";
    const containerClass =
      layout === "grid"
        ? "grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2"
        : "flex gap-2 flex-wrap";
    return (
      <div className={`${containerClass} px-2 py-2 mb-2`}>
        {stats.map((s: any, i: number) => {
          const c = resolveColor(s.color) || colors.cyan;
          return (
            <div
              key={`${s.label}-${i}`}
              className="px-2.5 py-1.5 rounded font-mono"
              style={{ backgroundColor: colors.surface2, border: `1px solid ${colors.border}` }}
            >
              <div className="text-dim text-[9px] uppercase tracking-wider">{s.label}</div>
              <div
                className="text-[14px] font-bold tabular-nums leading-tight mt-0.5"
                style={{ color: c }}
              >
                {s.value}
              </div>
            </div>
          );
        })}
      </div>
    );
  },

  MetadataHeader: ({ element }: any) => {
    const stats = element.props.stats ?? [];
    return (
      <div
        className="px-3 py-2 mb-3 font-mono"
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        <div className="text-[15px] font-bold leading-tight" style={{ color: colors.cyan }}>
          {element.props.title}
        </div>
        {element.props.subtitle && (
          <div className="text-muted text-[11px] mt-0.5">{element.props.subtitle}</div>
        )}
        <div className="flex items-center gap-3 mt-1.5 text-[10px]">
          {element.props.date && (
            <span className="text-dim tabular-nums">{element.props.date}</span>
          )}
          {stats.length > 0 && (
            <div className="flex gap-2 flex-wrap">
              {stats.map((s: any, i: number) => (
                <span key={`${s.label}-${i}`} className="text-muted">
                  <span className="text-dim">{s.label}: </span>
                  <span className="text-text font-bold tabular-nums">{s.value}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  },

  MeetingDiff: ({ element }: any) => {
    const before = element.props.before ?? [];
    const after = element.props.after ?? [];
    const newDecisions: string[] = element.props.newDecisions ?? [];
    const actions = element.props.actions ?? [];

    const renderStep = (s: any, i: number) => {
      const c = diffStatusColors[s.status] ?? colors.muted;
      const strike = s.status === "removed";
      return (
        <div
          key={`${s.step}-${i}`}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] mb-0.5 rounded"
          style={{
            color: c,
            backgroundColor: `${c}08`,
            textDecoration: strike ? "line-through" : "none",
            borderLeft: `2px solid ${c}`,
          }}
        >
          <span className="text-[8px] uppercase tracking-wider opacity-70">{s.status}</span>
          <span className="text-text">{s.step}</span>
        </div>
      );
    };

    return (
      <div className="mb-3 font-mono">
        <div
          className="px-2.5 py-1.5"
          style={{ borderBottom: `1px solid ${colors.border}` }}
        >
          <div className="text-[12px] font-bold" style={{ color: colors.cyan }}>
            {element.props.title}
          </div>
          <div className="text-dim text-[10px]">{element.props.meeting}</div>
        </div>
        <div className="grid grid-cols-2 gap-2 px-2.5 py-2">
          <div>
            <div className="text-dim text-[9px] uppercase tracking-wider mb-1">before</div>
            {before.map(renderStep)}
          </div>
          <div>
            <div className="text-dim text-[9px] uppercase tracking-wider mb-1">after</div>
            {after.map(renderStep)}
          </div>
        </div>
        {newDecisions.length > 0 && (
          <div className="px-2.5 py-2" style={{ borderTop: `1px solid ${colors.border}` }}>
            <div className="text-dim text-[9px] uppercase tracking-wider mb-1">new decisions</div>
            {newDecisions.map((d, i) => (
              <div
                key={`${i}-${d.slice(0, 12)}`}
                className="text-text text-[11px] py-0.5 pl-2"
                style={{ borderLeft: `2px solid ${colors.amber}` }}
              >
                {d}
              </div>
            ))}
          </div>
        )}
        {actions.length > 0 && (
          <div className="px-2.5 py-2" style={{ borderTop: `1px solid ${colors.border}` }}>
            <div className="text-dim text-[9px] uppercase tracking-wider mb-1">action items</div>
            <table className="w-full text-[10px]">
              <thead>
                <tr className="text-dim">
                  <th className="text-left font-normal pb-1 pr-2">who</th>
                  <th className="text-left font-normal pb-1 pr-2">what</th>
                  <th className="text-left font-normal pb-1 pr-2">status</th>
                  <th className="text-left font-normal pb-1">blocker</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a: any, i: number) => (
                  <tr
                    key={`${a.who}-${i}`}
                    style={{ borderTop: `1px solid ${colors.border}` }}
                  >
                    <td className="py-1 pr-2 text-cyan font-bold">{a.who}</td>
                    <td className="py-1 pr-2 text-text">{a.what}</td>
                    <td className="py-1 pr-2 text-muted">{a.status}</td>
                    <td className="py-1 text-coral">{a.blocker ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  },

  DecisionLog: ({ element }: any) => {
    const decisions = element.props.decisions ?? [];
    const [filter, setFilter] = useState<"all" | "active" | "superseded">("all");

    const visible = decisions.filter((d: any) => {
      if (filter === "all") return true;
      const status = (d.status ?? "").toLowerCase();
      return status === filter;
    });

    const counts = {
      all: decisions.length,
      active: decisions.filter((d: any) => (d.status ?? "").toLowerCase() === "active").length,
      superseded: decisions.filter((d: any) => (d.status ?? "").toLowerCase() === "superseded").length,
    };

    const tabs: Array<"all" | "active" | "superseded"> = ["all", "active", "superseded"];

    return (
      <div className="mb-3 font-mono">
        {element.props.title && (
          <div className="text-[12px] font-bold mb-1.5 px-2" style={{ color: colors.cyan }}>
            {element.props.title}
          </div>
        )}
        <div className="flex gap-1 px-2 mb-2">
          {tabs.map((t) => {
            const active = filter === t;
            return (
              <button
                key={t}
                onClick={() => setFilter(t)}
                className="text-[10px] uppercase tracking-wider px-2 py-1 rounded transition-colors"
                style={{
                  color: active ? colors.cyan : colors.muted,
                  backgroundColor: active ? `${colors.cyan}15` : "transparent",
                  border: `1px solid ${active ? colors.cyan : colors.border}`,
                }}
              >
                {t} <span className="text-dim ml-1">{counts[t]}</span>
              </button>
            );
          })}
        </div>
        <div className="space-y-1.5 px-2">
          {visible.map((d: any, i: number) => {
            const status = (d.status ?? "").toLowerCase();
            const isSuperseded = status === "superseded";
            const borderColor = isSuperseded ? colors.dim : colors.cyan;
            return (
              <div
                key={`${d.date}-${i}`}
                className="px-2.5 py-1.5 rounded"
                style={{
                  borderLeft: `2px solid ${borderColor}`,
                  backgroundColor: isSuperseded ? "transparent" : `${colors.cyan}06`,
                  opacity: isSuperseded ? 0.55 : 1,
                }}
              >
                <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider">
                  <span className="text-dim tabular-nums">{d.date}</span>
                  <span className="text-muted">·</span>
                  <span className="text-muted">{d.meeting}</span>
                  {d.project && (
                    <>
                      <span className="text-muted">·</span>
                      <span className="text-magenta">{d.project}</span>
                    </>
                  )}
                  <span
                    className="ml-auto px-1.5 py-0 rounded"
                    style={{
                      color: isSuperseded ? colors.dim : colors.green,
                      border: `1px solid ${isSuperseded ? colors.dim : colors.green}40`,
                    }}
                  >
                    {d.status}
                  </span>
                </div>
                {d.topic && (
                  <div
                    className="italic text-[10px] mt-1"
                    style={{ color: colors.muted, fontFamily: "ui-serif, Georgia, serif" }}
                  >
                    {d.topic}
                  </div>
                )}
                <div
                  className="text-text text-[11px] mt-0.5 leading-relaxed"
                  style={{ textDecoration: isSuperseded ? "line-through" : "none" }}
                >
                  {d.text}
                </div>
                {d.source && (
                  <div className="text-dim text-[9px] mt-1">source: {d.source}</div>
                )}
              </div>
            );
          })}
          {visible.length === 0 && (
            <div className="text-dim text-[10px] italic px-2 py-1">no decisions</div>
          )}
        </div>
      </div>
    );
  },
};
