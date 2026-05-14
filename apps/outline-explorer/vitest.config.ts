import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: [],
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      // Stub `server-only` — the real package throws when imported outside a
      // React Server Component context; tests run in Node so we no-op it.
      "server-only": resolve(__dirname, "./test/stubs/server-only.ts"),
      // Stub `bash-tool` — its transitive `just-bash` peer dep isn't
      // installed and the import chain breaks tests that load
      // explorer-agent.ts (which imports bash-tool's createSkillTool).
      // The tests don't exercise the skill-tool path, so a no-op stub is
      // sufficient.
      "bash-tool": resolve(__dirname, "./test/stubs/bash-tool.ts"),
    },
  },
});
