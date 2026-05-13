// Shared color palettes for FLOAT components — single source of truth consumed
// by:
//   - @floatty/render-door (Solid renderer; imports for ContextStream + bbsCatalog)
//   - render-catalog/directives.ts ($projectColor + $ctxColor resolution)
//
// Keep map keys lowercase / kebab-case to match marker conventions
// ([project::rangle/pharmacy], [mode::debugging]).
//
// Unknown values resolve to UNKNOWN_COLOR by convention — matches the prior
// inline behavior in render-door/components.tsx@1851.

export const UNKNOWN_COLOR = "#888";

/** Color per project namespace — surfaces in ContextStream pills + project-keyed visualizations. */
export const STREAM_PROJECT_COLORS: Record<string, string> = {
  floatty: "#00e5ff",
  "floatty/doors-v2": "#00e5ff",
  "json-render": "#e040a0",
  "rangle/pharmacy": "#ffb300",
  "rangle/skills-for-change": "#98c379",
  "float-hub": "#98c379",
};

/** Color per work mode — surfaces in ContextStream timeline dots + mode-keyed pills. */
export const STREAM_MODE_COLORS: Record<string, string> = {
  debugging: "#ff4444",
  "session-archaeology": "#c678dd",
  digest: "#98c379",
  "float-loop": "#00e5ff",
  "incoming-requirements": "#ffb300",
  onboarding: "#98c379",
  meeting: "#e040a0",
  "post-meeting": "#e040a0",
};
