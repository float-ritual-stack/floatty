"use client";

import { ExplorerRenderer } from "@/lib/catalog/explorer-renderer";
import { blockToSpec } from "@/lib/catalog/block-to-spec";
import type { Block } from "@/lib/types";

interface BlockContentProps {
  block: Block;
  truncateAt?: number;
}

export function BlockContent({ block, truncateAt }: BlockContentProps) {
  const spec = blockToSpec(block, truncateAt);
  return <ExplorerRenderer spec={spec} />;
}
