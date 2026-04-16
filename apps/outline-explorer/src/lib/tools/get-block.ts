import { tool } from "ai";
import { z } from "zod";
import { getBlock } from "../floatty-client";

export const getBlockTool = tool({
  description:
    "Fetch a specific block by its UUID, including its subtree. Use when you have a block ID and need to see its content and children.",
  inputSchema: z.object({
    blockId: z.string().describe("Block UUID to fetch"),
    includeTree: z
      .boolean()
      .optional()
      .describe("Include full subtree (default true)"),
  }),
  execute: async ({ blockId, includeTree = true }) => {
    const includes = ["ancestors"];
    if (includeTree) includes.push("tree");

    const block = await getBlock(blockId, includes);

    const lines: string[] = [];
    if (block.tree) {
      for (const node of block.tree.slice(0, 200)) {
        const indent = "  ".repeat(node.depth);
        lines.push(`${indent}${node.content}`);
      }
    }

    const breadcrumb = block.ancestors?.map((a) => a.content) ?? [];

    // For door blocks, prefer renderedMarkdown (FLO-633 server-side projection,
    // ~0.19× token cost vs raw spec) over the tree walk.
    const renderedMarkdown = block.metadata?.renderedMarkdown ?? null;
    const isDoor = block.outputType === "door";

    return {
      blockId: block.id,
      content: block.content,
      blockType: block.blockType,
      outputType: block.outputType ?? null,
      breadcrumb,
      outlinks: block.metadata?.outlinks ?? [],
      childCount: block.childIds?.length ?? 0,
      tree: lines.join("\n"),
      treeBlockCount: block.tree?.length ?? 0,
      ...(isDoor && renderedMarkdown
        ? { renderedMarkdown, summary: block.metadata?.summary ?? null }
        : {}),
    };
  },
});
