import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import {
  sharedComponentDefinitions,
  explorerComponentDefinitions,
} from "@float/render-catalog/components";
import { z } from "zod";

// All component definitions live in @float/render-catalog. This file
// composes Set A (shared) + Set C (explorer-only) into a single catalog
// + declares explorer-specific actions.

export const explorerCatalog = defineCatalog(schema, {
  components: {
    ...sharedComponentDefinitions,
    ...explorerComponentDefinitions,
  },
  actions: {
    setState: {
      params: z.object({
        statePath: z.string(),
        value: z.any(),
      }),
      description: "Update a value in the state model",
    },
    pushState: {
      params: z.object({
        statePath: z.string(),
        value: z.any(),
        clearStatePath: z.string().optional(),
      }),
      description: "Append an item to an array in state",
    },
    removeState: {
      params: z.object({
        statePath: z.string(),
        index: z.number(),
      }),
      description: "Remove an item from an array by index",
    },
  },
});
