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

export const qmdSearchTool = tool({
  description:
    "Search the QMD knowledge base — 4900+ markdown documents across Linear issues, daily notes, sysops logs, technical writing, patterns, conversation exports, and more. Use when the outline references something (like a [[FLO-NNN]] issue, a person, a pattern, a decision) that isn't in the outline itself. Also useful for finding historical context about topics mentioned in blocks.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Natural language search query. Be specific — e.g. 'FLO-480 assessment flow' or 'render door architecture decision'"
      ),
    collection: z
      .string()
      .optional()
      .describe(
        "Optional collection filter: linear-issues, bbs-daily, sysops-log, techcraft, patterns, consciousness-tech, claude-skills, recon, claude-plans, rangle-weekly"
      ),
    limit: z
      .number()
      .optional()
      .describe("Max results (default 5)"),
  }),
  execute: async ({ query, collection, limit = 5 }) => {
    const unavailable = await checkQmdAvailable();
    if (unavailable) {
      return { total: 0, hits: [], error: unavailable, unavailable: true };
    }

    try {
      const args = ["query", query, "--limit", String(limit), "--json"];
      if (collection) {
        args.push("--collection", collection);
      }

      const { stdout } = await execFileAsync("qmd", args, {
        timeout: 30000,
        env: buildQmdEnv(),
      });

      const results = JSON.parse(stdout);

      return {
        total: results.length,
        hits: results.slice(0, limit).map(
          (r: {
            docid: string;
            score: number;
            file: string;
            title: string;
            snippet: string;
            context?: string;
          }) => ({
            id: r.docid,
            score: r.score,
            title: r.title,
            source: r.file.replace(/^qmd:\/\//, ""),
            snippet: r.snippet,
          })
        ),
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "QMD search failed";
      const timedOut = message.includes("TIMEOUT") || message.includes("timed out");
      return { total: 0, hits: [], error: message, query, collection: collection ?? null, timedOut };
    }
  },
});
