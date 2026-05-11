/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import {
  colors,
  resolveColor,
  resolveIcon,
  Terminal,
  Paintbrush,
  Search,
} from "./shared";
import { projectColors } from "@/lib/constants";

// ── Callout type → glyph + accent color ──────────────────────────────────
// Glyph-only (no lucide dispatch) to stay clear of react-hooks/static-
// components — the rule flags dynamic <Icon /> rendering even when the
// lookup is stable. Glyphs carry the same affordance for the briefing
// aesthetic.
const CALLOUT_STYLES: Record<string, { color: string; glyph: string }> = {
  note: { color: colors.cyan, glyph: "✦" },
  info: { color: colors.cyan, glyph: "ℹ" },
  tip: { color: colors.green, glyph: "★" },
  success: { color: colors.green, glyph: "✓" },
  warning: { color: colors.amber, glyph: "⚠" },
  todo: { color: colors.amber, glyph: "☐" },
  danger: { color: colors.coral, glyph: "✗" },
  failure: { color: colors.coral, glyph: "✗" },
  bug: { color: colors.coral, glyph: "✗" },
  example: { color: colors.magenta, glyph: "◆" },
  question: { color: colors.cyan, glyph: "?" },
  quote: { color: colors.dim, glyph: "❝" },
  abstract: { color: colors.cyan, glyph: "◇" },
};

// Sizing pass-throughs for Stack — pulls width/flex/maxWidth/etc into inline style.
function stackSizingStyle(props: any): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (props.width) style.width = props.width;
  if (props.minWidth) style.minWidth = props.minWidth;
  if (props.maxWidth) style.maxWidth = props.maxWidth;
  if (props.flex) style.flex = props.flex;
  if (props.overflow) style.overflow = props.overflow;
  if (props.borderRight) style.borderRight = props.borderRight;
  if (props.padding) style.padding = props.padding;
  return style;
}

