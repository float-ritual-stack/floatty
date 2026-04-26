// @float/render-catalog — shared FLOAT semantic vocabulary for json-render.
//
// Consumed by:
//   - @floatty/render-door (SolidJS renderer; Tauri door bundle)
//   - apps/outline-explorer (React renderer; Next.js + MCP)
//
// Framework-agnostic — only depends on @json-render/core + zod.
// Each consumer composes its own catalog via:
//   defineCatalog(schema, { components: { ...sharedComponentDefinitions, ...domainDefinitions }, actions: ... })
//
// See .float/work/floatty-catalog-extraction/PLAN.md for the full migration plan.

export * from "./components";
