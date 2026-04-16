import { searchPagesByPrefix } from "./floatty-client";

export interface ResolveResult {
  blockId: string;
  name: string;
}

export interface ResolveAmbiguous {
  candidates: { name: string; blockId: string | null }[];
}

export type ResolveRouteResponse =
  | ({ type: "resolved" } & ResolveResult)
  | ({ type: "ambiguous"; title: string } & ResolveAmbiguous)
  | { type: "not_found"; title: string; error: string };

/**
 * Resolve a page title to a canonical blockId using a 3-tier fuzzy match:
 * exact → prefix → single-fuzzy. Returns null if no match or ambiguous.
 */
export async function resolvePageTitle(
  title: string
): Promise<ResolveResult | ResolveAmbiguous | null> {
  const pages = await searchPagesByPrefix(title, 5);
  if (!pages.length) return null;

  const lTitle = title.toLowerCase();

  const exact = pages.find((p) => p.name.toLowerCase() === lTitle);
  if (exact?.blockId) return { blockId: exact.blockId, name: exact.name };

  const prefix = pages.find((p) => p.name.toLowerCase().startsWith(lTitle));
  if (prefix?.blockId) return { blockId: prefix.blockId, name: prefix.name };

  const fuzzy = pages.filter((p) => p.name.toLowerCase().includes(lTitle));
  if (fuzzy.length === 1 && fuzzy[0].blockId) {
    return { blockId: fuzzy[0].blockId, name: fuzzy[0].name };
  }

  if (fuzzy.length > 1) {
    return { candidates: fuzzy.map((p) => ({ name: p.name, blockId: p.blockId })) };
  }

  // Fallback: first result from prefix search
  if (pages[0].blockId) return { blockId: pages[0].blockId, name: pages[0].name };

  return null;
}
