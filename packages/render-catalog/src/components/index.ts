// Barrel re-export of all component definition sets.
// Each consumer imports the sets it wants and spreads them into its own
// defineCatalog call. See package README + PLAN.md for the canonical pattern.

export { sharedComponentDefinitions } from "./shared";
export * from "./enums";

// Stubs — populated in subsequent FLO-657 steps:
// Step 4b: list-shape components (Timeline/List/AnchoredList/Narrative)
// Step 5:  door-only and explorer-only sets

export const listShapeComponentDefinitions = {} as const;
export const doorComponentDefinitions = {} as const;
export const explorerComponentDefinitions = {} as const;
