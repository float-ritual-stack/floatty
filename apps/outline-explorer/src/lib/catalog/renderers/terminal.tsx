/* eslint-disable @typescript-eslint/no-explicit-any */
import { colors, resolveColor } from "./shared";

export const terminalRenderers = {
  TuiPanel: ({ element, children }: any) => {
    const title: string | undefined = element.props.title;
    const titleColor = resolveColor(element.props.titleColor) ?? colors.cyan;
    return (
      <div className="relative mb-3 mt-2 px-3 pb-2 pt-3 font-mono" style={{ border: `1px solid ${colors.border}` }}>
        {title ? (
          <div
            className="absolute -top-[7px] left-3 px-1.5 text-[10px] font-semibold uppercase tracking-wide leading-none"
            style={{ backgroundColor: colors.bg, color: titleColor }}
          >
            {title}
          </div>
        ) : null}
        <div className="text-[11px] text-text leading-relaxed">{children}</div>
      </div>
    );
  },

  TuiStat: ({ element }: any) => {
    const valueColor = resolveColor(element.props.color) ?? colors.cyan;
    return (
      <div
        className="flex flex-col items-center justify-center mb-2 px-3 py-2 font-mono"
        style={{ border: `1px solid ${colors.border}`, backgroundColor: colors.surface }}
      >
        <div
          className="text-[10px] uppercase tracking-wider leading-none mb-1"
          style={{ color: colors.muted }}
        >
          {element.props.label}
        </div>
        <div
          className="text-[18px] font-bold leading-none"
          style={{ color: valueColor }}
        >
          {element.props.value}
        </div>
      </div>
    );
  },

  Code: ({ element }: any) => {
    const language: string | undefined = element.props.language;
    return (
      <div className="relative mb-2">
        {language ? (
          <div
            className="absolute top-1 right-2 px-1.5 text-[9px] uppercase tracking-wider leading-none rounded"
            style={{ color: colors.muted, backgroundColor: colors.surface2 }}
          >
            {language}
          </div>
        ) : null}
        <pre
          className="px-3 py-2 text-[11px] font-mono leading-relaxed overflow-x-auto rounded"
          style={{ backgroundColor: colors.surface2, border: `1px solid ${colors.border}` }}
        >
          <code style={{ color: colors.text }}>{element.props.content}</code>
        </pre>
      </div>
    );
  },
};
