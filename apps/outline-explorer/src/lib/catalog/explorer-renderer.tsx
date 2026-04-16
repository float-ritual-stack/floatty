"use client";

import { createRenderer } from "@json-render/react";
import type { ComponentMap } from "@json-render/react";
import type { InferCatalogComponents } from "@json-render/core";
import { explorerCatalog } from "./explorer-catalog";
import { analysisRenderers } from "./renderers/analysis";
import { blockPrimitiveRenderers } from "./renderers/block-primitives";
import { navRenderers } from "./renderers/nav";
import { typographyRenderers } from "./renderers/typography";
import { visualizationRenderers } from "./renderers/visualizations";

type ExplorerComponentCatalog = InferCatalogComponents<typeof explorerCatalog>;

const explorerComponents = {
  ...analysisRenderers,
  ...navRenderers,
  ...typographyRenderers,
  ...visualizationRenderers,
  ...blockPrimitiveRenderers,
} as ComponentMap<ExplorerComponentCatalog>;

export const ExplorerRenderer = createRenderer(
  explorerCatalog,
  explorerComponents
);
