// Set C — explorer-only workflow UI. After the parity ship, this is reduced
// to the 3 components that render explorer's own workflow (block-as-shell-
// command, block-as-render-prompt, block-as-search-query). These are NOT
// in shared.ts because they have no meaning outside explorer's outline-tree
// rendering context.

import { z } from "zod";

export const explorerComponentDefinitions = {
  ShellCommand: {
    props: z.object({
      command: z.string().describe("Shell command text"),
      hasOutput: z
        .boolean()
        .optional()
        .describe("Whether this block has output children"),
    }),
    slots: ["default"],
    description: "sh:: executable shell command block",
  },

  RenderPrompt: {
    props: z.object({
      prompt: z.string().describe("Render prompt text"),
      hasOutput: z
        .boolean()
        .optional()
        .describe("Whether render output exists"),
    }),
    description:
      "render:: trigger for render agent — content is a prompt",
  },

  SearchQuery: {
    props: z.object({
      query: z.string().describe("Search or pick query text"),
      resultCount: z
        .number()
        .optional()
        .describe("Number of results found"),
    }),
    description: "search:: or pick:: executable query block",
  },
};
