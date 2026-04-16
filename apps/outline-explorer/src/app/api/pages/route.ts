import type { NextRequest } from "next/server";
import { searchPagesByPrefix } from "@/lib/floatty-client";

export async function GET(request: NextRequest) {
  try {
    const prefix = request.nextUrl.searchParams.get("prefix") ?? "";
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
    const pages = await searchPagesByPrefix(prefix, limit);
    return Response.json({ pages });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}
