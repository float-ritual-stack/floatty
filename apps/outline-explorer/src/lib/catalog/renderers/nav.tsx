/* eslint-disable @typescript-eslint/no-explicit-any */
import { colors, ArrowRight, resolveIcon, resolveColor } from "./shared";


export const navRenderers = {
  Row: ({ children }: any) => (
    <div className="flex flex-wrap gap-1.5 mb-2">{children}</div>
  ),

  Timeline: ({ children }: any) => (
    <div className="flex flex-col gap-0 mb-2">{children}</div>
  ),

  BlockRef: ({ element }: any) => (
    <span
      className="inline-flex items-center gap-1 bg-cyan/10 text-cyan px-1.5 py-0.5 rounded text-[10px] cursor-pointer hover:bg-cyan/20 transition-colors"
      data-page={element.props.page}
      data-block-id={element.props.blockId}
    >
      [[{element.props.title}]]
    </span>
  ),

  WalkChip: ({ element }: any) => (
    <span
      className="inline-flex items-center gap-1 bg-purple/10 border border-purple/25 text-purple px-2 py-0.5 rounded text-[11px] cursor-pointer hover:bg-purple/25 hover:border-purple/40 hover:scale-[1.02] transition-all"
      data-walk-page={element.props.page}
      title={element.props.reason}
    >
      <ArrowRight size={10} />
      {element.props.page}
    </span>
  ),

  Chip: ({ element }: any) => {
    const c = resolveColor(element.props.color);
    const Icon = resolveIcon(element.props.icon);
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono transition-colors"
        style={{
          color: c,
          backgroundColor: `${c}12`,
          border: `1px solid ${c}30`,
          cursor: element.props.clickable ? "pointer" : "default",
        }}
      >
        {Icon && <Icon size={9} />}
        {element.props.label}
      </span>
    );
  },

  SectionLabel: ({ element, children }: any) => {
    const c = resolveColor(element.props.color);
    const Icon = resolveIcon(element.props.icon);
    return (
      <div>
        <div className="flex items-center gap-1.5 mb-2 mt-4">
          {Icon && <Icon size={11} style={{ color: c }} />}
          <span
            className="text-[9px] font-mono uppercase tracking-widest"
            style={{ color: c }}
          >
            {element.props.label}
          </span>
          <div className="flex-1 h-px" style={{ backgroundColor: `${c}20` }} />
        </div>
        <div className="flex flex-wrap gap-1.5">{children}</div>
      </div>
    );
  },

  ConfidenceDot: ({ element }: any) => {
    const dotColors: Record<string, string> = {
      high: colors.green,
      medium: colors.amber,
      low: colors.coral,
      partial: colors.purple,
    };
    const c = dotColors[element.props.level] ?? colors.dim;
    return (
      <span className="inline-flex items-center gap-1 text-[9px] font-mono" style={{ color: c }}>
        <span
          className="rounded-full"
          style={{ width: 6, height: 6, backgroundColor: c }}
        />
        {element.props.level}
      </span>
    );
  },

  StatPill: ({ element }: any) => {
    const c = resolveColor(element.props.color);
    return (
      <div
        className="inline-flex flex-col items-center px-2.5 py-1 rounded"
        style={{ backgroundColor: `${c}05`, border: `1px solid ${c}10` }}
      >
        <span className="text-[12px] font-medium font-mono leading-tight" style={{ color: c }}>
          {element.props.value}
        </span>
        <span className="text-[7px] font-mono uppercase tracking-wide leading-tight" style={{ color: colors.dim }}>
          {element.props.label}
        </span>
      </div>
    );
  },

  TimelineEvent: ({ element }: any) => {
    const c = resolveColor(element.props.color);
    return (
      <div className="flex items-center gap-2 py-0.5">
        <span className="rounded-full shrink-0" style={{ width: 8, height: 8, backgroundColor: c }} />
        <span className="text-muted text-[10px] font-mono w-12 shrink-0">{element.props.time}</span>
        <span className="text-text text-[11px] font-mono">{element.props.label}</span>
      </div>
    );
  },

  StepIndicator: ({ element }: any) => (
    <div
      className="flex items-center gap-2 px-2 py-1 bg-surface text-[10px] mb-0.5"
      style={{ borderLeftWidth: 2, borderLeftColor: colors.amber }}
    >
      <span className="text-amber uppercase font-bold">
        {element.props.tool}
      </span>
      <span className="text-text">{element.props.target}</span>
      {element.props.result && (
        <span className="text-muted ml-auto">{element.props.result}</span>
      )}
    </div>
  ),

  EnrichedStepCard: ({ element }: any) => {
    const toolColors: Record<string, string> = {
      expand_page: colors.cyan,
      search_blocks: colors.amber,
      get_inbound: colors.purple,
      get_block: colors.green,
      suggest_walks: colors.magenta,
      qmd_search: colors.coral,
    };
    const c = toolColors[element.props.tool] ?? colors.dim;
    return (
      <details className="mb-1.5">
        <summary
          className="flex items-start gap-2 px-2.5 py-1.5 bg-surface cursor-pointer list-none [&::-webkit-details-marker]:hidden"
          style={{ borderLeft: `3px solid ${c}`, borderRadius: "0 4px 4px 0" }}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-[10px] font-mono uppercase font-semibold" style={{ color: c }}>
                {element.props.tool}
              </span>
              <span className="text-text text-[11px] font-mono">{element.props.target}</span>
            </div>
            {element.props.reason && (
              <div className="text-dim text-[10px] font-mono">{element.props.reason}</div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {element.props.result && (
              <span className="text-muted text-[10px] font-mono">{element.props.result}</span>
            )}
            {element.props.preview && (
              <span className="text-[9px] font-mono underline" style={{ color: c }}>
                preview
              </span>
            )}
          </div>
        </summary>
        {element.props.preview && (
          <div
            className="px-2.5 py-1.5 bg-bg text-muted text-[10px] font-mono leading-relaxed whitespace-pre-wrap max-h-[120px] overflow-y-auto"
            style={{ borderLeft: `3px solid ${c}30`, borderRadius: "0 0 4px 0" }}
          >
            {element.props.preview}
          </div>
        )}
      </details>
    );
  },

  // ─── Door-promoted vocabulary (PR B) ──────────────────────────────────────
  // React parity impls for shared.ts entries. Solid counterparts live in
  // packages/render-door/src/components.tsx.

  DocLayout: ({ children }: any) => (
    <div
      className="flex font-mono"
      style={{
        minHeight: "400px",
        height: "100%",
        backgroundColor: colors.bg,
        color: colors.text,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  ),

  NavBrand: ({ element }: any) => (
    <div
      className="font-mono"
      style={{
        padding: "16px",
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div
        className="font-bold"
        style={{
          fontSize: "13px",
          color: colors.magenta,
          letterSpacing: "2px",
        }}
      >
        {element.props.title}
      </div>
      {element.props.subtitle && (
        <div
          style={{
            fontSize: "10px",
            color: colors.muted,
            marginTop: "2px",
          }}
        >
          {element.props.subtitle}
        </div>
      )}
    </div>
  ),

  NavSection: ({ element, children }: any) => {
    const c = resolveColor(element.props.accent);
    return (
      <div>
        <div
          className="font-mono uppercase"
          style={{
            padding: "12px 0 4px 16px",
            fontSize: "9px",
            letterSpacing: "3px",
            color: c,
          }}
        >
          {element.props.label}
        </div>
        {children}
      </div>
    );
  },

  NavItem: ({ element }: any) => {
    const active = !!element.props.active;
    return (
      <div
        data-nav-id={element.props.id}
        className="font-mono cursor-pointer transition-all"
        style={{
          display: "block",
          padding: "6px 16px",
          fontSize: "12px",
          color: active ? "#fff" : colors.text,
          borderLeft: `3px solid ${active ? colors.magenta : "transparent"}`,
          backgroundColor: active ? colors.surface2 : "transparent",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            marginRight: "8px",
            verticalAlign: "middle",
            backgroundColor: active ? colors.magenta : "transparent",
            boxShadow: active ? `0 0 6px ${colors.magenta}` : "none",
          }}
        />
        {element.props.label}
      </div>
    );
  },

  NavFooter: ({ element }: any) => {
    // Mirror the Solid side's inline-markdown handling without ever rendering
    // raw HTML: split on **bold** / `code` / [[wikilink]] tokens and render
    // structured spans. Spec content is AI-generated and goes through
    // catalog.validate() upstream, but rendering unsanitized HTML at the
    // renderer layer is still the wrong default.
    const text: string = element.props.content ?? "";
    const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/g);
    return (
      <div
        className="font-mono"
        style={{
          padding: "12px 16px",
          borderTop: `1px solid ${colors.border}`,
          fontSize: "9px",
          color: colors.muted,
          lineHeight: 1.8,
          marginTop: "auto",
        }}
      >
        {parts.map((part: string, i: number) => {
          if (part.startsWith("**") && part.endsWith("**")) {
            return <strong key={i}>{part.slice(2, -2)}</strong>;
          }
          if (part.startsWith("`") && part.endsWith("`")) {
            return (
              <code key={i} style={{ color: colors.cyan }}>{part.slice(1, -1)}</code>
            );
          }
          if (part.startsWith("[[") && part.endsWith("]]")) {
            const target = part.slice(2, -2);
            return (
              <span key={i} style={{ color: colors.cyan }}>{target}</span>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </div>
    );
  },

  TagBar: ({ element, children }: any) => (
    <div
      className="flex flex-wrap"
      style={{
        gap: `${element.props.gap ?? 6}px`,
        marginBottom: "28px",
      }}
    >
      {children}
    </div>
  ),

  TagChip: ({ element }: any) => {
    const active = !!element.props.active;
    return (
      <span
        className="font-mono uppercase cursor-pointer transition-all"
        style={{
          fontSize: "10px",
          letterSpacing: "1px",
          padding: "3px 10px",
          border: `1px solid ${active ? colors.magenta : colors.border}`,
          color: active ? colors.magenta : colors.text,
          backgroundColor: active ? "rgba(224,64,160,0.12)" : "transparent",
        }}
      >
        {element.props.name}
      </span>
    );
  },

  RefSection: ({ element, children }: any) => (
    <div
      style={{
        marginTop: "12px",
        paddingTop: "12px",
        borderTop: `1px solid ${colors.border}`,
      }}
    >
      <div
        className="font-mono uppercase"
        style={{
          fontSize: "10px",
          letterSpacing: "3px",
          color: colors.magenta,
          marginBottom: "12px",
        }}
      >
        {element.props.label || "CONNECTED"} →
      </div>
      {children}
    </div>
  ),

  RefCard: ({ element }: any) => (
    <div
      className="cursor-pointer transition-all"
      style={{
        display: "block",
        padding: "10px 14px",
        marginBottom: "6px",
        border: `1px solid ${colors.border}`,
        backgroundColor: "transparent",
      }}
      data-ref-id={element.props.id}
    >
      <div
        className="font-mono uppercase"
        style={{
          fontSize: "9px",
          letterSpacing: "2px",
          color: colors.muted,
        }}
      >
        {element.props.type.replace("-", " ")}
      </div>
      <div
        className="font-mono"
        style={{
          fontSize: "13px",
          color: colors.text,
          marginTop: "2px",
        }}
      >
        {element.props.title}
      </div>
    </div>
  ),

  Breadcrumb: ({ element }: any) => (
    <div
      className="font-mono cursor-pointer transition-opacity hover:opacity-100"
      style={{
        fontSize: "11px",
        color: colors.cyan,
        marginBottom: "20px",
        opacity: 0.7,
      }}
    >
      ← {element.props.label}
    </div>
  ),
};
