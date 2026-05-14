import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSession, listSessions } from "@/lib/sessions/store";

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createBody = z.object({
  title: z.string().max(200).optional(),
  originPageId: z.string().nullish(),
  originSelectedIds: z.array(z.string()).optional(),
});

export async function GET(req: NextRequest) {
  const parsed = listQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid query" }, { status: 400 });
  }
  const sessions = listSessions(parsed.data);
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = createBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  const session = createSession(parsed.data);
  return NextResponse.json({ session }, { status: 201 });
}
