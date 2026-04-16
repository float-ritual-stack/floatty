// Color palette — matches the artifact's C object, exposed as Tailwind theme tokens
export const colors = {
  bg: "#0d0d0d",
  surface: "#141414",
  surface2: "#1a1a1a",
  hover: "#222222",
  border: "#2a2a2a",
  text: "#c9d1d9",
  muted: "#6e7681",
  dim: "#484f58",
  cyan: "#00e5ff",
  magenta: "#e040a0",
  coral: "#ff6b6b",
  amber: "#ffb300",
  green: "#98c379",
  purple: "#c678dd",
  red: "#ff4444",
} as const;

export const projectColors: Record<string, string> = {
  "client/project-a": colors.amber,
  floatty: colors.cyan,
  "float-hub": colors.magenta,
  float: colors.purple,
};

export const typeColors: Record<string, string> = {
  text: colors.dim,
  h1: colors.cyan,
  h2: colors.green,
  h3: colors.amber,
  ctx: colors.magenta,
  sh: colors.coral,
  artifact: colors.purple,
  quote: colors.amber,
};

export function getProject(block: {
  metadata?: { markers?: { markerType: string; value: string }[] } | null;
}): string | null {
  return (
    block?.metadata?.markers?.find((m) => m.markerType === "project")?.value?.trim() || null
  );
}

export function getProjectColor(project: string | null): string {
  return (project && projectColors[project]) || colors.dim;
}

export function getTypeColor(blockType: string): string {
  return typeColors[blockType] || colors.dim;
}

export function truncate(s: string | undefined | null, n = 120): string {
  if (!s) return "";
  const flat = s.replace(/\n/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "\u2026" : flat;
}

export function formatDate(ms: number | undefined | null): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString("en-CA");
}
