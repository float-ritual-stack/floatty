import {
  Compass, AlertTriangle, Info, AlertCircle, Search, Terminal,
  Paintbrush, Link2, ChevronRight, ExternalLink, FileText,
  Sparkles, Zap, Brain, GitBranch, Clock, ArrowRight, BarChart3,
  type LucideIcon,
} from "lucide-react";
import { colors } from "@/lib/constants";

export { colors, ArrowRight, ChevronRight, Link2, ExternalLink, Terminal, Paintbrush, Search, AlertTriangle, AlertCircle, Info, GitBranch, FileText, Zap };

// Icon lookup for string-based icon props from AI specs
const iconMap: Record<string, LucideIcon> = {
  Compass, AlertTriangle, Info, AlertCircle, Search, Terminal,
  Paintbrush, Link2, ChevronRight, ExternalLink, FileText,
  Sparkles, Zap, Brain, GitBranch, Clock, ArrowRight, BarChart3,
};

export function resolveIcon(name?: string): LucideIcon | null {
  return name ? iconMap[name] ?? null : null;
}

// Color token resolution — AI sends token names, renderer resolves
export function resolveColor(token?: string): string {
  if (!token) return colors.dim;
  return (colors as Record<string, string>)[token] ?? token;
}

export const severityColors: Record<string, string> = {
  info: colors.cyan,
  warning: colors.amber,
  critical: colors.red,
};

export const confidenceColors: Record<string, string> = {
  high: colors.green,
  medium: colors.amber,
  low: colors.coral,
};

export const variantStyles: Record<string, { borderColor: string; bg: string }> = {
  default: { borderColor: colors.border, bg: "" },
  highlight: { borderColor: colors.cyan, bg: "bg-cyan/5" },
  warning: { borderColor: colors.amber, bg: "bg-amber/5" },
};
