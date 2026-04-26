// Barrel re-export of all component definition sets.
// Each consumer imports the sets it wants and spreads them into its own
// defineCatalog call. See package README + PLAN.md for the canonical pattern.

// Phase 1 of FLO-657 lands these as empty stubs to validate the package
// scaffolding (typecheck + import resolution) before Step 4 begins moving
// real component definitions from render-door + outline-explorer.

export const sharedComponentDefinitions = {} as const;
export const listShapeComponentDefinitions = {} as const;
export const doorComponentDefinitions = {} as const;
export const explorerComponentDefinitions = {} as const;
