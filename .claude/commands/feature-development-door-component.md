---
name: feature-development-door-component
description: Workflow command scaffold for feature-development-door-component in floatty.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-development-door-component

Use this workflow when working on **feature-development-door-component** in `floatty`.

## Goal

Implements a new 'door' (pluggable UI module) or adds significant features to an existing door, including catalog, component, registry, and render logic.

## Common Files

- `doors/render/catalog.ts`
- `doors/render/components.tsx`
- `doors/render/registry.ts`
- `doors/render/render.tsx`
- `doors/render/door.json`
- `package.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit or create doors/render/catalog.ts to define schemas and catalog entries.
- Implement or update components in doors/render/components.tsx.
- Wire up or update doors/render/registry.ts for registry and style injection.
- Update doors/render/render.tsx to add new routes or logic.
- Optionally, update or add doors/render/door.json manifest.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.