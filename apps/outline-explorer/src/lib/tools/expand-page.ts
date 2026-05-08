import { tool } from "ai";
import { z } from "zod";
import { getBlock } from "../floatty-client";
import { resolvePageTitle } from "../page-resolver";

export const expandPageTool = tool({
  description:
    "Open / load / fetch / view / read / expand a page's subtree by title (page name like 'FLO-679' or 'floatty'). Use when you have a page name and need its full subtree — content, children, structure. For block IDs use get_block; for full-text search use search_blocks.",
  inputSchema: z.object({
    title: z.string().describe("Page title to look up"),
  }),
  execute: async ({ title }) => {
    const result = await resolvePageTitle(title);

    if (!result) return { error: `Page "${title}" not found` };

    if ("candidates" in result) {
      return {
        error: `Ambiguous title "${title}" — did you mean one of: ${result.candidates.map((c) => c.name).join(", ")}?`,
      };
    }

    const block = await getBlock(result.blockId, ["tree"]);

    const lines: string[] = [];
    if (block.tree) {
      for (const node of block.tree.slice(0, 200)) {
        const indent = "  ".repeat(node.depth);
        lines.push(`${indent}${node.content}`);
      }
    }

    return {
      page: result.name,
      blockId: result.blockId,
      blockCount: block.tree?.length ?? 0,
      tree: lines.join("\n"),
    };
  },
});
