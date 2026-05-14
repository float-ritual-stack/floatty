import type { UIMessage } from "ai";
import type { SessionBlockSource } from "./types";

/**
 * Extract block references from a chat session for the session_blocks index.
 *
 * Three sources, prioritized for reuse:
 *
 * 1. `context` — block IDs the user explicitly pinned via `pageContextId`
 *    or `selectedIds` when starting the session.
 * 2. `tool-output` — block IDs returned by `get_block`/`expand_page`/
 *    `get_inbound` tool calls. The block payload from floatty-server
 *    already carries `metadata.outlinks` pre-extracted; we don't re-parse
 *    those, we just record the block ID the tool returned.
 * 3. `wikilink` — `[[wikilink]]` targets that appear in assistant prose
 *    text or in spec output (BlockRef / PageRef props). Bracket-balanced
 *    scan, not regex — handles nested `[[outer [[inner]]]]` correctly
 *    (matches floatty's inlineParser semantics).
 *
 * TODO: extract bracket-balanced wikilink scanning to
 * `packages/render-catalog/src/parsers/wikilink.ts` so floatty's
 * `apps/floatty/src/lib/inlineParser.ts` and outline-explorer can share
 * the same function. For now this is a focused port of the relevant
 * logic from inlineParser (the full inline-token tree isn't needed here).
 */

export interface BlockRef {
  blockId: string;
  source: SessionBlockSource;
}

interface ExtractInput {
  messages: UIMessage[];
  originPageId?: string | null;
  originSelectedIds?: string[];
}

/**
 * Extract block refs from the inputs above. Returns deduped refs (one row
 * per (blockId, source) pair). Caller stamps `touchedAt` at insert time.
 */
export function extractBlockRefs(input: ExtractInput): BlockRef[] {
  const seen = new Set<string>();
  const refs: BlockRef[] = [];

  function add(blockId: string, source: SessionBlockSource) {
    if (!blockId) return;
    const key = `${source}::${blockId}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ blockId, source });
  }

  // 1. context refs from when the session was created.
  if (input.originPageId) add(input.originPageId, "context");
  for (const id of input.originSelectedIds ?? []) add(id, "context");

  // 2 + 3. walk messages.
  for (const msg of input.messages) {
    const parts = (msg as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;

      // Tool output parts carry block IDs as either the input.blockId or
      // structured fields in the output. The AI SDK tool-UI shape:
      // { type: "tool-...", state: "output-available", input: {...}, output: {...} }
      if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        // input args (e.g., get_block has { blockId: "uuid" })
        const inputArg = p.input as Record<string, unknown> | undefined;
        if (inputArg) {
          if (typeof inputArg.blockId === "string") add(inputArg.blockId, "tool-output");
          if (typeof inputArg.id === "string") add(inputArg.id, "tool-output");
        }
        // tool output payload — for blocks, it's { block: { id, ... } } or
        // a list of blocks; we accept any `id` field we find at depth-1
        // structure (cheap heuristic, won't over-collect).
        const output = p.output;
        collectIdsFromUnknown(output, (id) => add(id, "tool-output"));
        continue;
      }

      // Spec parts ($state and $elements may carry BlockRef/PageRef props).
      // pipeJsonRender names these with `data-spec` part type; the spec is
      // a JSON document of `{ root, elements, state }`. Walk `props` for
      // `blockId` / `target` / `page` fields.
      if (p.type === "data-spec" && p.data && typeof p.data === "object") {
        collectIdsFromUnknown(p.data, (id) => add(id, "wikilink"));
      }

      // Plain text parts — scan for `[[wikilink]]` and `BlockRef`-like
      // identifiers that the model emitted as prose.
      if (p.type === "text" && typeof p.text === "string") {
        for (const target of extractWikilinks(p.text)) {
          // We record wikilinks as `page:` prefixed when they look like a
          // page name; UUIDs go through unchanged. This matches the
          // "page:Name" / "uuid" convention used in `selectedIds`.
          add(looksLikeUuid(target) ? target : `page:${target}`, "wikilink");
        }
      }
    }
  }

  return refs;
}

/**
 * Bracket-balanced `[[wikilink]]` extractor. Handles nested
 * `[[outer [[inner]]]]` by counting opens/closes — matches
 * floatty inlineParser semantics. Returns inner targets (for
 * `[[target|alias]]`, only the target is returned).
 */
export function extractWikilinks(text: string): string[] {
  const targets: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("[[", i);
    if (open === -1) break;
    // Find matching `]]` accounting for nested `[[`.
    let depth = 1;
    let j = open + 2;
    let close = -1;
    while (j < text.length - 1) {
      if (text[j] === "[" && text[j + 1] === "[") {
        depth++;
        j += 2;
        continue;
      }
      if (text[j] === "]" && text[j + 1] === "]") {
        depth--;
        if (depth === 0) {
          close = j;
          break;
        }
        j += 2;
        continue;
      }
      j++;
    }
    if (close === -1) break; // unclosed; skip to end
    const inner = text.slice(open + 2, close);
    // Strip aliases: `target|alias` → `target`
    const pipeIdx = inner.indexOf("|");
    const target = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
    if (target) targets.push(target);
    i = close + 2;
  }
  return targets;
}

function looksLikeUuid(s: string): boolean {
  // Loose check — full UUID v4 has 36 chars including dashes; accept that
  // shape. Avoids over-aggressive matching on short alphanum strings.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Walk any unknown JSON-ish value collecting `id`/`blockId`/`block_id`/
 * `target`/`page` string fields. Conservative depth limit prevents
 * runaway on adversarial payloads.
 */
function collectIdsFromUnknown(
  value: unknown,
  emit: (id: string) => void,
  depth = 0
): void {
  if (depth > 12) return;
  if (!value) return;
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) collectIdsFromUnknown(item, emit, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      const normalized = v.trim();
      if (!normalized) continue; // skip empty/whitespace — avoids `page:` entries
      if ((k === "blockId" || k === "block_id" || k === "id") && looksLikeUuid(normalized)) {
        emit(normalized);
      } else if (k === "target" || k === "page" || k === "pageName") {
        emit(looksLikeUuid(normalized) ? normalized : `page:${normalized}`);
      }
    } else {
      collectIdsFromUnknown(v, emit, depth + 1);
    }
  }
}
