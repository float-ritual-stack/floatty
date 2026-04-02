---
name: component-extraction-refactor
description: Workflow command scaffold for component-extraction-refactor in floatty.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /component-extraction-refactor

Use this workflow when working on **component-extraction-refactor** in `floatty`.

## Goal

Extracting shared logic or UI from a large component into a new file (hook or component), reducing complexity and improving modularity.

## Common Files

- `src/components/BlockItem.tsx`
- `src/components/views/DoorPaneView.tsx`
- `src/components/BlockOutputView.tsx`
- `src/hooks/useContentSync.ts`
- `src/hooks/useDoorChirpListener.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Identify reusable logic or UI in an existing component file (e.g., BlockItem.tsx).
- Create a new file (e.g., useContentSync.ts, useDoorChirpListener.ts, BlockOutputView.tsx) in the appropriate directory (src/hooks/ or src/components/).
- Move the relevant code from the original component to the new file.
- Update the original component to import and use the new hook/component.
- Test to ensure all functionality remains intact.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.