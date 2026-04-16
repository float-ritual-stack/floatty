/* eslint-disable @typescript-eslint/no-explicit-any */
import { colors, Terminal, Paintbrush, Search } from "./shared";
import { projectColors } from "@/lib/constants";


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
};
