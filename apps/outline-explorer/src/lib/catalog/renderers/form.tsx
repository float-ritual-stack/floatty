/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from "react";
import { useBoundProp } from "@json-render/react";
import { colors } from "./shared";

// Form renderers — bound-prop variants must read through useBoundProp so that
// `{ $bindState: "/path" }` descriptors resolve at render time (and write
// back when the user mutates the input). Without this the agent's earlier
// readStringProp helper returned "" for every binding descriptor, which
// silently broke TextInput / TextArea display and FilterButtons / TabNav
// active state (CodeRabbit Major on PR #307).

function ButtonRenderer({ element, emit }: any) {
  const variant: "primary" | "secondary" | "danger" = element.props.variant ?? "primary";

  const styles: Record<string, { bg: string; color: string; border: string }> = {
    primary: { bg: colors.cyan, color: colors.bg, border: colors.cyan },
    secondary: { bg: colors.surface2, color: colors.text, border: colors.border },
    danger: { bg: colors.coral, color: colors.bg, border: colors.coral },
  };
  const s = styles[variant] ?? styles.primary;

  return (
    <button
      type="button"
      className="px-3 py-1.5 rounded text-[11px] font-mono font-semibold leading-none transition-opacity hover:opacity-80"
      style={{
        backgroundColor: s.bg,
        color: s.color,
        borderWidth: 1,
        borderColor: s.border,
      }}
      onClick={() => emit?.("press")}
    >
      {element.props.label}
    </button>
  );
}

function TextInputRenderer({ element, bindings }: any) {
  const label = element.props.label as string | undefined;
  const placeholder = element.props.placeholder as string | undefined;
  const [value, setValue] = useBoundProp<string>(
    typeof element.props.value === "string" ? element.props.value : undefined,
    bindings?.value,
  );

  return (
    <div className="mb-2">
      {label && (
        <label
          className="block text-[10px] font-mono uppercase tracking-wider mb-1"
          style={{ color: colors.muted }}
        >
          {label}
        </label>
      )}
      <input
        type="text"
        value={value ?? ""}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        className="w-full px-2 py-1.5 rounded text-[11px] font-mono leading-snug outline-none focus:outline-none"
        style={{
          backgroundColor: colors.surface,
          color: colors.text,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      />
    </div>
  );
}

function TextAreaRenderer({ element, bindings }: any) {
  const label = element.props.label as string | undefined;
  const placeholder = element.props.placeholder as string | undefined;
  const rows = (element.props.rows as number | undefined) ?? 4;
  const [value, setValue] = useBoundProp<string>(
    typeof element.props.value === "string" ? element.props.value : undefined,
    bindings?.value,
  );

  return (
    <div className="mb-2">
      {label && (
        <label
          className="block text-[10px] font-mono uppercase tracking-wider mb-1"
          style={{ color: colors.muted }}
        >
          {label}
        </label>
      )}
      <textarea
        value={value ?? ""}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full px-2 py-1.5 rounded text-[11px] font-mono leading-relaxed outline-none focus:outline-none resize-y"
        style={{
          backgroundColor: colors.surface,
          color: colors.text,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      />
    </div>
  );
}

function CollapsibleSectionRenderer({ element, children }: any) {
  const initialExpanded = element.props.expanded === undefined ? true : !!element.props.expanded;
  const [expanded, setExpanded] = useState<boolean>(initialExpanded);

  const titleColor =
    typeof element.props.color === "string"
      ? (colors as Record<string, string>)[element.props.color] ?? element.props.color
      : colors.cyan;
  const count = element.props.count as number | undefined;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left text-[11px] font-mono font-semibold transition-colors hover:bg-hover"
        style={{ color: titleColor }}
      >
        <span
          className="inline-block transition-transform"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            color: titleColor,
          }}
          aria-hidden="true"
        >
          ▸
        </span>
        <span className="flex-1">{element.props.title}</span>
        {typeof count === "number" && (
          <span className="text-[10px] font-normal" style={{ color: colors.muted }}>
            {count}
          </span>
        )}
      </button>
      {expanded && <div className="pl-3 mt-1 space-y-1">{children}</div>}
    </div>
  );
}

function FilterButtonsRenderer({ element, bindings }: any) {
  const filters = (element.props.filters ?? []) as Array<{
    id: string;
    label: string;
    count?: number;
  }>;
  const [active, setActive] = useBoundProp<string>(
    typeof element.props.active === "string" ? element.props.active : undefined,
    bindings?.active,
  );

  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {filters.map((f) => {
        const isActive = f.id === active;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => setActive(f.id)}
            aria-pressed={isActive}
            className="px-2 py-1 rounded text-[10px] font-mono leading-none transition-colors"
            style={{
              backgroundColor: isActive ? `${colors.cyan}20` : colors.surface,
              color: isActive ? colors.cyan : colors.text,
              borderWidth: 1,
              borderColor: isActive ? colors.cyan : colors.border,
            }}
          >
            <span>{f.label}</span>
            {typeof f.count === "number" && (
              <span className="ml-1.5" style={{ color: isActive ? colors.cyan : colors.muted }}>
                {f.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TabNavRenderer({ element, bindings }: any) {
  const tabs = (element.props.tabs ?? []) as Array<{ id: string; label: string }>;
  const variant: "horizontal" | "pills" = element.props.variant ?? "horizontal";
  const [active, setActive] = useBoundProp<string>(
    typeof element.props.active === "string" ? element.props.active : undefined,
    bindings?.active,
  );

  if (variant === "pills") {
    return (
      <div className="flex flex-wrap gap-1 mb-2">
        {tabs.map((t) => {
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              aria-pressed={isActive}
              className="px-2.5 py-1 rounded-full text-[10px] font-mono leading-none transition-colors"
              style={{
                backgroundColor: isActive ? colors.cyan : colors.surface,
                color: isActive ? colors.bg : colors.text,
                borderWidth: 1,
                borderColor: isActive ? colors.cyan : colors.border,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    );
  }

  // horizontal (default) — underline variant
  return (
    <div
      className="flex items-end gap-3 mb-2"
      style={{ borderBottomWidth: 1, borderBottomColor: colors.border }}
    >
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t.id)}
            aria-pressed={isActive}
            className="pb-1.5 text-[11px] font-mono leading-none transition-colors"
            style={{
              color: isActive ? colors.cyan : colors.muted,
              borderBottomWidth: 2,
              borderBottomColor: isActive ? colors.cyan : "transparent",
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const formRenderers = {
  Button: ButtonRenderer,
  TextInput: TextInputRenderer,
  TextArea: TextAreaRenderer,
  CollapsibleSection: CollapsibleSectionRenderer,
  FilterButtons: FilterButtonsRenderer,
  TabNav: TabNavRenderer,
};
