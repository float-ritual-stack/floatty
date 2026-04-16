import { tool } from "ai";
import { z } from "zod";

export const suggestWalksTool = tool({
  description:
    "Suggest 2-5 pages the user should explore next in the knowledge graph. Call this at the end of your analysis to recommend related pages worth visiting.",
  inputSchema: z.object({
    pages: z
      .array(z.string())
      .min(1)
      .max(5)
      .describe("Page titles to suggest exploring"),
  }),
  execute: async ({ pages }) => {
    return { suggested: pages };
  },
});