// Minimal inline markdown for EntryBody — mirrors typography.tsx Paragraph.
function renderInlineMarkdown(text: string, keyPrefix: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part: string, i: number) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-bold">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={`${keyPrefix}-${i}`}
          className="px-1 py-px rounded text-[10px] font-mono"
          style={{ backgroundColor: colors.surface2, color: colors.cyan }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-${i}`}>{part}</span>;
  });
}

// Internal collapsible Callout — needs useState for toggle behavior.
function CalloutRenderer({ element, children }: any) {
  const type = element.props.type ?? "note";
  const style = CALLOUT_STYLES[type] ?? CALLOUT_STYLES.note;
  const collapsible = !!element.props.collapsible;
  const [expanded, setExpanded] = useState(element.props.defaultExpanded ?? true);

  const showBody = !collapsible || expanded;

  return (
    <div
      className="my-2 rounded"
      style={{
        borderLeftWidth: 3,
        borderLeftColor: style.color,
        backgroundColor: `${style.color}10`,
      }}
    >
      {collapsible ? (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 px-2 py-1 cursor-pointer select-none text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((v: boolean) => !v)}
        >
          <span className="text-[12px] leading-none shrink-0" style={{ color: style.color }}>
            {style.glyph}
          </span>
          <span
            className="text-[11px] uppercase font-bold tracking-wider"
            style={{ color: style.color }}
          >
            {element.props.title ?? type}
          </span>
          <span className="ml-auto text-[10px]" style={{ color: colors.dim }} aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-2 py-1">
          <span className="text-[12px] leading-none shrink-0" style={{ color: style.color }}>
            {style.glyph}
          </span>
          <span
            className="text-[11px] uppercase font-bold tracking-wider"
            style={{ color: style.color }}
          >
            {element.props.title ?? type}
          </span>
        </div>
      )}
      {showBody && children && (
        <div className="px-2 pb-2 text-[11px]" style={{ color: colors.text }}>
          {children}
        </div>
      )}
    </div>
  );
}

export const blockPrimitiveRenderers = {
  HeadingBlock: ({ element, children }: any) => {
    const styles: Record<string, { size: string; color: string }> = {
      h1: { size: "text-[14px]", color: colors.cyan },
      h2: { size: "text-[12px]", color: colors.green },
      h3: { size: "text-[11px]", color: colors.amber },
    };
    const s = styles[element.props.level] ?? styles.h3;
    return (
      <div className={`${s.size} font-bold leading-snug`} style={{ color: s.color }}>
        {element.props.content}
        {children}
      </div>
    );
  },

  ContextMarker: ({ element }: any) => {
    const project = element.props.project;
    const projColor = project ? projectColors[project] ?? colors.dim : null;
    return (
      <div
        className="flex items-center gap-1.5 px-2 py-0.5 text-[11px]"
        style={{ borderLeftWidth: 2, borderLeftColor: colors.magenta }}
      >
        {element.props.timestamp && (
          <span className="text-muted text-[10px] shrink-0">
            {element.props.timestamp}
          </span>
        )}
        {project && (
          <span
            className="text-[9px] uppercase px-1 py-px rounded"
            style={{ color: projColor!, backgroundColor: `${projColor!}15` }}
          >
            {project}
          </span>
        )}
        {element.props.mode && (
          <span className="text-dim text-[9px]">{element.props.mode}</span>
        )}
        <span className="text-text truncate">
          {element.props.content
            .replace(/^ctx::\s*/, "")
            .replace(/\d{4}-\d{2}-\d{2}\s*@?\s*\d{1,2}:\d{2}\s*(AM|PM)?\s*/i, "")
            .replace(/\[project::[^\]]*\]\s*/g, "")
            .replace(/\[mode::[^\]]*\]\s*/g, "")
            .trim() || "ctx"}
        </span>
      </div>
    );
  },

  ShellCommand: ({ element, children }: any) => (
    <div
      className="px-2 py-0.5 text-[11px]"
      style={{ borderLeftWidth: 2, borderLeftColor: colors.coral }}
    >
      <div className="flex items-center gap-1">
        <Terminal size={10} style={{ color: colors.coral }} className="shrink-0" />
        <code className="text-text font-mono">
          {element.props.command}
        </code>
        {element.props.hasOutput && (
          <span className="text-dim text-[9px] ml-auto shrink-0">has output</span>
        )}
      </div>
      {children}
    </div>
  ),

  RenderPrompt: ({ element }: any) => (
    <div
      className="px-2 py-0.5 text-[11px]"
      style={{ borderLeftWidth: 2, borderLeftColor: colors.purple }}
    >
      <div className="flex items-center gap-1">
        <Paintbrush size={10} style={{ color: colors.purple }} className="shrink-0" />
        <span className="text-purple text-[9px] uppercase font-bold shrink-0">render</span>
        <span className="text-text italic truncate">{element.props.prompt}</span>
      </div>
    </div>
  ),

  SearchQuery: ({ element }: any) => (
    <div
      className="px-2 py-0.5 text-[11px]"
      style={{ borderLeftWidth: 2, borderLeftColor: colors.cyan }}
    >
      <div className="flex items-center gap-1">
        <Search size={10} style={{ color: colors.cyan }} className="shrink-0" />
        <span className="text-text">{element.props.query}</span>
        {element.props.resultCount != null && (
          <span className="text-dim text-[9px] ml-auto shrink-0">
            {element.props.resultCount} results
          </span>
        )}
      </div>
    </div>
  ),

  WikilinkChip: ({ element }: any) => (
    <span
      className="inline-flex items-center gap-1 bg-cyan/10 text-cyan px-1.5 py-0.5 rounded text-[10px] cursor-pointer hover:bg-cyan/20 transition-colors"
      data-wikilink-target={element.props.target}
    >
      [[{element.props.target}]]
    </span>
  ),

  OutlinerBlock: ({ element, children }: any) => (
    <div className="text-text text-[11px] whitespace-pre-wrap break-words">
      {element.props.content}
      {children}
    </div>
  ),

  // ── Door-promoted vocabulary (PR B) ────────────────────────────────────

  Stack: ({ element, children }: any) => {
    const direction = element.props.direction ?? "vertical";
    const gap = element.props.gap;
    const isHorizontal = direction === "horizontal";
    const style: React.CSSProperties = {
      ...stackSizingStyle(element.props),
      ...(gap != null ? { gap: `${gap}px` } : {}),
    };
    return (
      <div
        className={`flex ${isHorizontal ? "flex-row" : "flex-col"}`}
        style={style}
        data-section-id={element.props.sectionId || undefined}
      >
        {children}
      </div>
    );
  },

  Callout: CalloutRenderer,

  Hero: ({ element }: any) => {
    const cover = element.props.cover;
    const density = element.props.density ?? "full";
    const isCompact = density === "compact";

    const coverIcon = cover?.icon ? resolveIcon(cover.icon) : null;
    const coverBg =
      cover?.gradient || (cover?.color ? resolveColor(cover.color) : null);

    const titleSize = isCompact ? "text-[20px]" : "text-[28px]";
    const subSize = isCompact ? "text-[11px]" : "text-[13px]";
    const padding = isCompact ? "px-3 py-3" : "px-5 py-6";

    return (
      <div
        className="rounded overflow-hidden my-3"
        style={{
          backgroundColor: cover ? "transparent" : colors.surface,
          border: `1px solid ${colors.border}`,
        }}
      >
        {cover && (
          <div
            className="relative flex items-center justify-center"
            style={{
              background: coverBg || colors.surface2,
              height: isCompact ? 60 : 100,
            }}
          >
            {coverIcon &&
              (() => {
                const Icon = coverIcon;
                return (
                  <Icon
                    size={isCompact ? 28 : 40}
                    style={{ color: colors.text, opacity: 0.75 }}
                  />
                );
              })()}
          </div>
        )}
        <div className={padding}>
          {element.props.eyebrow && (
            <div
              className="text-[10px] uppercase tracking-wider font-bold mb-1.5"
              style={{ color: colors.muted }}
            >
              {element.props.eyebrow}
            </div>
          )}
          <h1
            className={`${titleSize} font-serif font-bold leading-tight`}
            style={{ color: colors.text, fontFamily: "Georgia, serif" }}
          >
            {element.props.title}
          </h1>
          {element.props.subtitle && (
            <p className={`${subSize} mt-2 leading-relaxed`} style={{ color: colors.muted }}>
              {element.props.subtitle}
            </p>
          )}
          {element.props.actions && element.props.actions.length > 0 && (
            <div className="flex flex-row gap-2 mt-3">
              {element.props.actions.map(
                (action: { label: string; href?: string; variant?: string }, i: number) => {
                  const isPrimary = action.variant !== "secondary";
                  const baseClasses =
                    "inline-flex items-center px-3 py-1.5 rounded text-[11px] font-bold transition-colors";
                  const style: React.CSSProperties = isPrimary
                    ? { backgroundColor: colors.cyan, color: colors.bg }
                    : {
                        backgroundColor: "transparent",
                        color: colors.text,
                        border: `1px solid ${colors.border}`,
                      };
                  if (action.href) {
                    return (
                      <a key={i} href={action.href} className={baseClasses} style={style}>
                        {action.label}
                      </a>
                    );
                  }
                  return (
                    <button key={i} className={baseClasses} style={style}>
                      {action.label}
                    </button>
                  );
                },
              )}
            </div>
          )}
        </div>
      </div>
    );
  },

  GalleryGrid: ({ element, children }: any) => {
    const columns = element.props.columns ?? "auto";
    const gap = element.props.gap ?? 14;
    const minCardWidth = element.props.minCardWidth ?? "260px";
    const gridTemplateColumns =
      columns === "auto"
        ? `repeat(auto-fit, minmax(${minCardWidth}, 1fr))`
        : `repeat(${columns}, minmax(0, 1fr))`;
    return (
      <div
        className="my-2"
        style={{
          display: "grid",
          gridTemplateColumns,
          gap: `${gap}px`,
        }}
      >
        {children}
      </div>
    );
  },

  CardCover: ({ element, children }: any) => {
    const cover = element.props.cover;
    const density = element.props.density ?? "comfortable";
    const isCompact = density === "compact";

    const coverIcon = cover?.icon ? resolveIcon(cover.icon) : null;
    const coverBg = cover?.gradient || (cover?.color ? resolveColor(cover.color) : null);
    const coverHeight = cover?.height ?? (isCompact ? "60px" : "84px");

    const titleSize = isCompact ? "text-[12px]" : "text-[13px]";
    const subSize = isCompact ? "text-[10px]" : "text-[11px]";
    const eyebrowSize = isCompact ? "text-[8px]" : "text-[9px]";
    const headerPadding = isCompact ? "px-2.5 py-2" : "px-3 py-2.5";

    const inner = (
      <div
        className="rounded overflow-hidden h-full flex flex-col transition-colors"
        style={{
          backgroundColor: colors.surface,
          border: `1px solid ${colors.border}`,
        }}
      >
        {cover && (
          <div
            className="relative flex items-center justify-center"
            style={{
              background: coverBg || colors.surface2,
              height: coverHeight,
            }}
          >
            {coverIcon &&
              (() => {
                const Icon = coverIcon;
                return (
                  <Icon
                    size={isCompact ? 20 : 26}
                    style={{ color: colors.text, opacity: 0.75 }}
                  />
                );
              })()}
          </div>
        )}
        <div className={`${headerPadding} flex flex-col flex-1`}>
          {element.props.eyebrow && (
            <div
              className={`${eyebrowSize} uppercase tracking-wider font-bold mb-1`}
              style={{ color: colors.muted }}
            >
              {element.props.eyebrow}
            </div>
          )}
          <div
            className={`${titleSize} font-bold leading-tight`}
            style={{ color: colors.text }}
          >
            {element.props.title}
          </div>
          {element.props.subtitle && (
            <div
              className={`${subSize} mt-1 leading-snug`}
              style={{ color: colors.muted }}
            >
              {element.props.subtitle}
            </div>
          )}
          {element.props.properties && element.props.properties.length > 0 && (
            <div className="flex flex-row flex-wrap gap-1 mt-2">
              {element.props.properties.map(
                (p: { label: string; value: string; color?: string }, i: number) => {
                  const c = p.color ? resolveColor(p.color) : colors.dim;
                  return (
                    <span
                      key={i}
                      className="text-[9px] px-1.5 py-px rounded"
                      style={{
                        color: c,
                        backgroundColor: `${c}15`,
                      }}
                    >
                      <span style={{ color: colors.muted }}>{p.label}:</span> {p.value}
                    </span>
                  );
                },
              )}
            </div>
          )}
          {children && <div className="mt-2 text-[11px]">{children}</div>}
          {element.props.footer && (
            <div
              className="mt-auto pt-2 text-[10px]"
              style={{
                color: colors.dim,
                borderTop: `1px dashed ${colors.border}`,
              }}
            >
              {element.props.footer}
            </div>
          )}
        </div>
      </div>
    );

    if (element.props.href) {
      return (
        <a
          href={element.props.href}
          className="block hover:opacity-90 transition-opacity no-underline"
        >
          {inner}
        </a>
      );
    }
    return inner;
  },

  Card: ({ element, children }: any) => (
    <div
      className="rounded p-3 my-2"
      style={{
        backgroundColor: colors.surface,
        border: `1px solid ${colors.border}`,
      }}
    >
      {element.props.title && (
        <div
          className="text-[12px] font-bold mb-1"
          style={{ color: colors.text }}
        >
          {element.props.title}
        </div>
      )}
      {element.props.subtitle && (
        <div className="text-[10px] mb-2" style={{ color: colors.muted }}>
          {element.props.subtitle}
        </div>
      )}
      {children && <div className="text-[11px]">{children}</div>}
    </div>
  ),

  QuoteBlock: ({ element }: any) => {
    const type = element.props.type ?? "quote";
    const accent =
      type === "insight" ? colors.cyan : type === "note" ? colors.amber : colors.dim;
    return (
      <blockquote
        className="my-2 px-3 py-2"
        style={{
          borderLeftWidth: 3,
          borderLeftColor: accent,
          backgroundColor: `${accent}08`,
        }}
      >
        <div
          className="text-[12px] italic leading-relaxed"
          style={{ color: colors.text, fontFamily: "Georgia, serif" }}
        >
          {element.props.text}
        </div>
        {element.props.attribution && (
          <div className="text-[10px] mt-1.5" style={{ color: colors.muted }}>
            — {element.props.attribution}
          </div>
        )}
      </blockquote>
    );
  },

  EntryHeader: ({ element }: any) => {
    const type = element.props.type;
    const badgeColor =
      type === "synthesis"
        ? colors.cyan
        : type === "archaeology"
        ? colors.amber
        : colors.magenta;
    return (
      <header
        className="mb-3 pb-3"
        style={{ borderBottom: `1px solid ${colors.border}` }}
      >
        <div className="flex items-center gap-2 mb-2">
          <span
            className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-px rounded"
            style={{ color: badgeColor, backgroundColor: `${badgeColor}15` }}
          >
            {type}
          </span>
          {element.props.board && (
            <span className="text-[9px]" style={{ color: colors.muted }}>
              {element.props.board}
            </span>
          )}
        </div>
        <h1
          className="text-[18px] font-bold leading-tight"
          style={{ color: colors.text, fontFamily: "Georgia, serif" }}
        >
          {element.props.title}
        </h1>
        <div
          className="flex flex-row gap-2 mt-1.5 text-[10px]"
          style={{ color: colors.muted }}
        >
          <span>{element.props.date}</span>
          {element.props.author && (
            <>
              <span>·</span>
              <span>{element.props.author}</span>
            </>
          )}
        </div>
      </header>
    );
  },

  EntryBody: ({ element }: any) => {
    const md: string = element.props.markdown ?? "";
    // Split on blank-line boundaries → paragraphs. Inline markdown handled per-paragraph.
    const paragraphs = md.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    return (
      <div
        className="text-[12px] leading-relaxed"
        style={{ color: colors.text, fontFamily: "Georgia, serif" }}
      >
        {paragraphs.map((para, i) => (
          <p key={i} className="mb-3 whitespace-pre-wrap">
            {renderInlineMarkdown(para, `p${i}`)}
          </p>
        ))}
      </div>
    );
  },

  Ellipsis: () => (
    <div
      className="text-center my-3 text-[14px] tracking-[0.5em] select-none"
      style={{ color: colors.dim }}
    >
      · · ·
    </div>
  ),
};

// No icon warm-up needed here. CALLOUT_STYLES is glyph-only; Hero and
// CardCover route their cover.icon prop through resolveIcon() which reads
// the iconMap populated in ./shared on module load.
