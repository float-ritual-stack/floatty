import { tool } from "ai";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildQmdEnv, checkQmdAvailable } from "./qmd-shared";

const execFileAsync = promisify(execFile);

export const qmdGetTool = tool({
  description:
    "Get / fetch / read / retrieve / load / open a single qmd document by file path (or docid). Returns plain markdown text. Use after qmd_search to pull the full body of a hit. Pairs with qmdSearchTool — search returns snippets + source paths, this returns full bodies.",
  inputSchema: z.object({
    file: z
      .string()
      .describe(
        "File path (as returned by qmd_search .source) or docid. May include :line suffix to start at a specific line."
      ),
    maxLines: z
      .number()
      .optional()
      .describe("Maximum lines to return (default: full document)."),
  }),
  execute: async ({ file, maxLines }) => {
    const unavailable = await checkQmdAvailable();
    if (unavailable) {
      return { body: "", error: unavailable, unavailable: true };
    }

    try {
      const args = ["get", file];
      if (maxLines !== undefined) {
        args.push("-l", String(maxLines));
      }

      const { stdout } = await execFileAsync("qmd", args, {
        timeout: 30000,
        env: buildQmdEnv(),
      });

      return { body: stdout };
    } catch (err) {
      const message = err instanceof Error ? err.message : "qmd get failed";
      const timedOut =
        message.includes("TIMEOUT") || message.includes("timed out");
      return { body: "", error: message, file, timedOut };
    }
  },
});
