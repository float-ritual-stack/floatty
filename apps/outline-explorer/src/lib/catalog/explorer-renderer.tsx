"use client";

import { createRenderer } from "@json-render/react";
import type { ComponentMap, CreateRendererProps } from "@json-render/react";
import type { InferCatalogComponents } from "@json-render/core";
import { floattyDirectives } from "@float/render-catalog";
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

const BaseExplorerRenderer = createRenderer(
  explorerCatalog,
  explorerComponents
);

// Wrap to inject floattyDirectives by default — symmetric with render-door,
// shared via @float/render-catalog so $projectColor / $ctxColor / $wikilink
// (plus the bundled standardDirectives) resolve consistently across surfaces.
// Callers can override by passing their own `directives` prop.
export function ExplorerRenderer(props: CreateRendererProps) {
  return <BaseExplorerRenderer directives={floattyDirectives} {...props} />;
}
