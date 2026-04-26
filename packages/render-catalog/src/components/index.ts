// Barrel re-export of all component definition sets.
// Each consumer imports the sets it wants and spreads them into its own
// defineCatalog call. See package README + PLAN.md for the canonical pattern.

export { sharedComponentDefinitions } from "./shared";
export { doorComponentDefinitions } from "./door";
export { explorerComponentDefinitions } from "./explorer";
export * from "./enums";

// Stub — populated in subsequent FLO-657 step:
// Step 4b: list-shape components (Timeline/List/AnchoredList/Narrative)
//   per FLO-657 Apr 20 comment

export const listShapeComponentDefinitions = {} as const;
