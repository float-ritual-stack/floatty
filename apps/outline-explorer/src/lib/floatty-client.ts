import "server-only";
import type {
  Block,
  BlockWithContext,
  SearchResponse,
  SearchOptions,
  PageEntry,
  Stats,
  TopologyResponse,
} from "./types";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function getFloattyUrl(): string {
  return requireEnv("FLOATTY_URL");
}

function getFloattyApiKey(): string {
  return requireEnv("FLOATTY_API_KEY");
}

async function floattyFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getFloattyUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getFloattyApiKey()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Floatty ${res.status}: ${body}`);
  }
  return res.json();
}

// Block operations

export async function getBlock(
  id: string,
  includes?: string[]
): Promise<BlockWithContext> {
  const params = new URLSearchParams();
  if (includes?.length) params.set("include", includes.join(","));
  const qs = params.toString();
  return floattyFetch<BlockWithContext>(
    `/api/v1/blocks/${id}${qs ? `?${qs}` : ""}`
  );
}

export async function listBlocks(): Promise<{
  blocks: Block[];
  root_ids: string[];
}> {
  return floattyFetch("/api/v1/blocks");
}

// Search

export async function searchBlocks(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResponse> {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.types) params.set("types", opts.types);
  if (opts.excludeTypes) params.set("exclude_types", opts.excludeTypes);
  if (opts.parentId) params.set("parent_id", opts.parentId);
  if (opts.outlink) params.set("outlink", opts.outlink);
  if (opts.markerType) params.set("marker_type", opts.markerType);
  if (opts.markerVal) params.set("marker_val", opts.markerVal);
  if (opts.createdAfter) params.set("created_after", String(opts.createdAfter));
  if (opts.createdBefore)
    params.set("created_before", String(opts.createdBefore));
  if (opts.includeBreadcrumb) params.set("include_breadcrumb", "true");
  if (opts.includeMetadata) params.set("include_metadata", "true");
  return floattyFetch<SearchResponse>(`/api/v1/search?${params.toString()}`);
}

// Pages

export async function searchPagesByPrefix(
  prefix: string,
  limit = 10
): Promise<PageEntry[]> {
  const params = new URLSearchParams({ prefix, limit: String(limit) });
  const res = await floattyFetch<{ pages: PageEntry[] }>(
    `/api/v1/pages/search?${params.toString()}`
  );
  return res.pages;
}

// Topology

export async function getTopology(): Promise<TopologyResponse> {
  return floattyFetch<TopologyResponse>("/api/v1/topology");
}

// Stats

export async function getStats(): Promise<Stats> {
  return floattyFetch<Stats>("/api/v1/stats");
}
