/**
 * block-to-spec — Convert floatty outline blocks into json-render Specs.
 *
 * Ported from floatty-ai-outline-explorer's block-to-spec.ts, adapted for
 * the ink catalog's standard components (Heading, Text, Badge, Markdown, etc.)
 * instead of the explorer's domain-specific renderers.
 *
 * Pure function — no side effects, no network calls.
 */

import type { Spec } from "@json-render/core";

// ── Types ──────────────────────────────────────────────────────────────

/** Minimal block shape — matches what ink-chat tools return from floatty API */
export interface OutlineBlock {
  id: string;
  content: string;
  depth?: number;
  blockType?: string;
  childIds?: string[];
  metadata?: {
    markers?: Array<{ markerType: string; value?: string }>;
    renderedMarkdown?: string;
  } | null;
}

// ── Parsers ────────────────────────────────────────────────────────────

/** Extract YYYY-MM-DD @ HH:MM (AM/PM) from a ctx:: line */
function parseCtxTimestamp(content: string): string | undefined {
  const m = content.match(
    /(\d{4}-\d{2}-\d{2})\s*@?\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
  );
  return m ? `${m[1]} ${m[2].trim()}` : undefined;
}

/** Extract [mode::X] value */
function parseMode(content: string): string | undefined {
  const m = content.match(/\[mode::([^\]]+)\]/);
  return m ? m[1].trim() : undefined;
}

/** Extract [project::X] value from content or metadata markers */
function parseProject(block: OutlineBlock): string | undefined {
  // Try metadata markers first (structured)
  const marker = block.metadata?.markers?.find(
    (m) => m.markerType === "project",
  );
  if (marker?.value) return marker.value.trim();
  // Fallback: parse from content
  const m = block.content.match(/\[project::([^\]]+)\]/);
  return m ? m[1].trim() : undefined;
}

/** Clean ctx:: content by stripping parsed markers */
function cleanCtxContent(content: string): string {
  return content
    .replace(/^ctx::\s*/, "")
    .replace(/\d{4}-\d{2}-\d{2}\s*@?\s*\d{1,2}:\d{2}\s*(?:AM|PM)?\s*/i, "")
    .replace(/\[project::[^\]]*\]\s*/g, "")
    .replace(/\[mode::[^\]]*\]\s*/g, "")
    .trim();
}

// ── Wikilink segmentation ──────────────────────────────────────────────

type SpecElements = Spec["elements"];

/**
 * Split text into alternating plain-text and [[wikilink]] segments,
 * emitting Text elements for prose and cyan Badge elements for wikilinks.
 */
function wikilinkSegments(
  text: string,
  prefix: string,
): { elements: SpecElements; childIds: string[] } | null {
  const parts: Array<{ text?: string; target?: string }> = [];
  let last = 0;

  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const idx = match.index!;
    if (idx > last) parts.push({ text: text.slice(last, idx) });
    parts.push({ target: match[1] });
    last = idx + match[0].length;
  }
  if (parts.length === 0) return null;
  if (last < text.length) parts.push({ text: text.slice(last) });

  const elements: SpecElements = {};
  const childIds: string[] = [];
  let i = 0;

  for (const part of parts) {
    const id = `${prefix}${i++}`;
    childIds.push(id);
    if (part.target) {
      elements[id] = {
        type: "Badge",
        props: { label: `[[${part.target}]]`, variant: "info" },
      };
    } else {
      elements[id] = {
        type: "Text",
        props: { content: part.text! },
      };
    }
  }

  return { elements, childIds };
}

// ── Main converter ─────────────────────────────────────────────────────

/**
 * Convert a floatty outline block to a json-render Spec using ink catalog
 * standard components.
 *
 * Recognizes: headings (h1/h2/h3), ctx:: markers, sh:: commands,
 * render:: prompts, search::/pick:: queries, and inline [[wikilinks]].
 */
