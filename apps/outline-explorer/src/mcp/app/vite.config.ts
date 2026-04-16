import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from "@tailwindcss/postcss";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname),
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: { "@": resolve(__dirname, "../../") },
  },
  css: {
    postcss: { plugins: [tailwindcss()] },
  },
  build: { outDir: resolve(__dirname, "../../../dist/mcp") },
});
