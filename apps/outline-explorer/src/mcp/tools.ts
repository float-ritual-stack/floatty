/**
 * Tool registration for the floatty-explorer MCP server.
 *
 * Architecture: MCP client → MCP server (stdio) → floatty-server (HTTP)
 *
 * This is a thin HTTP adapter, NOT an import of the Next.js tool modules.
 * The existing tools in src/lib/tools/ depend on floatty-client.ts which
 * uses "server-only" (a Next.js guard). Instead, we call the same REST API
 * directly. Schemas match the existing tools exactly.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildQmdEnv, checkQmdAvailable } from "../lib/tools/qmd-shared.js";
import type {
  Block,
  PageSearchHit,
  PresenceResponse,
  SearchHit,
  TreeNode,
} from "../lib/types.js";

const execFileAsync = promisify(execFile);

// ── Floatty HTTP client (standalone, no Next.js deps) ──────────────

function getFloattyUrl(): string {
  return process.env.FLOATTY_URL!; // validated in server.ts
}

function getApiKey(): string {
  return process.env.FLOATTY_API_KEY!;
}

async function floattyFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${getFloattyUrl()}${path}`, {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Floatty ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── MCP response helpers ────────────────────────────────────────────

function textResult(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorResult(msg: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

// ── Tool registrations ──────────────────────────────────────────────

export function registerDataTools(server: McpServer) {
  // 1. expand_page — fetch a page's subtree by title
  //
  // Page-search hits carry `ancestorContext` (always-on cheap fields). We
  // surface the orientation context (nearest page identity, subtree size,
  // inbound count) on the response so callers don't need a follow-up
  // `get_block` — same one-call orientation win the floatty-backend skill
  // subsection calls out.
  server.tool(
    "expand_page",
    "Fetch a page's subtree by title. Use when you need to see the content tree of a specific page in the knowledge graph.",
    { title: z.string().describe("Page title to look up") },
    async ({ title }: { title: string }) => {
      try {
        // include= is opt-in for the costlier fields; effective_markers is
        // useful for navigating to a specific project page.
        const params = new URLSearchParams({
          prefix: title,
          limit: "5",
          include: "effective_markers",
        });
        const pagesRes = await floattyFetch<{ pages: PageSearchHit[] }>(
          `/api/v1/pages/search?${params}`,
        );

        const pages = pagesRes.pages ?? [];
        if (!pages.length) return textResult({ error: `Page "${title}" not found` });

        const exact = pages.find((p) => p.name.toLowerCase() === title.toLowerCase());
        const match = exact ?? pages[0];

        if (!match.blockId) {
          return textResult({ error: `Page "${match.name}" is a stub (referenced but not created)` });
        }

        // FLO-684: pull tree AND the page block's own createdAt/updatedAt/
        // outputType so consumers can answer "when was this page last
        // touched" without a third call. The Block type already carries
        // createdAt/updatedAt; outputType is optional and skip-serialized
        // when absent.
        const block = await floattyFetch<
          Block & { tree?: TreeNode[] }
        >(`/api/v1/blocks/${match.blockId}?include=tree`);

        const lines: string[] = [];
        if (block.tree) {
          for (const node of block.tree.slice(0, 200)) {
            lines.push(`${"  ".repeat(node.depth)}${node.content}`);
          }
        }

        return textResult({
          page: match.name,
          blockId: match.blockId,
          blockCount: block.tree?.length ?? 0,
          tree: lines.join("\n"),
          createdAt: block.createdAt ?? null,
          updatedAt: block.updatedAt ?? null,
          outputType: block.outputType ?? null,
          // Inline orientation — the agent gets page identity, ancestor
          // chain, effective markers, and inbound count without a third
          // API call.
          ancestorContext: match.ancestorContext ?? null,
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // 2. get_block — fetch a specific block by UUID with subtree
  server.tool(
    "get_block",
    "Fetch a specific block by its UUID, including its subtree. Use when you have a block ID and need to see its content and children.",
    {
      blockId: z.string().describe("Block UUID to fetch"),
      includeTree: z.boolean().optional().describe("Include full subtree (default true)"),
    },
    async ({ blockId, includeTree = true }: { blockId: string; includeTree?: boolean }) => {
      try {
        const includes = ["ancestors"];
        if (includeTree) includes.push("tree");
        const params = `?include=${includes.join(",")}`;

        // Block GET response — extends shared `Block` with the optional
        // context shape from ?include=ancestors,tree.
        const block = await floattyFetch<
          Block & {
            ancestors?: { id: string; content: string }[];
            tree?: TreeNode[];
          }
        >(`/api/v1/blocks/${blockId}${params}`);

        const lines: string[] = [];
        if (block.tree) {
          for (const node of block.tree.slice(0, 200)) {
            lines.push(`${"  ".repeat(node.depth)}${node.content}`);
          }
        }

        const isDoor = block.outputType === "door";
        const renderedMarkdown = block.metadata?.renderedMarkdown ?? null;

        return textResult({
          blockId: block.id,
          content: block.content,
          blockType: block.blockType,
          outputType: block.outputType ?? null,
          breadcrumb: block.ancestors?.map((a) => a.content).reverse() ?? [],
          outlinks: block.metadata?.outlinks ?? [],
          childCount: block.childIds?.length ?? 0,
          tree: lines.join("\n"),
          treeBlockCount: block.tree?.length ?? 0,
          // Always-on wire contract for /blocks/:id (slow-context path
          // already, so effectiveMarkers is populated automatically).
          ancestorContext: block.ancestorContext ?? null,
          ...(isDoor && renderedMarkdown
            ? { renderedMarkdown, summary: block.metadata?.summary ?? null }
            : {}),
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // 3. search_blocks — full-text search across all blocks
  //
  // Every hit carries `ancestorContext` (cheap fields always-on;
  // effective_markers + inbound_samples opt-in via include=). Default
  // include includes effective_markers so the search hit answers "which
  // project does this hit belong to" without a follow-up call.
  server.tool(
    "search_blocks",
    "Full-text search across all blocks in the knowledge graph. Returns matching blocks with breadcrumb context AND ancestorContext (nearestPageName, effectiveMarkers, inboundCount) — usually no follow-up call needed for orientation.",
    {
      query: z.string().describe("Search query"),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Max results (default 15, max 200)."),
    },
    async ({ query, limit = 15 }: { query: string; limit?: number }) => {
      try {
        const params = new URLSearchParams({
          q: query,
          limit: String(limit),
          include_breadcrumb: "true",
          include_metadata: "true",
          include: "effective_markers",
        });

        const results = await floattyFetch<{
          total: number;
          hits: SearchHit[];
        }>(`/api/v1/search?${params}`);

        return textResult({
          total: results.total,
          hits: results.hits.map((h) => ({
            blockId: h.blockId,
            score: h.score,
            blockType: h.blockType,
            content: h.content,
            snippet: h.snippet,
            breadcrumb: h.breadcrumb,
            markers: h.metadata?.markers,
            outlinks: h.metadata?.outlinks,
            // FLO-684: timestamps + outputType passed through. `?? null` is
            // the established idiom across this file for optional fields
            // (ancestorContext, renderedMarkdown, outputType pre-FLO-684) —
            // explicit absence handling for deleted-block / pre-684-server
            // responses. Same projection applies to get_inbound below.
            createdAt: h.createdAt ?? null,
            updatedAt: h.updatedAt ?? null,
            outputType: h.outputType ?? null,
            ancestorContext: h.ancestorContext ?? null,
          })),
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // 4. get_inbound — find blocks linking TO a target page via [[wikilinks]]
  //
  // Parameterized in FLO-684: `limit` (was hardcoded 15) and `metaFilter`
  // (server-side `?has_markers=` shortcut) so artifact/agent consumers can
  // ask for "only refs with metadata" or "only refs without" without paging
  // through the whole list and filtering client-side.
  //
  // Hits also surface `createdAt`/`updatedAt`/`outputType` (FLO-684) so
  // recency sort and door-vs-text classification work without an N+1
  // `get_block` per result.
  server.tool(
    "get_inbound",
    "Find blocks that link TO a target page via [[wikilinks]]. Use to discover what references or connects to a page. Each result includes the block's markers, outgoing outlinks, timestamps, and outputType for further graph traversal and recency sorting.",
    {
      target: z.string().describe("Page or link name to find backlinks for"),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Max results (default 15, max 200)."),
      metaFilter: z
        .enum(["all", "with-meta", "without-meta"])
        .optional()
        .describe(
          "Restrict to refs with/without metadata markers. Default 'all'."
        ),
    },
    async ({
      target,
      limit = 15,
      metaFilter = "all",
    }: {
      target: string;
      limit?: number;
      metaFilter?: "all" | "with-meta" | "without-meta";
    }) => {
      try {
        const params = new URLSearchParams({
          outlink: target,
          limit: String(limit),
          include_breadcrumb: "true",
          include_metadata: "true",
          // Match search_blocks: opt into effective_markers so inherited
          // ancestor context surfaces on inbound hits too. Daddy's
          // 2026-04-26 ancestor-context test pass flagged the gap.
          include: "effective_markers",
        });
        if (metaFilter === "with-meta") {
          params.set("has_markers", "true");
        } else if (metaFilter === "without-meta") {
          params.set("has_markers", "false");
        }

        // NOTE: `score` is omitted from this projection. `get_inbound` uses
        // an outlink= filter with empty `q`, which the backend serves via
        // tantivy's AllQuery — every hit gets a constant score (1.0), so the
        // value carries no ranking signal. See
        // apps/floatty/src-tauri/floatty-core/src/search/service.rs
        // (search_with_filters: `if query_trimmed.is_empty() { Box::new(AllQuery) }`).
        const results = await floattyFetch<{
          total: number;
          hits: SearchHit[];
        }>(`/api/v1/search?${params}`);

        return textResult({
          total: results.total,
          refs: results.hits.map((h) => ({
            blockId: h.blockId,
            blockType: h.blockType,
            content: h.content,
            breadcrumb: h.breadcrumb,
            markers: h.metadata?.markers,
            outlinks: h.metadata?.outlinks,
            createdAt: h.createdAt ?? null,
            updatedAt: h.updatedAt ?? null,
            outputType: h.outputType ?? null,
            // Surfaces nearestPageName + subtreeSize so the caller knows
            // which page the inbound source lives in without a follow-up
            // navigate.
            ancestorContext: h.ancestorContext ?? null,
          })),
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // 5. suggest_walks — recommend pages to explore next
  server.tool(
    "suggest_walks",
    "Suggest 2-5 pages the user should explore next in the knowledge graph. Call this at the end of your analysis to recommend related pages worth visiting.",
    {
      pages: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe("Page titles to suggest exploring"),
    },
    async ({ pages }: { pages: string[] }) => {
      // Purely declarative — returns suggestions as-is.
      // In the Next.js app these render as walk chips.
      // In MCP, the client decides presentation.
      return textResult({ suggested: pages });
    }
  );

  // 6. qmd_search — search external knowledge base
  server.tool(
    "qmd_search",
    "Search the QMD knowledge base — 4900+ markdown documents across Linear issues, daily notes, sysops logs, technical writing, patterns, conversation exports, and more. Use when the outline references something (like a [[FLO-NNN]] issue, a person, a pattern, a decision) that isn't in the outline itself.",
    {
      query: z
        .string()
        .describe(
          'Natural language search query. Be specific — e.g. "FLO-480 assessment flow" or "render door architecture decision"'
        ),
      collection: z
        .string()
        .optional()
        .describe(
          "Optional collection filter: linear-issues, bbs-daily, sysops-log, techcraft, patterns, consciousness-tech, claude-skills, recon, claude-plans, rangle-weekly"
        ),
      limit: z.number().optional().describe("Max results (default 5)"),
    },
    async ({
      query,
      collection,
      limit = 5,
    }: {
      query: string;
      collection?: string;
      limit?: number;
    }) => {
      const unavailable = await checkQmdAvailable();
      if (unavailable) {
        return textResult({
          total: 0,
          hits: [],
          error: unavailable,
          unavailable: true,
          query,
          collection: collection ?? null,
        });
      }
      try {
        const args = ["query", query, "--limit", String(limit), "--json"];
        if (collection) args.push("--collection", collection);

        const { stdout } = await execFileAsync("qmd", args, {
          timeout: 30000,
          env: buildQmdEnv(),
        });

        const results = JSON.parse(stdout);

        return textResult({
          total: results.length,
          hits: results.slice(0, limit).map(
            (r: {
              docid: string;
              score: number;
              file: string;
              title: string;
              snippet: string;
            }) => ({
              id: r.docid,
              score: r.score,
              title: r.title,
              source: r.file.replace(/^qmd:\/\//, ""),
              snippet: r.snippet,
            })
          ),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : "QMD search failed";
        const timedOut =
          message.includes("TIMEOUT") || message.includes("timed out");
        return textResult({
          total: 0,
          hits: [],
          error: message,
          query,
          collection: collection ?? null,
          timedOut,
        });
      }
    }
  );

  // 7. qmd_get — retrieve a single qmd document as plain text
  server.tool(
    "qmd_get",
    "Retrieve a single qmd document by file path (or docid). Returns plain markdown text. Use after qmd_search to pull the full body of a hit. This is the text-content adapter for the cowork bridge — use instead of mcp__qmd__get when working inside cowork artifacts.",
    {
      file: z
        .string()
        .describe(
          "File path (as returned by qmd_search .source) or docid. May include :line suffix to start at a specific line."
        ),
      maxLines: z
        .number()
        .optional()
        .describe("Maximum lines to return (default: full document)."),
    },
    async ({ file, maxLines }: { file: string; maxLines?: number }) => {
      const unavailable = await checkQmdAvailable();
      if (unavailable) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: unavailable }],
        };
      }
      try {
        const args = ["get", file];
        if (maxLines !== undefined) args.push("-l", String(maxLines));

        const { stdout } = await execFileAsync("qmd", args, {
          timeout: 30000,
          env: buildQmdEnv(),
        });

        return { content: [{ type: "text" as const, text: stdout }] };
      } catch (e) {
        const message = e instanceof Error ? e.message : "qmd get failed";
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `qmd get failed: ${message}` },
          ],
        };
      }
    }
  );

  // 8. qmd_multi_get — batch retrieve qmd documents as plain text
  server.tool(
    "qmd_multi_get",
    "Batch retrieve qmd documents by glob pattern or comma-separated list. Returns documents concatenated as plain markdown. Use instead of mcp__qmd__multi_get when working inside cowork artifacts.",
    {
      pattern: z
        .string()
        .describe(
          "Glob pattern (e.g. 'sysops-log/2026-04-*') or comma-separated file list."
        ),
    },
    async ({ pattern }: { pattern: string }) => {
      const unavailable = await checkQmdAvailable();
      if (unavailable) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: unavailable }],
        };
      }
      try {
        const { stdout } = await execFileAsync(
          "qmd",
          ["multi-get", pattern],
          {
            timeout: 30000,
            env: buildQmdEnv(),
          }
        );

        return { content: [{ type: "text" as const, text: stdout }] };
      } catch (e) {
        const message = e instanceof Error ? e.message : "qmd multi-get failed";
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `qmd multi-get failed: ${message}` },
          ],
        };
      }
    }
  );

  // 9. presence — what is the user currently focused on? ([[FLO-680]])
  //
  // Returns the focused block id + paneId + ancestorContext (page identity,
  // ancestor chain, effective markers) in a single call. Replaces the
  // documented `presence + get_block` chain — orienting an agent on the
  // user's current focus is now one fetch.
  server.tool(
    "presence",
    "Get the user's currently-focused block in floatty, with ancestorContext (nearestPageName, effectiveMarkers, inboundCount) so you can orient on what they're looking at without a follow-up call. Returns null when no focus is set.",
    {
      includeInboundSamples: z
        .boolean()
        .optional()
        .describe("Include up to 5 inbound source previews (default false)."),
    },
    async ({
      includeInboundSamples = false,
    }: {
      includeInboundSamples?: boolean;
    }) => {
      try {
        const includes = ["effective_markers"];
        if (includeInboundSamples) includes.push("inbound_samples");
        const params = new URLSearchParams({ include: includes.join(",") });
        const url = `/api/v1/presence?${params}`;

        // /presence returns 204 No Content when no focus is set. floattyFetch
        // doesn't model that — handle inline so the tool returns a clean null
        // rather than throwing.
        const res = await fetch(`${getFloattyUrl()}${url}`, {
          headers: {
            Authorization: `Bearer ${getApiKey()}`,
            "Content-Type": "application/json",
          },
        });
        if (res.status === 204) {
          return textResult({ focused: null });
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`Floatty ${res.status}: ${body}`);
        }
        const presence = (await res.json()) as PresenceResponse;
        return textResult({
          focused: {
            blockId: presence.blockId,
            paneId: presence.paneId ?? null,
            ancestorContext: presence.ancestorContext ?? null,
          },
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );
}