export function blockToSpec(block: OutlineBlock, truncateAt?: number): Spec {
  const type = block.blockType ?? "text";
  let content = block.content ?? "";
  if (truncateAt && content.length > truncateAt) {
    content = content.slice(0, truncateAt) + "\u2026";
  }

  // ── Headings ──────────────────────────────────────────────────────
  if (type === "h1" || type === "h2" || type === "h3") {
    const level = type === "h1" ? 1 : type === "h2" ? 2 : 3;
    const wl = wikilinkSegments(content, "w");
    if (wl) {
      return {
        root: "b",
        elements: {
          b: {
            type: "Box",
            props: { flexDirection: "row", gap: 1 },
            children: wl.childIds,
          },
          ...wl.elements,
        },
      };
    }
    return {
      root: "b",
      elements: {
        b: { type: "Heading", props: { level, content } },
      },
    };
  }

  // ── ctx:: markers → Badge row with timestamp, project, mode ───────
  if (content.startsWith("ctx::")) {
    const timestamp = parseCtxTimestamp(content);
    const project = parseProject(block);
    const mode = parseMode(content);
    const cleaned = cleanCtxContent(content);

    const children: string[] = [];
    const elements: SpecElements = {};

    if (timestamp) {
      children.push("ts");
      elements.ts = {
        type: "Text",
        props: { content: timestamp, dimColor: true },
      };
    }
    if (project) {
      children.push("proj");
      elements.proj = {
        type: "Badge",
        props: { label: project, variant: "info" },
      };
    }
    if (mode) {
      children.push("mode");
      elements.mode = {
        type: "Badge",
        props: { label: mode, variant: "default" },
      };
    }
    if (cleaned) {
      children.push("body");
      elements.body = {
        type: "Text",
        props: { content: cleaned },
      };
    }

    return {
      root: "b",
      elements: {
        b: {
          type: "Box",
          props: {
            flexDirection: "row",
            gap: 1,
            borderStyle: "single",
            borderLeft: true,
            borderRight: false,
            borderTop: false,
            borderBottom: false,
            borderColor: "magenta",
            paddingLeft: 1,
          },
          children,
        },
        ...elements,
      },
    };
  }

  // ── sh:: commands ─────────────────────────────────────────────────
  if (content.startsWith("sh::")) {
    const command = content.replace(/^sh::\s*/, "");
    const hasOutput = (block.childIds?.length ?? 0) > 0;
    return {
      root: "b",
      elements: {
        b: {
          type: "Box",
          props: {
            flexDirection: "row",
            gap: 1,
            borderStyle: "single",
            borderLeft: true,
            borderRight: false,
            borderTop: false,
            borderBottom: false,
            borderColor: "red",
            paddingLeft: 1,
          },
          children: hasOutput ? ["cmd", "out"] : ["cmd"],
        },
        cmd: {
          type: "Text",
          props: { content: `$ ${command}`, bold: true },
        },
        ...(hasOutput
          ? {
              out: {
                type: "Text",
                props: { content: "(has output)", dimColor: true },
              },
            }
          : {}),
      },
    };
  }

  // ── render:: prompts ──────────────────────────────────────────────
  if (content.startsWith("render::")) {
    const prompt = content.replace(/^render::\s*/, "");
    return {
      root: "b",
      elements: {
        b: {
          type: "Box",
          props: {
            flexDirection: "row",
            gap: 1,
            borderStyle: "single",
            borderLeft: true,
            borderRight: false,
            borderTop: false,
            borderBottom: false,
            borderColor: "magenta",
            paddingLeft: 1,
          },
          children: ["label", "prompt"],
        },
        label: {
          type: "Badge",
          props: { label: "render", variant: "warning" },
        },
        prompt: {
          type: "Text",
          props: { content: prompt, italic: true },
        },
      },
    };
  }

  // ── search:: / pick:: queries ─────────────────────────────────────
  if (content.startsWith("search::") || content.startsWith("pick::")) {
    const query = content.replace(/^(?:search|pick)::\s*/, "");
    return {
      root: "b",
      elements: {
        b: {
          type: "Box",
          props: {
            flexDirection: "row",
            gap: 1,
            borderStyle: "single",
            borderLeft: true,
            borderRight: false,
            borderTop: false,
            borderBottom: false,
            borderColor: "cyan",
            paddingLeft: 1,
          },
          children: ["label", "query"],
        },
        label: {
          type: "Badge",
          props: { label: "search", variant: "info" },
        },
        query: {
          type: "Text",
          props: { content: query },
        },
      },
    };
  }

  // ── Default: plain text with inline wikilinks ─────────────────────
  const wl = wikilinkSegments(content, "w");
  if (wl) {
    return {
      root: "b",
      elements: {
        b: {
          type: "Box",
          props: { flexDirection: "row", gap: 0 },
          children: wl.childIds,
        },
        ...wl.elements,
      },
    };
  }

  return {
    root: "b",
    elements: {
      b: { type: "Text", props: { content } },
    },
  };
}

// ── Batch converter for tool results ────────────────────────────────

/**
 * Convert an array of outline blocks (as returned by floatty tree endpoints)
 * into a single Spec with a vertical layout. Each block becomes a depth-indented
 * row in the tree.
 */
export function blocksToSpec(
  blocks: OutlineBlock[],
  opts?: { maxBlocks?: number; truncateAt?: number },
): Spec {
  const max = opts?.maxBlocks ?? 50;
  const truncated = blocks.slice(0, max);

  const rootChildren: string[] = [];
  const allElements: SpecElements = {};

  for (let i = 0; i < truncated.length; i++) {
    const block = truncated[i];
    const blockSpec = blockToSpec(block, opts?.truncateAt ?? 200);

    // Prefix all element keys with block index to avoid collisions
    const prefix = `b${i}_`;
    const wrapperId = `${prefix}wrap`;

    rootChildren.push(wrapperId);

    // Wrap in a Box with left padding for depth
    allElements[wrapperId] = {
      type: "Box",
      props: {
        flexDirection: "row",
        paddingLeft: (block.depth ?? 0) * 2,
      },
      children: [`${prefix}root`],
    };

    // Remap the block spec's elements with prefixed keys
    for (const [key, el] of Object.entries(blockSpec.elements)) {
      const prefixedKey = key === blockSpec.root ? `${prefix}root` : `${prefix}${key}`;
      allElements[prefixedKey] = {
        ...el,
        children: el.children?.map((c) =>
          c === blockSpec.root ? `${prefix}root` : `${prefix}${c}`,
        ),
      };
    }
  }

  if (blocks.length > max) {
    const moreId = "more";
    rootChildren.push(moreId);
    allElements[moreId] = {
      type: "Text",
      props: {
        content: `… and ${blocks.length - max} more blocks`,
        dimColor: true,
      },
    };
  }

  return {
    root: "root",
    elements: {
      root: {
        type: "Box",
        props: { flexDirection: "column" },
        children: rootChildren,
      },
      ...allElements,
    },
  };
}
