import { tool } from "ai";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Narrow env: only pass what qmd needs, never expose all server env vars to a subprocess.
function buildQmdEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    NO_COLOR: "1",
  };
}

// Check at first invocation whether the binary is available.
// Returns null if available, an error string if not.
let availabilityError: string | null | undefined = undefined;

async function checkQmdAvailable(): Promise<string | null> {
  if (availabilityError !== undefined) return availabilityError;
  try {
    await execFileAsync("which", ["qmd"], { env: buildQmdEnv() });
    availabilityError = null;
  } catch {
    availabilityError =
      "qmd binary not found on PATH. Install qmd and ensure it is available before using this tool.";
  }
  return availabilityError;
}

export const qmdMultiGetTool = tool({
  description:
    "Batch retrieve qmd documents by glob pattern or comma-separated list. Returns documents concatenated as plain markdown. Use when you need several related documents at once (e.g. a week of sysops-log posts).",
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
