/* eslint-disable @typescript-eslint/no-explicit-any */
import { colors, resolveColor } from "./shared";

export const typographyRenderers = {
  Heading: ({ element, children }: any) => {
    const level = element.props.level ?? 1;
    const styles: Record<number, { size: string; color: string; weight: string }> = {
      1: { size: "text-[16px]", color: colors.cyan, weight: "font-bold" },
      2: { size: "text-[13px]", color: colors.text, weight: "font-semibold" },
      3: { size: "text-[11px]", color: colors.muted, weight: "font-semibold" },
    };
    const s = styles[level] ?? styles[3];
    return (
      <div>
        <div className={`${s.size} ${s.weight} font-mono leading-snug mt-3 mb-1.5`} style={{ color: s.color }}>
          {element.props.content}
        </div>
        {children}
      </div>
    );
  },

  Paragraph: ({ element }: any) => {
    const parts = element.props.content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return (
      <p className="text-text text-[11px] font-mono leading-relaxed mb-2">
        {parts.map((part: string, i: number) => {
          if (part.startsWith("**") && part.endsWith("**")) {
            return <strong key={i} className="text-text font-bold">{part.slice(2, -2)}</strong>;
          }
          if (part.startsWith("`") && part.endsWith("`")) {
            return (
              <code key={i} className="px-1 py-px rounded text-[10px]" style={{ backgroundColor: colors.surface2, color: colors.cyan }}>
                {part.slice(1, -1)}
              </code>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </p>
    );
  },

  Bold: ({ element }: any) => (
    <strong className="text-text text-[11px] font-mono font-bold">{element.props.content}</strong>
  ),

  InlineCode: ({ element }: any) => (
    <code className="px-1 py-px rounded text-[10px] font-mono" style={{ backgroundColor: colors.surface2, color: colors.cyan }}>
      {element.props.content}
    </code>
  ),

  BulletList: ({ element }: any) => (
    <ul className="text-text text-[11px] font-mono leading-relaxed mb-2 pl-4">
      {(element.props.items ?? []).map((item: string, i: number) => (
        <li key={i} className="mb-0.5" style={{ listStyleType: "disc" }}>{item}</li>
      ))}
    </ul>
  ),

  StatusLine: ({ element }: any) => {
    const c = resolveColor(element.props.color);
    return (
      <div className="text-[11px] font-mono leading-relaxed mb-1.5">
        <span style={{ color: c }} className="font-bold">▸ {element.props.label}: </span>
        <span className="text-text">{element.props.content}</span>
      </div>
    );
  },

  Divider: () => (
    <hr className="my-3" style={{ borderColor: `${colors.border}80`, borderTopWidth: 1 }} />
  ),

  Prose: ({ element }: any) => {
    const parts = element.props.content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
    return (
      <div className="text-text text-[11px] leading-relaxed whitespace-pre-wrap break-words px-2 py-1">
        {parts.map((part: string, i: number) => {
          if (part.startsWith("**") && part.endsWith("**")) {
            return <strong key={i} className="font-bold">{part.slice(2, -2)}</strong>;
          }
          if (part.startsWith("`") && part.endsWith("`")) {
            return (
              <code key={i} className="px-1 py-px rounded text-[10px]" style={{ backgroundColor: colors.surface2, color: colors.cyan }}>
                {part.slice(1, -1)}
              </code>
            );
          }
          return <span key={i}>{part}</span>;
        })}
      </div>
    );
  },
};
