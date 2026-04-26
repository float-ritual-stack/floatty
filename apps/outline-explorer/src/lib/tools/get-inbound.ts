import { tool } from "ai";
import { z } from "zod";
import { searchBlocks } from "../floatty-client";

export const getInboundTool = tool({
  description:
    "Find blocks that link TO a target page via [[wikilinks]]. Use to discover what references or connects to a page.",
  inputSchema: z.object({
    target: z.string().describe("Page or link name to find backlinks for"),
  }),
  execute: async ({ target }) => {
    const results = await searchBlocks("", {
      outlink: target,
      limit: 15,
      includeBreadcrumb: true,
      includeMetadata: true,
      // Match search_blocks parity — surface inherited markers on inbound
      // hits so the caller knows the lineage without a follow-up.
      include: "effective_markers",
    });

    return {
      total: results.total,
      refs: results.hits.map((h) => ({
        content: h.content,
        // Server already returns breadcrumb rootmost-first via take(5).rev()
        // in shape_search_hit; keep as-is.
        breadcrumb: h.breadcrumb,
      })),
    };
  },
});
