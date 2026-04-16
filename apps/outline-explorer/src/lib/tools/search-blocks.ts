import { tool } from "ai";
import { z } from "zod";
import { searchBlocks } from "../floatty-client";

export const searchBlocksTool = tool({
  description:
    "Full-text search across all blocks in the knowledge graph. Returns matching blocks with breadcrumb context.",
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
