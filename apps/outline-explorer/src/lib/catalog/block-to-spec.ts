import type { Block } from "../types";
import { getProject } from "../constants";

interface SpecElement {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
}

interface Spec {
  root: string;
  elements: Record<string, SpecElement>;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Extract YYYY-MM-DD @ HH:MM (AM/PM) from a ctx:: line */
function parseCtxTimestamp(content: string): string | undefined {
  const m = content.match(
    /(\d{4}-\d{2}-\d{2})\s*@?\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i
  );
  return m ? `${m[1]} ${m[2].trim()}` : undefined;
}

/** Extract [mode::X] value from content */
function parseMode(content: string): string | undefined {
  const m = content.match(/\[mode::([^\]]+)\]/);
  return m ? m[1].trim() : undefined;
}

/**
 * Split text into alternating plain-text and wikilink segments.
 * Returns element entries to merge into the spec, plus the child ID list.
 */
function wikilinkSegments(
  text: string,
  prefix: string
): { elements: Record<string, SpecElement>; childIds: string[] } | null {
  const parts: { text?: string; target?: string }[] = [];
  let last = 0;

  for (const match of text.matchAll(WIKILINK_RE)) {
    const idx = match.index!;
    if (idx > last) parts.push({ text: text.slice(last, idx) });
    parts.push({ target: match[1] });
    last = idx + match[0].length;
  }
  if (parts.length === 0) return null;
  if (last < text.length) parts.push({ text: text.slice(last) });

  const elements: Record<string, SpecElement> = {};
  const childIds: string[] = [];
  let i = 0;

  for (const part of parts) {
    const id = `${prefix}${i++}`;
    childIds.push(id);
    if (part.target) {
      elements[id] = {
        type: "WikilinkChip",
        props: { target: part.target },
      };
    } else {
      elements[id] = {
        type: "Prose",
        props: { content: part.text! },
      };
    }
  }

  return { elements, childIds };
}

/**
 * Convert a Block to a json-render Spec based on its blockType and content.
 * Pure function — no side effects.
 */
export function blockToSpec(block: Block, truncateAt?: number): Spec {
  const type = block.blockType;
  let content = block.content ?? "";
  if (truncateAt && content.length > truncateAt) {
    content = content.slice(0, truncateAt) + "\u2026";
  }

  // ── Headings ──────────────────────────────────────────────────────
  if (type === "h1" || type === "h2" || type === "h3") {
    const wl = wikilinkSegments(content, "w");
    if (wl) {
      return {
        root: "b",
        elements: {
          b: {
            type: "HeadingBlock",
            props: { level: type, content: "" },
            children: wl.childIds,
          },
          ...wl.elements,
        },
      };
    }
    return {
      root: "b",
      elements: {
        b: { type: "HeadingBlock", props: { level: type, content } },
      },
    };
  }

  // ── ctx:: markers ─────────────────────────────────────────────────
  if (content.startsWith("ctx::")) {
    const project = getProject(block) ?? undefined;
    const timestamp = parseCtxTimestamp(content);
    const mode = parseMode(content);
    return {
      root: "b",
      elements: {
        b: {
          type: "ContextMarker",
          props: { content, timestamp, project, mode },
        },
      },
    };
  }

  // ── sh:: commands ─────────────────────────────────────────────────
  if (content.startsWith("sh::")) {
    return {
      root: "b",
      elements: {
        b: {
          type: "ShellCommand",
          props: {
            command: content.replace(/^sh::\s*/, ""),
            hasOutput: (block.childIds?.length ?? 0) > 0,
          },
        },
      },
    };
  }

  // ── render:: prompts ──────────────────────────────────────────────
  if (content.startsWith("render::")) {
    return {
      root: "b",
      elements: {
        b: {
          type: "RenderPrompt",
          props: {
            prompt: content.replace(/^render::\s*/, ""),
            hasOutput: (block.childIds?.length ?? 0) > 0,
          },
        },
      },
    };
  }

  // ── search:: / pick:: queries ─────────────────────────────────────
  if (content.startsWith("search::") || content.startsWith("pick::")) {
    return {
      root: "b",
      elements: {
        b: {
          type: "SearchQuery",
          props: {
            query: content.replace(/^(?:search|pick)::\s*/, ""),
          },
        },
      },
    };
  }

  // ── Default: OutlinerBlock with inline wikilinks ──────────────────
  const wl = wikilinkSegments(content, "w");
  if (wl) {
    return {
      root: "b",
      elements: {
        b: {
          type: "OutlinerBlock",
          props: { content: "", blockType: type, blockId: block.id },
          children: wl.childIds,
        },
        ...wl.elements,
      },
    };
  }

  return {
    root: "b",
    elements: {
      b: {
        type: "OutlinerBlock",
        props: { content, blockType: type, blockId: block.id },
      },
    },
  };
}
