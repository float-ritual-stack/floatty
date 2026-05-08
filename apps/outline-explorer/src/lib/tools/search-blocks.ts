import { tool } from "ai";
import { z } from "zod";
import { searchBlocks } from "../floatty-client";

export const searchBlocksTool = tool({
  description:
    "Search / find / lookup / query / grep blocks by full-text content across the knowledge graph. Use when you don't have a block ID or page title and need to find blocks containing specific text. Returns matching blocks with breadcrumb context. For backlinks use get_inbound; for known IDs use get_block.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().optional().describe("Max results (default 15)"),
  }),
  execute: async ({ query, limit = 15 }) => {
    const results = await searchBlocks(query, {
      limit,
      includeBreadcrumb: true,
      includeMetadata: true,
    });

    return {
      total: results.total,
      hits: results.hits.map((h) => ({
        content: h.content,
        snippet: h.snippet,
        breadcrumb: h.breadcrumb,
        outlinks: h.metadata?.outlinks,
      })),
    };
  },
});
