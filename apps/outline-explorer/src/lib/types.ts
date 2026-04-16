// Floatty API response types

export interface Marker {
  markerType: string;
  value: string;
}

export interface InheritedMarker extends Marker {
  sourceBlockId: string;
}

export interface BlockMetadata {
  markers: Marker[];
  outlinks: string[];
  renderedMarkdown?: string | null;
  summary?: string | null;
}

export interface Block {
  id: string;
  content: string;
  parentId: string | null;
  childIds: string[];
  collapsed: boolean;
  blockType: string;
  metadata: BlockMetadata | null;
  inheritedMarkers: InheritedMarker[] | null;
  createdAt: number;
  updatedAt: number;
  outputType: string | null;
  output: unknown | null;
}

export interface BlockWithContext extends Block {
  ancestors?: { id: string; content: string }[];
  siblings?: { before: Block[]; after: Block[] };
  children?: Block[];
  tree?: TreeNode[];
  tokenEstimate?: { totalChars: number; blockCount: number; maxDepth: number };
}

export interface TreeNode {
  id: string;
  content: string;
  depth: number;
}

// Search API types
export interface SearchHit {
  blockId: string;
  score: number;
  content: string;
  snippet: string | null;
  breadcrumb?: string[];
  metadata?: BlockMetadata;
  blockType?: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  total: number;
}

export interface SearchOptions {
  limit?: number;
  types?: string;
  excludeTypes?: string;
  parentId?: string;
  outlink?: string;
  markerType?: string;
  markerVal?: string;
  createdAfter?: number;
  createdBefore?: number;
  includeBreadcrumb?: boolean;
  includeMetadata?: boolean;
}

// Pages API types
export interface PageEntry {
  name: string;
  isStub: boolean;
  blockId: string | null;
}

// Topology API types
export interface TopologyNode {
  id: string; // page name
  b: number; // block count in subtree
  i: number; // inlink count
  rc: number;
  orp: number;
  ref: number;
  bid?: string; // block UUID (if page exists, not ref-only)
}

export interface TopologyResponse {
  n: TopologyNode[];
  e: [string, string][];
  c: Record<string, [number, string][]>;
  daily: { d: string; n: number }[];
  meta: {
    blocks: number;
    pages: number;
    days: number;
    roots: number;
    refOnly: number;
    orphans: number;
  };
}

// Stats API types
export interface Stats {
  blockCount: number;
  rootCount: number;
  typeDistribution: Record<string, number>;
  markerCoverage: Record<string, number>;
}

// UI state types
export type ViewMode = "pages" | "search" | "timeline";

export interface PageListItem {
  name: string;
  blockId: string | null;
  blockCount: number;
  isStub: boolean;
}
