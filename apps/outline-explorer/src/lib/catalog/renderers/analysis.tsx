/* eslint-disable @typescript-eslint/no-explicit-any */
import { colors, severityColors, confidenceColors, variantStyles, AlertTriangle, AlertCircle, Info, Link2, FileText, GitBranch, Zap, ExternalLink, ChevronRight, resolveColor } from "./shared";
import type { LucideIcon } from "lucide-react";

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
              {element.props.body.slice(0, 80)}{element.props.body.length > 80 ? "\u2026" : ""}
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
};
