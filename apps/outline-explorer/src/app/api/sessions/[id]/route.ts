import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteSession, getSession, updateSession } from "@/lib/sessions/store";
import { extractBlockRefs } from "@/lib/sessions/block-index";

const patchBody = z.object({
  title: z.string().max(200).optional(),
  // UIMessage[] is too complex to validate fully here; trust the client and
  // validate at JSON.parse time on hydrate. We accept any array.
  messages: z.array(z.unknown()).optional(),
  // When messages is provided, the route extracts block refs itself unless
  // the caller passes blockRefs explicitly (e.g. test fixtures).
  blockRefs: z
    .array(
      z.object({
        blockId: z.string(),
        source: z.enum(["context", "tool-output", "wikilink"]),
      })
    )
    .optional(),
  originPageId: z.string().nullish(),
  originSelectedIds: z.array(z.string()).optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const session = getSession(id);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ session });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  }

  // If messages changed but caller didn't supply blockRefs, derive them.
  let blockRefs = parsed.data.blockRefs;
  if (parsed.data.messages && !blockRefs) {
    blockRefs = extractBlockRefs({
      // Trust the shape — UIMessage[] from useChat is well-formed by the time
      // it reaches us; route-level deep validation isn't worth the cost.
      messages: parsed.data.messages as Parameters<typeof extractBlockRefs>[0]["messages"],
      originPageId: parsed.data.originPageId ?? undefined,
      originSelectedIds: parsed.data.originSelectedIds,
    });
  }

  const session = updateSession(id, {
    title: parsed.data.title,
    messages: parsed.data.messages as Parameters<typeof updateSession>[1]["messages"],
    blockRefs,
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ session });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const ok = deleteSession(id);
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
