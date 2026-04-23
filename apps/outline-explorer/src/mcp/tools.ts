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
import { buildQmdEnv } from "../lib/tools/qmd-shared.js";

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
  server.tool(
    "expand_page",
    "Fetch a page's subtree by title. Use when you need to see the content tree of a specific page in the knowledge graph.",
    { title: z.string().describe("Page title to look up") },
    async ({ title }: { title: string }) => {
      try {
        const params = new URLSearchParams({ prefix: title, limit: "5" });
        const pagesRes = await floattyFetch<{ pages: { name: string; blockId: string | null }[] }>(
          `/api/v1/pages/search?${params}`
        );

        const pages = pagesRes.pages ?? [];
        if (!pages.length) return textResult({ error: `Page "${title}" not found` });

        const exact = pages.find((p) => p.name.toLowerCase() === title.toLowerCase());
        const match = exact ?? pages[0];

        if (!match.blockId) {
          return textResult({ error: `Page "${match.name}" is a stub (referenced but not created)` });
        }

        const block = await floattyFetch<{ tree?: { depth: number; content: string }[] }>(
          `/api/v1/blocks/${match.blockId}?include=tree`
        );

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

        const block = await floattyFetch<{
          id: string;
          content: string;
          blockType: string;
          outputType?: string | null;
          childIds?: string[];
          metadata?: { outlinks?: string[]; renderedMarkdown?: string | null; summary?: string | null } | null;
          ancestors?: { id: string; content: string }[];
          tree?: { depth: number; content: string }[];
        }>(`/api/v1/blocks/${blockId}${params}`);

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
          breadcrumb: block.ancestors?.map((a) => a.content) ?? [],
          outlinks: block.metadata?.outlinks ?? [],
          childCount: block.childIds?.length ?? 0,
          tree: lines.join("\n"),
          treeBlockCount: block.tree?.length ?? 0,
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
  server.tool(
    "search_blocks",
    "Full-text search across all blocks in the knowledge graph. Returns matching blocks with breadcrumb context.",
    {
      query: z.string().describe("Search query"),
      limit: z.number().optional().describe("Max results (default 15)"),
    },
    async ({ query, limit = 15 }: { query: string; limit?: number }) => {
      try {
        const params = new URLSearchParams({
          q: query,
          limit: String(limit),
          include_breadcrumb: "true",
          include_metadata: "true",
        });

        const results = await floattyFetch<{
          total: number;
          hits: {
            content: string;
            snippet: string | null;
            breadcrumb?: string[];
            metadata?: { outlinks?: string[] } | null;
          }[];
        }>(`/api/v1/search?${params}`);

        return textResult({
          total: results.total,
          hits: results.hits.map((h) => ({
            content: h.content,
            snippet: h.snippet,
            breadcrumb: h.breadcrumb,
            outlinks: h.metadata?.outlinks,
          })),
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // 4. get_inbound — find blocks linking TO a target page via [[wikilinks]]
  server.tool(
    "get_inbound",
    "Find blocks that link TO a target page via [[wikilinks]]. Use to discover what references or connects to a page.",
    { target: z.string().describe("Page or link name to find backlinks for") },
    async ({ target }: { target: string }) => {
      try {
        const params = new URLSearchParams({
          outlink: target,
          limit: "15",
          include_breadcrumb: "true",
          include_metadata: "true",
        });

        const results = await floattyFetch<{
          total: number;
          hits: { content: string; breadcrumb?: string[] }[];
        }>(`/api/v1/search?${params}`);

        return textResult({
          total: results.total,
          refs: results.hits.map((h) => ({
            content: h.content,
            breadcrumb: h.breadcrumb,
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
}
