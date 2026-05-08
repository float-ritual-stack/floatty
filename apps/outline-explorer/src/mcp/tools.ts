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
  TokenEstimate,
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

async function floattyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getFloattyUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Floatty ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Constants ───────────────────────────────────────────────────────

// Cap for the rendered `tree` string in expand_page / get_block. The full
// structured shape rides on `treeNodes` (bounded server-side at 1000); this
// cap is purely a token-efficiency safety net for agents skimming the string.
// `treeTruncated: true` is surfaced when the underlying tree exceeds this.
const TREE_STRING_CAP = 200;

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
    "Open / load / fetch / view / read / expand a page's subtree by title (page name like 'FLO-679' or 'floatty'). Use when you have a page name and need its full subtree — content, children, structure. For block IDs use get_block; for full-text search use search_blocks. Returns tree (rendered string AND structured treeNodes array), tokenEstimate, blockCount, ancestorContext (with `kind`, `childrenPreview`, `siblings`, `effectiveMarkers` — heading-only-with-children blocks classified as `nav_node`, leaf headings as `leaf_marker`), and freshness (createdAt/updatedAt).",
    { title: z.string().describe("Page title to look up") },
    async ({ title }: { title: string }) => {
      try {
        // include= opts into the navigation-layer surfaces:
        //   effective_markers     — own + inherited markers with provenance
        //   nav_classification    — kind: nav_node | content_block | leaf_marker
        //   children_preview      — first 5 children (id + 200-char preview)
        //   siblings              — prev/next sibling refs within parent
        // Tier 1+2 of FLO-679 (PR #302 + #303). Default-on so agents
        // see the rendering-legibility signals without per-call opt-in.
        const params = new URLSearchParams({
          prefix: title,
          limit: "5",
          include: "effective_markers,nav_classification,children_preview,siblings",
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
        //
        // Dual-shape return: `tree` (rendered string, token-cheap for skim)
        // alongside `treeNodes` (structured array for live-artifact consumers
        // that need to navigate sub-blocks). `tokenEstimate` always-on so
        // callers can size the response without a follow-up.
        const block = await floattyFetch<
          Block & { tree?: TreeNode[]; tokenEstimate?: TokenEstimate }
        >(`/api/v1/blocks/${match.blockId}?include=tree,token_estimate`);

        // Render up to TREE_STRING_CAP nodes for token-cheap skim. The full
        // structured array goes out via `treeNodes` regardless. The
        // `treeTruncated` flag tells consumers when the rendered string is a
        // partial view of treeNodes — switch to treeNodes (or paginate via
        // search_blocks with parent_id) when true.
        const lines: string[] = [];
        if (block.tree) {
          for (const node of block.tree.slice(0, TREE_STRING_CAP)) {
            lines.push(`${"  ".repeat(node.depth)}${node.content}`);
          }
        }
        const treeTruncated = (block.tree?.length ?? 0) > TREE_STRING_CAP;

        return textResult({
          page: match.name,
          blockId: match.blockId,
          // Symmetry with get_block: childCount = direct, treeBlockCount = total.
          // Replaces former `blockCount` field — single-user app, BC break OK.
          childCount: block.childIds?.length ?? 0,
          treeBlockCount: block.tree?.length ?? 0,
          tree: lines.join("\n"),
          treeTruncated,
          treeNodes: block.tree ?? [],
          tokenEstimate: block.tokenEstimate ?? null,
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

  // 2. get_block — fetch a specific block by UUID or short-hash prefix with subtree
  //
  // Description leads with an alias bouquet ("Get / fetch / read / retrieve /
  // look up / load a block by id") so tool_search surfaces this for the full
  // range of natural-language verbs agents reach for ("get block by id",
  // "read block", "look up block", etc.). Without the aliases the description
  // only matched "fetch", and agents searching "get block by id" missed the
  // tool and concluded the capability didn't exist.
  server.tool(
    "get_block",
    "Get / fetch / read / retrieve / look up / load a block by id (full UUID or 6+ hex char short-hash prefix, e.g. '37371679' or a [[37371679]] wikilink with brackets stripped). Use this when you already have a block ID, short hash, or [[wikilink]] hash and need the block's content, ancestors (breadcrumb), or subtree — not for searching by text (use search_blocks for that). Server resolves prefixes via /api/v1/blocks/:id. Returns block content, breadcrumb (ancestors), subtree (both rendered string AND structured treeNodes array), tokenEstimate, outlinks, and ancestorContext. On ambiguous prefix the server returns 409 — broaden the prefix or use search_blocks to disambiguate.",
    {
      blockId: z.string().describe("Full block UUID or 6+ hex character short-hash prefix (case-insensitive). Strip [[ ]] from wikilink form before passing."),
      includeTree: z.boolean().optional().describe("Include full subtree (default true). When true, response carries `tree` (rendered string), `treeNodes` (structured array of {id, content, depth, childIds}), and `tokenEstimate`. Use estimate_subtree first if you suspect a large subtree."),
    },
    async ({ blockId, includeTree = true }: { blockId: string; includeTree?: boolean }) => {
      try {
        // Tier 1+2 of FLO-679 (PR #302/#303) opt-ins are surfaced on every
        // block-returning endpoint. Default-on for symmetry with search_blocks
        // and get_inbound — the rendering-legibility signals are cheap relative
        // to a tree fetch and let agents disambiguate nav-nodes vs content-blocks
        // without a second call.
        const includes = ["ancestors", "nav_classification", "children_preview", "siblings"];
        if (includeTree) {
          includes.push("tree");
          includes.push("token_estimate");
        }
        const params = `?include=${includes.join(",")}`;

        // Block GET response — extends shared `Block` with the optional
        // context shape from ?include=ancestors,tree,token_estimate.
        const block = await floattyFetch<
          Block & {
            ancestors?: { id: string; content: string }[];
            tree?: TreeNode[];
            tokenEstimate?: TokenEstimate;
          }
        >(`/api/v1/blocks/${blockId}${params}`);

        // Render up to TREE_STRING_CAP nodes for token-cheap skim. The full
        // structured array goes out via `treeNodes` regardless. The
        // `treeTruncated` flag tells consumers when the rendered string is a
        // partial view of treeNodes — switch to treeNodes (or paginate via
        // search_blocks with parent_id) when true.
        const lines: string[] = [];
        if (block.tree) {
          for (const node of block.tree.slice(0, TREE_STRING_CAP)) {
            lines.push(`${"  ".repeat(node.depth)}${node.content}`);
          }
        }
        const treeTruncated = (block.tree?.length ?? 0) > TREE_STRING_CAP;

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
          treeTruncated,
          treeNodes: block.tree ?? [],
          treeBlockCount: block.tree?.length ?? 0,
          tokenEstimate: block.tokenEstimate ?? null,
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

  // 2.5 estimate_subtree — cheap size peek before fetching content
  //
  // Cautious-agent pattern: peek at a subtree's size before deciding whether
  // to pull the whole thing. Many blocks are 1-2 lines; many subtrees are
  // 500+ blocks. `?include=token_estimate` alone returns just the size
  // metrics without serialising the tree array — much cheaper than a full
  // get_block(includeTree:true) when you only need to size the response.
  server.tool(
    "estimate_subtree",
    "Estimate / measure / preview / size-check / count a block's subtree WITHOUT fetching content. Use to decide whether to expand a tree before paying the token cost. Returns blockCount, totalChars, maxDepth, estimatedTokens (chars/4), and directChildren. Heuristics: blockCount <50 = pull all safely; 50-200 = consider scoping; >200 = paginate via search_blocks({parentId}) instead.",
    {
      blockId: z.string().describe("Block UUID or 6+ hex short-hash prefix to size."),
    },
    async ({ blockId }: { blockId: string }) => {
      try {
        const block = await floattyFetch<
          Block & { tokenEstimate?: TokenEstimate }
        >(`/api/v1/blocks/${blockId}?include=token_estimate`);

        const e = block.tokenEstimate;
        return textResult({
          blockId: block.id,
          directChildren: block.childIds?.length ?? 0,
          totalChars: e?.totalChars ?? 0,
          blockCount: e?.blockCount ?? 0,
          maxDepth: e?.maxDepth ?? 0,
          // Rough token approximation. /4 is the standard rule of thumb for
          // English+code mixed content. Treat as a budget hint, not a billing
          // figure.
          estimatedTokens: Math.ceil((e?.totalChars ?? 0) / 4),
        });
      } catch (err) {
        return errorResult(String(err));
      }
    }
  );

  // 3. search_blocks — full-text search across all blocks
  //
  // Every hit carries `ancestorContext` (cheap fields always-on; nav-layer
  // surfaces opt-in via include=). Default include opts into effective_markers
  // (which-project), nav_classification (kind: nav_node|content_block|
  // leaf_marker), children_preview (first 5 children), and siblings
  // (prev/next refs) — agents see rendering-legibility signals + answer
  // "which page does this hit belong to" without a follow-up call.
  server.tool(
    "search_blocks",
    "Search / find / lookup / query / grep blocks by full-text content across the knowledge graph. Use when you don't have a block ID or page title and need to find blocks containing specific text. Returns matching blocks with breadcrumb context AND ancestorContext (nearestPageName, effectiveMarkers, inboundCount, **kind** [`nav_node`/`content_block`/`leaf_marker`], **childrenPreview** [first 5 children], **siblings** [prev/next]) — usually no follow-up call needed for orientation. Pass parentId to scope the search to a specific subtree (e.g. paginate within a large page). For backlinks use get_inbound; for known IDs use get_block.",
    {
      query: z.string().describe("Search query. Pass empty string with parentId to list-paginate a subtree by recency without keyword filtering."),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Max results (default 15, max 200)."),
      parentId: z
        .string()
        .optional()
        .describe("Restrict search to descendants of this block (UUID or 6+ hex prefix). Use to paginate within a large subtree when get_block's tree response is truncated."),
    },
    async ({ query, limit = 15, parentId }: { query: string; limit?: number; parentId?: string }) => {
      try {
        const params = new URLSearchParams({
          q: query,
          limit: String(limit),
          include_breadcrumb: "true",
          include_metadata: "true",
          // Tier 1+2 of FLO-679 (PR #302/#303):
          //   effective_markers     → own + inherited project/marker provenance
          //   nav_classification    → kind: nav_node | content_block | leaf_marker
          //                            (Tier 1 of the doctrine — heading-only-with-
          //                            children blocks tag as nav_node so renderers
          //                            can preview their first child instead of
          //                            stacking three identical "## arcs" hits)
          //   children_preview      → first 5 children (id + 200-char preview)
          //                            (Tier 2 — auto-expand affordance for nav-nodes)
          //   siblings              → prev/next sibling refs within parent
          // Cost: ~1KB/hit when children_preview fires. Acceptable for the
          // navigation-legibility win.
          include: "effective_markers,nav_classification,children_preview,siblings",
        });
        if (parentId !== undefined) params.set("parent_id", parentId);

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
    "Find backlinks / inbound links / references / what-links-here — blocks that link TO a target page via [[wikilinks]] (the inverse of an outlink lookup). Use to discover what references, connects to, or cites a page. Each result includes the block's markers, outgoing outlinks, timestamps, outputType for further graph traversal and recency sorting, AND ancestorContext (nearestPageName, effectiveMarkers, **kind** [`nav_node`/`content_block`/`leaf_marker`], **childrenPreview** [first 5 children for nav-nodes], **siblings** [prev/next]) so backlinks renderers can show heading-only-with-children inbound refs distinctly from content blocks.",
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
          // Match search_blocks: full nav-layer opt-in.
          // Tier 1+2 of FLO-679 (PR #302/#303):
          //   effective_markers     → own + inherited project/marker provenance
          //   nav_classification    → kind: nav_node | content_block | leaf_marker
          //                            (Tier 1 — three "## arcs" backlinks tag as
          //                            nav_node + carry distinct subtreeSize, so
          //                            backlink renderers can disambiguate
          //                            visually instead of showing three identical
          //                            "## arcs" rows)
          //   children_preview      → first 5 children (id + 200-char preview)
          //                            (Tier 2 — auto-expand the section header's
          //                            top-of-content for inline preview without a
          //                            follow-up get_block)
          //   siblings              → prev/next sibling refs within parent
          //                            (Tier 2 — adjacent context for backlink
          //                            disambiguation)
          include: "effective_markers,nav_classification,children_preview,siblings",
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
    "Search / find / lookup / query the QMD knowledge base — 4900+ markdown documents across Linear issues, daily notes, sysops logs, technical writing, patterns, conversation exports, and more. Use when the outline references something (like a [[FLO-NNN]] issue, a person, a pattern, a decision) that isn't in the outline itself.",
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
    "Get / fetch / read / retrieve / load / open a single qmd document by file path (or docid). Returns plain markdown text. Use after qmd_search to pull the full body of a hit. This is the text-content adapter for the cowork bridge — use instead of mcp__qmd__get when working inside cowork artifacts.",
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
    "Batch get / fetch / read / retrieve / load multiple qmd documents by glob pattern or comma-separated list (e.g. 'sysops-log/2026-04-*'). Returns documents concatenated as plain markdown. Use instead of mcp__qmd__multi_get when working inside cowork artifacts.",
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
    "Get / check / where-is the user's current focus / active block / cursor position in floatty, with ancestorContext (nearestPageName, effectiveMarkers, inboundCount) so you can orient on what they're looking at right now without a follow-up call. Returns null when no focus is set.",
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

  // ── Write tools ─────────────────────────────────────────────────────
  //
  // Wrap existing floatty-server endpoints. The API enforces validation
  // (parentId XOR afterId on add_block, YYYY-MM-DD shape on append_to_daily,
  // etc.) — we surface server errors verbatim rather than re-validating.

  // 10. add_block — create a new block under a parent or after a sibling
  //
  // Door projection contract (preferred for door blocks like render::):
  // pass content = SEMANTIC TITLE and output = ENVELOPE. The block lands
  // with the rendered view ready and contentEditable showing a clean title.
  //
  // Anti-pattern (avoid): writing content as `render:: {full JSON spec}`
  // and relying on auto-execute. The full spec sits in contentEditable
  // looking like garbage until the door projects it, and any reconnect /
  // sync re-fire can briefly unmount the rendered view, exposing the JSON.
  server.tool(
    "add_block",
    "Add / create / insert / make / write / post / append a new block in the outline. Pass parentId (nest under this block as last child) OR afterId (insert as a sibling after this block) — exactly one. Returns the created block's UUID and ancestorContext for orientation. Use create_page for named pages, append_to_daily for daily-note children — those wrap the same API but autocreate the parent. For DOOR blocks (render::, daily::, etc.), prefer the projection-contract shape: content = a semantic title, output = the door envelope, outputType = 'door'. That keeps contentEditable clean and the rendered view stable. Writing `content: 'render:: {json}'` and relying on auto-execute is supported for back-compat but produces a worse UX (raw JSON shows in contentEditable until projected; reconnect / sync events can briefly unmount the rendered view).",
    {
      content: z.string().describe("Block content (markdown / floatty syntax allowed). For door blocks, prefer a semantic title here and pass the spec via `output`."),
      parentId: z.string().optional().describe("Parent block UUID or 6+ hex prefix. Mutually exclusive with afterId."),
      afterId: z.string().optional().describe("Insert after this sibling block (UUID or prefix). Mutually exclusive with parentId."),
      output: z.unknown().optional().describe("Door / executor output envelope. For render:: this is `{ kind: 'view', doorId: 'render', schema: 1, data: { spec: <json-render spec>, title: <string>, generatedVia: 'agent' } }`. Required when outputType is 'door'."),
      outputType: z.string().optional().describe("Output type tag. Use 'door' for render::/daily::/etc. Required when output is set."),
      outputStatus: z.enum(["complete", "running", "error"]).optional().describe("Output status. Defaults to 'complete' when output is set."),
    },
    async ({ content, parentId, afterId, output, outputType, outputStatus }: { content: string; parentId?: string; afterId?: string; output?: unknown; outputType?: string; outputStatus?: "complete" | "running" | "error" }) => {
      try {
        // XOR enforcement at the MCP boundary so agents get a clear actionable
        // message instead of bubbling up an opaque server error. Server enforces
        // the same rule, this is the friendly cross-check.
        if ((parentId === undefined) === (afterId === undefined)) {
          return errorResult(
            "Exactly one of parentId or afterId must be provided. parentId nests as last child; afterId inserts as a following sibling."
          );
        }
        // Output projection contract: outputType is required when output is
        // set. Server enforces the same; this is the friendly cross-check.
        if (output !== undefined && outputType === undefined) {
          return errorResult(
            "outputType is required when output is set. Use 'door' for render::/daily::/etc."
          );
        }

        const body: Record<string, unknown> = { content };
        if (parentId !== undefined) body.parentId = parentId;
        if (afterId !== undefined) body.afterId = afterId;
        if (output !== undefined) body.output = output;
        if (outputType !== undefined) body.outputType = outputType;
        if (outputStatus !== undefined) body.outputStatus = outputStatus;

        const block = await floattyFetch<Block>("/api/v1/blocks", {
          method: "POST",
          body: JSON.stringify(body),
        });

        return textResult({
          blockId: block.id,
          content: block.content,
          blockType: block.blockType,
          childCount: block.childIds?.length ?? 0,
          outputType: block.outputType ?? null,
          ancestorContext: block.ancestorContext ?? null,
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // 11. patch_block — update an existing block
  server.tool(
    "patch_block",
    "Update / edit / modify / patch / change / rewrite / move / rename / reparent / collapse / uncollapse an existing block, or replace its door / executor output projection. All fields except blockId are optional — pass only what changes. content edits text (rename / rewrite); parentId moves the block to a new parent (move / reparent / relocate); collapsed toggles the per-pane collapse state (Y.Doc-persisted); output / outputType / outputStatus replace the block's projection envelope (use to refresh a door's rendered view without re-typing the trigger). Returns the updated block.",
    {
      blockId: z.string().describe("Block UUID or 6+ hex short-hash prefix."),
      content: z.string().optional().describe("New block content."),
      parentId: z.string().optional().describe("New parent block UUID or prefix (moves the block)."),
      collapsed: z.boolean().optional().describe("Set the block's collapsed state."),
      output: z.unknown().optional().describe("Replace the door / executor output envelope. For render:: this is `{ kind: 'view', doorId: 'render', schema: 1, data: { spec, title, generatedVia } }`."),
      outputType: z.string().optional().describe("Output type tag (e.g. 'door'). Required when output is set on a block that doesn't already have an outputType."),
      outputStatus: z.enum(["complete", "running", "error"]).optional().describe("Output status."),
    },
    async ({ blockId, content, parentId, collapsed, output, outputType, outputStatus }: { blockId: string; content?: string; parentId?: string; collapsed?: boolean; output?: unknown; outputType?: string; outputStatus?: "complete" | "running" | "error" }) => {
      try {
        const body: Record<string, unknown> = {};
        if (content !== undefined) body.content = content;
        if (parentId !== undefined) body.parentId = parentId;
        if (collapsed !== undefined) body.collapsed = collapsed;
        if (output !== undefined) body.output = output;
        if (outputType !== undefined) body.outputType = outputType;
        if (outputStatus !== undefined) body.outputStatus = outputStatus;

        // Empty-body guard — caller passed only blockId. Surface a clear UX
        // error at the MCP boundary rather than making a no-op API call.
        if (Object.keys(body).length === 0) {
          return errorResult(
            "No updates requested. Provide at least one of: content, parentId, collapsed, output, outputType, outputStatus."
          );
        }

        const block = await floattyFetch<Block>(`/api/v1/blocks/${blockId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });

        return textResult({
          blockId: block.id,
          content: block.content,
          blockType: block.blockType,
          childCount: block.childIds?.length ?? 0,
          outputType: block.outputType ?? null,
          ancestorContext: block.ancestorContext ?? null,
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // 12. create_page — get-or-create a named page (FLO-652 semantic upsert)
  //
  // Idempotent. Returns the existing page when one matches (case-insensitive)
  // or creates one under the `pages::` container. Use this for any named
  // page — daily notes, project pages, sysop notes, MOCs — instead of
  // hand-rolling pages:: container manipulation through add_block.
  server.tool(
    "create_page",
    "Create / make / new / upsert / ensure / get-or-create / find-or-create a named page (idempotent). Use for any named page in the knowledge graph: daily notes, project pages, sysop notes, MOCs. Server autocreates the `pages::` container if missing, returns existing page if name matches (case-insensitive). Returns the page block with ancestorContext.",
    {
      name: z.string().trim().min(1).describe("Page name. Must be non-empty after trimming whitespace."),
    },
    async ({ name }: { name: string }) => {
      try {
        const block = await floattyFetch<Block>(
          `/api/v1/pages/${encodeURIComponent(name)}`,
          {
            method: "POST",
            body: JSON.stringify({}),
          }
        );

        // Server stores page name as `# ${canonicalName}` heading content.
        // create_page is case-insensitive idempotent, so an existing match may
        // carry different canonical casing than the request. Surface the
        // server-canonical name to avoid drift, with the request name as fallback.
        const canonicalName =
          block.content.split("\n")[0].replace(/^#\s+/, "").trim() || name;

        return textResult({
          blockId: block.id,
          name: canonicalName,
          requestedName: name,
          content: block.content,
          childCount: block.childIds?.length ?? 0,
          ancestorContext: block.ancestorContext ?? null,
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );

  // 13. append_to_daily — append a child to a daily note (autocreates note)
  //
  // Replaces the find-daily-then-add_block dance. Daily note autocreation
  // handled server-side; the YYYY-MM-DD shape is validated server-side to
  // prevent orphan pages that GET /api/v1/daily/:date can't resolve.
  server.tool(
    "append_to_daily",
    "Append / add / log / write / post / record / journal a child block under a daily note (autocreates the daily note if missing). Date format must be YYYY-MM-DD. Returns the new child block. Use this instead of resolving the daily note by name and calling add_block — server handles autocreation atomically.",
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
        .describe("Daily note date, e.g. '2026-04-28'. Server rejects other formats."),
      content: z.string().trim().min(1).describe("Block content. Must be non-empty after trimming."),
    },
    async ({ date, content }: { date: string; content: string }) => {
      try {
        const block = await floattyFetch<Block>(
          `/api/v1/daily/${date}/append`,
          {
            method: "POST",
            body: JSON.stringify({ content }),
          }
        );

        return textResult({
          blockId: block.id,
          date,
          content: block.content,
          ancestorContext: block.ancestorContext ?? null,
        });
      } catch (e) {
        return errorResult(String(e));
      }
    }
  );
}
