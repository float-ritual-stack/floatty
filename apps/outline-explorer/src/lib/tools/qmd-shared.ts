import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Narrow env: only pass what qmd needs, never expose all server env vars to a subprocess.
// Keeps FLOATTY_API_KEY, ANTHROPIC_API_KEY, DB connection strings etc. out of child processes.
export function buildQmdEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? "",
    PATH: process.env.PATH ?? "",
    NODE_ENV: process.env.NODE_ENV ?? "development",
    NO_COLOR: "1",
  };
}

// Check at first invocation whether the qmd binary is available.
// Returns null if available, an error string if not.
// Shared cache across all qmd tools — one lookup per process.
let availabilityError: string | null | undefined = undefined;

export async function checkQmdAvailable(): Promise<string | null> {
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
