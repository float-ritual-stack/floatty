import { tool } from "ai";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { buildQmdEnv, checkQmdAvailable } from "./qmd-shared";

const execFileAsync = promisify(execFile);

export const qmdMultiGetTool = tool({
  description:
    "Batch get / fetch / read / retrieve / load multiple qmd documents by glob pattern or comma-separated list. Returns documents concatenated as plain markdown. Use when you need several related documents at once (e.g. a week of sysops-log posts).",
  inputSchema: z.object({
    pattern: z
      .string()
      .describe(
        "Glob pattern (e.g. 'sysops-log/2026-04-*') or comma-separated file list."
      ),
  }),
  execute: async ({ pattern }) => {
    const unavailable = await checkQmdAvailable();
    if (unavailable) {
      return { body: "", error: unavailable, unavailable: true };
    }

    try {
      const { stdout } = await execFileAsync("qmd", ["multi-get", pattern], {
        timeout: 30000,
        env: buildQmdEnv(),
      });

      return { body: stdout };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "qmd multi-get failed";
      const timedOut =
        message.includes("TIMEOUT") || message.includes("timed out");
      return { body: "", error: message, pattern, timedOut };
    }
  },
});
