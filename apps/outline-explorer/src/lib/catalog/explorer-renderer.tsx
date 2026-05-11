"use client";

import { createRenderer } from "@json-render/react";
import type { ComponentMap } from "@json-render/react";
import type { InferCatalogComponents } from "@json-render/core";
import { explorerCatalog } from "./explorer-catalog";
import { analysisRenderers } from "./renderers/analysis";
import { blockPrimitiveRenderers } from "./renderers/block-primitives";
import { formRenderers } from "./renderers/form";
import { navRenderers } from "./renderers/nav";
import { terminalRenderers } from "./renderers/terminal";
import { typographyRenderers } from "./renderers/typography";
import { visualizationRenderers } from "./renderers/visualizations";

type ExplorerComponentCatalog = InferCatalogComponents<typeof explorerCatalog>;

const explorerComponents = {
  ...analysisRenderers,
  ...navRenderers,
  ...typographyRenderers,
  ...visualizationRenderers,
  ...blockPrimitiveRenderers,
  ...formRenderers,
  ...terminalRenderers,
} as ComponentMap<ExplorerComponentCatalog>;

export const ExplorerRenderer = createRenderer(
  explorerCatalog,
  explorerComponents
);
