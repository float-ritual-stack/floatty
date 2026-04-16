import type { NextRequest } from "next/server";
import { searchBlocks } from "@/lib/floatty-client";

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const query = sp.get("q") ?? "";
    const results = await searchBlocks(query, {
      limit: Number(sp.get("limit") ?? "20"),
      types: sp.get("types") ?? undefined,
      excludeTypes: sp.get("exclude_types") ?? undefined,
      parentId: sp.get("parent_id") ?? undefined,
      outlink: sp.get("outlink") ?? undefined,
      markerType: sp.get("marker_type") ?? undefined,
      markerVal: sp.get("marker_val") ?? undefined,
      createdAfter: sp.has("created_after")
        ? Number(sp.get("created_after"))
        : undefined,
      createdBefore: sp.has("created_before")
        ? Number(sp.get("created_before"))
        : undefined,
      includeBreadcrumb: sp.get("include_breadcrumb") === "true",
      includeMetadata: sp.get("include_metadata") === "true",
    });
    return Response.json(results);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
