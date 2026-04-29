// Floatty API response types

export interface Marker {
  markerType: string;
  value?: string;
}

export interface InheritedMarker extends Marker {
  sourceBlockId: string;
}

// AncestorContext (the navigation-layer surface).
//
// Mirrors the Rust DTO in `floatty-server/src/api/blocks.rs`. Surfaced on
// every block-returning endpoint (BlockDto, BlockSearchHit, PresenceResponse,
// PageSearchResult). Always-on cheap fields; `effectiveMarkers` and
// `inboundSamples` opt-in via `?include=effective_markers,inbound_samples`
// (always-on for `/blocks/:id` since slow-context path already).
//
// `ancestorBlockIds` is ROOTMOST-FIRST per the wire contract — matches the
// breadcrumb composer's `take(5).rev()` shape.
export type EffectiveMarkerSource =
  | { kind: "own" }
  | { kind: "inherited"; sourceBlockId: string };

export interface EffectiveMarker {
  markerType: string;
  value: string;
  source: EffectiveMarkerSource;
}

export interface InboundSample {
  blockId: string;
  /** Truncated content preview (≤200 chars). Empty when source block deleted. */
  content: string;
}

export interface AncestorContext {
  nearestPageBlockId?: string;
  nearestPageName?: string;
  /** ROOTMOST-FIRST, capped at 10 by the walker. */
  ancestorBlockIds?: string[];
  /** Only present when `?include=effective_markers` (always-on for /blocks/:id). */
  effectiveMarkers?: EffectiveMarker[];
  /** Deduped union of [[wikilinks]] across the focused block + walked ancestors. */
  ancestorOutlinks?: string[];
  /** Approximate descendant count (capped at 1000 by the indexer). */
  subtreeSize: number;
  /** Number of inbound `[[wikilink]]` references to this block's nearest page. */
  inboundCount: number;
  /** Only present when `?include=inbound_samples`; default top-5. */
  inboundSamples?: InboundSample[];
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
  /**
   * Navigation-layer surface — populated by `/blocks/:id` (always-on with
   * effectiveMarkers), by `/blocks/resolve/:prefix`, and by `/blocks` when
   * `?ancestorContext=true`. May be null/absent for bulk responses or root
   * blocks with no chain.
   */
  ancestorContext?: AncestorContext;
}

export interface BlockWithContext extends Block {
  ancestors?: { id: string; content: string }[];
  siblings?: { before: Block[]; after: Block[] };
  children?: Block[];
  tree?: TreeNode[];
  tokenEstimate?: TokenEstimate;
}

export interface TreeNode {
  id: string;
  content: string;
  depth: number;
  childIds: string[];
}

export interface TokenEstimate {
  totalChars: number;
  blockCount: number;
  maxDepth: number;
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
  /**
   * Block creation timestamp (ms since epoch). Mirrors `BlockDto.createdAt`.
   * Omitted when the source block was deleted between indexing and response
   * (in that case the field serializes as 0 server-side and is dropped via
   * `skip_serializing_if`). FLO-684.
   */
  createdAt?: number;
  /**
   * Block last-update timestamp (ms since epoch). Single source of truth is
   * the block's `updatedAt` Y.Map field — frontend stamps on every local
   * edit; REST mutations stamp on PATCH/POST. Use for recency sorting on
   * inbound/search hits without an N+1 follow-up `get_block` per result.
   * FLO-684.
   */
  updatedAt?: number;
  /**
   * Block output type when set (e.g., `"door"`, `"eval-result"`,
   * `"search-results"`). Mirrors `BlockDto.outputType` so MCP/agent
   * consumers can distinguish a door spec from a plain text block without
   * a follow-up GET. FLO-684.
   */
  outputType?: string;
  /**
   * Navigation-layer surface — populated on every hit. Cheap fields
   * always-on; opt-in fields (`effectiveMarkers`, `inboundSamples`) gated
   * by `?include=`.
   */
  ancestorContext?: AncestorContext;
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
  /**
   * Comma-separated `?include=` directives for AncestorContext.
   * Recognised: `effective_markers`, `inbound_samples`. Cheap fields are
   * always-on regardless of this parameter.
   */
  include?: string;
  /** Cap for `inbound_samples` (default 5; max 50). */
  inboundSampleCount?: number;
}

// Page search response (mirrors PageSearchResult on the wire)
export interface PageSearchHit {
  name: string;
  isStub: boolean;
  blockId: string | null;
  /** Populated only for non-stub pages (stubs have no chain to compute). */
  ancestorContext?: AncestorContext;
}

// Presence response shape ([[FLO-680]])
export interface PresenceResponse {
  blockId: string;
  paneId?: string;
  /** Same opt-in rules as search hits: cheap fields always-on. */
  ancestorContext?: AncestorContext;
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
