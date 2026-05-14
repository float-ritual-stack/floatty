import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listSessionsByBlock } from "@/lib/sessions/store";

const query = z.object({
  blockId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(req: NextRequest) {
  const parsed = query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    // Surface the actual zod failure so clients can distinguish a missing
    // blockId from an invalid `limit` — hardcoded "Missing blockId" obscures
    // the latter case.
    return NextResponse.json(
      { error: "Invalid query", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const sessions = listSessionsByBlock(parsed.data.blockId, parsed.data.limit ?? 20);
  return NextResponse.json({ sessions });
}
